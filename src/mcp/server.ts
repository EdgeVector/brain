// MCP server for fbrain — exposes both read (`fbrain_search`, `fbrain_ask`,
// `fbrain_get`, `fbrain_list`, `fbrain_backlinks`) and write (`fbrain_put`, `fbrain_status`,
// `fbrain_append`, `fbrain_delete`, `fbrain_link`) tools to MCP clients
// (Claude Code, Codex, etc.) over stdio. 10 tools total. `fbrain_status`
// (status-only patch) and `fbrain_append` (grow a body without a full
// rewrite) close the read/write asymmetry: without them the only write was
// `fbrain_put`, a FULL replace whose body defaults to empty, so the natural
// get(windowed)→edit→re-put loop silently truncated large records.
//
// Each handler wraps the existing CLI command function and captures its
// printed output as a single text content block. No shell-out — the
// command functions are called in-process so the agent sees the same
// results as the matching `fbrain` subcommand from the terminal.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";

import { getFbrainVersion } from "../version.ts";
import { ConfigInvalidError, ConfigMissingError, type Config } from "../config.ts";
import { searchCmd, type SearchHitJson } from "../commands/search.ts";
import { askCmd } from "../commands/ask.ts";
import { getRecord, formatRecordJsonWindow, type RecordJson } from "../commands/get.ts";
import { listCmd, type ListResult } from "../commands/list.ts";
import { parseUpdatedSince } from "../cli.ts";
import { putCmd } from "../commands/put.ts";
import { statusCmd, type StatusShowResult } from "../commands/status.ts";
import { appendCmd } from "../commands/append.ts";
import { deleteRecord } from "../commands/delete.ts";
import { linkCmd } from "../commands/link.ts";
import { backlinksCmd, type BacklinksJson } from "../commands/backlinks.ts";
import { FbrainError, newReadClientFromCfg, stripDoctorTip } from "../client.ts";
import { RECORD_TYPES } from "../schemas.ts";
import { establishConsentInline } from "../commands/init-consent.ts";
import {
  listLiveSlugsPage,
  schemaHashFor,
} from "../record.ts";

export const FBRAIN_MCP_NAME = "fbrain";
// The complete agent-integration surface this server exposes — 5 read tools
// + 5 write tools = 10. Single-sourced here so the `doctor --mcp` boot probe
// can assert the live `tools/list` reports EXACTLY this set (a renamed or
// dropped tool fails the probe) without re-listing the names. Keep in sync
// with the `registerTool` calls below.
export const FBRAIN_MCP_TOOL_NAMES = [
  "fbrain_search",
  "fbrain_ask",
  "fbrain_get",
  "fbrain_list",
  "fbrain_backlinks",
  "fbrain_put",
  "fbrain_status",
  "fbrain_append",
  "fbrain_delete",
  "fbrain_link",
] as const;
// Single-sourced via getFbrainVersion() so `fbrain --version` (cli.ts) and
// the MCP `serverInfo.version` reported here can't drift. Includes the git
// short-SHA suffix when the running source lives in a git checkout, so MCP
// clients (Claude Code, Codex) see the same build identifier the CLI does.
export const FBRAIN_MCP_VERSION: string = getFbrainVersion();

// Default idle-reap window: exit an MCP server that has received no request for
// 30 minutes. A host can abandon a stdio MCP server while keeping the pipe open,
// so transport close never fires and the process lingers. Reaping an idle server
// is transparent: the host respawns it on the next tool call. Override via
// FBRAIN_MCP_IDLE_TIMEOUT_MS; set it <= 0 to disable.
export const DEFAULT_MCP_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function mcpIdleTimeoutMs(): number {
  const raw = process.env.FBRAIN_MCP_IDLE_TIMEOUT_MS;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_MCP_IDLE_TIMEOUT_MS;
}

// Transport-agnostic idle reaper: touch() (re)starts the clock; if it elapses
// without another touch, onIdle fires. Pure + injectable for unit tests without
// real stdio transport or process.exit. Non-positive idleMs disables it.
export function makeIdleReaper(opts: { idleMs: number; onIdle?: () => void }): {
  enabled: boolean;
  touch: () => void;
  stop: () => void;
} {
  const onIdle = opts.onIdle ?? ((): void => process.exit(0));
  const enabled = Number.isFinite(opts.idleMs) && opts.idleMs > 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    enabled,
    touch() {
      if (!enabled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onIdle, opts.idleMs);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

// Config can be supplied two ways:
//   - `cfg`    — an already-loaded Config (the common case; what the CLI
//                `fbrain mcp` subcommand and the test suite pass).
//   - `getCfg` — a thunk that loads the Config on demand (calls `readConfig()`
//                inside). This is what the `fbrain-mcp` bin entrypoint passes
//                so the server can START even when no config exists yet: the
//                handshake + `tools/list` succeed, and config resolution is
//                deferred to the moment a tool is actually CALLED. A
//                `ConfigMissingError`/`ConfigInvalidError` thrown by the thunk
//                surfaces as a clean per-tool `isError` "run `fbrain init`"
//                hint (see the tool runners) instead of a server that dies on startup.
// Exactly one of the two is required; `cfg` is normalized to a `getCfg` thunk
// internally so every tool handler resolves config through the same lazy path.
//
// `autoGrant` is the ONLY non-config option: an injection seam for the cold-
// capability self-warm path (see runWriteTool / attemptAutoGrant). Production
// never sets it — the server uses the real `establishConsentInline` — but tests
// drive the retry deterministically without standing up a node or enabling
// enforcement (the unit suite runs with FBRAIN_APP_IDENTITY_ENFORCE=false, so
// the real write path never reaches the consent throw). It is gated behind the
// same opt-in env regardless, so wiring a stub can never auto-grant unless the
// operator opted in.
export type CreateServerOptions = (
  | { cfg: Config; getCfg?: undefined }
  | { getCfg: () => Config; cfg?: undefined }
) & {
  /** Test-only override for the cold-capability self-warm grant. */
  autoGrant?: AutoGrantFn;
};

// Performs a non-interactive consent grant against the configured node and
// resolves true if it landed a capability, false otherwise. Wraps
// `establishConsentInline(nonInteractiveGrant:true)` in production.
export type AutoGrantFn = (cfg: Config) => Promise<boolean>;

// Surfaced (as an `isError` tool result) when a tool is called on a server
// that started without a usable config — the new-developer case where
// `fbrain mcp` was registered before `fbrain init` ran. Actionable + concise:
// names the one command that fixes it and where it writes.
export const CONFIG_MISSING_HINT =
  "fbrain is not initialized on this machine — run `fbrain init` first " +
  "(writes ~/.fbrain/config.json), then retry.";

// Recovery hint surfaced when a required field arrives `undefined` — i.e. the
// tool was called with no value for it. The bite-y case is an empty `{}`: an
// MCP client occasionally delivers a tool call whose real arguments were
// dropped before reaching the server (observed repeatedly with large
// `fbrain_put` bodies in long agent sessions — the call lands with every
// field undefined). zod is the ONLY layer that sees this: the MCP SDK
// validates a tool's `inputSchema` and returns a JSON-RPC -32602 BEFORE the
// tool handler ever runs, so a handler-level guard would never fire on the
// real path. Putting the hint on the schema means the agent gets an
// actionable message instead of a bare "expected string, received undefined".
export const DROPPED_INPUT_HINT =
  "fbrain received no value for a required field — the tool arguments were " +
  "likely dropped before reaching the server. This happens when a call's " +
  "arguments are large (e.g. a `fbrain_put` body over ~1KB, or one with " +
  "newlines/emoji) in a long agent session: the oversized inline body fails " +
  "to parse or is dropped in transit before it reaches the server. RECOVER " +
  "by staging the body to a file and passing its path as `body_path` (a " +
  "short path always survives where a large inline `body` is dropped), or " +
  "pass `body_b64` (UTF-8 body bytes encoded as standard base64), or use the " +
  "CLI `fbrain put <slug> --type <type> < body.md`, or split the write into " +
  "smaller records.";

export const ASK_QUERY_REQUIRED_HINT =
  "fbrain_ask requires a non-empty `query` string (`question` is accepted " +
  "as an alias). Example: " +
  '`fbrain_ask({"query":"deployment rollback decision","limit":5})`.';

export const GET_SLUG_REQUIRED_HINT =
  "fbrain_get requires a non-empty `slug` string. Example: " +
  '`fbrain_get({"slug":"deployment-rollback-decision","type":"concept"})`. ' +
  "For fuzzy/text lookup, call fbrain_ask first.";

export const BACKLINKS_SLUG_REQUIRED_HINT =
  "fbrain_backlinks requires a non-empty `slug` string (the TARGET record " +
  "whose inbound links you want). Example: " +
  '`fbrain_backlinks({"slug":"deployment-rollback-decision"})`. ' +
  "To find a record by text instead, call fbrain_ask first.";

// Default char cap on the body a single `fbrain_get` returns. A record body
// counts toward the agent harness's tool-result token budget twice over (the
// human text block AND the `structuredContent` body), and a large note can be
// huge — the live repro was a 186,356-char project tracker (~47K tokens) that
// overflowed the budget outright, so `fbrain_get` returned a hard error and
// ZERO usable content. 40,000 chars is ~10K tokens, comfortably under the
// limit even counted twice, and big enough that almost every record fits in
// one window. Bodies at or under this cap (with offset 0) are returned whole
// and unchanged. Overridable per-call via the `body_limit` input.
export const FBRAIN_GET_BODY_LIMIT_DEFAULT = 40_000;

// Compute the body window for one `fbrain_get` call and the pagination
// metadata that tells the agent whether more remains. `offset`/`limit` are the
// (already-validated) request values; `total` is the full body length.
// Returns `truncated: false` with `next: null` for the common single-window
// case (the caller then OMITS the window fields entirely, preserving the
// pre-pagination result shape byte-for-byte). A window is "applied" whenever
// the body doesn't fit from `offset` in one `limit`-sized slice, OR a non-zero
// `offset` was requested (paging into a record is itself a windowed read).
export function bodyWindow(
  total: number,
  offset: number,
  limit: number,
): { start: number; end: number; truncated: boolean; next: number | null; windowed: boolean } {
  // Clamp the start into [0, total] so an over-large offset returns an empty
  // tail window (end-of-body) rather than a negative slice.
  const start = Math.min(Math.max(offset, 0), total);
  const end = Math.min(start + limit, total);
  const truncated = end < total;
  const windowed = truncated || start > 0;
  return { start, end, truncated, next: truncated ? end : null, windowed };
}

// ── Output schemas for the read tools ────────────────────────────────────
// Each read tool declares an `outputSchema` describing the typed JSON it
// returns in `structuredContent`, so an MCP client gets fields back instead
// of regex-parsing the human text block. The shapes are the SAME ones the
// CLI emits under `--json` — the command functions hand the exact value to
// the MCP layer via their `onResult` sink (one source of truth, no second
// divergent shape; see each command's `onResult` option).
//
// MCP requires `structuredContent` to be an OBJECT, so the array-returning
// tools (search/ask/list) wrap their array under a single named key
// (`matches` / `records`) rather than returning a bare array; `get` returns
// the single record object directly.

// One search/ask match: `{slug, score, type, title, snippet, confidence}` (mirrors
// SearchHitJson). `type` is the canonical lowercase RecordType so a client
// can match it against the input `type` filter verbatim; `score` is the
// 6-decimal-rounded relevance — a 0–1 cosine for search, but a SMALL fused
// RRF score for ask (a top ask hit is ~0.02–0.03, not 0–1, and not
// comparable to search's cosine; rank order is the signal, never magnitude)
// — and is `null` only when the node reported no score for a search hit.
// `snippet` is a short deterministic body extract (a window around the first
// matching query term, or the body head for a pure-vector hit) so an agent
// can read the answer inline without a follow-up `fbrain_get`. `confidence`
// labels the existing weak-match classifier: weak rows are additive closest
// candidates, not trusted answers.
const matchSchema = z.object({
  slug: z.string().describe("Record slug."),
  score: z
    .number()
    .nullable()
    .describe(
      "Relevance score. For search: a 0–1 cosine (higher = closer). For ask: a fused-RRF score that is SMALL by construction — a TOP hit is ~0.02–0.03, NOT a 0–1 relevance, and NOT comparable to search's cosine. Rank order (highest first) is the signal; do NOT apply an absolute magnitude threshold (e.g. 'ignore < 0.5') — that would silently discard every ask result. Null when unscored.",
    ),
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type."),
  title: z.string().describe("Record title."),
  snippet: z
    .string()
    .describe(
      "Short body extract (~120 chars) around the first matching query term — or the body head for a pure-vector hit — so the answer is visible inline without a follow-up fbrain_get. Empty only when the record body is empty.",
    ),
  confidence: z
    .enum(["strong", "weak", "fallback"])
    .describe(
      "Retrieval confidence label. `strong` = a real vector match. `weak` = the whole vector result set looks like a noise-floor band; treat rows as closest-known candidates, not trusted answers. `fallback` = a BM25 keyword-rescue row surfaced because the vector search found nothing usable (score is null, no semantic confidence). Any non-`strong` row makes the tool's `confident` flag false.",
    ),
});

const confidenceFromMatches = (matches: readonly SearchHitJson[]): boolean =>
  matches.length > 0 && matches.every((m) => m.confidence === "strong");

// One `fbrain_list` row — the compact summary the CLI `list --json` emits
// (body intentionally omitted; use `fbrain_get` for the full record).
const summarySchema = z.object({
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type."),
  slug: z.string().describe("Record slug."),
  title: z.string().describe("Record title."),
  status: z.string().describe("Status enum value for the type."),
  tags: z.array(z.string()).describe("Tag list."),
  design_slug: z
    .string()
    .optional()
    .describe("Parent design slug — only present on types that carry a design link."),
  created_at: z.string().describe("ISO-8601 creation timestamp."),
  updated_at: z.string().describe("ISO-8601 last-update timestamp."),
});

// The full single record `fbrain_get` returns (mirrors RecordJson) — the
// summary fields plus the markdown `body` and the optional design-link /
// child-task relationship fields.
const recordSchema = z.object({
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type."),
  slug: z.string().describe("Record slug."),
  title: z.string().describe("Record title."),
  status: z.string().describe("Status enum value for the type."),
  tags: z.array(z.string()).describe("Tag list."),
  design_slug: z
    .string()
    .optional()
    .describe("Parent design slug — only present on types that carry a design link."),
  design_missing: z
    .boolean()
    .optional()
    .describe("True when this record's parent design was deleted since the link was written."),
  children: z
    .array(z.object({ slug: z.string(), status: z.string() }))
    .optional()
    .describe("Child task summaries — only present for type=design."),
  linked_from: z
    .array(
      z.object({
        type: z.enum(RECORD_TYPES),
        slug: z.string(),
        status: z.string(),
        via: z.array(z.enum(["explicit", "body"])),
      }),
    )
    .optional()
    .describe(
      "Backlinks to this slug from explicit stored edges and body [[slug]] references.",
    ),
  created_at: z.string().describe("ISO-8601 creation timestamp."),
  updated_at: z.string().describe("ISO-8601 last-update timestamp."),
  body: z
    .string()
    .describe(
      "Markdown body. May be a WINDOW of the full body when it exceeds the char cap — see `bodyTruncated`/`bodyTotalChars`/`bodyNextOffset` (and the `[body truncated …]` note in the text rendering). Page to the rest by re-calling fbrain_get with `body_offset`.",
    ),
  // ── Body-pagination window fields ──────────────────────────────────────
  // `fbrain_get` caps how much of a record's body it returns in one call so a
  // large note (a 186K-char project tracker is ~47K tokens) can't overflow the
  // agent harness's tool-result token budget. When the body fits in one window
  // (≤ cap and offset 0) these fields are OMITTED entirely — the result is
  // byte-for-byte the pre-pagination shape, no regression for the common case.
  // They appear only when a window was applied (or a non-zero `body_offset`
  // was requested), and the `body` above is then the sliced window, not the
  // whole body.
  bodyTotalChars: z
    .number()
    .int()
    .optional()
    .describe(
      "Total length of the FULL body in characters (the window in `body` may be shorter). Present only when the body was windowed.",
    ),
  bodyOffset: z
    .number()
    .int()
    .optional()
    .describe(
      "Character offset into the full body where the returned `body` window starts. Present only when the body was windowed.",
    ),
  bodyTruncated: z
    .boolean()
    .optional()
    .describe(
      "True when `body` is a partial window of a larger body (more remains past this window). Present only when the body was windowed; absent (treat as false) for a single-window record.",
    ),
  bodyNextOffset: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "The `body_offset` to pass on the next fbrain_get call to read the following window; `null` when this window reaches the end of the body. Present only when the body was windowed.",
    ),
});

// ── Output schemas for the write tools ───────────────────────────────────
// Symmetric with the read tools above: each write tool declares an
// `outputSchema` describing the typed JSON it returns in `structuredContent`,
// so an agent can confirm its mutation landed (created vs updated, the
// resolved type/slug, soft-delete, the link pair) without regex-parsing the
// one-line English confirmation. Each shape is derived from the SAME value the
// command function / handler already computes for its printed line (the
// command's `onResult` sink), so structuredContent can't drift from the text.

// `fbrain_put` → `{action, type, slug}`, mirroring the CLI's
// `created|updated <type> <slug>` line. `action` distinguishes a fresh insert
// from an in-place update so an agent knows whether it created or overwrote.
const putResultSchema = z.object({
  action: z
    .enum(["created", "updated"])
    .describe("`created` for a new record, `updated` for an in-place re-put."),
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type written."),
  slug: z.string().describe("Resolved record slug."),
  // Read-after-write honesty for the agent loop. The write is ALWAYS
  // persisted and record-list-visible before `fbrain_put` returns (the
  // put's own verify-read guarantees that). `indexPending` reports the
  // separate, lagging VECTOR index: `true` means the just-written record
  // was NOT yet in the native (semantic) index when the short confirmation
  // budget expired, so an immediate `fbrain_search`/`fbrain_ask` in this
  // same session may not surface it yet (re-query in a moment). `false`
  // means it IS already vector-searchable. Defaults to `false` — the common
  // warm-node case where indexing caught up inside the budget.
  indexPending: z
    .boolean()
    .describe(
      "`true` only when the record landed but the semantic (vector) index " +
        "had not caught up within the post-write confirmation budget, so an " +
        "immediate fbrain_search/fbrain_ask may miss it — re-query shortly. " +
        "`false` (the default) means it is already vector-searchable.",
    ),
});

// `fbrain_delete` → `{action, type, slug, soft}`. `soft` is always `true` —
// fold_db is append-only, so every delete is a tombstone, never a hard delete.
const deleteResultSchema = z.object({
  action: z.literal("deleted").describe("Always `deleted`."),
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type deleted."),
  slug: z.string().describe("Resolved record slug."),
  soft: z
    .literal(true)
    .describe("Always true — the delete is a soft tombstone (fold_db is append-only)."),
});

const backlinksResultSchema = z.object({
  slug: z.string().describe("Target slug."),
  type: z.enum(RECORD_TYPES).optional().describe("Target type filter, when provided."),
  linked_from: z
    .array(
      z.object({
        type: z.enum(RECORD_TYPES),
        slug: z.string(),
        status: z.string(),
        via: z.array(z.enum(["explicit", "body"])),
      }),
    )
    .describe("Records linking to the target slug."),
});

// `fbrain_link` → `{action, from_type, from_slug, to_type, to_slug}`.
const linkResultSchema = z.object({
  action: z.literal("linked").describe("Always `linked`."),
  from_type: z.enum(RECORD_TYPES).describe("Source record type."),
  from_slug: z.string().describe("Source record slug."),
  to_type: z.enum(RECORD_TYPES).describe("Target record type."),
  to_slug: z.string().describe("Target record slug."),
});

// `fbrain_status` returns one of two payloads depending on how it was called:
//   • per-record patch (`slug` AND `status` given) → `{action:"status_changed",
//     type, slug, from, to}`, mirroring the CLI's `<type> <slug>: <from> → <to>`
//     transition line (`from`/`to` bracket the change).
//   • per-record READ (`slug` only, no `status`) → `{action:"status", type,
//     slug, status}` — the record's current status, no mutation. This mode
//     MUST emit structured content like every other: the tool declares an
//     outputSchema, and the SDK's validateToolOutput rejects any successful
//     result without structuredContent.
//   • node/overall status (NO `slug`) → `{action:"node_status", reachable,
//     provisioned, nodeUrl, version?, uptimeSeconds?, detail?}` — the health
//     check an agent expects from a bare `fbrain_status {}` (a READ; it never
//     touches the write/consent path, so it works with zero write capability).
//
// MCP builds a single `z.object` from the shape handed to `registerTool`, so
// the declared `outputSchema` can't be a bare union. Instead this LOOSE shape
// lets `action` be any of the three literals and marks every mode-specific
// field optional, so a `status_changed`, `status`, or `node_status` payload
// all validate.
const statusOutputShape = {
  action: z
    .enum(["status_changed", "status", "node_status"])
    .describe(
      "`status_changed` for a record status patch, `status` for a slug-only status read, `node_status` for a bare node/overall health check.",
    ),
  // ── status_changed (per-record patch) + status (per-record read) fields ──
  type: z
    .enum(RECORD_TYPES)
    .optional()
    .describe("Canonical lowercase record type (status_changed/status modes)."),
  slug: z.string().optional().describe("Resolved record slug (status_changed/status modes)."),
  from: z.string().optional().describe("The record's status BEFORE this mutation (status_changed mode)."),
  to: z.string().optional().describe("The record's status AFTER this mutation (status_changed mode)."),
  status: z
    .string()
    .optional()
    .describe("The record's CURRENT status (status mode — slug-only read)."),
  // ── node_status (bare call) fields ──
  reachable: z.boolean().optional().describe("True when the node answered the status probe (node_status mode)."),
  provisioned: z
    .boolean()
    .optional()
    .describe("True when the node has completed onboarding (node_status mode)."),
  nodeUrl: z.string().optional().describe("The configured node URL the probe targeted (node_status mode)."),
  version: z.string().optional().describe("Node release string, when reported (node_status mode)."),
  uptimeSeconds: z.number().optional().describe("Node uptime in seconds, when reported (node_status mode)."),
  detail: z
    .string()
    .optional()
    .describe("Reason when the node is unreachable or not provisioned (node_status mode)."),
};

// `fbrain_append` → `{action:"appended", type, slug, oldBodyChars, newBodyChars,
// bytesAppended}`. The char counts bracket the growth so an agent can confirm
// the body GREW (never shrank/truncated) — the whole point of the primitive.
const appendResultSchema = z.object({
  action: z.literal("appended").describe("Always `appended`."),
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type."),
  slug: z.string().describe("Resolved record slug."),
  oldBodyChars: z.number().int().describe("Body length in characters BEFORE the append."),
  newBodyChars: z.number().int().describe("Body length in characters AFTER the append."),
  bytesAppended: z
    .number()
    .int()
    .describe("Characters added (chunk length plus any auto-inserted separator)."),
});

// ── Cold-capability self-warm (opt-in) ───────────────────────────────────
// The MCP server is launched with FBRAIN_FORCE_FILE_KEYCHAIN=1, so it reads
// its write capability from the file store (~/.fbrain/capabilities/), not the
// OS keychain. `fbrain init --grant-consent` (the CLI default) warms only the
// keychain, so the file store stays cold and every MCP write fast-fails with
// `consent_required_non_interactive` ("No write capability is cached …"). The
// validated manual fix is `FBRAIN_FORCE_FILE_KEYCHAIN=1 fbrain init
// --grant-consent`, which warms the SAME file store the server reads.
//
// This self-warm path runs that grant automatically on the first cold-cache
// write — BUT ONLY when the operator opted in via FBRAIN_MCP_AUTO_GRANT_CONSENT.
// Security: auto-grant is no stronger than the owner running the grant by hand.
// `establishConsentInline(nonInteractiveGrant:true)` reuses the exact same
// machinery (`defaultRunFolddbGrant` shells out to `folddb consent grant
// fbrain --yes`, then `acquireCapability` polls + stores), which still requires
// an owner-local `folddb` on PATH and the node's master key to be available —
// the grant fast-fails otherwise. We do NOT touch FBRAIN_APP_IDENTITY_ENFORCE.
// The grant lands in the store `defaultCapabilityStore()` selects, which honors
// FBRAIN_FORCE_FILE_KEYCHAIN — so it warms precisely the store the server reads.

export const MCP_AUTO_GRANT_ENV = "FBRAIN_MCP_AUTO_GRANT_CONSENT";

// Opt-in gate. Off unless the operator set the env to an affirmative value, so
// the human consent gate is preserved by default — a cold-cache write
// fast-fails cleanly (with the existing agentHint) exactly as before.
export function mcpAutoGrantConsentEnabled(): boolean {
  const raw = process.env[MCP_AUTO_GRANT_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// True only for the one error a cold file-store capability raises on the MCP
// write path: `acquireCapability` fast-fails with this code when no capability
// is cached and it can't request a grant non-interactively (capability.ts).
function isColdCapabilityError(err: unknown): boolean {
  return err instanceof FbrainError && err.code === "consent_required_non_interactive";
}

// Production auto-grant: drive the same non-interactive grant `fbrain init
// --grant-consent` runs, against the configured node, writing into the store
// `defaultCapabilityStore()` selects (honoring FBRAIN_FORCE_FILE_KEYCHAIN). On
// any failure (folddb not on PATH, master key unavailable, denial, timeout) it
// returns false so the original cold-capability error surfaces unchanged —
// auto-grant never masks a genuine failure with a misleading message.
async function defaultAutoGrant(cfg: Config): Promise<boolean> {
  try {
    const result = await establishConsentInline({
      nodeUrl: cfg.nodeUrl,
      userHash: cfg.userHash,
      nonInteractiveGrant: true,
      // Swallow the inline grant's human-oriented progress lines — the MCP
      // channel surfaces only the tool result, and a failed grant falls
      // through to the original error below.
      print: () => {},
    });
    return result.state === "granted_inline" || result.state === "already_granted";
  } catch {
    // A genuine grant failure (denial/expiry/transport) — let the caller
    // surface the original cold-capability error rather than this one.
    return false;
  }
}

export function createFbrainMcpServer(opts: CreateServerOptions): McpServer {
  // Normalize both option shapes to a single lazy loader. When an eager `cfg`
  // is supplied it's wrapped in a thunk that just returns it, so the resolution
  // path is identical whether config was loaded up-front (CLI subcommand,
  // tests) or is deferred until first tool call (the `fbrain-mcp` bin, where
  // the server must start even with no config on disk).
  const getCfg: () => Config = opts.getCfg ?? (() => opts.cfg);
  // The cold-capability self-warm grant. Default = the real inline grant;
  // tests inject a stub. Either way it only runs when the operator opted in
  // (mcpAutoGrantConsentEnabled) — see runWriteTool.
  const autoGrant: AutoGrantFn = opts.autoGrant ?? defaultAutoGrant;
  const server = new McpServer({
    name: FBRAIN_MCP_NAME,
    version: FBRAIN_MCP_VERSION,
  });

  const typeEnum = z.enum(RECORD_TYPES);
  // Required, non-empty string. A *missing* value (`undefined`) means the
  // call arrived without this argument — almost always dropped input rather
  // than a deliberate omission — so swap the opaque "received undefined" for
  // DROPPED_INPUT_HINT. An empty string or a wrong type falls through to
  // zod's default message (returning `undefined` from the error map yields to
  // the next error source).
  const requiredText = (description: string) =>
    z
      .string({
        error: (issue) =>
          issue.input === undefined ? DROPPED_INPUT_HINT : undefined,
      })
      .min(1)
      .describe(description);
  const actionableRequiredText = (description: string, message: string) =>
    z
      .string({
        error: () => message,
      })
      .trim()
      .min(1, { error: message })
      .describe(description);

  server.registerTool(
    "fbrain_search",
    {
      title: "Search fbrain",
      description:
        "Pure-vector semantic search across indexed fbrain records (designs, tasks, concepts, preferences, references, agents, projects, spikes, sops). Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 9. Returns one line per match: `slug · score · type · title`, with a short matching body snippet under each. `structuredContent.matches[]` carries `{slug, score, type, title, snippet, confidence}` — the `snippet` is a deterministic ~120-char body extract around the first matching query term (body head for a pure-vector hit), so you can read the answer inline without a follow-up `fbrain_get`. `structuredContent.confident` is false when the result set looks like the noise floor; if `confident:false`, treat it as not-found and do not trust the rows. For better recall — especially on rare tokens, acronyms, and exact keyword matches that pure-vector ranks out — prefer `fbrain_ask`, which fuses BM25 + vector (the eval-winning hybrid). Escalate to `fbrain_ask` when this returns weak or missing matches.",
      inputSchema: {
        query: requiredText("Search query."),
        type: typeEnum
          .array()
          .optional()
          .describe(
            "Restrict results to one or more record types. Omit to search all types.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results (newest-first)."),
        exact: z
          .boolean()
          .optional()
          .describe("Exact-match mode (server-side ?exact=true)."),
        min_score: z
          .number()
          .optional()
          .describe("Server-side score floor (?min_score=F)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is `{ matches: [{slug,score,type,title,...}, …], confident }` —
      // the SAME array the CLI `--json` emits, wrapped under `matches`
      // because MCP requires structuredContent to be an object.
      outputSchema: {
        matches: z
          .array(matchSchema)
          .describe("Matches, highest score first (empty array on no matches)."),
        confident: z
          .boolean()
          .describe(
            "False when no strong match was found; treat `matches` as not-found/closest candidates rather than trusted answers.",
          ),
      },
    },
    (args) =>
      runReadTool<SearchHitJson[]>(
        getCfg,
        (cfg, print, onResult) =>
          searchCmd({
            cfg,
            query: args.query,
            print,
            // MCP bundles every printed line into one text block — fold
            // CLI-stderr advisories back into the same sink so agents still
            // see the weak-match note inline. The CLI uses its own default
            // (console.error) when no override is passed.
            printErr: print,
            limit: args.limit,
            exact: args.exact,
            minScore: args.min_score,
            types: args.type,
            onResult,
            // Agent channel: render the empty/no-match recovery hint in
            // MCP-tool terms (`fbrain_put`/`fbrain_ask`), never CLI verbs or
            // the no-MCP-tool `fbrain reindex` / repo doc-path dead-end.
            agent: true,
          }),
        (matches) => ({ matches, confident: confidenceFromMatches(matches) }),
      ),
  );

  server.registerTool(
    "fbrain_ask",
    {
      title: "Ask fbrain (hybrid retrieval)",
      description:
        "Hybrid retrieval over fbrain records: runs BM25 (keyword) AND vector (semantic) ranking and fuses them via Reciprocal Rank Fusion (RRF). This is the eval-winning, recommended primitive for recall — vector handles paraphrase while BM25 catches rare tokens, acronyms, and exact-keyword matches the embedding model misses, so `fbrain_ask` surfaces keyword-relevant records that pure-vector `fbrain_search` ranks out of the top results. Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 9. Returns a best-first ranked list, one line per match: `rank · slug · type · title`, with a short matching body snippet under each. `structuredContent.matches[]` carries `{slug, score, type, title, snippet, confidence}` (already ordered best-first) — the `snippet` is a deterministic ~120-char body extract around the first matching query term (body head for a pure-vector hit), so you can read the answer inline without a follow-up `fbrain_get`. `structuredContent.confident` is false when the whole result set looks like the noise floor; if `confident:false`, treat it as not-found and do not trust the rows. The `score` is a fused-RRF value that is SMALL by construction — a TOP hit is ~0.02–0.03, NOT a 0–1 relevance and NOT comparable to `fbrain_search`'s cosine; read rank order, never magnitude. Needs no API key (LLM query expansion is intentionally not used here). Prefer this over `fbrain_search` when you want the best recall.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Search query. `question` is accepted as an alias — pass either " +
              "(agents naturally reach for `question`). At least one is required.",
          ),
        question: z
          .string()
          .optional()
          .describe(
            "Alias for `query` — the natural param name agents guess. Mapped " +
              "to `query` when `query` is absent. Pass one of `query`/`question`.",
          ),
        type: typeEnum
          .array()
          .optional()
          .describe(
            "Restrict results to one or more record types. Omit to search all types.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is `{ matches: [{slug,score,type,title,...}, …], confident }` —
      // identical shape to `fbrain_search`; `score` here is the fused RRF
      // score (always non-null for ask hits) — small by construction (a top
      // hit is ~0.02–0.03), so rank, never magnitude, is the signal.
      outputSchema: {
        matches: z
          .array(matchSchema)
          .describe(
            "Fused (BM25 + vector) matches, highest score first (empty on no matches). Scores are small by construction (a top hit is ~0.02–0.03) and are NOT comparable to fbrain_search's 0–1 cosine — read rank order, not magnitude.",
          ),
        confident: z
          .boolean()
          .describe(
            "False when no strong match was found; treat `matches` as not-found/closest candidates rather than trusted answers.",
          ),
      },
    },
    (args) =>
      runReadTool<SearchHitJson[]>(
        getCfg,
        async (cfg, print, onResult) => {
          // Accept `question` as an alias for `query`: map it in when `query`
          // is absent. Neither present (or all-whitespace) → the same
          // actionable hint the old required-`query` schema raised, so a bare
          // call still gets a helpful example instead of an opaque arg error.
          const resolvedQuery = resolveAskQuery(args);
          await askCmd({
            cfg,
            query: resolvedQuery,
            print,
            // MCP bundles every printed line into one text block — fold
            // CLI-stderr advisories (e.g. the all-stopword note) back into
            // the same sink so agents see them inline, matching the search
            // handler. The CLI uses its own default (console.error) otherwise.
            printErr: print,
            limit: args.limit,
            types: args.type,
            onResult,
            // Agent channel: render the empty-brain recovery hint in MCP-tool
            // terms (`fbrain_put`), never the `fbrain <type> new` CLI verb.
            agent: true,
            // LLM query expansion stays OFF (the default): the eval winner is
            // plain BM25 + vector + RRF, and keeping it off means the tool
            // works for any agent with zero extra config (no API key). A
            // follow-up can add an optional `expand` param if wanted.
          });
        },
        (matches) => ({ matches, confident: confidenceFromMatches(matches) }),
      ),
  );

  server.registerTool(
    "fbrain_get",
    {
      title: "Get fbrain record",
      description:
        "Print a single fbrain record by slug. The ONLY lookup key is `slug` " +
        "(plus optional `type`) — there is no `query`/`key`/`id` argument; for " +
        "text or fuzzy lookup use `fbrain_search` instead. Without `type`, " +
        "queries every registered schema and errors if the slug exists in " +
        "multiple types. Large bodies are PAGINATED: the body is capped at " +
        `~${FBRAIN_GET_BODY_LIMIT_DEFAULT.toLocaleString("en-US")} chars per ` +
        "call so a big record (a long design/project note) can't overflow the " +
        "tool-result token budget. When the body is windowed the result carries " +
        "`bodyTruncated=true`, `bodyTotalChars`, `bodyOffset`, and `bodyNextOffset` " +
        "(and a `[body truncated …]` note in the text); read the rest by re-calling " +
        "fbrain_get with `body_offset` set to the previous `bodyNextOffset` (repeat " +
        "until `bodyNextOffset` is null). `body_limit` overrides the per-call cap. " +
        "A record that fits in one window returns unchanged (no window fields).",
      inputSchema: {
        slug: actionableRequiredText("Record slug.", GET_SLUG_REQUIRED_HINT),
        type: typeEnum
          .optional()
          .describe(
            "Restrict lookup to one record type. Omit to search all types.",
          ),
        body_offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Character offset into the body to start the returned window at (default 0 = body head). Set to a prior response's `bodyNextOffset` to page to the next window of a large body.",
          ),
        body_limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Max body characters to return in this call (default ~${FBRAIN_GET_BODY_LIMIT_DEFAULT.toLocaleString("en-US")}, ~10K tokens). Lower it to stay further under the token budget; the metadata + non-body fields are always returned.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is the single record object (the SAME shape the
      // CLI `get --json` emits, plus the optional body-window fields). Unlike
      // the array tools there's nothing to wrap — the record is already an
      // object.
      outputSchema: recordSchema.shape,
    },
    (args) =>
      runGetTool(getCfg, {
        slug: args.slug,
        type: args.type,
        bodyOffset: args.body_offset ?? 0,
        bodyLimit: args.body_limit ?? FBRAIN_GET_BODY_LIMIT_DEFAULT,
      }),
  );

  server.registerTool(
    "fbrain_list",
    {
      title: "List fbrain records",
      description:
        "List records (newest-first), optionally filtered by type/status/tag and " +
        "`updated_since` (records changed at/after an instant). Page past `limit` " +
        "with `offset`. Set `count: true` for a match count only (no bodies) — the " +
        "cheap way to answer \"how many …\". Output: `type · slug · status · title " +
        "[tags]` per line (or a bare number in count mode).",
      inputSchema: {
        type: typeEnum.optional().describe("Restrict to one record type."),
        status: z
          .string()
          .optional()
          .describe("Filter by status enum value."),
        tag: z.string().optional().describe("Filter by tag membership."),
        updated_since: z
          .string()
          .optional()
          .describe(
            "Keep only records updated at/after this instant — an ISO-8601 " +
              "timestamp (`2026-07-01T12:00:00Z`) or a relative window token " +
              "(`45s`, `30m`, `24h`, `7d`, `2w`).",
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Skip the first N matches (after filter+sort) before `limit` applies — " +
              "pages past `limit` (offset 50 + limit 50 → records 51–100).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results."),
        count: z
          .boolean()
          .optional()
          .describe(
            "Count-only mode: return just how many records match the filters " +
              "(no bodies). Ignores offset/limit (a count is of the whole match set).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is either `{ records: [summary, …] }` (row mode —
      // the SAME array the CLI `list --json` emits, body omitted; use
      // `fbrain_get` for the full record) or `{ count: N }` (count mode).
      outputSchema: {
        records: z
          .array(summarySchema)
          .optional()
          .describe(
            "Record summaries, newest-first (empty array on no records). " +
              "Present in row mode; absent when `count` is set.",
          ),
        count: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Number of matching records. Present only when `count` is set."),
      },
    },
    (args) =>
      runReadTool<ListResult>(
        getCfg,
        (cfg, print, onResult) => {
          const listOpts: Parameters<typeof listCmd>[0] = {
            cfg,
            print,
            type: args.type,
            status: args.status,
            tag: args.tag,
            offset: args.offset,
            limit: args.limit,
            count: args.count,
            onResult,
            // Agent channel: render the empty/filter-no-match recovery hint in
            // MCP-tool terms (`fbrain_put`/`fbrain_list`), never CLI verbs.
            agent: true,
          };
          if (args.updated_since !== undefined) {
            listOpts.updatedSinceMs = parseUpdatedSince(args.updated_since);
          }
          return listCmd(listOpts);
        },
        (result) =>
          Array.isArray(result) ? { records: result } : { count: result.count },
      ),
  );

  server.registerTool(
    "fbrain_backlinks",
    {
      title: "List fbrain backlinks",
      description:
        "List records that link to a target slug through explicit stored edges " +
        "or body [[slug]] references. This read does not require the target " +
        "record to exist, so dangling wiki-link intent remains queryable. " +
        "Pass `type` to filter typed explicit edges; body refs are slug-only.",
      inputSchema: {
        slug: actionableRequiredText("Target slug.", BACKLINKS_SLUG_REQUIRED_HINT),
        type: typeEnum
          .optional()
          .describe("Optional target type filter for typed explicit edges."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      outputSchema: backlinksResultSchema.shape,
    },
    (args) =>
      runReadTool<BacklinksJson>(
        getCfg,
        (cfg, print, onResult) =>
          backlinksCmd({
            cfg,
            slug: args.slug,
            type: args.type,
            print,
            onResult,
          }),
        (result) => result,
      ),
  );

  server.registerTool(
    "fbrain_put",
    {
      title: "Put fbrain record",
      description:
        "Upsert a record. Re-puts update in place — no duplicate, no 409. " +
        "One of `type` or a `type:` field in `frontmatter` is required — " +
        "there is NO silent default. If `frontmatter` is provided it is " +
        "used verbatim (without the `---` fences); otherwise frontmatter is " +
        "synthesized from `type`, `title`, `tags`, and `status`. For a large " +
        "or multiline body, pass `body_b64` (UTF-8 body bytes encoded as " +
        "standard base64) or stage it to a file and pass `body_path` instead " +
        "of inlining `body` — a long inline `body` can be silently dropped " +
        "in transit in long sessions, whereas these shorter arguments " +
        "survive. Returns " +
        "one line: `created|updated <type> <slug>`. Before returning, the " +
        "write is confirmed read-after-write consistent: the record is " +
        "record-list-visible AND a short bounded poll waits for it to land in " +
        "the semantic (vector) index, so an immediate follow-up " +
        "`fbrain_search`/`fbrain_ask` in the same session returns it. If the " +
        "vector index has not caught up within that budget the write still " +
        "succeeds but `indexPending: true` is set (and noted in the text) so " +
        "you know to re-query shortly.",
      inputSchema: {
        slug: requiredText("Record slug (lowercase, [a-z0-9-_])."),
        type: typeEnum
          .optional()
          .describe(
            "Record type. Required unless a `type:` field is set in " +
              "`frontmatter` — there is no silent default.",
          ),
        title: z
          .string()
          .optional()
          .describe("Record title. Defaults to first H1 in body, else slug."),
        body: z
          .string()
          .optional()
          .describe(
            "Markdown body (indexed for search). Defaults to empty. For a " +
              "body over ~1KB or one containing newlines/emoji, DO NOT inline " +
              "it here — stage it to a file and pass `body_path`, or pass " +
              "`body_b64`. A long or multiline inline `body` can fail to " +
              "parse or be dropped in transit before it ever reaches the " +
              "server; `body_path` (a short path) always survives. Mutually " +
              "exclusive with `body_path` and `body_b64`.",
          ),
        body_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to a UTF-8 file whose contents become the body. " +
              "Use this instead of `body` for large records: a path is a " +
              "short argument that survives the input-dropping that truncates " +
              "a long inline `body` in long agent sessions. Mutually " +
              "exclusive with `body` and `body_b64`.",
          ),
        body_b64: z
          .string()
          .optional()
          .describe(
            "Standard base64 encoding of the UTF-8 markdown body bytes. Use " +
              "this instead of inline `body` for multiline, emoji, or large " +
              "records to avoid JSON string escaping failures. Whitespace is " +
              "ignored. Mutually exclusive with `body` and `body_path`.",
          ),
        status: z
          .string()
          .optional()
          .describe(
            "Status enum value for the type. Valid values DIFFER per type — " +
              "`active` is accepted by concept/preference/reference/agent/spike/sop " +
              "but is NOT valid for project, design, or task. Per type: " +
              "design = draft|reviewed|approved|implemented|archived; " +
              "task = open|in_progress|blocked|done|cancelled; " +
              "project = planning|in_progress|done|archived; " +
              "concept/agent = active|archived; " +
              "preference = active|superseded; " +
              "reference = active|broken|archived; " +
              "spike = active|concluded; " +
              "sop = active|superseded|archived. Omit to use the type's default " +
              "(first enum value). Synthesized into the put's frontmatter so " +
              "it lands atomically in the same mutation and is validated " +
              "against the type's enum BEFORE any HTTP write — an invalid " +
              "status errors out without persisting a partial record. Ignored " +
              "when raw `frontmatter` is supplied (set `status:` in the " +
              "frontmatter directly).",
          ),
        tags: z
          .preprocess((v) => normalizeTagsArg(v), z.array(z.string()))
          .optional()
          .describe(
            "Tag list. Replaces existing tags on update. A string is accepted as one tag, or split on commas.",
          ),
        frontmatter: z
          .string()
          .optional()
          .describe(
            "Raw YAML-subset frontmatter (no `---` fences). When set, " +
              "overrides synthesis from `type`/`title`/`tags`.",
          ),
        allow_shrink: z
          .boolean()
          .optional()
          .describe(
            "Bypass the body-shrink guard. fbrain_put is a FULL REPLACE, so a " +
              "re-put whose body drops >half of an existing non-empty body — or " +
              "clears it to empty — is REFUSED with `body_shrink_guard` by " +
              "default (the common get(windowed)→edit→re-put truncation, or a " +
              "status-only re-put that wipes the body). To ADD to a body without " +
              "a rewrite use `fbrain_append`; to change only status use " +
              "`fbrain_status`. Set `allow_shrink: true` ONLY to truncate on " +
              "purpose.",
          ),
      },
      // `structuredContent` is `{action, type, slug, indexPending}` — the
      // first three are the SAME values that compose the
      // `created|updated <type> <slug>` text line (so the typed output can't
      // drift from the prose fallback); `indexPending` is the read-after-write
      // honesty signal added by the post-write vector-index confirmation below.
      outputSchema: putResultSchema.shape,
    },
    (args) =>
      runWriteTool(getCfg, autoGrant, async (cfg, print, onResult) => {
        // Strip the non-body `allow_shrink` control before body resolution so
        // it never leaks into synthesized frontmatter; thread it to putCmd's
        // shrink guard below.
        const { allow_shrink, ...putArgs } = args;
        const input = buildPutInput(resolvePutBody(putArgs));
        // Read-after-write confirmation for the agent loop. `putCmd` already
        // guarantees the row is record-list-visible (its own verify-read), AND
        // — as of the CLI search-parity change (#295 CLI half) — confirms the
        // record landed in the SEMANTIC (vector) index that
        // `fbrain_search`/`fbrain_ask` read, surfacing `result.indexPending`.
        // fold_db indexes the embedding asynchronously AFTER the mutation
        // returns, so in one warm process a follow-up search can fire inside
        // that sub-second window and miss the just-written record; `putCmd`'s
        // bounded confirmation closes that window (or, on timeout, reports
        // `indexPending: true`). It NEVER fails or blocks a persisted write.
        // We just thread its result through to the agent — the deeper
        // server-side synchronous-indexing change is a separate fold/native-
        // index item (docs/phase-7-search-latency-spike.md, G3d/G3e).
        const result = await putCmd({
          cfg,
          slug: args.slug,
          input,
          allowShrink: allow_shrink === true,
        });
        const indexPending = result.indexPending;
        print(
          `${result.action} ${result.type} ${result.slug}` +
            (indexPending
              ? " (indexPending: semantic index catching up — an immediate search may miss it; re-query shortly)"
              : ""),
        );
        onResult({
          action: result.action,
          type: result.type,
          slug: result.slug,
          indexPending,
        });
      }),
  );

  server.registerTool(
    "fbrain_status",
    {
      title: "Get or set fbrain status",
      description:
        "Three modes, keyed on `slug`/`status`:\n" +
        "• With NO `slug` → NODE/OVERALL STATUS: a cheap health check of the " +
        "configured LastDB node (reachable? provisioned? version/uptime). This " +
        "is a READ — it needs no write capability. A bare `fbrain_status {}` " +
        "returns this instead of erroring on a missing slug.\n" +
        "• With a `slug` but NO `status` → READ one record's current status " +
        "(`{action:\"status\", slug, type, status}`). Also a read — no write " +
        "capability, no mutation.\n" +
        "• With a `slug` and `status` → PATCH one record's status WITHOUT a " +
        "full re-put: reads the live record, swaps in the new `status`, and " +
        "writes back preserving body/title/tags/created_at. Prefer this over " +
        "`fbrain_put` for a status change (`fbrain_put` is a FULL REPLACE whose " +
        "body defaults to empty, so a status-only re-put WIPES the body). The " +
        "status is validated against the resolved type's enum BEFORE any write. " +
        "Without `type`, resolves across every type and errors on an ambiguous " +
        "slug. Returns one line: `<type> <slug>: <from> → <to>`.",
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe(
            "Record slug to read or patch. OMIT to get the node/overall " +
              "status (a bare `fbrain_status {}` is a node health check). " +
              "With `slug` but no `status`, reads the record's current status.",
          ),
        status: z
          .string()
          .optional()
          .describe(
            "New status enum value for the record's type (pass with `slug` " +
              "to patch; omit to READ the record's current status). Valid " +
              "values DIFFER per type: " +
              "design = draft|reviewed|approved|implemented|archived; " +
              "task = open|in_progress|blocked|done|cancelled; " +
              "project = planning|in_progress|done|archived; " +
              "concept/agent = active|archived; " +
              "preference = active|superseded; " +
              "reference = active|broken|archived; " +
              "spike = active|concluded; " +
              "sop = active|superseded|archived. Validated before any write — an " +
              "invalid value errors without mutating.",
          ),
        type: typeEnum
          .optional()
          .describe(
            "Restrict lookup to one record type. Omit to resolve across all " +
              "types (errors on an ambiguous slug). Ignored in node-status mode.",
          ),
      },
      // `structuredContent` is `{action:"status_changed", …}` (patch),
      // `{action:"status", …}` (slug-only read), or `{action:"node_status", …}`
      // (bare call) — the loose shape accepts all three.
      outputSchema: statusOutputShape,
    },
    (args) => {
      // No slug → node/overall status. This is a READ (auto-identity + health),
      // so it runs on the read path and never demands write capability. This is
      // the papercut fix: a bare `fbrain_status {}` health check no longer
      // errors on a missing slug.
      if (args.slug === undefined || args.slug.trim().length === 0) {
        return runReadTool<NodeStatusPayload>(
          getCfg,
          async (cfg, print, onResult) => {
            const payload = await probeNodeStatus(cfg);
            print(renderNodeStatus(payload));
            onResult(payload);
          },
          (payload) => payload as unknown as Record<string, unknown>,
        );
      }
      // Slug WITHOUT a status → per-record status READ (show mode). This must
      // run on the read runner (no write capability) AND emit structured
      // content: the tool declares an outputSchema, so the MCP SDK's
      // validateToolOutput rejects any successful result without
      // `structuredContent`. (Routing this through the write runner used to
      // return text-only output — the SDK then threw "has an output schema but
      // no structured content".)
      if (args.status === undefined) {
        return runReadTool<StatusShowResult>(
          getCfg,
          (cfg, print, onResult) =>
            statusCmd({
              cfg,
              slug: args.slug!,
              type: args.type,
              print,
              onResult: (r) => onResult(r as StatusShowResult),
            }),
          (payload) => payload as unknown as Record<string, unknown>,
        );
      }
      // Slug + status → the original per-record status patch (a write).
      return runWriteTool(getCfg, autoGrant, (cfg, print, onResult) =>
        statusCmd({
          cfg,
          slug: args.slug!,
          newStatus: args.status,
          type: args.type,
          print,
          onResult: (r) => onResult(r),
        }),
      );
    },
  );

  server.registerTool(
    "fbrain_append",
    {
      title: "Append to fbrain record body",
      description:
        "Append a chunk to an existing record's body WITHOUT a full rewrite. " +
        "This is the primitive that unblocks growing a LARGE record: " +
        "`fbrain_get` WINDOWS a big body (~40K chars) and `fbrain_put` is a " +
        "full replace, so the get→edit→re-put loop truncates past the window " +
        "AND times out on a big record. `fbrain_append` instead reads the " +
        "live record server-side (full body, no window), concatenates your " +
        "chunk, and writes it back preserving title/tags/status/created_at. " +
        "It can only GROW the body, so it never truncates and never trips the " +
        "put shrink guard. Pass the chunk as `chunk` (short/inline), " +
        "`chunk_b64` (multiline/emoji — standard base64 of the UTF-8 bytes), " +
        "or `chunk_path` (a large chunk staged to a file); exactly one is " +
        "required (`text` is accepted as an alias for `chunk` — the natural " +
        "param name agents reach for). A single blank line separates the " +
        "chunk from a non-empty body unless `raw:true`. Without `type`, " +
        "resolves across every type and errors on an ambiguous slug. Returns " +
        "one line: `appended <n> chars to <type> <slug> (<old> → <new>)`.",
      inputSchema: {
        slug: requiredText("Record slug."),
        chunk: z
          .string()
          .optional()
          .describe(
            "Text to append to the body. `text` is accepted as an alias — pass " +
              "either (agents naturally reach for `text`). For a large or " +
              "multiline chunk prefer `chunk_b64` or `chunk_path` — a long " +
              "inline `chunk` can be dropped in transit. Mutually exclusive " +
              "with `text`/`chunk_path`/`chunk_b64`.",
          ),
        text: z
          .string()
          .optional()
          .describe(
            "Alias for `chunk` — the natural param name agents guess. Mapped " +
              "to `chunk` when `chunk` is absent. Mutually exclusive with " +
              "`chunk`/`chunk_path`/`chunk_b64`.",
          ),
        chunk_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to a UTF-8 file whose contents are appended. Use for " +
              "a large chunk. Mutually exclusive with `chunk`/`chunk_b64`.",
          ),
        chunk_b64: z
          .string()
          .optional()
          .describe(
            "Standard base64 of the UTF-8 chunk bytes. Use for multiline/emoji " +
              "chunks to avoid JSON escaping issues. Whitespace ignored. " +
              "Mutually exclusive with `chunk`/`chunk_path`.",
          ),
        type: typeEnum
          .optional()
          .describe(
            "Restrict lookup to one record type. Omit to resolve across all " +
              "types (errors on an ambiguous slug).",
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            "Concatenate byte-exact (no auto-inserted blank-line separator).",
          ),
      },
      // `structuredContent` is `{action:"appended", type, slug, oldBodyChars,
      // newBodyChars, bytesAppended}` — the SAME values `appendCmd` prints via
      // its `onResult` sink.
      outputSchema: appendResultSchema.shape,
    },
    (args) =>
      runWriteTool(getCfg, autoGrant, (cfg, print, onResult) =>
        appendCmd({
          cfg,
          slug: args.slug,
          chunk: resolveAppendChunk(args),
          type: args.type,
          raw: args.raw,
          print,
          onResult: (r) => onResult(r),
        }),
      ),
  );

  server.registerTool(
    "fbrain_delete",
    {
      title: "Delete fbrain record",
      description:
        "Soft-delete a record. fold_db is append-only — the workaround " +
        "stamps a tombstone tag so every fbrain read path treats the " +
        "record as gone. Without `type`, probes every type and errors if " +
        "the slug exists in multiple. Deleting a design still referenced " +
        "by live tasks is blocked unless `force` is set (the slug becomes " +
        "reusable after delete).",
      inputSchema: {
        slug: requiredText("Record slug."),
        type: typeEnum
          .optional()
          .describe(
            "Restrict delete to one record type. Omit to probe all types " +
              "(errors on ambiguous slug).",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Delete a design even if live tasks still link to it, leaving " +
              "their design references dangling.",
          ),
      },
      // `structuredContent` is `{action:"deleted", type, slug, soft:true}` —
      // the SAME resolved type/slug `deleteRecord` prints, via its `onResult`
      // sink, so the typed output can't drift from the text line.
      outputSchema: deleteResultSchema.shape,
    },
    (args) =>
      runWriteTool(getCfg, autoGrant, (cfg, print, onResult) =>
        deleteRecord({
          cfg,
          slug: args.slug,
          print,
          type: args.type,
          force: args.force,
          onResult,
        }),
      ),
  );

  server.registerTool(
    "fbrain_link",
    {
      title: "Link fbrain records",
      description:
        "Link fbrain records. Pass just `{from_slug, to_slug}` for the " +
        "legacy task → design pair; `from_type`/`to_type` default to " +
        "`task`/`design`. Other type pairs are valid explicit stored edges " +
        "and are recorded on the source as a generic link tag. Missing " +
        "explicit targets are rejected.",
      inputSchema: {
        from_slug: requiredText("Slug of the source record to link."),
        to_slug: requiredText("Slug of the target record to link to."),
        from_type: typeEnum.default("task").describe("Source record type (default task)."),
        to_type: typeEnum.default("design").describe("Target record type (default design)."),
      },
      // `structuredContent` is `{action:"linked", from_type, from_slug,
      // to_type, to_slug}` — the SAME normalized slugs `linkCmd` prints, via
      // its `onResult` sink.
      outputSchema: linkResultSchema.shape,
    },
    (args) =>
      runWriteTool(getCfg, autoGrant, async (cfg, print, onResult) => {
        await linkCmd({
          cfg,
          taskSlug: args.from_slug,
          designSlug: args.to_slug,
          fromSlug: args.from_slug,
          toSlug: args.to_slug,
          fromType: args.from_type,
          toType: args.to_type,
          print,
          onResult,
        });
      }),
  );

  return server;
}

// Resolve `fbrain_ask`'s query, accepting `question` as an alias for `query`
// (agents naturally guess `question`). `query` wins when both are present.
// Neither present, or all-whitespace → the same actionable hint the old
// required-`query` schema raised, surfaced through `runReadTool`'s error
// envelope so a bare call still gets a helpful example.
export function resolveAskQuery(args: { query?: string; question?: string }): string {
  const raw = args.query ?? args.question;
  if (raw === undefined || raw.trim().length === 0) {
    throw new FbrainError({
      code: "missing_query",
      message: ASK_QUERY_REQUIRED_HINT,
      agentHint: ASK_QUERY_REQUIRED_HINT,
    });
  }
  return raw;
}

// The structured payload `fbrain_status {}` returns: a node/overall health
// snapshot (mirrors nodeStatusResultSchema).
export type NodeStatusPayload = {
  action: "node_status";
  reachable: boolean;
  provisioned: boolean;
  nodeUrl: string;
  version?: string;
  uptimeSeconds?: number;
  detail?: string;
};

// Probe the configured node's overall status via the read client: auto-identity
// (reachable + provisioned) and health (version/uptime). Best-effort — a
// probe failure is reported as `reachable:false` with a detail, never thrown,
// so a bare `fbrain_status {}` always returns a status object rather than an
// error envelope for a merely-down node.
export async function probeNodeStatus(cfg: Config): Promise<NodeStatusPayload> {
  const node = newReadClientFromCfg(cfg);
  const payload: NodeStatusPayload = {
    action: "node_status",
    reachable: false,
    provisioned: false,
    nodeUrl: cfg.nodeUrl,
  };
  try {
    const identity = await node.autoIdentity();
    payload.reachable = true;
    payload.provisioned = identity.provisioned;
    if (!identity.provisioned) payload.detail = identity.reason;
  } catch (err) {
    payload.reachable = false;
    payload.detail =
      err instanceof FbrainError
        ? stripDoctorTip(err.message)
        : err instanceof Error
          ? err.message
          : String(err);
    return payload;
  }
  // Health is informational — a failure here doesn't flip `reachable` (the
  // auto-identity probe already answered that); we just skip version/uptime.
  try {
    const health = await node.health();
    if (health.version !== undefined) payload.version = health.version;
    if (health.uptime_s !== undefined) payload.uptimeSeconds = health.uptime_s;
  } catch {
    // best-effort; leave version/uptime unset.
  }
  return payload;
}

// One-line human rendering of the node/overall status, mirroring the terse
// style of the other MCP text blocks.
export function renderNodeStatus(p: NodeStatusPayload): string {
  if (!p.reachable) {
    return `node ${p.nodeUrl}: unreachable${p.detail ? ` (${p.detail})` : ""}`;
  }
  const bits: string[] = [p.provisioned ? "provisioned" : "not provisioned"];
  if (p.version !== undefined) bits.push(`v${p.version}`);
  if (p.uptimeSeconds !== undefined) bits.push(`up ${p.uptimeSeconds}s`);
  if (!p.provisioned && p.detail) bits.push(`(${p.detail})`);
  return `node ${p.nodeUrl}: reachable, ${bits.join(", ")}`;
}

type PutArgs = {
  slug: string;
  type?: string;
  title?: string;
  body?: string;
  status?: string;
  tags?: string[] | string;
  frontmatter?: string;
};

// When `body_path` or `body_b64` is set, resolve it into a normal inline
// string before serialization. Both are short transport-safe alternatives to a
// long/multiline inline `body`: `body_path` reads from a staged UTF-8 file, and
// `body_b64` keeps multiline/emoji text out of JSON string escaping entirely.
// The three body sources are mutually exclusive. Returns normalized PutArgs
// (no `body_path`/`body_b64`) so buildPutInput stays a pure function.
export function resolvePutBody(args: PutArgs & { body_path?: string; body_b64?: string }): PutArgs {
  const { body_path, body_b64, ...rest } = args;
  const sources = [rest.body, body_path, body_b64].filter((v) => v !== undefined);
  if (sources.length > 1) {
    throw new FbrainError({
      code: "multiple_body_sources",
      message: "fbrain_put: pass only one of `body`, `body_path`, or `body_b64`.",
      hint: "Use `body_b64` for inline multiline/emoji bodies, or `body_path` for large bodies; do not combine them.",
    });
  }
  if (sources.length === 0) return rest;
  if (rest.body !== undefined) return rest;
  if (body_b64 !== undefined)
    return { ...rest, body: decodeB64Field(body_b64, "fbrain_put", "body_b64") };

  let body: string;
  try {
    body = readFileSync(body_path!, "utf8");
  } catch (err) {
    throw new FbrainError({
      code: "body_path_unreadable",
      message:
        `fbrain_put: could not read body_path '${body_path!}': ` +
        (err instanceof Error ? err.message : String(err)),
      hint: "Pass an absolute path to a readable UTF-8 file.",
    });
  }
  return { ...rest, body };
}

type AppendChunkArgs = {
  chunk?: string;
  // `text` is an alias for `chunk` — the natural param name agents guess.
  // Both are plain inline strings; `chunk` wins when both are present.
  text?: string;
  chunk_path?: string;
  chunk_b64?: string;
};

// Resolve the append chunk from exactly one of `chunk` (alias: `text`) /
// `chunk_path` / `chunk_b64`, mirroring `resolvePutBody`'s three-source
// contract (a path or base64 survives the input-dropping that truncates a
// long inline value). `text` is folded into `chunk` first (agents naturally
// reach for `text`); `chunk` wins when both are present. All unset errors —
// appendCmd separately rejects an empty resolved chunk.
export function resolveAppendChunk(args: AppendChunkArgs): string {
  // `text` is an alias for `chunk`: fold it in when `chunk` is absent so the
  // rest of the mutual-exclusion + source-count logic sees a single inline
  // source. `chunk` wins when both are present (mirrors `query`/`question`).
  const inlineChunk = args.chunk ?? args.text;
  const sources = [inlineChunk, args.chunk_path, args.chunk_b64].filter(
    (v) => v !== undefined,
  );
  if (sources.length > 1) {
    throw new FbrainError({
      code: "multiple_chunk_sources",
      message:
        "fbrain_append: pass only one of `chunk` (alias `text`), `chunk_path`, or `chunk_b64`.",
      hint: "Use `chunk_b64` for inline multiline/emoji chunks, or `chunk_path` for large chunks; do not combine them.",
    });
  }
  if (sources.length === 0) {
    throw new FbrainError({
      code: "missing_chunk",
      message:
        "fbrain_append: one of `chunk` (alias `text`), `chunk_path`, or `chunk_b64` is required.",
      hint: "Pass the text to append as `chunk`/`text` (inline), `chunk_b64` (base64), or `chunk_path` (a staged file).",
    });
  }
  if (inlineChunk !== undefined) return inlineChunk;
  if (args.chunk_b64 !== undefined)
    return decodeB64Field(args.chunk_b64, "fbrain_append", "chunk_b64");
  let chunk: string;
  try {
    chunk = readFileSync(args.chunk_path!, "utf8");
  } catch (err) {
    throw new FbrainError({
      code: "chunk_path_unreadable",
      message:
        `fbrain_append: could not read chunk_path '${args.chunk_path!}': ` +
        (err instanceof Error ? err.message : String(err)),
      hint: "Pass an absolute path to a readable UTF-8 file.",
    });
  }
  return chunk;
}

// Decode a `*_b64` input into UTF-8 text. Serves BOTH `fbrain_put` (`body_b64`)
// and `fbrain_append` (`chunk_b64`), so the error strings are parameterized by
// the calling tool + field — a bad `chunk_b64` must name fbrain_append and
// `chunk_b64`/`chunk_path`, never fbrain_put's field names.
function decodeB64Field(
  b64: string,
  tool: "fbrain_put" | "fbrain_append",
  field: "body_b64" | "chunk_b64",
): string {
  const pathField = field === "body_b64" ? "body_path" : "chunk_path";
  const compact = b64.replace(/\s+/g, "");
  if (
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    /={1,2}[A-Za-z0-9+/]/.test(compact)
  ) {
    throw new FbrainError({
      code: `${field}_invalid`,
      message: `${tool}: ${field} is not valid standard base64.`,
      hint: `Pass UTF-8 text bytes encoded as standard base64, or use \`${pathField}\`.`,
    });
  }
  try {
    const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), "=");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(padded, "base64"));
  } catch (err) {
    throw new FbrainError({
      code: `${field}_invalid_utf8`,
      message:
        `${tool}: ${field} decoded, but the bytes are not valid UTF-8: ` +
        (err instanceof Error ? err.message : String(err)),
      hint: `Encode the text as UTF-8 before base64 encoding, or use \`${pathField}\`.`,
    });
  }
}

export function buildPutInput(args: PutArgs): string {
  const body = args.body ?? "";
  if (typeof args.frontmatter === "string") {
    const trimmed = args.frontmatter.replace(/^\r?\n+/, "").replace(/\r?\n+$/, "");
    return trimmed.length === 0
      ? body
      : `---\n${trimmed}\n---\n${body}`;
  }
  // No raw frontmatter: synthesize it from the args. Mirror the CLI `put`
  // contract — there is NO silent type default. The historic fallback was
  // `design` (the heaviest type), so an untyped put silently minted a Design
  // row — the exact footgun #70 removed from the CLI. Require an explicit
  // type; the `frontmatter` path above carries its own `type:` instead.
  if (args.type === undefined || args.type.length === 0) {
    throw new FbrainError({
      code: "missing_type",
      message:
        "fbrain_put requires a `type` (or a `type:` field in `frontmatter`).",
      hint: "One of: design | task | concept | preference | reference | agent | project | spike | sop.",
    });
  }
  const lines: string[] = [];
  lines.push(`type: ${args.type}`);
  if (args.title !== undefined && args.title.length > 0) {
    lines.push(`title: ${yamlScalar(args.title)}`);
  }
  const tags = normalizeTagsArg(args.tags);
  if (tags !== undefined) {
    const items = tags.map((t) => yamlScalar(t)).join(", ");
    lines.push(`tags: [${items}]`);
  }
  // Status rides into the same frontmatter so putCmd's pre-flight
  // `ensureStatus(type, parsed.status)` validates the value BEFORE any
  // mutation lands. Pre-fix the MCP handler synthesized frontmatter
  // without status and fired a follow-up `statusCmd` to apply it — on an
  // invalid status the put had already committed (with the type's default
  // status) by the time the validation threw, leaving a record behind that
  // the agent never saw mention of (`runTool` drops the accumulated
  // `created <type> <slug>` line on a thrown second step). One atomic
  // write, validated up-front, matches the tool's documented "Returns one
  // line: `created|updated <type> <slug>`" contract.
  if (args.status !== undefined && args.status.length > 0) {
    lines.push(`status: ${yamlScalar(args.status)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export function normalizeTagsArg(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined;
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(tags)) return tags;
  return tags as string[];
}

function yamlScalar(value: string): string {
  // Quote anything that contains a YAML-significant character so the
  // frontmatter parser reads it as a scalar — keeps things robust without
  // pulling in a full YAML serializer.
  if (/^[A-Za-z0-9 _.\-]+$/.test(value) && !value.startsWith(" ") && !value.endsWith(" ")) {
    return value;
  }
  // Use double quotes, escape embedded quotes and backslashes. Also escape
  // newlines / CRs as `\n` / `\r` — leaving them raw inside the quotes
  // pushes the scalar across multiple physical lines, which the
  // line-based frontmatter parser then reads as `key: "line one` followed
  // by a continuation line that doesn't match `key: value` and throws
  // `frontmatter_malformed`. Backslash MUST be escaped first; downstream
  // `unescapeDoubleQuoted` reverses each pair from left to right.
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  // Typed JSON mirroring the tool's declared `outputSchema`. Set only by
  // the read tools (`runReadTool`); the human text block stays the
  // readable fallback for clients that don't consume structuredContent.
  // MCP requires this to be an object, so array results are wrapped under
  // a named key by their handler.
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Every tool handler follows the same shape: resolve the config, run the
// underlying command, collect its printed lines into one text block, and map
// any thrown error into an `isError` envelope. The read/write runners below
// both build on that shape — the only difference is whether (and how) they
// also attach typed `structuredContent`.
//
// Config is resolved INSIDE each runner's try, via the `getCfg` thunk — not at
// server construction. That's what lets the server start with no config on
// disk: `initialize`/`tools/list` never touch config, and a missing/invalid
// config only surfaces when a tool is actually called, as a clean `isError`
// "run `fbrain init` first" hint rather than a startup crash.

// Read-tool runner: alongside the human text block, capture
// the command's structured payload (handed back via its `onResult` sink —
// the SAME value the CLI emits under `--json`, so MCP `structuredContent`
// can't drift from the CLI JSON shape) and attach it as `structuredContent`,
// wrapped by `wrap` into the object MCP requires (an array result is nested
// under a named key). The command still runs in human mode so the text
// fallback renders for clients that ignore structuredContent. If the
// command throws (e.g. `fbrain_get` on an unknown slug) before `onResult`
// fires, the error envelope is returned and no structuredContent is set.
async function runReadTool<P>(
  getCfg: () => Config,
  fn: (
    cfg: Config,
    print: (line: string) => void,
    onResult: (payload: P) => void,
  ) => Promise<void> | void,
  wrap: (payload: P) => Record<string, unknown>,
): Promise<ToolResult> {
  const lines: string[] = [];
  let cfg: Config;
  try {
    cfg = getCfg();
  } catch (err) {
    if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
      return { content: [{ type: "text", text: CONFIG_MISSING_HINT }], isError: true };
    }
    throw err;
  }
  let structured: Record<string, unknown> | undefined;
  try {
    await fn(
      cfg,
      (l) => lines.push(l),
      (payload) => {
        structured = wrap(payload);
      },
    );
  } catch (err) {
    return errorResult(err);
  }
  const result = textResult(lines.join("\n"));
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

// `fbrain_get` runner — a body-paginating variant of `runReadTool`. It can't
// reuse `runReadTool` because the body must be WINDOWED before it reaches both
// the text content AND the `structuredContent` body (both count toward the
// agent harness token budget; the live overflow was a 186K-char record). So
// instead of streaming `getRecord`'s printed text straight through, it captures
// the structured `RecordJson` via `onResult`, slices the body to the requested
// window, re-renders the human text from the windowed record, and attaches the
// windowed structured object plus the pagination metadata. A body that fits in
// one window (≤ cap, offset 0) yields the SAME shape as before — no window
// fields, byte-identical text — so the common case is unchanged. `getRecord`
// itself is untouched (the CLI `fbrain get` has no cap).
async function runGetTool(
  getCfg: () => Config,
  args: { slug: string; type?: RecordJson["type"]; bodyOffset: number; bodyLimit: number },
): Promise<ToolResult> {
  let cfg: Config;
  try {
    cfg = getCfg();
  } catch (err) {
    if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
      return { content: [{ type: "text", text: CONFIG_MISSING_HINT }], isError: true };
    }
    throw err;
  }
  let record: RecordJson | undefined;
  try {
    await getRecord({
      cfg,
      slug: args.slug,
      type: args.type,
      // Drop `getRecord`'s human text — we re-render it from the windowed
      // record below so the body shown matches the windowed structuredContent.
      print: () => {},
      onResult: (payload) => {
        record = payload;
      },
    });
  } catch (err) {
    // Unknown/ambiguous slug throws before onResult: same error envelope as
    // any read tool, no structuredContent — unchanged from the old path.
    return errorResult(await enrichGetNotFoundError(cfg, err, args));
  }
  // Defensive: a successful resolve always fires onResult, but if it somehow
  // didn't, fall back to the error envelope rather than emitting a partial.
  if (record === undefined) {
    return errorResult(new Error("fbrain_get: no record resolved"));
  }

  const fullBody = record.body;
  const total = fullBody.length;
  const win = bodyWindow(total, args.bodyOffset, args.bodyLimit);
  const windowedBody = fullBody.slice(win.start, win.end);

  // Structured payload: start from the resolved record, swap in the windowed
  // body, and attach the pagination metadata ONLY when a window was applied.
  const structured: Record<string, unknown> = {
    ...record,
    body: windowedBody,
  };
  if (win.windowed) {
    structured.bodyTotalChars = total;
    structured.bodyOffset = win.start;
    structured.bodyTruncated = win.truncated;
    structured.bodyNextOffset = win.next;
  }

  const text = formatRecordJsonWindow(record, {
    body: windowedBody,
    offset: win.start,
    total,
    truncated: win.truncated,
  });

  const result = textResult(text);
  result.structuredContent = structured;
  return result;
}

async function enrichGetNotFoundError(
  cfg: Config,
  err: unknown,
  args: { slug: string; type?: RecordJson["type"] },
): Promise<unknown> {
  if (!(err instanceof FbrainError) || err.code !== "not_found") return err;
  const candidates = await nearestSlugCandidates(cfg, args.slug, args.type);
  if (candidates.length === 0) return err;
  const rendered = candidates
    .map((c) => (args.type ? c.slug : `${c.slug} (${c.type})`))
    .join(", ");
  const suffix = `Nearest candidate slugs: ${rendered}.`;
  return new FbrainError({
    code: err.code,
    message: err.message,
    hint: err.hint ? `${err.hint} ${suffix}` : suffix,
    agentHint: err.agentHint ? `${suffix} ${err.agentHint}` : suffix,
  });
}

// Fuzzy-match candidates for the get-miss hint. COST-BOUNDED by design: one
// small slug+tags page per type (`listLiveSlugsPage` — no bodies, no
// pagination), never `listRecords`' full-field full-corpus fetch. The hint is
// best-effort decoration on an error path, so sampling the first page per
// type is the contract; on a brain whose type outgrows the page the hint may
// simply miss a candidate, which is acceptable — the not_found error itself
// is unchanged.
async function nearestSlugCandidates(
  cfg: Config,
  slug: string,
  type?: RecordJson["type"],
): Promise<Array<{ slug: string; type: RecordJson["type"] }>> {
  const node = newReadClientFromCfg(cfg);
  const types = type ? [type] : RECORD_TYPES;
  const candidates: Array<{ slug: string; type: RecordJson["type"]; score: number }> = [];
  for (const t of types) {
    try {
      const slugs = await listLiveSlugsPage(node, schemaHashFor(t, cfg));
      for (const candidateSlug of slugs) {
        candidates.push({
          slug: candidateSlug,
          type: t,
          score: slugFuzzyScore(slug, candidateSlug),
        });
      }
    } catch {
      // Best-effort error hint only; preserve the original not_found error.
    }
  }
  return candidates
    .sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug) || a.type.localeCompare(b.type))
    .slice(0, 3)
    .map(({ slug: s, type: t }) => ({ slug: s, type: t }));
}

function slugFuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (q.length === 0 || c.length === 0) return Number.POSITIVE_INFINITY;
  const distance = levenshtein(q, c) / Math.max(q.length, c.length);
  const prefix = commonPrefixLength(q, c);
  const prefixBonus = Math.min(prefix, 8) * 0.025;
  const substringBonus = q.includes(c) || c.includes(q) ? 0.15 : 0;
  return distance - prefixBonus - substringBonus;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

// Write-tool runner: alongside the human text block, capture
// the typed payload the handler emits via `onResult` and attach it as
// `structuredContent`. Symmetric with `runReadTool`, but the write payloads
// are already objects (`{action,…}`), so there's no array-wrapping step. The
// payload is derived from the SAME value the handler prints, so the typed
// output can't drift from the text fallback. On a thrown error the error
// envelope is returned and no structuredContent is set — the on-error envelope
// is unchanged (`isError` + text, no structuredContent), exactly as before.
async function runWriteTool(
  getCfg: () => Config,
  autoGrant: AutoGrantFn,
  fn: (
    cfg: Config,
    print: (line: string) => void,
    onResult: (payload: Record<string, unknown>) => void,
  ) => Promise<void> | void,
): Promise<ToolResult> {
  let cfg: Config;
  try {
    cfg = getCfg();
  } catch (err) {
    if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
      return { content: [{ type: "text", text: CONFIG_MISSING_HINT }], isError: true };
    }
    throw err;
  }

  // One write attempt. Returns the ToolResult on success, or RE-THROWS on
  // error so the caller can decide whether to self-warm + retry. Fresh sinks
  // per attempt so a failed-then-retried write never double-prints.
  const attempt = async (): Promise<ToolResult> => {
    const lines: string[] = [];
    let structured: Record<string, unknown> | undefined;
    await fn(
      cfg,
      (l) => lines.push(l),
      (payload) => {
        structured = payload;
      },
    );
    const result = textResult(lines.join("\n"));
    if (structured !== undefined) result.structuredContent = structured;
    return result;
  };

  try {
    return await attempt();
  } catch (err) {
    // Cold file-store capability self-warm. The server runs with
    // FBRAIN_FORCE_FILE_KEYCHAIN=1, so `acquireCapability` fast-fails with
    // `consent_required_non_interactive` when the file store has no cached
    // capability (it can't request a grant non-interactively). When the
    // operator opted in (FBRAIN_MCP_AUTO_GRANT_CONSENT), run the same grant
    // `fbrain init --grant-consent` performs — into the SAME store this server
    // reads (defaultCapabilityStore honors FBRAIN_FORCE_FILE_KEYCHAIN) — then
    // retry the write ONCE. Without the opt-in, or if the grant doesn't land
    // (no owner-local folddb / missing master key / denial), the original
    // error surfaces unchanged: a clean fast-fail with the existing agentHint.
    if (isColdCapabilityError(err) && mcpAutoGrantConsentEnabled()) {
      const granted = await autoGrant(cfg);
      if (granted) {
        try {
          return await attempt();
        } catch (retryErr) {
          return errorResult(retryErr);
        }
      }
    }
    return errorResult(err);
  }
}

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text: text.length === 0 ? "(empty)" : text }],
  };
}

function errorResult(err: unknown): ToolResult {
  let message: string;
  if (err instanceof FbrainError) {
    // This channel is consumed by agents, not a human at a terminal: the CLI
    // `fbrain doctor` tip and brew/daemon remediation in `hint` aren't
    // actionable here. Drop the doctor tip from the message and prefer a
    // channel-neutral `agentHint` over the CLI-flavored `hint` when set.
    const base = stripDoctorTip(err.message);
    const hint = err.agentHint ?? err.hint;
    message = hint ? `${base} (hint: ${hint})` : base;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    isError: true,
  };
}
