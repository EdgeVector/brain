// Typed HTTP wrappers for fold_db_node + schema_service.
//
// Every node endpoint sends X-User-Hash (per Phase 0 spike: missing →
// `401 MISSING_USER_CONTEXT`). All errors flow through `mapError` so
// every Error Registry row maps to an actionable message in exactly
// one place.
//
// As of the @lastdb/app-sdk port, the app data path rides the SDK's
// `LastDbClient` — the same wire client every LastDB app uses — with the SDK's
// typed errors translated back into fbrain's FbrainError registry (see
// `mapSdkDataError`). That covers consent, query/queryAll, mutation, and
// app-scoped search. The remaining hand-rolled node surface is deliberately
// Brain-specific owner/admin glue the SDK contract does not expose:
// schemas/load, schema declaration/listing, bootstrap, auto-identity, health,
// raw calls, and owner-session attestation.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  CapabilityDeniedError,
  LastDbClient,
  PermissionDeniedError,
  RequestRejectedError,
  TransportError,
  UnexpectedResponseError,
  UnknownAppError,
  AppInSandboxError,
  InvalidScopeError,
  ConsentDeniedError,
  CapabilityRevokedError,
  ConsentExpiredError,
  ConsentRequestNotFoundError,
  capabilityStoreKey,
  type CapabilityStore as SdkCapabilityStore,
  type ConsentScope,
  type JsonValue as SdkJsonValue,
  type KeyValue as SdkKeyValue,
  type QueryFilter as SdkQueryFilter,
  type QueryResult as SdkQueryResult,
  type QueryRow as SdkQueryRow,
  type SearchHit as SdkSearchHit,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

import type { Config } from "./config.ts";
import type { AddSchemaRequest, RecordType } from "./schemas.ts";

export type Verbose = (msg: string) => void;

const noopVerbose: Verbose = () => {};

// Per-write capability header names (mirror fold_db_node/src/handlers/caller.rs:
// APP_CAPABILITY_HEADER / CAPABILITY_TS_HEADER). Defined here — the lowest
// layer that writes them onto the wire — so capability.ts can import them
// without a circular dependency.
export const APP_CAPABILITY_HEADER = "X-App-Capability";
export const CAPABILITY_TS_HEADER = "X-Capability-Ts";

// Owner-session attestation header (the OWNER-session axis, distinct from the
// X-App-Capability / X-Capability-Ts third-party-app axis above). fbrain runs
// as the node owner; post app-isolation-flip (fold#739) the node's owner verbs
// and owner-isolation bypass require an ATTESTED transport. fbrain mints a
// one-time pairing code over the node's UDS control socket, exchanges it for a
// session token over the full-surface UDS when available (TCP on older nodes),
// and presents that token here on every request — the exact pairing the CLI's
// `attest_owner_session` performs (fold_db_node `src/bin/folddb/commands/ui.rs`).
// Must match the node's session header name.
export const FOLDDB_SESSION_HEADER = "X-Folddb-Session";

// The node's body discriminator for "this transport is not attested" — fold's
// owner-verb gate returns `403 {"error":"transport_not_attested"}`. fbrain
// re-pairs once and retries when it sees this (a restarted node invalidates the
// in-memory session token).
export const TRANSPORT_NOT_ATTESTED = "transport_not_attested";

// Filename of the node's Unix-domain data/control socket — must match
// `fold_db_node::server::uds::SOCKET_FILE_NAME` ("folddb.sock"), the same
// constant the CLI's attest path uses. NOTE: the FoldDB→LastDB rebrand moved
// the node *data home* from `~/.folddb` to `~/.lastdb` (v0.15.1+), but the
// socket *file name* is unchanged — only the home dir moved.
const SOCKET_FILE_NAME = "folddb.sock";
const FULL_SURFACE_SOCKET_FILE_NAME = "folddb-full.sock";

// Resolve the running node's data home (the dir holding `port` and `data/`).
//
// The FoldDB→LastDB rebrand is mid-flight: there is NO single fixed default
// home, so fbrain must work against BOTH and pick the one that's actually live:
//   - the shipped LastDB.app desktop node uses `~/.folddb` as its data home,
//   - a v0.15.1+ CLI / brew `lastdb` node uses `~/.lastdb`.
// A mixed-version machine can have BOTH dirs on disk (e.g. a dev who first ran a
// 0.15.1 brew node — creating `~/.lastdb` — then switched to LastDB.app, which
// uses `~/.folddb`). Precedence:
//   1. `LASTDB_HOME` env (the new explicit override),
//   2. `FOLDDB_HOME` env (the legacy explicit override — still honored),
//   3. the candidate home whose live control socket (`data/folddb.sock`)
//      actually exists — `~/.lastdb` first, then `~/.folddb` — so we attest
//      against the node that's truly running rather than whichever home dir
//      merely exists (the dir can be a stale leftover with no live socket),
//   4. `~/.lastdb` if its dir exists (no socket on either — pre-launch default),
//   5. `~/.folddb` otherwise (legacy fallback — also the path when neither
//      dir exists yet, so error/hint strings keep pointing somewhere real).
//
// CRITICAL: every place that derives the node home (socket path + port
// breadcrumb + init hint) MUST go through this one resolver so the owner-
// attestation UDS socket and the node URL always derive from the SAME root —
// a mismatch silently fails owner attestation with a misleading
// `transport_not_attested` (the original dogfood bug). Probing for the live
// socket here (not in `defaultFolddbSocketPath` alone) is what keeps that
// invariant on a mixed machine.
export function resolveNodeHome(): string {
  const lastdbEnv = process.env.LASTDB_HOME;
  if (lastdbEnv && lastdbEnv.length > 0) return lastdbEnv;
  const folddbEnv = process.env.FOLDDB_HOME;
  if (folddbEnv && folddbEnv.length > 0) return folddbEnv;
  // Both default node-home paths derive from the guarded home base so a broken
  // HOME fails loud rather than resolving to a relative `undefined/.lastdb`.
  // (An explicit LASTDB_HOME/FOLDDB_HOME override above already bypasses this.)
  return resolveDefaultNodeHome(fbrainHomeBase(), existsSync);
}

// The pure default-home resolver behind `resolveNodeHome` (after the env
// overrides are consumed), split out so the socket-preference + directory
// fallback is directly unit-testable with an injected home base and `exists`
// probe — in-process `os.homedir()` reads the passwd entry (not $HOME) and the
// real machine's `~/.lastdb`/`~/.folddb` state can't be driven from a test, so
// this seam lets a test assert the mixed-version cases deterministically.
// Production code calls `resolveNodeHome`, which passes `fbrainHomeBase()` and
// the real `existsSync`. Precedence (steps 3–5 of resolveNodeHome's doc):
//   3. the default home whose live control socket (`data/folddb.sock`) exists —
//      `~/.lastdb` first, then `~/.folddb`,
//   4. `~/.lastdb` if its dir exists (no socket on either — pre-launch default),
//   5. `~/.folddb` otherwise.
export function resolveDefaultNodeHome(
  homeBase: string,
  exists: (p: string) => boolean,
): string {
  const lastdbDefault = join(homeBase, ".lastdb");
  const folddbDefault = join(homeBase, ".folddb");
  // Prefer the home whose control socket actually exists: that's the node truly
  // running on this machine, regardless of which home *directories* are present.
  if (exists(join(lastdbDefault, "data", SOCKET_FILE_NAME))) return lastdbDefault;
  if (exists(join(folddbDefault, "data", SOCKET_FILE_NAME))) return folddbDefault;
  // No live socket under either default: fall back to the directory-existence
  // heuristic (`~/.lastdb` first) so error/hint strings still point somewhere
  // real before any node has been launched.
  if (exists(lastdbDefault)) return lastdbDefault;
  return folddbDefault;
}

// Build the `onboarding_already_complete` (HTTP 410) recovery hint's "start
// fresh" command so it points at the dev's REAL node home rather than a
// hardcoded `~/.folddb`. The rebrand moved the onboarding state to
// `~/.lastdb/config/` on a v0.15.1+ node, so a hardcoded `rm -rf ~/.folddb/config/`
// silently no-ops on a current node and the dev stays wedged. Routing through
// `resolveNodeHome()` keeps the 0.14.x fallback (`~/.folddb`) intact while
// printing `~/.lastdb/config/` on a current node. Exported so it is directly
// unit-testable (the 410 path is hard to exercise end-to-end).
export function onboardingResetConfigDir(): string {
  return `${join(resolveNodeHome(), "config")}/`;
}

// Resolve the node's UDS control-socket path. Mirrors the CLI: the socket lives
// at `<home>/data/folddb.sock`, where `<home>` is `resolveNodeHome()` — which
// now prefers whichever default home (`~/.lastdb` for a v0.15.1+ CLI node,
// `~/.folddb` for the LastDB.app desktop node) has a live socket on disk, so on
// a mixed-version machine this returns the socket that's actually there rather
// than a dead path under a stale home dir. An explicit override (config field /
// FBRAIN_FOLDDB_SOCKET env) wins for ephemeral / non-default nodes.
export function defaultFolddbSocketPath(override?: string): string {
  // Precedence: the FBRAIN_FOLDDB_SOCKET env wins (the ad-hoc / test override),
  // then an explicit config-supplied path, then the default
  // `<resolveNodeHome()>/data/folddb.sock`.
  const envOverride = process.env.FBRAIN_FOLDDB_SOCKET;
  if (envOverride && envOverride.length > 0) return envOverride;
  if (override && override.length > 0) return override;
  return join(resolveNodeHome(), "data", SOCKET_FILE_NAME);
}

export function discoverFullSurfaceSocket(socketPath?: string): string | undefined {
  if (socketPath === undefined || socketPath.length === 0) return undefined;
  const fullSocketPath = join(dirname(socketPath), FULL_SURFACE_SOCKET_FILE_NAME);
  if (existsSync(fullSocketPath)) return fullSocketPath;
  // fold #1246 (2026-06-30) collapsed the separate `folddb-full.sock` owner
  // surface INTO the canonical control socket: a current node serves the
  // owner-attested verbs (`/api/session/browser-pair`, declare-schema, …) on
  // `folddb.sock` itself, and no `folddb-full.sock` sibling is created. When
  // that sibling is absent, fall back to the control socket so owner-session
  // attestation completes against a collapsed node instead of silently
  // degrading to unattested (which fails the owner verb). A pre-collapse node
  // that still exposes the separate sibling is handled by the branch above.
  return existsSync(socketPath) ? socketPath : undefined;
}

// Mint a one-time pairing code over the node's UDS control socket, then exchange
// it for an owner-session token over `folddb-full.sock`. Returns the token, or
// `null` on ANY failure (no socket, mint refused, exchange non-2xx, parse
// error) — null means "proceed unattested", exactly the CLI's behavior on a
// default (non-isolation) build where nothing is gated and the control socket
// is absent.
//
// Mirrors `attest_owner_session` + `mint_pairing_code` in fold_db_node's
// `src/bin/folddb/commands/ui.rs`. We guard on `existsSync(socketPath)` BEFORE
// issuing any fetch (just as the Rust path checks `socket.exists()` first) so
// that on a socketless node — and in the unit suite, where no socket exists —
// no HTTP request is made and the caller degrades cleanly.
export async function attestOwnerSession(
  socketPath: string,
  verbose: Verbose = noopVerbose,
): Promise<string | null> {
  if (!existsSync(socketPath)) {
    verbose(`owner-session attestation skipped: no control socket at ${socketPath}`);
    return null;
  }
  // This handshake is the FIRST node I/O of every CLI invocation — it runs
  // BEFORE the read/write transports arm their own deadlines — so it carries
  // its own. Each fetch (and its small body read) is bounded by
  // `defaultTimeoutMs()` via the same abort deadline as callNodeRaw
  // (L1137): one controller spans the whole request lifecycle so a stall in
  // either the headers or the body read trips the same deadline. The
  // genuinely-soft outcomes (refused, missing fields, connection error) still
  // fail soft with `return null` so fbrain proceeds unattested exactly as
  // before; only a TIMEOUT surfaces the canonical `service_timeout` error, so a
  // contended/wedged node yields the bounded heavy-load/idempotent-retry hint
  // instead of a silent unbounded hang.
  const timeoutMs = defaultTimeoutMs();
  // Fetch + parse JSON under a single deadline. Returns null when the response
  // is non-OK (caller's soft path); throws the canonical service_timeout error
  // when the request or body read stalls past the deadline.
  const fetchJsonWithDeadline = async (
    path: string,
    routeSocket: NodeSocketSelection,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<Record<string, unknown> | null> => {
    try {
      const res = await boundedNodeFetch({
        baseUrl: "http://localhost",
        path,
        method: "POST",
        headers,
        body,
        service: "node",
        socketPath,
        timeoutMs,
        routeSocket,
      });
      if (res.status < 200 || res.status >= 300) {
        verbose(`owner-session ${path} refused (HTTP ${res.status})`);
        return null;
      }
      return JSON.parse(res.text) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof BoundedFetchFailure && err.timeout) {
        verbose(`owner-session ${path} timed out after ${timeoutMs}ms`);
        throw timeoutError(path, "POST", "node", timeoutMs, err.cause);
      }
      throw err;
    }
  };

  // Mint over the UDS control socket (a verb that exists ONLY on the
  // owner-attested channel). Bun's fetch speaks HTTP over a Unix socket via the
  // `unix` option, keeping fbrain on its single global-fetch HTTP stack.
  let pairingCode: string;
  try {
    // trace-egress: loopback (UDS control socket on the local machine; pairing
    // mint, never leaves the host)
    const body = await fetchJsonWithDeadline(
      "/control/browser-pairing-code",
      { socketPath, kind: "data" },
    );
    if (body === null) return null;
    const code = body.pairing_code;
    if (typeof code !== "string" || code.length === 0) {
      verbose("owner-session mint response missing pairing_code");
      return null;
    }
    pairingCode = code;
  } catch (err) {
    // service_timeout surfaces; only genuinely-soft failures degrade to null.
    if (err instanceof FbrainError && err.code === "service_timeout") throw err;
    verbose(`owner-session mint failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  // Exchange the code over the full-surface UDS. A socket-only node always
  // exposes `folddb-full.sock` beside the control socket; if it's absent there
  // is no socket to exchange over (the retired loopback TCP listener is gone),
  // so fail soft to `null` (proceed unattested) — the same degrade-cleanly
  // contract as a missing control socket.
  const fullSocketPath = discoverFullSurfaceSocket(socketPath);
  if (!fullSocketPath) {
    verbose(`owner-session exchange skipped: no full-surface socket beside ${socketPath}`);
    return null;
  }
  try {
    // trace-egress: loopback (UDS full-surface socket on the local machine;
    // pairing-code exchange, never leaves the host)
    const body = await fetchJsonWithDeadline(
      "/api/session/browser-pair",
      { socketPath: fullSocketPath, kind: "full" },
      { "Content-Type": "application/json" },
      JSON.stringify({ code: pairingCode }),
    );
    if (body === null) return null;
    const token = body.session_token;
    if (typeof token !== "string" || token.length === 0) {
      verbose("owner-session exchange response missing session_token");
      return null;
    }
    verbose("owner-session attested");
    return token;
  } catch (err) {
    if (err instanceof FbrainError && err.code === "service_timeout") throw err;
    verbose(`owner-session exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export type NativeIndexHit = {
  schema_name: string;
  schema_display_name?: string | null;
  field: string;
  key_value: { hash: string | null; range: string | null };
  value: string;
  metadata?: { fragment_idx?: number; match_type?: string; score?: number };
};

export type SearchOptions = {
  exact?: boolean;
  minScore?: number;
  // Schema names to restrict the search to (matched against IndexResult.schema_name).
  // When set + non-empty, fold_db filters EmbeddingIndex entries to this set
  // BEFORE the top-50 cosine cut — so unrelated schemas on a shared daemon
  // (Persona, User Accounts, Contacts, CalendarEvent, …) cannot drown fbrain
  // hits out of the top-K. Empty / omitted ⇒ no filter (unfiltered). Needs
  // fold_db `feat(native-index): schema-scoped search filter` (PR #264); older
  // daemons silently ignore the param so this is safe to send unconditionally.
  //
  // Under app_identity v3.1 this filter is largely REDUNDANT: fbrain's schemas
  // are namespaced under `fbrain/*` (owner_app_id folds into the identity hash),
  // so the hashes fbrain queries no longer collide with other apps' schemas on
  // a shared daemon. The design's optional `X-App-ID` read hint is the eventual
  // replacement. We keep this filter for now — it stays correct (it filters by
  // the app-namespaced hash) and harmless, and it protects search quality
  // during the migration window before every node carries namespaced data.
  schemas?: string[];
  // Internal escape hatch for write-path semantic-index confirmation: that
  // probe must verify the native/vector index itself, not satisfy itself from
  // the local `/api/query` fallback used by user-facing reads on nodes that no
  // longer expose `/api/native-index/search`.
  localFallback?: boolean;
};

const LOCAL_SEARCH_FIELDS = [
  "slug",
  "title",
  "body",
  "status",
  "tags",
  "created_at",
  "updated_at",
];

type LocalSearchDoc = {
  schemaName: string;
  key: { hash: string | null; range: string | null };
  title: string;
  body: string;
  score: number;
};

export type RegisteredSchema = {
  name: string;
  descriptive_name: string;
  schema_type: string;
  fields: string[];
  field_types: Record<string, unknown>;
  identity_hash?: string;
  source?: string;
};

export type RawResponse = {
  status: number;
  headers: Headers;
  body: string;
  json: unknown;
};

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
  // The base64-encoded ed25519 public key of whoever wrote the record's
  // head atoms. `pubkeyToUserHash` derives the fold_db user_hash from it
  // for telemetry (G13 `fbrain doctor --usage`).
  author_pub_key?: string;
  // metadata also exists (per-field atom_uuid + writer_pubkey) but only
  // author_pub_key is needed by current code paths.
};

export type QueryResponse = {
  ok: boolean;
  results: QueryRow[];
  total_count?: number;
  returned_count?: number;
  has_more?: boolean;
};

// Single-request page size for the `/api/query` pagination loop. The node
// caps individual page requests at MAX_QUERY_LIMIT (1000); we ride that
// cap directly so a database of N records resolves in ceil(N/1000) round
// trips. The server's INTERNAL_FETCH_CAP (10000) is a separate ceiling
// on the post-filter result set per-request — beyond that the node sets
// `has_more` and we'd need to keep iterating.
export const QUERY_PAGE_SIZE = 1000;

// Safety cap to prevent an infinite pagination loop if the node ever
// returns `has_more: true` together with an empty `results` page. At a
// page size of 1000 this still permits 1,000,000 records before bailing
// — well beyond fbrain's expected scale, but bounded.
export const QUERY_PAGE_LIMIT = 1000;

// Detail fields carried by a capability 403 (the node may include `schema`,
// `capability_id`, or `timestamp_skew_secs` depending on the reason).
export type Capability403Detail = {
  schema?: string;
  capabilityId?: string;
  timestampSkewSecs?: number;
};

export class FbrainError extends Error {
  readonly code: string;
  readonly hint?: string;
  // Channel-neutral alternative to `hint` for non-interactive callers (the
  // MCP server). `hint` carries CLI/brew remediation an agent can't run
  // (`fbrain doctor`, `folddb daemon …`); when an error sets `agentHint` the
  // MCP boundary shows that instead. See errorResult in src/mcp/server.ts.
  readonly agentHint?: string;
  override readonly cause?: unknown;
  // Set when this error is a discriminated capability 403 (app_identity v3.1).
  // The capability layer switches on `capabilityReason` to decide whether to
  // discard the cached token, silently re-acquire, retry once, or surface.
  readonly capabilityReason?: string;
  readonly capabilityDetail?: Capability403Detail;
  constructor(opts: {
    code: string;
    message: string;
    hint?: string;
    agentHint?: string;
    cause?: unknown;
    capabilityReason?: string;
    capabilityDetail?: Capability403Detail;
  }) {
    super(opts.message);
    this.name = "FbrainError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.agentHint = opts.agentHint;
    this.cause = opts.cause;
    this.capabilityReason = opts.capabilityReason;
    this.capabilityDetail = opts.capabilityDetail;
  }
}

// Raised when the OS cannot give us a usable home directory and we therefore
// cannot derive ANY of fbrain's on-disk paths (config, keychain, migrations,
// caches, usage log, node home). Extends FbrainError so it carries a stable
// `code` + structured `hint` like every other operational error. Its code is
// NOT in USAGE_ERROR_CODES, so it stays exit 1 (operational, not a usage
// error).
//
// WHY THIS EXISTS: `os.homedir()` does NOT throw on a broken HOME. When a
// spawn passes a JS-`undefined` HOME (`env: { ...process.env, HOME: fakeHome }`
// with `fakeHome` undefined — several test harnesses + dogfood scripts do
// exactly this), Bun/Node return the LITERAL string `"undefined"`. Every
// `join(homedir(), ".fbrain", …)` (and `~/.lastdb` / `~/.folddb` node-home)
// then becomes a RELATIVE path like `undefined/.fbrain/…`, and the first
// `mkdirSync(dirname(path), …)` + `writeFileSync` silently scatters config +
// keychain + caches under whatever cwd the process happened to be standing in
// (observed: a stray `./undefined/.fbrain/config.json` committed-adjacent in
// the repo root). An *empty/unset* HOME is FINE — `homedir()` falls back to
// the passwd entry and returns an absolute path; only a garbage VALUE (the
// literal `"undefined"`/`"null"`) or any non-absolute result triggers the
// scatter. We fail loud here instead.
//
// Defined here (the lowest layer, alongside FbrainError) so both client.ts's
// `resolveNodeHome` and config.ts's path resolvers can share ONE guard with no
// import cycle; config.ts re-exports `fbrainHomeBase`/`HomeUnresolvedError` so
// the rest of the codebase imports them from there.
export class HomeUnresolvedError extends FbrainError {
  constructor(resolved: string) {
    super({
      code: "home_unresolved",
      message:
        `Could not resolve a usable home directory: os.homedir() returned ` +
        `${JSON.stringify(resolved)}, which is not an absolute path.`,
      hint:
        "Set a valid $HOME (an absolute path), or pin the config path " +
        "explicitly with the FBRAIN_CONFIG env var. A common cause is a " +
        'spawn passing an undefined HOME (`env: { HOME: undefined }`), which ' +
        'makes os.homedir() return the literal string "undefined".',
      agentHint:
        "The HOME environment variable is unset or invalid (os.homedir() " +
        `returned ${JSON.stringify(resolved)}). Set HOME to an absolute path, ` +
        "or set FBRAIN_CONFIG to an absolute config path.",
    });
    this.name = "HomeUnresolvedError";
  }
}

// The single guarded home resolver. Every fbrain on-disk path derives from
// here (config / keychain / migrations / bm25 cache / expand cache / usage /
// node home), so a broken HOME can never `mkdir`/write a relative
// `undefined/…` path — it fails loud with HomeUnresolvedError instead. Returns
// the same value as `homedir()` on the happy path (a valid absolute home), so
// behavior is identical for every real developer; this is pure hardening.
export function fbrainHomeBase(): string {
  return validateHomeBase(homedir());
}

// The pure guard predicate behind `fbrainHomeBase`, split out so it is
// directly unit-testable with literal inputs (in-process `os.homedir()` on
// macOS reads the passwd entry, NOT $HOME, so a test cannot exercise the bad
// shapes by overriding process.env.HOME — only a spawned child can). Rejects
// the three failure shapes the dogfood found: a missing/empty result, the
// literal garbage strings Bun/Node yield from an `undefined`/`null` HOME, and
// any other non-absolute path (which would resolve relative to cwd). Exported
// for tests; production code calls `fbrainHomeBase`.
export function validateHomeBase(h: string): string {
  if (!h || h === "undefined" || h === "null" || !isAbsolute(h)) {
    throw new HomeUnresolvedError(h);
  }
  return h;
}

// Every node/schema HTTP request gets a deadline that bounds BOTH the fetch
// AND the response-body read, so a node that returns headers fast then stalls
// while streaming the body (the cold-schema-init failure mode) can never hang
// the CLI unbounded. Overridable via FBRAIN_HTTP_TIMEOUT_MS for a genuinely
// slow node.
const DEFAULT_TIMEOUT_MS = 30_000;

function defaultTimeoutMs(): number {
  const raw = process.env.FBRAIN_HTTP_TIMEOUT_MS;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// Per-KB and ceiling for the payload-scaled WRITE deadline. The node
// chunk-embeds the *entire* body on write (~512-char chunks, batched), so a
// write's cost is O(payload): a ~218KB record is ~425 chunk embeddings and
// routinely blows past the flat 30s deadline, hard-failing `service_timeout`
// for no reason other than that the record is big. (Reads stay on
// `defaultTimeoutMs()` — they embed a single query vector and a 219KB read
// round-trips in ~0.26s, so a fast deadline still surfaces a wedged node
// quickly.) These scale the deadline up with body size so a large write
// succeeds out of the box; the ceiling keeps a runaway from hanging forever.
const PER_KB_MS = 300;
const MAX_WRITE_TIMEOUT_MS = 240_000;

// Deadline for a write whose body is `bodyBytes` long. An explicit
// FBRAIN_HTTP_TIMEOUT_MS still wins unchanged — that's authoritative user
// intent and must not be silently rescaled. Otherwise grow the base 30s
// deadline by `PER_KB_MS` per KB of body, clamped to [DEFAULT, MAX]. A
// zero-byte body (a GET / bodyless request routed through a write transport)
// resolves to exactly DEFAULT_TIMEOUT_MS, so reads are never slowed.
export function writeTimeoutMs(bodyBytes: number): number {
  const raw = process.env.FBRAIN_HTTP_TIMEOUT_MS;
  const override = raw === undefined ? NaN : parseInt(raw, 10);
  if (Number.isFinite(override) && override > 0) return override;
  const scaled = DEFAULT_TIMEOUT_MS + Math.ceil(Math.max(0, bodyBytes) / 1024) * PER_KB_MS;
  return Math.min(Math.max(DEFAULT_TIMEOUT_MS, scaled), MAX_WRITE_TIMEOUT_MS);
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

// Default local-CPU-pressure probe — 1-minute load average and core count from
// the OS. Injectable in `timeoutHint` so tests don't depend on the host's live
// load. A reading of [0, 0] means "unmeasurable" (loadavg() returns 0s on some
// platforms, e.g. Windows) → callers fall back to the load-agnostic hint.
export function defaultLoadProbe(): { load1: number; cores: number } {
  return { load1: loadavg()[0] ?? 0, cores: cpus().length };
}

// The over-subscription factor at which we blame local CPU starvation rather
// than the node. A load average above `cores * factor` means meaningfully more
// runnable work than the machine has cores — the classic "a `cargo build` is
// hogging the box" state a new dev hits in their first hour. 1.5 leaves headroom
// for the normal load a healthy machine carries without crying starvation.
const STARVATION_LOAD_FACTOR = 1.5;

// Hint for a request timeout. For the local node path this is load-aware: when
// the host is CPU-saturated (load >> cores) the node is almost certainly
// STARVED, not broken — so the old static "cold-initializing its schema index"
// guess was actively misleading (it sent devs to restart a perfectly healthy,
// hours-up node when the real fix was "await the other CPU hog"). The
// schema-service path is a remote Lambda, where local load is irrelevant — it
// keeps the load-agnostic hint. See the `nodeDownHint` / `isNodeReachableButErroring`
// family for the precedent of context-aware hints.
export function timeoutHint(
  service: "node" | "schema",
  loadProbe: () => { load1: number; cores: number } = defaultLoadProbe,
): string {
  const idempotentTail =
    "Writes are upserts keyed by slug, so re-running the command is safe. Raise the deadline with FBRAIN_HTTP_TIMEOUT_MS if it's just slow.";
  if (service === "node") {
    const { load1, cores } = loadProbe();
    // load1 > 0 guards the "unmeasurable" platforms; cores > 0 is defensive.
    if (cores > 0 && load1 > cores * STARVATION_LOAD_FACTOR) {
      return (
        `This machine is under heavy CPU load (load ${load1.toFixed(1)} on ${cores} cores) — ` +
        "the node is likely starved, not broken. Re-run once the other work " +
        "(e.g. a build/test run) finishes. " +
        idempotentTail
      );
    }
    return (
      "The node may be slow (under load, or cold-initializing its schema index). " +
      idempotentTail
    );
  }
  return (
    "The schema service may be under heavy load (e.g. a cold Lambda). " +
    idempotentTail
  );
}

// A stalled request/body-read fails fast with the idempotent-retry hint: every
// fbrain write is an upsert keyed by slug, so re-running the command is safe.
function timeoutError(
  path: string,
  method: string,
  service: "node" | "schema",
  timeoutMs: number,
  cause: unknown,
): FbrainError {
  const which = service === "node" ? "node" : "schema service";
  return new FbrainError({
    code: "service_timeout",
    message: `${which} did not respond within ${timeoutMs}ms (${method} ${path}) ${DOCTOR_TIP}.`,
    hint: timeoutHint(service),
    cause,
  });
}

// Appended by every node + schema-service error message so non-doctor callers
// (list/put/etc.) point users at `fbrain doctor`. `doctor` itself must strip
// this back off — see stripDoctorTip below.
export const DOCTOR_TIP = "— run `fbrain doctor` for a full diagnosis";

// Strip the trailing " ${DOCTOR_TIP}." that client.ts appends to FbrainError
// messages, preserving the natural trailing period. Used inside `fbrain doctor`
// so its own output doesn't tell the user to run `fbrain doctor`.
export function stripDoctorTip(message: string): string {
  const suffix = ` ${DOCTOR_TIP}.`;
  if (message.endsWith(suffix)) {
    return message.slice(0, -suffix.length) + ".";
  }
  return message;
}

export type SchemaServiceClient = {
  baseUrl: string;
  registerSchema(req: AddSchemaRequest): Promise<{
    canonicalHash: string;
    status: number;
    replacedSchema: string | null;
  }>;
  listSchemas(): Promise<unknown>;
  getSchemaByHash(hash: string): Promise<RegisteredSchema | null>;
  rawCall(method: string, path: string, body?: unknown): Promise<RawResponse>;
};

// Supplies the verbatim base64 CapabilityToken blob attached to every write
// as `X-App-Capability`. Returns null when no capability is held (the node
// then treats the caller as NodeOwner, or — under enforcement — 403s with
// `consent_required`). Resolved per write so a re-acquired token is picked up
// without rebuilding the client.
export type CapabilityProvider = () => string | null;

// One entry of `GET /api/schemas` — a schema loaded into the node's DB.
// `identity_hash` is the canonical (owner-namespaced) hash the node computed;
// `owner_app_id` is present on app-owned schemas (e.g. `"fbrain"`).
export type LoadedSchema = {
  descriptive_name?: string;
  owner_app_id?: string;
  identity_hash?: string;
};

export type AppSchemaDeclaration = {
  app_id: string;
  schema: string;
  canonical: string;
  resolution: "mint" | "link" | string;
  decision?: string;
};

// Parsed `GET /api/health` response. `version` is the running fold_db_node's
// release string (e.g. "0.14.1"); it is OPTIONAL because an older node may not
// report one — callers that surface it (e.g. `fbrain doctor`) must tolerate its
// absence and fall back gracefully.
export type HealthResult = {
  ok: boolean;
  uptime_s?: number;
  version?: string;
};

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  // GET /api/health — the node's liveness + version probe. Returns the parsed
  // `{ ok, uptime_s, version }`; `version` is tolerated-missing (older nodes
  // omit it). Informational only — `fbrain doctor` surfaces the reported
  // version on its node-reachable line; a failure here must NOT be treated as
  // the node being down (the auto-identity probe owns that verdict).
  health(): Promise<HealthResult>;
  bootstrap(name: string): Promise<{ userHash: string }>;
  // App-identity consent handshake (app_identity v3.1). request-consent +
  // consent-status are the two app-driven steps; the owner grants out-of-band
  // via `folddb consent grant`.
  requestConsent(appId: string, scope: string): Promise<{ status: number; body: unknown }>;
  consentStatus(requestId: string): Promise<{ status: number; body: unknown }>;
  // Load published schemas into the node's DB. Pass a list of schema
  // identifiers (canonical identity hash or `descriptive_name`) to scope the
  // load to just those (fold #877) — a fresh node then pulls only the handful
  // it needs instead of the entire global catalog. Omit (or pass an empty
  // list) to load every available schema, as before. Forward-compatible: a
  // pre-#877 node ignores the scope body and full-loads.
  loadSchemas(schemas?: readonly string[]): Promise<{
    available_schemas_loaded: number;
    schemas_loaded_to_db: number;
    failed_schemas: string[];
  }>;
  // POST /api/apps/declare-schema — declare an app-owned local schema directly
  // with the node. Newer local-first nodes persist an app-schema mapping and
  // return the canonical local-mint hash without consulting schema_service.
  declareAppSchema?(appId: string, schema: AddSchemaRequest["schema"]): Promise<AppSchemaDeclaration>;
  // GET /api/schemas — the schemas currently loaded into this node's DB,
  // each carrying the authoritative `identity_hash` the node computed. Used
  // by `fbrain init` to RESOLVE an already-published `fbrain/*` schema's
  // canonical hash without a cert-gated re-POST (the fresh-consumer path).
  listLoadedSchemas(): Promise<LoadedSchema[]>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
  }): Promise<void>;
  deleteRecord(opts: { schemaHash: string; keyHash: string }): Promise<void>;
  queryAll(opts: { schemaHash: string; fields: string[] }): Promise<QueryResponse>;
  // Single bounded page — ONE /api/query round trip, no pagination loop, no
  // dedup/total_count guards. For probes and best-effort hint decoration that
  // only need a small sample of rows (projected fields, capped limit) and must
  // NEVER escalate into a full corpus fetch on a no-match path: the
  // empty-brain probe (`hasAnyLiveRecord`) and the fbrain_get nearest-slug
  // candidate scan. Real data reads keep using `queryAll` (complete, guarded)
  // or `queryByKey` (point-read). Optional so hand-built NodeClient test mocks
  // don't all have to grow it; callers fall back to `queryAll` when absent.
  queryPage?(opts: {
    schemaHash: string;
    fields: string[];
    limit: number;
  }): Promise<QueryRow[]>;
  queryByKey?(opts: {
    schemaHash: string;
    fields: string[];
    keyHash: string;
  }): Promise<QueryRow | null>;
  search(query: string, opts?: SearchOptions): Promise<NativeIndexHit[]>;
  rawCall(method: string, path: string, body?: unknown): Promise<RawResponse>;
};

export function newSchemaServiceClient(
  baseUrl: string,
  verbose: Verbose = noopVerbose,
): SchemaServiceClient {
  const url = stripTrailingSlash(baseUrl);
  return {
    baseUrl: url,
    async registerSchema(req) {
      const path = "/v1/schemas";
      const { res, readBody } = await callSchemaServiceRaw(url, path, "POST", req, verbose);
      const body = await readBody();
      if (res.status !== 200 && res.status !== 201) {
        throw mapSchemaServiceError(res, body, path);
      }
      const schemaObj =
        body && typeof body === "object"
          ? ((body as Record<string, unknown>).schema as Record<string, unknown> | undefined)
          : undefined;
      const canonicalHash =
        schemaObj && typeof schemaObj.name === "string" ? (schemaObj.name as string) : null;
      if (!canonicalHash) {
        throw new FbrainError({
          code: "schema_register_no_hash",
          message: `Schema service did not return a canonical hash for ${req.schema.descriptive_name}.`,
          hint: "Inspect the schema service response — fbrain expects `schema.name` to carry the identity hash.",
        });
      }
      const replacedSchema =
        body && typeof body === "object" && "replaced_schema" in body
          ? ((body.replaced_schema as string | null | undefined) ?? null)
          : null;
      return { canonicalHash, status: res.status, replacedSchema };
    },
    async listSchemas() {
      const { res, readBody } = await callSchemaServiceRaw(url, "/v1/schemas", "GET", undefined, verbose);
      const body = await readBody();
      if (res.status !== 200) {
        throw mapSchemaServiceError(res, body, "/v1/schemas");
      }
      return body;
    },
    async getSchemaByHash(hash) {
      const path = `/v1/schema/${encodeURIComponent(hash)}`;
      const { res, readBody } = await callSchemaServiceRaw(url, path, "GET", undefined, verbose);
      if (res.status === 404) {
        await readBody();
        return null;
      }
      const body = await readBody();
      if (res.status !== 200) {
        throw mapSchemaServiceError(res, body, path);
      }
      // Two response shapes have been observed:
      //   - {schema: {...}, system: bool}  (SchemaEnvelope, current server)
      //   - {...schema fields...}          (older or simpler responses)
      // Prefer the envelope; fall back to treating the body as the schema.
      const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      if (!obj) {
        throw new FbrainError({
          code: "schema_lookup_bad_response",
          message: `Schema service ${path} returned a non-JSON or non-object body: ${JSON.stringify(body).slice(0, 200)}`,
        });
      }
      const wrapped = obj.schema as Record<string, unknown> | undefined;
      const schemaObj = wrapped && typeof wrapped === "object" ? wrapped : obj;
      if (!schemaObj.fields && !schemaObj.field_types && !schemaObj.descriptive_name) {
        throw new FbrainError({
          code: "schema_lookup_no_schema",
          message: `Schema service ${path} returned unrecognised body: ${JSON.stringify(body).slice(0, 200)}`,
        });
      }
      return {
        name: stringProp(schemaObj, "name"),
        descriptive_name: stringProp(schemaObj, "descriptive_name"),
        schema_type: stringProp(schemaObj, "schema_type"),
        fields: Array.isArray(schemaObj.fields)
          ? (schemaObj.fields as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
        field_types:
          schemaObj.field_types && typeof schemaObj.field_types === "object"
            ? (schemaObj.field_types as Record<string, unknown>)
            : {},
        identity_hash:
          typeof schemaObj.identity_hash === "string" ? (schemaObj.identity_hash as string) : undefined,
        source: typeof schemaObj.source === "string" ? (schemaObj.source as string) : undefined,
      };
    },
    async rawCall(method, path, body) {
      const { res, readBody } = await callSchemaServiceRaw(url, path, method, body, verbose);
      const text = await readBody({ asText: true });
      const json = parseJsonSafe(text);
      return { status: res.status, headers: res.headers, body: text, json };
    },
  };
}

function stringProp(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export function newNodeClient(opts: {
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  // When set, every MUTATION (create/update/delete) attaches the returned
  // base64 capability blob as `X-App-Capability` plus a fresh `X-Capability-Ts`.
  // Reads are NOT gated (design: reads bypass capability enforcement), so the
  // provider is only consulted on the mutation path. Returning null sends no
  // capability headers (NodeOwner fallback / enforcement off).
  capability?: CapabilityProvider;
  // The canonical app id the SDK client acts as on the consent + mutation
  // paths. Defaults to "fbrain" (the only app this CLI is).
  appId?: string;
  // Path to the node's UDS control socket, used to mint the owner-session
  // pairing code (see `attestOwnerSession`). Defaults to
  // `${FOLDDB_HOME ?? ~/.folddb}/data/folddb.sock` (overridable via the
  // `FBRAIN_FOLDDB_SOCKET` env or the config `nodeSocketPath` field). When the
  // socket is absent (a non-isolation node) mint fails fast and fbrain proceeds
  // unattested, exactly as today.
  socketPath?: string;
}): NodeClient {
  const url = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const userHash = opts.userHash;
  const capability = opts.capability;
  const appId = opts.appId ?? "fbrain";
  const socketPath = defaultFolddbSocketPath(opts.socketPath);

  // Owner-session attestation (app-isolation flip, fold#739). Attest ONCE per
  // client: the first node request that needs the token resolves a shared
  // promise; subsequent requests reuse the cached token. On a node whose
  // control socket is absent this resolves to `null` and no `X-Folddb-Session`
  // header is ever attached — fbrain behaves exactly
  // as before. `invalidateSession()` clears the cache so a `transport_not_
  // attested` 403 (a restarted node dropped its in-memory session) triggers a
  // single re-pair on retry.
  let sessionTokenPromise: Promise<string | null> | null = null;
  const sessionToken = (): Promise<string | null> => {
    if (sessionTokenPromise === null) {
      sessionTokenPromise = attestOwnerSession(socketPath, verbose);
    }
    return sessionTokenPromise;
  };
  const invalidateSession = (): void => {
    sessionTokenPromise = null;
  };
  // Build the X-Folddb-Session header for the next request, omitting it when
  // unattested (token null). Resolved per request so a re-pair after a 403 is
  // picked up without rebuilding the client.
  const sessionHeader = async (): Promise<Record<string, string>> => {
    const token = await sessionToken();
    return token ? { [FOLDDB_SESSION_HEADER]: token } : {};
  };

  // The SDK transport carries X-User-Hash on every request (the production
  // node's HTTP server is stateless — identity comes from the header; gap #1,
  // fold_dev_node #127). One transport is shared by every SDK client this
  // node client mints. It is a fetch-backed implementation of the SDK's
  // Transport seam rather than the SDK's node:http default, so fbrain keeps
  // exactly one HTTP stack: the same global `fetch` every other node call
  // uses (and the same one the unit suite stubs to capture outgoing
  // requests — the SDK's node:http transport would bypass that stub and leak
  // test traffic onto real sockets).
  //
  // The session header is injected dynamically (a per-request supplier) so the
  // owner-session token attaches to the SDK's consent/mutation calls too, and
  // an invalidation-after-403 re-pair is reflected without rebuilding the
  // transport.
  const sdkTransport = fetchTransport(url, { "X-User-Hash": userHash }, sessionHeader, socketPath);

  // SDK clients constructed here never use the SDK's capability store —
  // fbrain's CapabilitySession owns acquisition/storage (via keychain.ts) and
  // hands the current blob in per call. A no-op store keeps the SDK from ever
  // touching a real keychain on this path.
  const sdkStore: SdkCapabilityStore = {
    async store() {},
    async load() {
      return null;
    },
    async remove() {},
  };

  // A fresh, cheap SDK client per call: construction is pure object wiring
  // (no IO), and per-call construction is how the per-write capability blob
  // (re-acquired mid-session by CapabilitySession) stays current.
  const sdkClient = (blob: string | null, forAppId: string = appId): LastDbClient =>
    new LastDbClient(
      forAppId,
      sdkTransport,
      sdkStore,
      blob,
      safeStoreKey(forAppId, sdkTransport.target),
      sdkTransport.target,
    );

  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> => {
    const send = async (): Promise<{ status: number; body: unknown }> => {
      const headers = { ...(extraHeaders ?? {}), ...(await sessionHeader()) };
      const { res, readBody } = await callNodeRaw(url, path, method, body, userHash, verbose, headers, socketPath);
      const parsed = await readBody();
      return { status: res.status, body: parsed };
    };
    const first = await send();
    // Re-pair once on a stale-session 403. A restarted node drops its in-memory
    // session token, so a request that was attested moments ago now returns
    // `403 {"error":"transport_not_attested"}`. Invalidate the cached token and
    // retry exactly once; if we were unattested to begin with (no socket → null
    // token), re-pair yields null again and the 403 surfaces unchanged.
    if (first.status === 403 && bodyError(first.body) === TRANSPORT_NOT_ATTESTED) {
      verbose(`← NODE ${method} ${path} 403 transport_not_attested — re-pairing once`);
      invalidateSession();
      return send();
    }
    return first;
  };

  // Common 200-or-throw wrapper around `callJson`. Endpoints that branch on
  // specific non-200 statuses (autoIdentity 503, bootstrap 410) and `rawCall`
  // stay on `callJson` directly; `search` also stays on `callJson` so its
  // error tag can intentionally strip the query string from the path. The
  // consent endpoints (requestConsent / consentStatus) and mutations ride the
  // SDK client above instead.
  const callJsonOk = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> => {
    const { status, body: parsed } = await callJson(path, method, body, extraHeaders);
    if (status !== 200) throw mapNodeError(status, parsed, path);
    return parsed;
  };

  // Run an SDK-backed node call, re-pairing the owner session once if it 403s
  // with `transport_not_attested`. Mirrors the raw-path retry in `callJson`:
  // the SDK surfaces a stale-session 403 as a typed PermissionDenied/Unexpected
  // error whose reason/body carries `transport_not_attested`. On match we
  // invalidate the cached token (so the next `sessionHeader()` re-mints) and
  // retry the thunk exactly once; everything else propagates untouched.
  const withSessionRepair = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isTransportNotAttested(err)) {
        verbose("SDK call 403 transport_not_attested — re-pairing once");
        invalidateSession();
        return fn();
      }
      throw err;
    }
  };

  // App-identity v3.1: the mutation rides the SDK client, which attaches the
  // verbatim base64 capability blob plus a fresh unix-epoch-seconds timestamp
  // (`X-App-Capability` + `X-Capability-Ts`) on every call. The timestamp is
  // recomputed per call so a token cached for hours still lands inside the
  // node's ±60s replay window. No capability provider, or a provider
  // returning null, sends neither header — the node treats the caller as
  // NodeOwner (or, under enforcement, 403s with `consent_required`). The
  // provider is resolved per write so a CapabilitySession re-acquire is
  // picked up without rebuilding the client.
  const mutate = async (
    kind: "create" | "update" | "delete",
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
  ): Promise<void> => {
    const blob = capability?.() ?? null;
    verbose(`→ NODE POST /api/mutation (sdk) schema=${schemaHash} type=${kind}`);
    try {
      await withSessionRepair(() =>
        sdkClient(blob).mutate(schemaHash, {
          mutationType: kind,
          fields: fields as Record<string, SdkJsonValue>,
          key: { hash: keyHash, range: null },
        }),
      );
      verbose(`← NODE POST /api/mutation status=200`);
    } catch (err) {
      throw mapSdkDataError(err, url, "POST", "/api/mutation", socketPath);
    }
  };

  const queryPageSdk = async (
    schemaHash: string,
    filter: SdkQueryFilter,
  ): Promise<SdkQueryResult> => {
    try {
      return await withSessionRepair(() => sdkClient(null).query(schemaHash, filter));
    } catch (err) {
      throw mapSdkDataError(err, url, "POST", "/api/query", socketPath);
    }
  };

  const queryAllGuarded = async ({
    schemaHash,
    fields,
  }: {
    schemaHash: string;
    fields: string[];
  }): Promise<QueryResponse> => {
    // The node's /api/query handler silently defaults to limit=100
    // (`DEFAULT_QUERY_LIMIT` in fold_db_node/src/handlers/query.rs) and
    // does NOT support a body-side tag/status filter — so any caller
    // that wants to filter by a record field has to fetch everything
    // and filter in-memory. We paginate up to QUERY_PAGE_SIZE rows per
    // request and stop once the node reports `has_more: false`.
    //
    // CLIENT-SIDE GUARDS — fold_db_node's offset pagination is broken
    // (handler `fold_db_node/src/handlers/query.rs`: `.skip(offset)
    // .take(limit)` over an unstably-ordered result set). Verified
    // 2026-05-30: paging a 177-row schema by 100 returns 177 rows but
    // only 134 unique — ~43 dups + ~43 silently dropped. fbrain is
    // safe today only because QUERY_PAGE_SIZE (1000) exceeds every
    // current schema's row count, so the second page is never
    // requested. To stay safe once any schema grows past the page
    // size, we never trust offset-paged results blindly:
    //   1. Dedupe rows by record key across pages — so a stable-
    //      ordering future node fix transparently keeps working,
    //      and an unstable node can never inflate the set with
    //      duplicates.
    //   2. If a follow-up page returns ONLY already-seen keys but
    //      claims has_more=true, throw — pagination is stalled
    //      mid-table and looping further would either spin to the
    //      QUERY_PAGE_LIMIT cap or return a silently-truncated set.
    //   3. After the loop terminates (has_more=false), if the
    //      node's own total_count is greater than our deduped row
    //      count, throw — the node dropped rows we cannot recover.
    // The proper root-cause fix lives in fold_db_node/query.rs
    // (stable ordering); this guard lets fbrain land independently.
    const allResults: QueryRow[] = [];
    const seenKeys = new Set<string>();
    let offset = 0;
    let lastTotalCount: number | null = null;
    for (let page = 0; page < QUERY_PAGE_LIMIT; page++) {
      const pageResult = await queryPageSdk(schemaHash, {
        fields,
        limit: QUERY_PAGE_SIZE,
        offset,
      });
      const pageResults = fromSdkRows(pageResult.rows);
      if (pageResult.page !== null) lastTotalCount = pageResult.page.totalCount;
      let newOnPage = 0;
      for (const row of pageResults) {
        const k = recordDedupKey(row);
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        allResults.push(row);
        newOnPage++;
      }
      // Stop on explicit `has_more: false`. Absent `has_more` (older
      // node, or a stub) is treated as "done" — a single non-paginated
      // response is then equivalent to the pre-pagination contract.
      const hasMore = pageResult.page?.hasMore === true;
      if (!hasMore) break;
      if (newOnPage === 0) {
        throw new FbrainError({
          code: "query_pagination_stalled",
          message:
            `Node /api/query returned page ${page + 1} at offset=${offset} ` +
            `with only previously-seen record keys but reported has_more=true ` +
            `(total_count=${lastTotalCount ?? "?"}) — the node is counting ` +
            `deleted/tombstoned record keys in total_count but omitting them from ` +
            `the materialized page, so has_more never clears and pagination cannot ` +
            `progress ${DOCTOR_TIP}.`,
          hint:
            "Upgrade the fold_db_node to a build with the tombstone-aware " +
            "list-query count fix (fold #995). This affects only the record type " +
            "you deleted from; other record types still work.",
        });
      }
      // Defensive: a node that returns has_more=true with an empty
      // results array would spin without progress. The stalled-page
      // guard above already covers this (0 new keys), but keep an
      // explicit break for clarity and so the throw above can only
      // ever fire on a real overlap.
      if (pageResults.length === 0) break;
      offset += pageResults.length;
    }
    if (lastTotalCount !== null && allResults.length < lastTotalCount) {
      throw new FbrainError({
        code: "query_pagination_incomplete",
        message:
          `Node /api/query finished with has_more=false but only ${allResults.length} ` +
          `unique records were collected across pages — the node's reported total_count ` +
          `was ${lastTotalCount}. This means total_count includes record keys the node ` +
          `never returned in any page: either deleted/tombstoned keys counted in the ` +
          `total, or rows silently dropped by unstable offset pagination on a schema ` +
          `larger than QUERY_PAGE_SIZE (${QUERY_PAGE_SIZE}) ${DOCTOR_TIP}.`,
        hint:
          "Upgrade the fold_db_node to a build with the tombstone-aware list-query " +
          "count fix (fold #995) and stable /api/query ordering. If the gap matches " +
          "records you recently deleted, only that record type is affected; other " +
          "types still work.",
      });
    }
    return {
      ok: true,
      results: allResults,
      total_count: lastTotalCount ?? allResults.length,
      returned_count: allResults.length,
    };
  };

  return {
    baseUrl: url,
    userHash,
    async autoIdentity() {
      const { status, body } = await callJson("/api/system/auto-identity", "GET");
      if (status === 200) {
        const uh = body && typeof body === "object" ? (body as Record<string, unknown>).user_hash : undefined;
        return {
          provisioned: true,
          userHash: typeof uh === "string" ? uh : userHash,
        };
      }
      if (status === 503) {
        return {
          provisioned: false,
          reason: bodyError(body) ?? "node_not_provisioned",
        };
      }
      throw mapNodeError(status, body, "/api/system/auto-identity");
    },
    async health() {
      // GET /api/health → `{ ok, uptime_s, version }`. The node reports its
      // release string here (`fbrain doctor` surfaces it on node-reachable).
      // `version` (and `uptime_s`) are read defensively: an older node may omit
      // either, so each is only carried through when it's the expected type.
      const { status, body } = await callJson("/api/health", "GET");
      if (status !== 200) throw mapNodeError(status, body, "/api/health");
      const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const result: HealthResult = { ok: b.ok === true };
      if (typeof b.uptime_s === "number") result.uptime_s = b.uptime_s;
      if (typeof b.version === "string" && b.version.length > 0) result.version = b.version;
      return result;
    },
    async bootstrap(name) {
      const { status, body } = await callJson("/api/setup/bootstrap", "POST", { name });
      if (status === 200) {
        const uh = body && typeof body === "object" ? (body as Record<string, unknown>).user_hash : undefined;
        if (typeof uh !== "string" || uh.length === 0) {
          throw new FbrainError({
            code: "bootstrap_no_user_hash",
            message: "Bootstrap succeeded but the node did not return a user_hash.",
            hint: "Inspect the response from POST /api/setup/bootstrap.",
          });
        }
        return { userHash: uh };
      }
      if (status === 410) {
        // The node and auto-identity disagree: auto-identity says
        // "not provisioned", bootstrap says "already provisioned". Surface
        // the node's own message field (typically a pointer to
        // POST /api/auth/restore) — the caller (init.ts) decides whether
        // to recover from an existing ~/.fbrain/config.json or rethrow.
        const nodeMsg = bodyMessage(body);
        throw new FbrainError({
          code: "onboarding_already_complete",
          message:
            `Node rejected POST /api/setup/bootstrap with 410 — already provisioned` +
            (nodeMsg ? `: ${nodeMsg}` : ".") +
            ` (auto-identity simultaneously reports the node as not provisioned — a contradictory state from the daemon).`,
          hint:
            "Recovery: (a) if ~/.fbrain/config.json from this node still exists, re-run `fbrain init` so it reuses the saved userHash; " +
            "(b) follow the node's own instruction above (typically `POST /api/auth/restore` with the recovery phrase); " +
            "(c) to start fresh, stop the daemon and clear its onboarding state " +
            `(homebrew default: \`rm -rf ${onboardingResetConfigDir()}\`), then re-run \`fbrain init\`.`,
        });
      }
      throw mapNodeError(status, body, "/api/setup/bootstrap");
    },
    async requestConsent(consentAppId, scope) {
      // Rides the SDK client's consent flow, translated back to the raw
      // {status, body} contract the capability layer (and `fbrain doctor`'s
      // write-ready probe) branches on — 202 / 404 / 403 / 400 per the
      // consent contract.
      verbose(`→ NODE POST /api/apps/request-consent (sdk) app=${consentAppId} scope=${scope}`);
      try {
        const r = await withSessionRepair(() =>
          sdkClient(null, consentAppId).requestConsent(parseScope(scope)),
        );
        verbose(`← NODE POST /api/apps/request-consent status=202`);
        return {
          status: 202,
          body: { request_id: r.requestId, expires_at: r.expiresAt },
        };
      } catch (err) {
        if (err instanceof UnknownAppError) {
          return { status: 404, body: { error: err.message, app_id: consentAppId } };
        }
        if (err instanceof AppInSandboxError) {
          return {
            status: 403,
            body: { reason: "app_in_sandbox", app_id: consentAppId, error: err.message },
          };
        }
        if (err instanceof InvalidScopeError) {
          return { status: 400, body: { error: err.message } };
        }
        if (err instanceof UnexpectedResponseError) {
          return { status: err.status, body: err.body };
        }
        if (err instanceof TransportError) {
          throw connectionError(url, "node", err, {
            socketPath,
            routeSocket: localNodeRouteSocket(
              "node",
              "POST",
              "/api/apps/request-consent",
              url,
              socketPath,
            ),
            socketCause: err,
          });
        }
        throw err;
      }
    },
    async consentStatus(requestId) {
      // One SDK consent-status poll, translated back to the raw {status,
      // body} shapes the node serves (200 granted / 202 pending / 403
      // denied|revoked / 408 expired / 404 unknown).
      try {
        const blob = await withSessionRepair(() => sdkClient(null).pollConsentOnce(requestId));
        if (blob === null) return { status: 202, body: { status: "pending" } };
        return { status: 200, body: { status: "granted", capability: blob } };
      } catch (err) {
        if (err instanceof CapabilityRevokedError) {
          return { status: 403, body: { status: "revoked" } };
        }
        if (err instanceof ConsentDeniedError) {
          return { status: 403, body: { status: "denied" } };
        }
        if (err instanceof ConsentExpiredError) {
          return { status: 408, body: { status: "expired" } };
        }
        if (err instanceof ConsentRequestNotFoundError) {
          return { status: 404, body: { status: "unknown" } };
        }
        if (err instanceof UnexpectedResponseError) {
          return { status: err.status, body: err.body };
        }
        if (err instanceof TransportError) {
          throw connectionError(url, "node", err, {
            socketPath,
            routeSocket: localNodeRouteSocket(
              "node",
              "GET",
              "/api/apps/consent-status",
              url,
              socketPath,
            ),
            socketCause: err,
          });
        }
        throw err;
      }
    },
    async loadSchemas(schemas) {
      // Scope the load to just the named schemas when a non-empty list is
      // given (fold #877): each entry is a canonical identity hash or a
      // `descriptive_name` (matching is lenient on whitespace/case). An empty
      // list — or none at all — sends no body, so the node loads the full
      // published catalog, exactly as before. This is forward-compatible: a
      // pre-#877 node ignores the body and full-loads either way.
      const scope = (schemas ?? []).filter((s) => typeof s === "string" && s.length > 0);
      const reqBody = scope.length > 0 ? { schemas: scope } : undefined;
      const body = await callJsonOk("/api/schemas/load", "POST", reqBody);
      const b = body as Record<string, unknown>;
      const failed = Array.isArray(b.failed_schemas) ? (b.failed_schemas as string[]) : [];
      return {
        available_schemas_loaded: numField(b, "available_schemas_loaded"),
        schemas_loaded_to_db: numField(b, "schemas_loaded_to_db"),
        failed_schemas: failed,
      };
    },
    async declareAppSchema(appId, schema) {
      const body = await callJsonOk("/api/apps/declare-schema", "POST", {
        app_id: appId,
        schema,
      });
      const b = body as Record<string, unknown>;
      const canonical = typeof b.canonical === "string" ? b.canonical : "";
      const schemaName = typeof b.schema === "string" ? b.schema : "";
      const resolution = typeof b.resolution === "string" ? b.resolution : "";
      if (!canonical || !schemaName || !resolution) {
        throw new FbrainError({
          code: "app_schema_declare_bad_response",
          message: `Node /api/apps/declare-schema returned an incomplete response: ${JSON.stringify(body).slice(0, 300)}.`,
          hint: "Upgrade the node or inspect the app-schema declaration response.",
        });
      }
      return {
        app_id: typeof b.app_id === "string" ? b.app_id : appId,
        schema: schemaName,
        canonical,
        resolution,
        decision: typeof b.decision === "string" ? b.decision : undefined,
      };
    },
    async listLoadedSchemas() {
      const body = await callJsonOk("/api/schemas", "GET");
      const arr =
        body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).schemas)
          ? ((body as Record<string, unknown>).schemas as unknown[])
          : [];
      return arr
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          descriptive_name:
            typeof s.descriptive_name === "string" ? s.descriptive_name : undefined,
          owner_app_id: typeof s.owner_app_id === "string" ? s.owner_app_id : undefined,
          identity_hash: typeof s.identity_hash === "string" ? s.identity_hash : undefined,
        }));
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await mutate("create", schemaHash, fields, keyHash);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await mutate("update", schemaHash, fields, keyHash);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      // Empty fields_and_values is the minimal body — see
      // docs/phase-5-delete-spike.md, Probe B. The orchestrator's earlier
      // smoketest passed `{slug: keyHash}` which has the side-effect of
      // writing a no-op atom rewriting the slug field with itself.
      await mutate("delete", schemaHash, {}, keyHash);
    },
    async queryAll({ schemaHash, fields }) {
      return queryAllGuarded({ schemaHash, fields });
    },
    async queryPage({ schemaHash, fields, limit }) {
      // One page, first offset, caller-capped limit. Intentionally no
      // has_more follow-up and none of queryAll's pagination guards — the
      // contract is "a small sample, one round trip", and the two callers
      // (empty-brain probe, nearest-slug hint scan) are explicitly
      // best-effort over whatever the first page holds.
      const page = await queryPageSdk(schemaHash, {
        fields,
        limit,
        offset: 0,
      });
      return fromSdkRows(page.rows);
    },
    async queryByKey({ schemaHash, fields, keyHash }) {
      const page = await queryPageSdk(schemaHash, {
        fields,
        filter: { HashKey: keyHash },
        limit: QUERY_PAGE_SIZE,
        offset: 0,
      });
      const results = fromSdkRows(page.rows);
      const row = findQueryRowByKey(results, keyHash);
      if (row) return row;
      if (queryByKeyFilterLooksIgnored(page, results)) {
        const fallback = await queryAllGuarded({ schemaHash, fields });
        return findQueryRowByKey(fallback.results, keyHash);
      }
      return null;
    },
    async search(query, searchOpts) {
      const schemaTargets = uniqueStrings(searchOpts?.schemas ?? []);
      try {
        const client = sdkClient(capability?.() ?? null);
        const targetResults =
          schemaTargets.length === 0
            ? [await withSessionRepair(() => client.search(query, { k: 50 }))]
            : await Promise.all(
                schemaTargets.map((target) =>
                  withSessionRepair(() => client.search(query, { k: 50, target })),
                ),
              );
        return sdkSearchHitsToNative(
          targetResults.flatMap((result) => result.hits),
          searchOpts,
          query,
          schemaTargets,
        );
      } catch (err) {
        if (
          err instanceof UnexpectedResponseError &&
          err.status === 404 &&
          searchOpts?.localFallback !== false
        ) {
          verbose(
            "app search endpoint missing; falling back to local keyword search over SDK query",
          );
          return localSearchFallback(query, searchOpts, queryPageSdk, verbose);
        }
        if (searchOpts?.localFallback !== false && isSdkMissingAppSearch(err)) {
          verbose(
            "app search endpoint missing; falling back to local keyword search over SDK query",
          );
          return localSearchFallback(query, searchOpts, queryPageSdk, verbose);
        }
        throw mapSdkDataError(err, url, "POST", "/api/app/search", socketPath);
      }
    },
    async rawCall(method, path, body) {
      const { res, readBody } = await callNodeRaw(url, path, method, body, userHash, verbose, await sessionHeader(), socketPath);
      const text = await readBody({ asText: true });
      const json = parseJsonSafe(text);
      return { status: res.status, headers: res.headers, body: text, json };
    },
  };
}

function sdkSearchHitsToNative(
  hits: SdkSearchHit[],
  searchOpts: SearchOptions | undefined,
  query: string,
  schemaTargets: string[],
): NativeIndexHit[] {
  const targetSet = schemaTargets.length > 0 ? new Set(schemaTargets) : null;
  const minScore = searchOpts?.minScore;
  const exactNeedle = searchOpts?.exact ? query.toLowerCase() : null;
  return hits.flatMap((hit): NativeIndexHit[] => {
    if (targetSet && !targetSet.has(hit.schemaName)) return [];
    const text = searchHitText(hit);
    if (exactNeedle && !text.toLowerCase().includes(exactNeedle)) return [];
    const score = hit.score ?? undefined;
    if (typeof minScore === "number" && (score === undefined || score < minScore)) {
      return [];
    }
    return [{
      schema_name: hit.schemaName,
      schema_display_name: hit.schemaDisplayName,
      field: "body",
      key_value: sdkKeyToFbrainKey(hit.keyValue, hit.key),
      value: text,
      metadata: {
        score,
        match_type: "app_scoped_search",
      },
    }];
  });
}

function searchHitText(hit: SdkSearchHit): string {
  const title = typeof hit.fields.title === "string" ? hit.fields.title : "";
  const body = typeof hit.fields.body === "string" ? hit.fields.body : "";
  const value = [title, body].filter((s) => s.length > 0).join("\n").trim();
  return value.length > 0 ? value : JSON.stringify(hit.fields);
}

function isSdkMissingAppSearch(err: unknown): boolean {
  return err instanceof FbrainError && err.code === "node_http_404";
}

function fromSdkRows(rows: readonly SdkQueryRow[]): QueryRow[] {
  return rows.map((row) => ({
    fields: row.fields as Record<string, unknown>,
    key: sdkKeyToFbrainKey(row.keyValue, row.key),
    author_pub_key: row.authorPubKey ?? undefined,
  }));
}

function sdkKeyToFbrainKey(
  keyValue: SdkKeyValue | null,
  renderedKey: string,
): { hash: string | null; range: string | null } {
  if (keyValue !== null) {
    return { hash: keyValue.hash, range: keyValue.range };
  }
  return { hash: renderedKey.length > 0 ? renderedKey : null, range: null };
}

async function localSearchFallback(
  query: string,
  searchOpts: SearchOptions | undefined,
  queryPage: (
    schemaHash: string,
    filter: SdkQueryFilter,
  ) => Promise<SdkQueryResult>,
  verbose: Verbose,
): Promise<NativeIndexHit[]> {
  const schemas = uniqueStrings(searchOpts?.schemas ?? []);
  if (schemas.length === 0) {
    verbose("local search fallback: no schema scope supplied; returning no hits");
    return [];
  }

  const docs: LocalSearchDoc[] = [];
  for (const schemaName of schemas) {
    const page = await queryPage(schemaName, {
      fields: LOCAL_SEARCH_FIELDS,
      limit: QUERY_PAGE_SIZE,
      offset: 0,
    });
    for (const row of fromSdkRows(page.rows)) {
      const fields = row.fields ?? {};
      const title = stringValue(fields.title);
      const bodyText = stringValue(fields.body);
      if (stringValue(fields.status) === "deleted") continue;
      const key = row.key ?? { hash: stringValue(fields.slug) || null, range: null };
      if (!key.hash) continue;
      const text = `${title}\n${bodyText}\n${arrayText(fields.tags)}`;
      if (searchOpts?.exact && !text.toLowerCase().includes(query.toLowerCase())) {
        continue;
      }
      const score = localTextScore(query, text);
      if (score <= 0) continue;
      docs.push({ schemaName, key, title, body: bodyText, score });
    }
  }

  if (docs.length === 0) return [];
  const topScore = Math.max(...docs.map((d) => d.score));
  return docs
    .map((d) => ({ ...d, score: topScore > 0 ? d.score / topScore : d.score }))
    .filter((d) => searchOpts?.minScore === undefined || d.score >= searchOpts.minScore)
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.schemaName}:${a.key.hash}`.localeCompare(`${b.schemaName}:${b.key.hash}`),
    )
    .slice(0, 50)
    .map((d): NativeIndexHit => ({
      schema_name: d.schemaName,
      schema_display_name: null,
      field: "body",
      key_value: d.key,
      value: `${d.title}\n${d.body}`.trim(),
      metadata: {
        score: d.score,
        match_type: "local_keyword_fallback",
      },
    }));
}

function localTextScore(query: string, text: string): number {
  const queryTerms = tokenizeForLocalSearch(query);
  if (queryTerms.length === 0) return 0;
  const haystack = tokenizeForLocalSearch(text);
  if (haystack.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const token of haystack) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  let score = 0;
  for (const term of new Set(queryTerms)) {
    const count = frequencies.get(term) ?? 0;
    if (count > 0) score += 1 + Math.log(count);
  }
  return score;
}

function tokenizeForLocalSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((s) => s.length >= 2);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((s) => typeof s === "string" && s.length > 0)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").join(" ")
    : "";
}

// Thin convenience wrapper mirroring `newWriteClientFromCfg`: every plain
// read call site (`ask`, `get`, `list`, `search`, `raw`) was spelling out
// the same `{ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose }`
// literal verbatim. Collapse that boilerplate so call sites read as "open
// a read client from this config" in one line. Callers that need to set
// `capability` (init-consent's null-provider transport) or use a non-cfg
// `userHash` (init's pre-bootstrap probe) still reach for `newNodeClient`
// directly.
export function newReadClientFromCfg(cfg: Config, verbose?: Verbose): NodeClient {
  const opts: Parameters<typeof newNodeClient>[0] = {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
  };
  if (verbose !== undefined) opts.verbose = verbose;
  if (cfg.nodeSocketPath !== undefined) opts.socketPath = cfg.nodeSocketPath;
  return newNodeClient(opts);
}

// String identity for a QueryRow's record key, used by queryAll to
// dedupe across pages. fold_db keys are either hash-typed (range null)
// or range-typed (hash null); either field alone is not unique across
// schemas with mixed keys, so we combine both with a separator that
// cannot appear in a hex hash or range string.
function recordDedupKey(row: QueryRow): string {
  const key = row.key;
  if (!key || typeof key !== "object") {
    // No key at all — fall back to JSON of the fields so rows still
    // dedupe deterministically. A node returning rows with no key is
    // already broken, but the dedupe contract must still hold.
    return `__no_key__|${JSON.stringify(row.fields ?? null)}`;
  }
  return `h:${key.hash ?? ""}|r:${key.range ?? ""}`;
}

function findQueryRowByKey(rows: QueryRow[], keyHash: string): QueryRow | null {
  for (const row of rows) {
    if (row.key?.hash === keyHash) return row;
  }
  for (const row of rows) {
    const f = (row.fields ?? {}) as Record<string, unknown>;
    if (f.slug === keyHash) return row;
  }
  return null;
}

function queryByKeyFilterLooksIgnored(body: SdkQueryResult, results: QueryRow[]): boolean {
  if (body.page?.hasMore === true) return true;
  if (results.length > 1) return true;
  return body.page !== null && body.page.totalCount > results.length;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" ? v : 0;
}

function bodyError(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return undefined;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function callNodeRaw(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  userHash: string,
  verbose: Verbose,
  extraHeaders?: Record<string, string>,
  socketPath?: string,
): Promise<BoundedResponse> {
  return verboseFetch({
    baseUrl,
    path,
    method,
    body,
    verbose,
    service: "node",
    headers: { "X-User-Hash": userHash, ...(extraHeaders ?? {}) },
    socketPath,
  });
}

async function callSchemaServiceRaw(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  verbose: Verbose,
): Promise<BoundedResponse> {
  return verboseFetch({ baseUrl, path, method, body, verbose, service: "schema", headers: {} });
}

// The result of a bounded request: the response headers, plus a `readBody`
// closure that drains the body UNDER THE SAME DEADLINE as the fetch. The node
// returns headers as soon as it accepts the request, then can stall for the
// whole cold-schema-init window while streaming the body; a plain
// `await res.text()` after the fetch is NOT covered by the fetch's own abort,
// so that stall used to hang the CLI unbounded. One abort signal governs
// both halves, and the timer is cleared the instant the body is fully read.
type ReadBody = {
  (opts: { asText: true }): Promise<string>;
  (opts?: { asText?: false }): Promise<unknown>;
};

type BoundedResponse = {
  res: Response;
  readBody: ReadBody;
};

// The node's data Unix-domain socket serves a small data-plane allowlist: read
// query, write mutation, schema listing, `/api/health`, the node-identity probe,
// and the native-index semantic search. Current nodes also expose
// `folddb-full.sock` beside it, and that socket serves the whole HTTP surface
// (owner/control routes included). Route selection mirrors the node client's
// socket_for(method, path): data-plane routes use `folddb.sock`; every other
// loopback-node route uses `folddb-full.sock` when present, else the collapsed
// control socket. Non-loopback node URLs never use the local socket.
//
// This MUST stay in lockstep with the node's data-socket route table. Adding a
// path here without the node also serving it on the data socket would dial the
// socket and get a 404; the inverse leaves a data route needlessly dependent on
// the full socket path.
const NODE_DATA_PLANE_ROUTES = {
  GET: [
    "/api/health",
    "/api/schemas",
    "/api/system/auto-identity",
    "/api/native-index/search",
  ],
  POST: ["/api/query", "/api/mutation"],
} as const;

// Compare the request path WITHOUT its `?query`/`#fragment` against the
// allowlist, mirroring the node router's `path_only`. Several data-plane
// routes are GETs that carry a query string (`/api/native-index/search?q=...`,
// `/api/schemas?include_system=true`); matching the full path-with-query
// against the allowlist would never hit, so a GET-with-query route could never
// select the socket and would always fall through to the retired TCP port.
function pathOnly(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

function isNodeDataPlaneRoute(method: string, path: string): boolean {
  const routes =
    NODE_DATA_PLANE_ROUTES[method.toUpperCase() as keyof typeof NODE_DATA_PLANE_ROUTES];
  return routes === undefined ? false : (routes as readonly string[]).includes(pathOnly(path));
}

type NodeSocketSelection = {
  socketPath: string;
  kind: "data" | "full";
};

type ConnectionErrorContext = {
  socketPath?: string;
  routeSocket?: NodeSocketSelection | null;
  socketCause?: unknown;
  phase?: "fetch" | "body";
};

// A LOCAL node speaks ONLY over its Unix socket — the loopback TCP listener is
// retired (fold `fold-retire-tcp-listener`), so there is NO TCP fallback. When
// the node URL is loopback and a socket path is configured, this returns the
// route's socket UNCONDITIONALLY (data-plane → the control socket; every other
// node route → `folddb-full.sock` when a pre-collapse node exposes it, else the
// control socket per fold #1246's collapse) EVEN WHEN the socket file is absent:
// if the node is down the connect simply fails and the caller maps it to a clear
// node-not-running diagnostic instead of silently dialing the retired `:9001`.
// Returns null when the node isn't a local-socket target (remote node, schema
// service, or no socket configured), leaving the caller on plain HTTP.
export function localNodeRouteSocket(
  service: "node" | "schema",
  method: string,
  path: string,
  baseUrl: string,
  socketPath?: string,
): NodeSocketSelection | null {
  const localNodeSocketOnly =
    service === "node" &&
    isLoopbackNodeUrl(baseUrl) &&
    socketPath !== undefined &&
    socketPath.length > 0;
  if (!localNodeSocketOnly) return null;
  if (isNodeDataPlaneRoute(method, path)) {
    return { socketPath: socketPath as string, kind: "data" };
  }
  return {
    // fold #1246 collapsed `folddb-full.sock` into the control socket, so
    // `discoverFullSurfaceSocket` returns the separate sibling when a
    // pre-collapse node exposes it, else the control socket itself. The
    // `?? socketPath` keeps the unconditional socket-only contract (never dial
    // TCP) even in the impossible undefined case.
    socketPath: discoverFullSurfaceSocket(socketPath as string) ?? (socketPath as string),
    kind: "full",
  };
}

type BoundedFetchFailureContext = ConnectionErrorContext;

class BoundedFetchFailure extends Error {
  override readonly cause: unknown;
  readonly failureCtx: BoundedFetchFailureContext;
  readonly timeout: boolean;

  constructor(cause: unknown, failureCtx: BoundedFetchFailureContext) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BoundedFetchFailure";
    this.cause = cause;
    this.failureCtx = failureCtx;
    this.timeout = isTimeoutError(cause);
  }
}

class FbrainTransportError extends TransportError {
  readonly failureCtx: BoundedFetchFailureContext;

  constructor(message: string, failureCtx: BoundedFetchFailureContext) {
    super(message);
    this.failureCtx = failureCtx;
  }
}

type BoundedFetchResult = {
  status: number;
  headers: Headers;
  text: string;
  failureCtx: BoundedFetchFailureContext;
};

async function boundedNodeFetch(opts: {
  baseUrl: string;
  path: string;
  method: string;
  body?: string;
  verbose?: Verbose;
  service: "node" | "schema";
  headers: Record<string, string>;
  socketPath?: string;
  timeoutMs: number;
  routeSocket?: NodeSocketSelection | null;
}): Promise<BoundedFetchResult> {
  const tcpUrl = `${opts.baseUrl}${opts.path}`;
  const tag = opts.service === "node" ? "NODE" : "SCHEMA";
  const headers = { ...opts.headers };
  const bodyBytes = Buffer.byteLength(opts.body ?? "");
  const localRouteSocket =
    opts.routeSocket !== undefined
      ? opts.routeSocket
      : localNodeRouteSocket(opts.service, opts.method, opts.path, opts.baseUrl, opts.socketPath);
  const preflightTarget = localRouteSocket
    ? `${opts.path} [${localRouteSocket.kind} socket selected]`
    : tcpUrl;
  opts.verbose?.(
    `→ ${tag} ${opts.method} ${preflightTarget}` +
      (opts.body !== undefined ? ` bodyBytes=${bodyBytes}` : ""),
  );

  // One controller for the whole request lifecycle (headers + body). This core
  // reads the body before returning, so the timer is always cleared in this
  // function even when a wrapper never asks to parse the response.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
  }, opts.timeoutMs);

  const attempt = async (socket: NodeSocketSelection | null): Promise<Response> => {
    const url = socket ? `http://localhost${opts.path}` : tcpUrl;
    const transport = socket ? `unix:${socket.socketPath} (${socket.kind})` : "tcp";
    opts.verbose?.(
      `→ ${tag} ${opts.method} ${url} [${transport}]` +
        (opts.body !== undefined ? ` bodyBytes=${bodyBytes}` : ""),
    );
    const init: RequestInit & { unix?: string } = {
      method: opts.method,
      headers,
      body: opts.body,
      signal: controller.signal,
    };
    if (socket) init.unix = socket.socketPath;
    const r = await fetch(url, init);
    opts.verbose?.(`← ${tag} ${opts.method} ${url} [${transport}] status=${r.status}`);
    return r;
  };

  let res: Response;
  const failureCtx: BoundedFetchFailureContext = {
    socketPath: opts.socketPath,
    routeSocket: localRouteSocket,
  };
  try {
    if (localRouteSocket) {
      // Loopback node URL: socket-only, never the retired TCP port.
      try {
        res = await attempt(localRouteSocket);
      } catch (socketErr) {
        failureCtx.socketCause = socketErr;
        failureCtx.phase = "fetch";
        throw socketErr;
      }
    } else {
      // Schema service (HTTPS Lambda) and any non-loopback target: plain HTTP.
      res = await attempt(null);
    }
    try {
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, failureCtx };
    } catch (err) {
      if (localRouteSocket) {
        failureCtx.socketCause = err;
        failureCtx.phase = "body";
      }
      throw err;
    }
  } catch (err) {
    throw new BoundedFetchFailure(err, failureCtx);
  } finally {
    clearTimeout(timer);
  }
}

// Shared inner fetch for both service clients. Differs only by the verbose
// log tag (NODE vs SCHEMA), the service-specific headers passed in (the node
// always sends X-User-Hash), and the connectionError service param. Same
// shape and intent as the per-flag helpers in PRs #87/#88/#89/#97.
async function verboseFetch(opts: {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
  verbose: Verbose;
  service: "node" | "schema";
  headers: Record<string, string>;
  timeoutMs?: number;
  socketPath?: string;
}): Promise<BoundedResponse> {
  const headers = { ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const bodyStr =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  // Scale the deadline by body size for writes: a bodyless request (GET/read)
  // has 0 bytes → exactly DEFAULT_TIMEOUT_MS (reads stay snappy), while a large
  // write body grows the deadline so it isn't capped by the small-record flat
  // 30s. An explicit per-call `timeoutMs` or FBRAIN_HTTP_TIMEOUT_MS still wins.
  const timeoutMs = opts.timeoutMs ?? writeTimeoutMs(Buffer.byteLength(bodyStr ?? ""));
  let result: BoundedFetchResult;
  try {
    result = await boundedNodeFetch({
      baseUrl: opts.baseUrl,
      path: opts.path,
      method: opts.method,
      body: bodyStr,
      verbose: opts.verbose,
      service: opts.service,
      headers,
      socketPath: opts.socketPath,
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof BoundedFetchFailure) {
      if (err.timeout) {
        throw timeoutError(opts.path, opts.method, opts.service, timeoutMs, err.cause);
      }
      throw connectionError(opts.baseUrl, opts.service, err.cause, err.failureCtx);
    }
    throw err;
  }

  const readBody = (async (readOpts?: { asText?: boolean }): Promise<unknown> => {
    try {
      if (readOpts?.asText) return result.text;
      return parseBody(result.text);
    } catch (err) {
      throw new FbrainError({
        code: "response_parse_failed",
        message: `Failed to parse ${opts.method} ${opts.path} response body: ${err instanceof Error ? err.message : String(err)}.`,
        cause: err,
      });
    }
  }) as ReadBody;

  return { res: new Response(null, { status: result.status, headers: result.headers }), readBody };
}

function parseJsonSafe(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Parse an already-read response body: JSON when it parses, the raw text
// otherwise, null when empty. (The body read itself is deadline-bounded in
// `verboseFetch`; this is the pure parse step.)
function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// True when a node URL points at the local machine (loopback host). The
// write-path vector-index confirmation (`verifyVectorIndexed`) only matters
// for a tight local create→search on the same warm node — over a remote node
// the round-trips aren't worth the latency, and the native index lag isn't the
// problem the user is hitting. Gate the CLI confirmation on this so a remote
// `--node-url` write stays cheap. (The MCP path doesn't gate because its agent
// loop is always against the local owned node.)
export function isLoopbackNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

// True when the prebuilt `folddb` binary is on PATH (Homebrew install or
// `FBRAIN_FOLDDB_BIN` override). Mirrors the probe in init-consent.ts so
// callers don't need to reach across modules. Injectable in `nodeDownHint`
// for tests so the assertion doesn't depend on the host PATH.
export function defaultIsFolddbBinaryInstalled(): boolean {
  const override = process.env.FBRAIN_FOLDDB_BIN;
  if (override && override.length > 0) return true;
  const probe = spawnSync("/bin/sh", ["-c", "command -v folddb"], { encoding: "utf8" });
  return probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
}

// Extract the TCP port from a node URL, defaulting to the http/https well-known
// port when the URL omits it. Returns null for an unparseable URL. Used to scope
// the wedged-vs-not-started probe to the TARGET port.
export function nodePortOf(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    if (u.protocol === "https:") return 443;
    if (u.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}

// True when SOMETHING is bound and LISTENING on the TARGET port of `url` on this
// host. This is deliberately port-scoped: `nodeDownHint` only runs after a
// transport failure to `url`, so "something is listening here but we still
// couldn't talk to it" means a wedged/mid-boot node ON THAT PORT — whereas
// "nothing is listening here" means the node simply isn't started. We must NOT
// use a host-wide `pgrep`: a sibling node serving a DIFFERENT port would make an
// unrelated down port look "wedged" and (wrongly) tell the dev to stop it.
//
// Uses `lsof -nP -iTCP:<port> -sTCP:LISTEN` (no name/DNS lookups, listeners
// only). Injectable in `nodeDownHint` so tests don't depend on the host's live
// socket table. A non-localhost URL can't be probed locally, so we report false
// (treat a remote node as "not a local wedge").
export function defaultIsTargetPortListening(url: string): boolean {
  if (!isLoopbackNodeUrl(url)) return false;
  const port = nodePortOf(url);
  if (port == null || !Number.isFinite(port)) return false;
  const probe = spawnSync("/bin/sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN`], {
    encoding: "utf8",
  });
  return probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
}

// True when a node URL is the default local CLI install marker. Used ONLY by
// `nodeDownHint` for install guidance — fbrain reaches a loopback node over
// its Unix socket and never dials TCP. Matches the current portless default
// (`http://127.0.0.1` / `http://localhost`) and the historical retired
// `:9001` marker so existing configs still get the right recovery text.
// Custom loopback ports (9050, 9101, …) are NOT default-install — those are
// contributor/ephemeral nodes and get from-source framing when no prebuilt
// binary is on PATH.
function isDefaultInstallNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const hostOk =
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname === "[::1]";
    if (!hostOk) return false;
    // Empty / default port (http → 80, but URL.port is "" when omitted) OR
    // the historical Mini/full-node TCP marker.
    return u.port === "" || u.port === "9001";
  } catch {
    return false;
  }
}

function socketFirstNodeHint(
  socketPath: string,
  opts: { cliInstallPath?: boolean; sourceCompileNote?: boolean } = {},
): string {
  const sourceNote = opts.sourceCompileNote
    ? " (first run compiles Rust — give it a few minutes)"
    : "";
  const cliNote = opts.cliInstallPath
    ? " If this is an intentional CLI/Homebrew node, start the foreground daemon with `lastdb daemon start` or repair its launchd service."
    : "";
  return (
    `fbrain uses the local LastDB Unix socket at ${socketPath}; run \`fbrain doctor\` for a full diagnosis. ` +
    "Start or reopen LastDB.app so that socket exists. " +
    `Contributors running from source: \`cd fold/fold_db_node && ./run.sh --local\`${sourceNote}. ` +
    "If your node uses a different home, set `FBRAIN_FOLDDB_SOCKET=/abs/path/to/folddb.sock` " +
    "or `LASTDB_HOME=<node-home>`." +
    cliNote
  );
}

// "Your node isn't reachable — start it" guidance. Three cases, all
// socket-first:
//   1. SOMETHING is bound and LISTENING on the TARGET port but the socket isn't
//      answering — the node is wedged, mid-boot, or hung (it did NOT just "not
//      start"). A restart of a wedged node just re-hangs, so point them at the
//      socket, `fbrain doctor`, logs, and stop-before-start recovery. This
//      branch wins first because a live-but-dead node is the most misdiagnosed
//      failure. The probe is scoped to the TARGET port — a sibling node serving
//      a DIFFERENT port must NOT make this down port look "wedged".
//   2. Nothing on the target port, but the default install target OR a prebuilt
//      `folddb` binary is on PATH — a downloaded/CLI user. Still lead with the
//      socket and LastDB.app recovery; include a conditional CLI/Homebrew note.
//   3. Nothing on the target port, not the default URL, and no prebuilt binary
//      — a genuine fold contributor running from source against a custom port.
export function nodeDownHint(
  url: string,
  isFolddbBinaryInstalled: () => boolean = defaultIsFolddbBinaryInstalled,
  isTargetPortListening: (url: string) => boolean = defaultIsTargetPortListening,
): string {
  const socketPath = defaultFolddbSocketPath();
  const cliInstallPath = isDefaultInstallNodeUrl(url) || isFolddbBinaryInstalled();
  if (isTargetPortListening(url)) {
    const cliNote = cliInstallPath
      ? " If this is an intentional CLI/Homebrew node, stop that daemon before starting it again."
      : "";
    return (
      `A node is bound to ${url} but isn't responding — it may still be starting up, or it may be wedged. ` +
      `fbrain uses the local LastDB Unix socket at ${socketPath}; run \`fbrain doctor\` for a full diagnosis. ` +
      "Check the node log; if it's wedged, stop it before restarting: stop the existing node process before starting it again. " +
      "Desktop app: quit LastDB.app, then reopen it. " +
      "Contributors running from source: stop the existing `lastdb_server`/`folddb_server` process, then `cd fold/fold_db_node && ./run.sh --local`." +
      cliNote
    );
  }
  if (cliInstallPath) {
    return socketFirstNodeHint(socketPath, { cliInstallPath: true });
  }
  return socketFirstNodeHint(socketPath, { sourceCompileNote: true });
}

function socketMissingHint(socketPath: string): string {
  return (
    `Start or reopen LastDB.app so it creates the Unix socket at ${socketPath}. ` +
    "Run `fbrain doctor` for a full diagnosis. Contributors running from source: " +
    "`cd fold/fold_db_node && ./run.sh --local`. " +
    "If your node uses a different home, set `FBRAIN_FOLDDB_SOCKET=/abs/path/to/folddb.sock` " +
    "or `LASTDB_HOME=<node-home>`."
  );
}

function socketMissingAgentHint(socketPath: string): string {
  return (
    `The local node socket is absent at ${socketPath}. Start LastDB, or point ` +
    "`FBRAIN_FOLDDB_SOCKET` / `LASTDB_HOME` at the running node's socket."
  );
}

function socketUnreachableHint(socketPath: string): string {
  return (
    `A Unix socket file exists at ${socketPath}, but it did not accept a connection. ` +
    "The node may still be starting, or the socket file may be stale. Check the node log; " +
    "if the node is wedged, stop it before starting it again."
  );
}

function socketUnreachableAgentHint(socketPath: string): string {
  return (
    `The Unix socket at ${socketPath} exists but did not accept a connection. ` +
    "Check whether the node is still starting, wedged, or leaving a stale socket file."
  );
}

// Discriminator for "node is UP but returned an HTTP error response" — as
// opposed to a transport failure (connection refused / DNS / timeout), which
// `connectionError` tags `service_unreachable`. Every node HTTP non-2xx flows
// through `mapNodeError`, which tags unmatched errors `node_http_<status>`;
// matched rules carry their own codes. We treat anything that is NOT
// `service_unreachable` as "reachable but erroring" so the caller can avoid
// the misleading "start the node" hint. See nodeHttpErrorHint.
export function isNodeReachableButErroring(err: unknown): boolean {
  return err instanceof FbrainError && err.code !== "service_unreachable";
}

// Returns the FOLDDB_MASTER_KEY remedy when the node's error text names the
// node-identity / master-key / keychain decryption path (the homebrew daemon's
// most common "up but 500" failure), else null. Shared by `nodeHttpErrorHint`
// (used by `fbrain doctor`'s reachability check) and `mapNodeError`'s generic
// 5xx fallthrough (used by runtime commands: search/list/put/get/…) so the
// heuristic + wording live in exactly one place.
function identityFailureRemedy(msg: string): string | null {
  if (
    !/keychain|master[ _-]?key|node identity|decrypt|foldd?b_master_key|os-keychain/.test(
      msg.toLowerCase(),
    )
  ) {
    return null;
  }
  return (
    "The node is up but can't decrypt its identity. Ensure the node process " +
    "has `FOLDDB_MASTER_KEY=<64-hex-bytes>` set in its environment (e.g. in " +
    "its launchd/systemd unit), or run a keychain-enabled build. The node's " +
    "own message above names the exact cause — restart the node after fixing it."
  );
}

// Hint for a node that is REACHABLE but returned an HTTP error (4xx/5xx) — the
// opposite of `nodeDownHint`. Telling such a user to "start the node" is wrong
// and wastes their time: the node is plainly up (it answered), and its own
// error body already names the real cause. The error's `detail` already
// surfaces the node's message verbatim, so this only supplies the actionable
// remedy. Used by `fbrain doctor`'s reachability check — do NOT add a `fbrain
// doctor` pointer here, since doctor consumes this string as its own `fix`.
export function nodeHttpErrorHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Status, when the generic `node_http_<status>` code carried it.
  const code = err instanceof FbrainError ? err.code : "";
  const statusMatch = /^node_http_(\d+)$/.exec(code);
  const status = statusMatch ? statusMatch[1] : undefined;
  const identityRemedy = identityFailureRemedy(msg);
  if (identityRemedy) return identityRemedy;
  return (
    `The node is up but returned an HTTP error${status ? ` (${status})` : ""} — ` +
    "this is not a 'start the node' problem. The node's message above is the " +
    "actionable cause; check the node log if it isn't self-explanatory."
  );
}

// fbrain talks to a deployed cloud schema-service Lambda by default —
// there is no local schema_service to "start" unless you're a fold
// contributor pointing at localhost. So an unreachable schema service is
// almost always a network/outage issue for a downloaded user.
export function schemaDownHint(url: string): string {
  if (/localhost|127\.0\.0\.1/.test(url)) {
    return "Start fold's schema service (`./run.sh --local --local-schema` runs both).";
  }
  return "fbrain uses a cloud schema service (no local schema_service to run) — check your network connection or for a service outage.";
}

function connectionError(
  baseUrl: string,
  service: "node" | "schema",
  cause: unknown,
  ctx: ConnectionErrorContext = {},
): FbrainError {
  const which = service === "node" ? "node" : "schema service";
  if (
    service === "node" &&
    ctx.routeSocket &&
    ctx.socketCause !== undefined &&
    (ctx.phase === "body" || existsSync(ctx.routeSocket.socketPath))
  ) {
    return new FbrainError({
      code: "service_unreachable",
      message: `node socket not reachable at unix:${ctx.routeSocket.socketPath} ${DOCTOR_TIP}.`,
      hint: socketUnreachableHint(ctx.routeSocket.socketPath),
      agentHint: socketUnreachableAgentHint(ctx.routeSocket.socketPath),
      cause: { socket: ctx.socketCause, fallback: cause },
    });
  }
  // Any LOCAL (loopback) node is socket-only — no TCP fallback — so an absent
  // socket means the node isn't running, whatever the loopback port.
  if (service === "node" && ctx.socketPath && isLoopbackNodeUrl(baseUrl) && !existsSync(ctx.socketPath)) {
    return new FbrainError({
      code: "service_unreachable",
      message: `node not running: Unix socket not found at ${ctx.socketPath} ${DOCTOR_TIP}.`,
      hint: socketMissingHint(ctx.socketPath),
      agentHint: socketMissingAgentHint(ctx.socketPath),
      cause,
    });
  }
  return new FbrainError({
    code: "service_unreachable",
    message: `${which} not reachable at ${baseUrl} ${DOCTOR_TIP}.`,
    hint: service === "node" ? nodeDownHint(baseUrl) : schemaDownHint(baseUrl),
    cause,
  });
}

// ---------------------------------------------------------------------------
// @lastdb/app-sdk glue
// ---------------------------------------------------------------------------

/**
 * A fetch-backed implementation of the SDK's pluggable Transport. The SDK's
 * built-in `httpTransport` rides node:http; fbrain deliberately injects this
 * one so that (a) every HTTP request fbrain makes — SDK paths included — goes
 * through the same global `fetch` (which the unit suite stubs to capture
 * outgoing requests), and (b) a non-JSON body degrades to `body: null`
 * instead of a hard transport error, matching fbrain's tolerant `parseBody`.
 */
function fetchTransport(
  baseUrl: string,
  defaultHeaders: Record<string, string>,
  // Optional per-request header supplier — used to inject the owner-session
  // `X-Folddb-Session` token (resolved fresh each call so an
  // invalidate-after-403 re-pair is reflected). Resolves to `{}` when
  // unattested. Awaited per send so the SDK's consent/mutation calls carry the
  // same owner-session attestation the raw node path does.
  dynamicHeaders?: () => Promise<Record<string, string>>,
  socketPath?: string,
): SdkTransport {
  return {
    target: baseUrl,
    async send(
      method: "GET" | "POST",
      path: string,
      options: { headers?: Record<string, string>; body?: unknown } = {},
    ) {
      const headers: Record<string, string> = {
        ...defaultHeaders,
        ...(dynamicHeaders ? await dynamicHeaders() : {}),
        ...(options.headers ?? {}),
      };
      const bodyStr =
        options.body === undefined ? undefined : JSON.stringify(options.body);
      if (bodyStr !== undefined) headers["Content-Type"] = "application/json";

      // Payload-scaled deadline (see writeTimeoutMs): the mutation/write path
      // routes through here, and its node-side cost is O(body) because the node
      // chunk-embeds the whole body. A bodyless GET → 0 bytes → DEFAULT, so
      // reads through this transport keep the fast deadline.
      const timeoutMs = writeTimeoutMs(Buffer.byteLength(bodyStr ?? ""));

      let res: BoundedFetchResult;
      try {
        res = await boundedNodeFetch({
          baseUrl,
          path,
          method,
          headers,
          body: bodyStr,
          service: "node",
          socketPath,
          timeoutMs,
        });
      } catch (err) {
        if (err instanceof BoundedFetchFailure) {
          if (err.timeout) throw timeoutError(path, method, "node", timeoutMs, err.cause);
          throw new FbrainTransportError(
            `request to ${baseUrl}${path} failed: ${err.message}`,
            err.failureCtx,
          );
        }
        throw err;
      }

      let parsed: unknown = null;
      if (res.text.length > 0) {
        try {
          parsed = JSON.parse(res.text);
        } catch {
          parsed = null;
        }
      }
      if (
        method === "POST" &&
        path === "/api/query" &&
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        options.body &&
        typeof options.body === "object" &&
        !Array.isArray(options.body)
      ) {
        const responseBody = parsed as Record<string, unknown>;
        const requestBody = options.body as Record<string, unknown>;
        if (responseBody.limit === undefined && typeof requestBody.limit === "number") {
          responseBody.limit = requestBody.limit;
        }
        if (responseBody.offset === undefined && typeof requestBody.offset === "number") {
          responseBody.offset = requestBody.offset;
        }
        if (responseBody.returned_count === undefined) {
          const rows = Array.isArray(responseBody.results)
            ? responseBody.results
            : Array.isArray(responseBody.rows)
              ? responseBody.rows
              : null;
          if (rows !== null) responseBody.returned_count = rows.length;
        }
      }
      return { status: res.status, body: parsed };
    },
  };
}

// `capabilityStoreKey` validates the app-id shape; fbrain's SDK clients never
// persist through the SDK store (no-op store), so an out-of-shape app id must
// not turn into a client-side throw where the node used to answer. Fall back
// to the raw app id as the (unused) key.
function safeStoreKey(appId: string, target: string): string {
  try {
    return capabilityStoreKey(appId, target);
  } catch {
    return appId;
  }
}

// fbrain's consent layer carries scope as the node's wire string; the SDK
// takes the structured ConsentScope and serializes it back to the same
// string. Only "wildcard" is used today; "explicit:a,b" maps onto the SDK's
// explicit form. Anything else is forwarded as a single explicit entry so the
// node stays the authority on rejecting it.
function parseScope(scope: string): ConsentScope {
  if (scope === "wildcard") return "wildcard";
  if (scope.startsWith("explicit:")) {
    return { explicit: scope.slice("explicit:".length).split(",") };
  }
  return { explicit: [scope] };
}

/**
 * Translate an @lastdb/app-sdk typed error back into fbrain's FbrainError
 * registry. The SDK discriminates exactly what `mapNodeError`'s dispatch
 * table reads off the raw response, so each arm reconstructs the body shape
 * the node sent and funnels through `mapNodeError` — keeping the registry the
 * single source of error wording:
 *
 * - `CapabilityDeniedError` carries the node's verbatim discriminated reason
 *   + detail (the eight-reason capability-403 contract, SDK gap #4) — rebuilt
 *   as `{status: 403, reason, ...detail}`.
 * - `UnexpectedResponseError` carries the raw {status, body} — lossless.
 * - `RequestRejectedError` (400) carries the node's `kind` + `error` text.
 * - `PermissionDeniedError` (403 without a reason) carries the node's
 *   discriminated reason text.
 * - `TransportError` → fbrain's `service_unreachable` with the start-the-node
 *   hint.
 */
// True when an @lastdb/app-sdk error represents the node's
// `transport_not_attested` 403 — the signal that this transport's owner session
// is stale (a restarted node dropped its in-memory token). The node may carry
// the discriminator in either `reason` (→ PermissionDeniedError) or `error` (→
// UnexpectedResponseError body), so check both shapes. A match drives a single
// re-pair + retry (see `withSessionRepair`); anything else is left untouched.
function isTransportNotAttested(err: unknown): boolean {
  if (err instanceof PermissionDeniedError && err.reason === TRANSPORT_NOT_ATTESTED) {
    return true;
  }
  if (err instanceof UnexpectedResponseError && err.status === 403) {
    return (
      bodyError(err.body) === TRANSPORT_NOT_ATTESTED ||
      bodyStringField(err.body, "reason") === TRANSPORT_NOT_ATTESTED
    );
  }
  return false;
}

function mapSdkDataError(
  err: unknown,
  baseUrl: string,
  method: string,
  path: string,
  socketPath?: string,
): FbrainError {
  // NB: CapabilityDeniedError subclasses PermissionDeniedError — order matters.
  if (err instanceof CapabilityDeniedError) {
    const body: Record<string, unknown> = { status: 403, reason: err.reason };
    if (err.detail.schema !== undefined) body.schema = err.detail.schema;
    if (err.detail.capabilityId !== undefined) body.capability_id = err.detail.capabilityId;
    if (err.detail.timestampSkewSecs !== undefined) {
      body.timestamp_skew_secs = err.detail.timestampSkewSecs;
    }
    return mapNodeError(403, body, path);
  }
  if (err instanceof PermissionDeniedError) {
    return mapNodeError(403, { kind: "permission_denied", error: err.reason }, path);
  }
  if (err instanceof RequestRejectedError) {
    return mapNodeError(400, err.body ?? { kind: err.kind, error: err.message }, path);
  }
  if (err instanceof UnexpectedResponseError) {
    return mapNodeError(err.status, err.body, path);
  }
  if (err instanceof FbrainTransportError) {
    return connectionError(baseUrl, "node", err, err.failureCtx);
  }
  if (err instanceof TransportError) {
    return connectionError(baseUrl, "node", err, {
      socketPath,
      routeSocket: localNodeRouteSocket("node", method, path, baseUrl, socketPath),
      socketCause: err,
    });
  }
  if (err instanceof FbrainError) return err;
  return new FbrainError({
    code: "sdk_error",
    message: `SDK call to ${path} failed: ${err instanceof Error ? err.message : String(err)}.`,
    cause: err,
  });
}

// Context fields read by the node-error dispatch table. Built once per call so
// each rule's `match` and `build` can stay declarative.
type NodeErrorContext = {
  status: number;
  body: unknown;
  path: string;
  errCode: string | undefined;
  msg: string | undefined;
  // Discriminator field for several fold_db_node error responses (e.g.
  // missing_user_context_response in fold_db_node/src/utils/http_errors.rs
  // returns `{code:"MISSING_USER_CONTEXT", error:"<human sentence>", ...}`).
  // `error` carries the human-readable message there, NOT the machine
  // token — so the discriminator lives in `code` and must be checked
  // separately from `bodyError`.
  codeField: string | undefined;
  reason: string | undefined;
  // Concatenated msg+errCode — the node's free-form failure text. The homebrew
  // daemon puts the failure text in `error`; future daemons may move it to
  // `message` — we grep both so heuristics survive that move. Used by the
  // embedding-model 400 regex and by the identity-failure 5xx heuristic.
  messageBlob: string;
};

type FbrainErrorInit = ConstructorParameters<typeof FbrainError>[0];

type NodeErrorRule = {
  match: (ctx: NodeErrorContext) => boolean;
  build: (ctx: NodeErrorContext) => FbrainErrorInit;
};

// Ordered dispatch table for node HTTP errors. First match wins; some arms are
// intentionally more specific than later ones, so order is load-bearing. A
// tuple that matches nothing falls through to the generic `node_http_${status}`
// mapping in `mapNodeError`.
const NODE_ERROR_RULES: NodeErrorRule[] = [
  // Owner-verb attestation 403 (app-isolation flip, fold#739). The node gates
  // owner verbs — `/api/schemas/load`, owner-isolation bypass, etc. — behind an
  // attested transport and returns `403 {"error":"transport_not_attested"}` to
  // bare loopback TCP. fbrain attests by minting a pairing code over the node's
  // UDS control socket (see `attestOwnerSession`); when it can't find that
  // socket it proceeds unattested and the verb 403s. The bite is the documented
  // CONTRIBUTOR path: README tells devs to run a from-source node via `./run.sh`
  // (a non-default data dir, so its socket is NOT at `~/.folddb/data/folddb.sock`)
  // and then `fbrain init --node-url …`. Without this rule that lands as an
  // opaque `node_http_403` at init step 4/6 with zero guidance. Resolve the
  // socket path the client would have used (env/HOME-derived; a config-supplied
  // `nodeSocketPath` override isn't visible to this pure mapper) and tell the
  // user whether it was even present, plus the one env var that fixes it.
  // Placed first: `transport_not_attested` arrives in the `error` field, so
  // `ctx.reason` is undefined and the capability-403 rule below won't catch it —
  // but ordering it ahead keeps the precedence explicit.
  {
    match: (ctx) => ctx.status === 403 && ctx.errCode === TRANSPORT_NOT_ATTESTED,
    build: (ctx) => {
      const socketPath = defaultFolddbSocketPath();
      const found = existsSync(socketPath);
      const where = found
        ? `fbrain found a control socket at ${socketPath} but the node rejected the session it minted there`
        : `fbrain found no control socket at ${socketPath}`;
      return {
        code: "transport_not_attested",
        message:
          `Node rejected ${ctx.path}: this owner verb requires an attested transport ` +
          `(app-isolation flip, fold#739) and bare loopback TCP can't drive it — ${where}.`,
        hint:
          (found
            ? "The socket exists but attestation failed — the node may have restarted (its in-memory " +
              "session dropped) or it isn't the node serving your --node-url. "
            : "fbrain attests by minting a pairing code over the node's UDS control socket, which lives at " +
              "`<node-data-home>/data/folddb.sock` — that's `~/.folddb/data/folddb.sock` for the LastDB.app " +
              "desktop node and `~/.lastdb/data/folddb.sock` for a v0.15.1+ CLI/brew node. fbrain probes " +
              "both and picks whichever socket exists; if your node uses a different home (a from-source " +
              "`./run.sh` node, or one launched with a custom `LASTDB_HOME`/`FOLDDB_HOME`) the probe won't find it. ") +
          "Point fbrain at the right socket with `FBRAIN_FOLDDB_SOCKET=/abs/path/to/folddb.sock` " +
          "(or `LASTDB_HOME=<node-home>` / `FOLDDB_HOME=<node-home>`), then re-run. The socket is created " +
          "by the OS user that owns the node, so run fbrain as that user on the same machine.",
        agentHint:
          `This node gates owner verbs behind an attested UDS control socket (fold#739). ${where}. ` +
          "Set the FBRAIN_FOLDDB_SOCKET env to the node's `<data-home>/data/folddb.sock` (LastDB.app " +
          "desktop: `~/.folddb/data/folddb.sock`; v0.15.1+ CLI/brew: `~/.lastdb/data/folddb.sock`) and " +
          "retry. fbrain must run as the OS user that owns the node.",
      };
    },
  },
  // Discriminated capability 403 (app_identity v3.1). Body is verbatim
  // `{"status":403,"reason":"<reason>", ...}`. Carry the reason + any detail
  // on the FbrainError so the capability layer can apply the contract behavior
  // (discard / re-acquire / retry-once / surface). A 403 without a recognised
  // `reason` falls through to the generic mapping below.
  {
    match: (ctx) => ctx.status === 403 && ctx.reason !== undefined,
    build: (ctx) => {
      const reason = ctx.reason as string;
      const detail: Capability403Detail = {};
      const schema = bodyStringField(ctx.body, "schema");
      if (schema !== undefined) detail.schema = schema;
      const capabilityId = bodyStringField(ctx.body, "capability_id");
      if (capabilityId !== undefined) detail.capabilityId = capabilityId;
      const skew = bodyNumberField(ctx.body, "timestamp_skew_secs");
      if (skew !== undefined) detail.timestampSkewSecs = skew;
      return {
        code: `capability_403_${reason}`,
        message: `Node rejected ${ctx.path}: capability denied (${reason}).`,
        capabilityReason: reason,
        capabilityDetail: detail,
      };
    },
  },
  {
    match: (ctx) =>
      ctx.status === 401 &&
      (ctx.codeField === "MISSING_USER_CONTEXT" ||
        ctx.errCode === "MISSING_USER_CONTEXT" ||
        ctx.msg?.includes("Authentication") === true),
    build: (ctx) => ({
      code: "missing_user_context",
      message: `Node rejected ${ctx.path}: missing X-User-Hash ${DOCTOR_TIP}.`,
      hint: "Re-run `fbrain init` so the config's userHash is regenerated.",
    }),
  },
  {
    match: (ctx) => ctx.status === 503 && ctx.errCode === "node_not_provisioned",
    build: () => ({
      code: "node_not_provisioned",
      message: `Node not set up ${DOCTOR_TIP}.`,
      hint: "Run `fbrain init` to bootstrap the node.",
    }),
  },
  {
    match: (ctx) => ctx.status === 409 && ctx.errCode === "ambiguous_schema_name",
    build: (ctx) => {
      const candidates = bodyAmbiguous(ctx.body);
      return {
        code: "ambiguous_schema_name",
        message:
          `Node rejected ${ctx.path}: schema collision (canonical hashes ${candidates.join(", ")}); ` +
          `fbrain config out of date — run \`fbrain init\` ${DOCTOR_TIP}.`,
        hint: "Re-run `fbrain init` — config will pick up the current canonical hash.",
      };
    },
  },
  {
    match: (ctx) =>
      ctx.status === 400 && (ctx.errCode === "unknown_fields" || ctx.msg?.includes("unknown") === true),
    build: (ctx) => ({
      code: "unknown_fields",
      message: `Node rejected ${ctx.path}: ${ctx.msg ?? "unknown field name"} ${DOCTOR_TIP}.`,
      hint: "Compare fbrain's schemas.ts against the registered schema; re-run `fbrain init` after editing.",
    }),
  },
  // The fold_db_node's embedding subsystem lazily loads `model.onnx` from a
  // local cache on the first semantic-search call. After certain restarts
  // (notably `brew upgrade folddb`) the cache can be partially populated, and
  // the node returns a 400 whose body carries
  // "...Failed to init embedding model: Failed to retrieve model.onnx" —
  // sometimes under `message`, sometimes under `error`. Without translation
  // the user sees an opaque error on `fbrain search` / `fbrain ask`; with
  // translation they get a single, actionable recovery command.
  {
    match: (ctx) =>
      ctx.status === 400 &&
      /Failed to (init embedding model|retrieve model\.onnx)/i.test(ctx.messageBlob),
    build: (ctx) => ({
      code: "embedding_model_unavailable",
      message:
        `Semantic search is unavailable — the fold_db node failed to load its embedding model ` +
        `(${ctx.messageBlob.trim()}) ${DOCTOR_TIP}.`,
      hint:
        "Restart the node so it re-fetches the ONNX file from the embedding cache " +
        "(homebrew: `lastdb daemon stop && lastdb daemon start`). " +
        "If the failure persists, run `fbrain doctor --freshness` and capture " +
        "the node log (the latest file under ~/Library/Logs/Homebrew/lastdb/).",
      agentHint:
        "This is a node-side issue, not something this tool can fix — ask the " +
        "operator to restart the fold_db node, then retry.",
    }),
  },
];

export function mapNodeError(status: number, body: unknown, path: string): FbrainError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  const ctx: NodeErrorContext = {
    status,
    body,
    path,
    errCode,
    msg,
    codeField: bodyStringField(body, "code"),
    reason: bodyStringField(body, "reason"),
    messageBlob: [msg, errCode].filter((s): s is string => typeof s === "string").join(" "),
  };
  for (const rule of NODE_ERROR_RULES) {
    if (rule.match(ctx)) return new FbrainError(rule.build(ctx));
  }
  // Build a 5xx hint that names the real cause when the body text points at
  // the node-identity / master-key / keychain decrypt path (the homebrew
  // daemon's most common "up but 500" failure — PR #227 fixed this for
  // `fbrain doctor`, but runtime commands like search/list/put/get all
  // funnel through this generic mapping and need the same actionable fix).
  // Non-identity 5xx points the user at `fbrain doctor` since they probably
  // ran search/list/get and have no other diagnostic surface to fall back on.
  let hint: string | undefined;
  if (status >= 500) {
    const identityRemedy = identityFailureRemedy(ctx.messageBlob);
    hint = identityRemedy
      ?? "Check the node log; this looks like a node-side bug. Run `fbrain doctor` for a full diagnosis.";
  }
  return new FbrainError({
    code: `node_http_${status}`,
    message: `Node ${path} returned HTTP ${status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""}.`,
    hint,
  });
}

// Shared explanation + remedy text for the schema-service publish gate, used
// from both `mapSchemaServiceError` (init's step 3 raw error) and
// `runSchemaPublishGateProbe` (doctor's stand-alone diagnosis). Keeping a
// single source so the two surfaces never drift.
export const CERT_REQUIRED_HINT =
  "fbrain's schemas under `fbrain/*` are namespaced — POSTing them to the " +
  "schema service requires a DevCert held by a maintainer (per app_identity v3.1). " +
  "A fresh consumer is expected to skip publishing entirely; init resolves the " +
  "already-published canonical hashes from the node after the cert-free catalog " +
  "load. You'll only see this error if the schemas have not yet been published " +
  "to this schema service at all. Remedies, any one of: " +
  "(a) ask a maintainer with a DevCert to run `fbrain init` once against this schema service so the canonical hashes are published; " +
  "(b) point fbrain at a different schema service that already has fbrain/* published (e.g. the prod cloud Lambda — the default).";

export function mapSchemaServiceError(res: Response, body: unknown, path: string): FbrainError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  const reason = bodyStringField(body, "reason");
  // App-identity v3.1 publish gate. The schema service rejects an
  // `owner_app_id`-tagged schema POST from a caller without a DevCert with
  // `401 {"reason":"cert_required"}`. For fbrain — whose schemas under
  // `fbrain/*` are pre-published org-wide — this is the canonical "fresh
  // consumer following the documented path" failure: re-POSTing canonical
  // hashes requires publish authority the consumer doesn't (and shouldn't) have.
  // Surface a discriminated code + actionable remedy instead of a raw
  // "HTTP 401" that gives the user nothing to act on.
  if (res.status === 401 && reason === "cert_required") {
    return new FbrainError({
      code: "schema_cert_required",
      message:
        `Schema service ${path} rejected publish with 401 cert_required — ` +
        `registering fbrain's namespaced schemas requires a one-time DevCert publish ` +
        `by a maintainer (this is expected for a fresh consumer) ${DOCTOR_TIP}.`,
      hint: CERT_REQUIRED_HINT,
    });
  }
  return new FbrainError({
    code: `schema_http_${res.status}`,
    message: `Schema service ${path} returned HTTP ${res.status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""} ${DOCTOR_TIP}.`,
  });
}

function bodyAmbiguous(body: unknown): string[] {
  if (body && typeof body === "object" && "ambiguous_schemas" in body) {
    const a = (body as Record<string, unknown>).ambiguous_schemas;
    if (Array.isArray(a)) return a.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export function bodyStringField(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function bodyNumberField(body: unknown, key: string): number | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function recordTypeForHash(
  hash: string,
  schemaHashes: Record<string, string>,
): RecordType | null {
  for (const [type, h] of Object.entries(schemaHashes)) {
    if (h === hash) return type as RecordType;
  }
  return null;
}

// fold_db's user_hash is the first 32 hex chars of sha256(raw pubkey).
// Verified against `auto-identity`: for our local node, sha256 of the
// base64-decoded `public_key` truncated to 16 bytes matches the
// `user_hash` field. Used by `fbrain doctor --usage` to partition writes
// across teammates without leaking the full pubkey.
export function pubkeyToUserHash(pubkey: string): string {
  const raw = Buffer.from(pubkey, "base64");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}
