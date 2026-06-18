// Typed HTTP wrappers for fold_db_node + schema_service.
//
// Every node endpoint sends X-User-Hash (per Phase 0 spike: missing →
// `401 MISSING_USER_CONTEXT`). All errors flow through `mapError` so
// every Error Registry row maps to an actionable message in exactly
// one place.
//
// As of the @folddb/app-sdk port, the consent handshake
// (`/api/apps/request-consent` + `/api/apps/consent-status`) and the mutation
// path (`/api/mutation`, with the per-write capability headers) ride the
// SDK's `FoldDbClient` — the same wire client every FoldDB app uses — with
// the SDK's typed errors translated back into fbrain's FbrainError registry
// (see `mapSdkDataError`). The rest of the node surface stays hand-rolled
// because the SDK deliberately does not cover it (native-index search,
// schemas/load, bootstrap, auto-identity, raw) or cannot express it yet
// (`queryAll`'s limit/offset pagination loop + per-page dedup guards).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CapabilityDeniedError,
  FoldDbClient,
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
  type Transport as SdkTransport,
} from "@folddb/app-sdk";

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
// session token over TCP, and presents that token here on every request — the
// exact pairing the CLI's `attest_owner_session` performs (fold_db_node
// `src/bin/folddb/commands/ui.rs`). Must match the node's session header name.
export const FOLDDB_SESSION_HEADER = "X-Folddb-Session";

// The node's body discriminator for "this transport is not attested" — fold's
// owner-verb gate returns `403 {"error":"transport_not_attested"}`. fbrain
// re-pairs once and retries when it sees this (a restarted node invalidates the
// in-memory session token).
export const TRANSPORT_NOT_ATTESTED = "transport_not_attested";

// Filename of the node's Unix-domain control socket — must match
// `fold_db_node::server::uds::SOCKET_FILE_NAME` ("folddb.sock"), the same
// constant the CLI's attest path uses.
const SOCKET_FILE_NAME = "folddb.sock";

// Resolve the node's UDS control-socket path. Mirrors the CLI: the socket lives
// at `<storage>/folddb.sock`, and the :9001 brain's data dir is
// `${FOLDDB_HOME ?? ~/.folddb}/data`. An explicit override (config field /
// FBRAIN_FOLDDB_SOCKET env) wins for ephemeral / non-default nodes.
export function defaultFolddbSocketPath(override?: string): string {
  // Precedence: the FBRAIN_FOLDDB_SOCKET env wins (the ad-hoc / test override),
  // then an explicit config-supplied path, then the default
  // `${FOLDDB_HOME ?? ~/.folddb}/data/folddb.sock`.
  const envOverride = process.env.FBRAIN_FOLDDB_SOCKET;
  if (envOverride && envOverride.length > 0) return envOverride;
  if (override && override.length > 0) return override;
  const home = process.env.FOLDDB_HOME ?? join(homedir(), ".folddb");
  return join(home, "data", SOCKET_FILE_NAME);
}

// Filename of fold's port breadcrumb — the running node writes its TCP listen
// port here (`fold_db_node` drops `${FOLDDB_HOME ?? ~/.folddb}/port`). Reading
// it lets `fbrain init` target whatever node is actually up on this machine
// instead of assuming the homebrew :9001 default.
const PORT_BREADCRUMB_FILE_NAME = "port";

// Derive the running node's TCP URL from fold's `${FOLDDB_HOME ?? ~/.folddb}/port`
// breadcrumb. Returns `http://127.0.0.1:<port>` when the file holds a valid
// integer port, or `null` when it is missing / empty / non-numeric (caller then
// falls back to the hardcoded default).
//
// CRITICAL: the home-resolution precedence MUST match `defaultFolddbSocketPath`
// (FOLDDB_HOME, then homedir) so the node URL and the owner-attestation UDS
// socket always derive from the SAME root — otherwise the two can silently
// resolve to different nodes and the owner-session attestation fails with a
// misleading `transport_not_attested` (the dogfood bug this fixes).
export function defaultNodeUrlFromBreadcrumb(): string | null {
  const home = process.env.FOLDDB_HOME ?? join(homedir(), ".folddb");
  const breadcrumbPath = join(home, PORT_BREADCRUMB_FILE_NAME);
  if (!existsSync(breadcrumbPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(breadcrumbPath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  // Reject empty / non-numeric / out-of-range; only a clean positive integer
  // port (1..65535) yields a URL.
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

// Mint a one-time pairing code over the node's UDS control socket, then
// exchange it over TCP for an owner-session token. Returns the token, or `null`
// on ANY failure (no socket, mint refused, exchange non-2xx, parse error) —
// null means "proceed unattested", exactly the CLI's behavior on a default
// (non-isolation) build where nothing is gated and the control socket is absent.
//
// Mirrors `attest_owner_session` + `mint_pairing_code` in fold_db_node's
// `src/bin/folddb/commands/ui.rs`. We guard on `existsSync(socketPath)` BEFORE
// issuing any fetch (just as the Rust path checks `socket.exists()` first) so
// that on a socketless node — and in the unit suite, where no socket exists —
// no HTTP request is made and the caller degrades cleanly.
export async function attestOwnerSession(
  nodeUrl: string,
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
  // `defaultTimeoutMs()` via an AbortController, mirroring callNodeRaw
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
    url: string,
    init: RequestInit & { unix?: string },
  ): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
    }, timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        verbose(`owner-session ${path} refused (HTTP ${res.status})`);
        return null;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (isTimeoutError(err)) {
        verbose(`owner-session ${path} timed out after ${timeoutMs}ms`);
        throw timeoutError(path, "POST", "node", timeoutMs, err);
      }
      throw err;
    } finally {
      done = true;
      clearTimeout(timer);
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
      "http://localhost/control/browser-pairing-code",
      { method: "POST", unix: socketPath },
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
  // Exchange the code over TCP for a session token.
  try {
    // trace-egress: loopback (local daemon TCP listener; pairing-code exchange,
    // never leaves the host)
    const body = await fetchJsonWithDeadline(
      "/api/session/browser-pair",
      `${stripTrailingSlash(nodeUrl)}/api/session/browser-pair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairingCode }),
      },
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

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
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
    hint: "The node may be under heavy load (e.g. cold-initializing its schema index). Writes are upserts keyed by slug, so re-running the command is safe. Raise the deadline with FBRAIN_HTTP_TIMEOUT_MS if the node is just slow.",
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

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
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
  // socket is absent (a non-isolation node — the current :9001 default) mint
  // fails fast and fbrain proceeds unattested, exactly as today.
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
  // control socket is absent (current :9001 default) this resolves to `null`
  // and no `X-Folddb-Session` header is ever attached — fbrain behaves exactly
  // as before. `invalidateSession()` clears the cache so a `transport_not_
  // attested` 403 (a restarted node dropped its in-memory session) triggers a
  // single re-pair on retry.
  let sessionTokenPromise: Promise<string | null> | null = null;
  const sessionToken = (): Promise<string | null> => {
    if (sessionTokenPromise === null) {
      sessionTokenPromise = attestOwnerSession(url, socketPath, verbose);
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
  const sdkTransport = fetchTransport(url, { "X-User-Hash": userHash }, sessionHeader);

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
  const sdkClient = (blob: string | null, forAppId: string = appId): FoldDbClient =>
    new FoldDbClient(
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
      const { res, readBody } = await callNodeRaw(url, path, method, body, userHash, verbose, headers);
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
    verbose(`→ NODE POST ${url}/api/mutation (sdk) schema=${schemaHash} type=${kind}`);
    try {
      await withSessionRepair(() =>
        sdkClient(blob).mutate(schemaHash, {
          mutationType: kind,
          fields: fields as Record<string, SdkJsonValue>,
          key: { hash: keyHash, range: null },
        }),
      );
      verbose(`← NODE POST ${url}/api/mutation status=200`);
    } catch (err) {
      throw mapSdkDataError(err, url, "/api/mutation");
    }
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
            "(c) to start fresh, stop the daemon and clear its onboarding state (homebrew default: `rm -rf ~/.folddb/config/`), then re-run `fbrain init`.",
        });
      }
      throw mapNodeError(status, body, "/api/setup/bootstrap");
    },
    async requestConsent(consentAppId, scope) {
      // Rides the SDK client's consent flow, translated back to the raw
      // {status, body} contract the capability layer (and `fbrain doctor`'s
      // write-ready probe) branches on — 202 / 404 / 403 / 400 per the
      // consent contract.
      verbose(`→ NODE POST ${url}/api/apps/request-consent (sdk) app=${consentAppId} scope=${scope}`);
      try {
        const r = await withSessionRepair(() =>
          sdkClient(null, consentAppId).requestConsent(parseScope(scope)),
        );
        verbose(`← NODE POST ${url}/api/apps/request-consent status=202`);
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
          throw connectionError(url, "node", err);
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
          throw connectionError(url, "node", err);
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
        const body = await callJsonOk("/api/query", "POST", {
          schema_name: schemaHash,
          fields,
          limit: QUERY_PAGE_SIZE,
          offset,
        });
        const b = body as Record<string, unknown>;
        const pageResults = Array.isArray(b.results) ? (b.results as QueryRow[]) : [];
        if (typeof b.total_count === "number") lastTotalCount = b.total_count;
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
        const hasMore = b.has_more === true;
        if (!hasMore) break;
        if (newOnPage === 0) {
          throw new FbrainError({
            code: "query_pagination_stalled",
            message:
              `Node /api/query returned page ${page + 1} at offset=${offset} ` +
              `with only previously-seen record keys but reported has_more=true — ` +
              `fold_db_node's offset pagination is unstable on schemas larger than ` +
              `QUERY_PAGE_SIZE (${QUERY_PAGE_SIZE}) and would loop or truncate ${DOCTOR_TIP}.`,
            hint:
              "Upgrade the fold_db_node to a version with stable /api/query ordering, " +
              "or temporarily reduce the schema's row count below QUERY_PAGE_SIZE.",
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
            `was ${lastTotalCount}. fold_db_node's offset pagination silently dropped rows ` +
            `via overlapping pages ${DOCTOR_TIP}.`,
          hint:
            "Upgrade the fold_db_node to a version with stable /api/query ordering, " +
            "or temporarily reduce the schema's row count below QUERY_PAGE_SIZE.",
        });
      }
      return {
        ok: true,
        results: allResults,
        total_count: lastTotalCount ?? allResults.length,
        returned_count: allResults.length,
      };
    },
    async search(query, searchOpts) {
      const params = new URLSearchParams();
      params.set("q", query);
      if (searchOpts?.exact) params.set("exact", "true");
      if (typeof searchOpts?.minScore === "number") {
        params.set("min_score", String(searchOpts.minScore));
      }
      if (searchOpts?.schemas && searchOpts.schemas.length > 0) {
        params.set("schemas", searchOpts.schemas.join(","));
      }
      const path = `/api/native-index/search?${params.toString()}`;
      const { status, body } = await callJson(path, "GET");
      if (status !== 200) throw mapNodeError(status, body, "/api/native-index/search");
      const b = body as Record<string, unknown>;
      const hits = Array.isArray(b.results) ? (b.results as NativeIndexHit[]) : [];
      return hits;
    },
    async rawCall(method, path, body) {
      const { res, readBody } = await callNodeRaw(url, path, method, body, userHash, verbose, await sessionHeader());
      const text = await readBody({ asText: true });
      const json = parseJsonSafe(text);
      return { status: res.status, headers: res.headers, body: text, json };
    },
  };
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
): Promise<BoundedResponse> {
  return verboseFetch({
    baseUrl,
    path,
    method,
    body,
    verbose,
    service: "node",
    headers: { "X-User-Hash": userHash, ...(extraHeaders ?? {}) },
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
// so that stall used to hang the CLI unbounded. One AbortController governs
// both halves, and the timer is cleared the instant the body is fully read.
type ReadBody = {
  (opts: { asText: true }): Promise<string>;
  (opts?: { asText?: false }): Promise<unknown>;
};

type BoundedResponse = {
  res: Response;
  readBody: ReadBody;
};

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
}): Promise<BoundedResponse> {
  const url = `${opts.baseUrl}${opts.path}`;
  const tag = opts.service === "node" ? "NODE" : "SCHEMA";
  const headers = { ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const bodyStr =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  opts.verbose(
    `→ ${tag} ${opts.method} ${url}` + (bodyStr !== undefined ? ` body=${bodyStr}` : ""),
  );

  // One controller for the whole request lifecycle (headers + body). The timer
  // keeps running after the fetch resolves, so if the body read stalls past the
  // deadline the abort fires mid-`text()` and we map it to the same timeout
  // error. `done` guards the timer so a slow *consumer* can never trip it once
  // the I/O is already complete.
  const controller = new AbortController();
  let done = false;
  const timer = setTimeout(() => {
    if (!done) controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    opts.verbose(`← ${tag} ${opts.method} ${url} status=${res.status}`);
  } catch (err) {
    done = true;
    clearTimeout(timer);
    if (isTimeoutError(err)) {
      throw timeoutError(opts.path, opts.method, opts.service, timeoutMs, err);
    }
    throw connectionError(opts.baseUrl, opts.service, err);
  }

  const readBody = (async (readOpts?: { asText?: boolean }): Promise<unknown> => {
    try {
      const text = await res.text();
      done = true;
      clearTimeout(timer);
      if (readOpts?.asText) return text;
      return parseBody(text);
    } catch (err) {
      done = true;
      clearTimeout(timer);
      if (isTimeoutError(err)) {
        throw timeoutError(opts.path, opts.method, opts.service, timeoutMs, err);
      }
      throw connectionError(opts.baseUrl, opts.service, err);
    }
  }) as ReadBody;

  return { res, readBody };
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

// True when a node URL is the default homebrew daemon (`:9001` on
// loopback). A downloaded user runs exactly this; a fold contributor
// running `./run.sh` from source gets an auto-slotted port (9101+) or
// passes a custom `--node-url`.
export function isDefaultNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "9001"
    );
  } catch {
    return false;
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

// "Your node isn't reachable — start it" guidance. A downloaded user — port
// `:9001` OR the prebuilt `folddb` binary on PATH — gets the Homebrew action
// first; the from-source `./run.sh` + "compiling Rust" framing is only right
// when the user has no prebuilt binary (a genuine fold contributor running
// from source against a custom port).
export function nodeDownHint(
  url: string,
  isFolddbBinaryInstalled: () => boolean = defaultIsFolddbBinaryInstalled,
): string {
  if (isDefaultNodeUrl(url) || isFolddbBinaryInstalled()) {
    return "Start it: `brew services start folddb` (or `brew services restart folddb` after a `brew upgrade`). Contributors running from source: `cd fold/fold_db_node && ./run.sh --local`.";
  }
  return "Start your fold node, e.g. `cd fold/fold_db_node && ./run.sh --local` (first run compiles Rust — give it a few minutes).";
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

function connectionError(baseUrl: string, service: "node" | "schema", cause: unknown): FbrainError {
  const which = service === "node" ? "node" : "schema service";
  return new FbrainError({
    code: "service_unreachable",
    message: `${which} not reachable at ${baseUrl} ${DOCTOR_TIP}.`,
    hint: service === "node" ? nodeDownHint(baseUrl) : schemaDownHint(baseUrl),
    cause,
  });
}

// ---------------------------------------------------------------------------
// @folddb/app-sdk glue
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

      // The mutation (write) path runs through this transport, so it carries
      // the same joint fetch + body-read deadline as the raw node path: one
      // AbortController bounds both halves, the timer survives the fetch so a
      // body-read stall (cold-schema-init) is aborted too, and a deadline hit
      // surfaces as `service_timeout` with the idempotent-retry hint rather
      // than a silent unbounded hang. A genuine connect failure stays a
      // TransportError (→ service_unreachable) as before.
      const timeoutMs = defaultTimeoutMs();
      const controller = new AbortController();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
      }, timeoutMs);

      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
      } catch (err) {
        done = true;
        clearTimeout(timer);
        if (isTimeoutError(err)) throw timeoutError(path, method, "node", timeoutMs, err);
        throw new TransportError(
          `request to ${baseUrl}${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        done = true;
        clearTimeout(timer);
        if (isTimeoutError(err)) throw timeoutError(path, method, "node", timeoutMs, err);
        throw new TransportError(
          `reading response from ${baseUrl}${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      done = true;
      clearTimeout(timer);

      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
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
 * Translate an @folddb/app-sdk typed error back into fbrain's FbrainError
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
// True when an @folddb/app-sdk error represents the node's
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

function mapSdkDataError(err: unknown, baseUrl: string, path: string): FbrainError {
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
    return mapNodeError(400, { kind: err.kind, error: err.message }, path);
  }
  if (err instanceof UnexpectedResponseError) {
    return mapNodeError(err.status, err.body, path);
  }
  if (err instanceof TransportError) {
    return connectionError(baseUrl, "node", err);
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
              "`<node-data-dir>/folddb.sock` — for the default `:9001` brain that's `~/.folddb/data/folddb.sock`. " +
              "A from-source node (`./run.sh`) or one launched with a custom `FOLDDB_HOME` keeps its socket elsewhere. ") +
          "Point fbrain at the right socket with `FBRAIN_FOLDDB_SOCKET=/abs/path/to/folddb.sock` " +
          "(or `FOLDDB_HOME=<node-home>`), then re-run. The socket is created by the OS user that " +
          "owns the node, so run fbrain as that user on the same machine.",
        agentHint:
          `This node gates owner verbs behind an attested UDS control socket (fold#739). ${where}. ` +
          "Set the FBRAIN_FOLDDB_SOCKET env to the node's `<data-dir>/folddb.sock` (default brain: " +
          "`~/.folddb/data/folddb.sock`) and retry. fbrain must run as the OS user that owns the node.",
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
        "(homebrew: `folddb daemon stop && folddb daemon start`). " +
        "If the failure persists, run `fbrain doctor --freshness` and capture " +
        "the node log (the latest file under ~/Library/Logs/Homebrew/folddb/).",
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
  "fbrain's 8 schemas under `fbrain/*` are namespaced — POSTing them to the " +
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
  // `401 {"reason":"cert_required"}`. For fbrain — whose 8 schemas under
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
