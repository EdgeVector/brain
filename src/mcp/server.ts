// MCP server for fbrain — exposes both read (`fbrain_search`, `fbrain_ask`,
// `fbrain_get`, `fbrain_list`) and write (`fbrain_put`, `fbrain_delete`,
// `fbrain_link`) tools to MCP clients (Claude Code, Codex, etc.) over stdio.
// 7 tools total.
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
import { listCmd, type RecordSummary } from "../commands/list.ts";
import { putCmd } from "../commands/put.ts";
import { deleteRecord } from "../commands/delete.ts";
import { linkCmd } from "../commands/link.ts";
import { FbrainError, newReadClientFromCfg, stripDoctorTip } from "../client.ts";
import { RECORD_TYPES } from "../schemas.ts";
import { establishConsentInline } from "../commands/init-consent.ts";
import {
  isTombstoned,
  listRecords,
  schemaHashFor,
} from "../record.ts";

export const FBRAIN_MCP_NAME = "fbrain";
// The complete agent-integration surface this server exposes — 4 read tools
// + 3 write tools = 7. Single-sourced here so the `doctor --mcp` boot probe
// can assert the live `tools/list` reports EXACTLY this set (a renamed or
// dropped tool fails the probe) without re-listing the names. Keep in sync
// with the `registerTool` calls below.
export const FBRAIN_MCP_TOOL_NAMES = [
  "fbrain_search",
  "fbrain_ask",
  "fbrain_get",
  "fbrain_list",
  "fbrain_put",
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
  "arguments are large (e.g. a long `fbrain_put` body) in a long agent " +
  "session. Recover by passing `body_b64` (UTF-8 body bytes encoded as " +
  "standard base64), staging the body to a file and passing its path as " +
  "`body_path` (a short path survives where a large inline `body` is " +
  "dropped), or via the CLI `fbrain put <slug> --type <type> < body.md`, or " +
  "split the write into smaller records.";

export const ASK_QUERY_REQUIRED_HINT =
  "fbrain_ask requires a non-empty `query` string. Example: " +
  '`fbrain_ask({"query":"deployment rollback decision","limit":5})`.';

export const GET_SLUG_REQUIRED_HINT =
  "fbrain_get requires a non-empty `slug` string. Example: " +
  '`fbrain_get({"slug":"deployment-rollback-decision","type":"concept"})`. ' +
  "For fuzzy/text lookup, call fbrain_ask first.";

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
    .enum(["strong", "weak"])
    .describe(
      "Retrieval confidence label. `weak` means the whole result set looks like a noise-floor fallback; treat rows as closest-known candidates, not trusted answers.",
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

// `fbrain_link` → `{action, from_type, from_slug, to_type, to_slug}`. v0
// supports task → design only, so `from_type`/`to_type` are fixed.
const linkResultSchema = z.object({
  action: z.literal("linked").describe("Always `linked`."),
  from_type: z.literal("task").describe("Source record type (always `task` in v0)."),
  from_slug: z.string().describe("Source task slug."),
  to_type: z.literal("design").describe("Target record type (always `design` in v0)."),
  to_slug: z.string().describe("Target design slug."),
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
        query: actionableRequiredText("Search query.", ASK_QUERY_REQUIRED_HINT),
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
          await askCmd({
            cfg,
            query: args.query,
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
        "List records (newest-first), optionally filtered by type/status/tag. Output: `type · slug · status · title [tags]` per line.",
      inputSchema: {
        type: typeEnum.optional().describe("Restrict to one record type."),
        status: z
          .string()
          .optional()
          .describe("Filter by status enum value."),
        tag: z.string().optional().describe("Filter by tag membership."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is `{ records: [summary, …] }` — the SAME array
      // the CLI `list --json` emits (body omitted; use `fbrain_get` for the
      // full record), wrapped under `records` because MCP requires an object.
      outputSchema: {
        records: z
          .array(summarySchema)
          .describe("Record summaries, newest-first (empty array on no records)."),
      },
    },
    (args) =>
      runReadTool<RecordSummary[]>(
        getCfg,
        (cfg, print, onResult) =>
          listCmd({
            cfg,
            print,
            type: args.type,
            status: args.status,
            tag: args.tag,
            limit: args.limit,
            onResult,
            // Agent channel: render the empty/filter-no-match recovery hint in
            // MCP-tool terms (`fbrain_put`/`fbrain_list`), never CLI verbs.
            agent: true,
          }),
        (records) => ({ records }),
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
              "large or multiline body prefer `body_b64` or `body_path` — a " +
              "long inline `body` can be dropped in transit. Mutually " +
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
        const input = buildPutInput(resolvePutBody(args));
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
        const result = await putCmd({ cfg, slug: args.slug, input });
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
        "Link a task to a parent design — pass just `{from_slug, to_slug}` " +
        "(mirrors the CLI `fbrain link <task-slug> <design-slug>`). v0 supports " +
        "task → design only, so the types are inferred; `from_type`/`to_type` " +
        "are optional and default to `task`/`design`. Pass them only for a " +
        "non-default pair (none exist in v0), which errors with " +
        "`unsupported_link_pair`.",
      inputSchema: {
        from_slug: requiredText("Slug of the task to link."),
        to_slug: requiredText("Slug of the parent design to link it under."),
        from_type: z
          .literal("task")
          .default("task")
          .describe(
            "Source record type. Optional — defaults to `task` (the only v0 source). Pass only for a non-default pair (none in v0).",
          ),
        to_type: z
          .literal("design")
          .default("design")
          .describe(
            "Target record type. Optional — defaults to `design` (the only v0 target). Pass only for a non-default pair (none in v0).",
          ),
      },
      // `structuredContent` is `{action:"linked", from_type, from_slug,
      // to_type, to_slug}` — the SAME normalized slugs `linkCmd` prints, via
      // its `onResult` sink. v0 is strictly task → design.
      outputSchema: linkResultSchema.shape,
    },
    (args) =>
      runWriteTool(getCfg, autoGrant, async (cfg, print, onResult) => {
        if (args.from_type !== "task" || args.to_type !== "design") {
          throw new FbrainError({
            code: "unsupported_link_pair",
            message: `Link pair ${args.from_type} → ${args.to_type} is not supported.`,
            hint: "v0 supports task → design only.",
          });
        }
        await linkCmd({
          cfg,
          taskSlug: args.from_slug,
          designSlug: args.to_slug,
          print,
          onResult,
        });
      }),
  );

  return server;
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
  if (body_b64 !== undefined) return { ...rest, body: decodeBodyB64(body_b64) };

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

function decodeBodyB64(body_b64: string): string {
  const compact = body_b64.replace(/\s+/g, "");
  if (
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
    /={1,2}[A-Za-z0-9+/]/.test(compact)
  ) {
    throw new FbrainError({
      code: "body_b64_invalid",
      message: "fbrain_put: body_b64 is not valid standard base64.",
      hint: "Pass UTF-8 markdown body bytes encoded as standard base64, or use `body_path`.",
    });
  }
  try {
    const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), "=");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(padded, "base64"));
  } catch (err) {
    throw new FbrainError({
      code: "body_b64_invalid_utf8",
      message:
        "fbrain_put: body_b64 decoded, but the bytes are not valid UTF-8: " +
        (err instanceof Error ? err.message : String(err)),
      hint: "Encode the markdown body as UTF-8 before base64 encoding, or use `body_path`.",
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
      const records = await listRecords(node, t, schemaHashFor(t, cfg));
      for (const record of records) {
        if (isTombstoned(record)) continue;
        candidates.push({
          slug: record.slug,
          type: t,
          score: slugFuzzyScore(slug, record.slug),
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
