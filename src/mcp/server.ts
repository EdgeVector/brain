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

import { getFbrainVersion } from "../version.ts";
import { ConfigInvalidError, ConfigMissingError, type Config } from "../config.ts";
import { searchCmd, type SearchHitJson } from "../commands/search.ts";
import { askCmd } from "../commands/ask.ts";
import { getRecord, type RecordJson } from "../commands/get.ts";
import { listCmd, type RecordSummary } from "../commands/list.ts";
import { putCmd } from "../commands/put.ts";
import { deleteRecord } from "../commands/delete.ts";
import { linkCmd } from "../commands/link.ts";
import { FbrainError, stripDoctorTip } from "../client.ts";
import { RECORD_TYPES } from "../schemas.ts";

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
export type CreateServerOptions =
  | { cfg: Config; getCfg?: undefined }
  | { getCfg: () => Config; cfg?: undefined };

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
  "session. Recover by staging the body to a file and passing its path as " +
  "`body_path` (a short path survives where a large inline `body` is " +
  "dropped), or via the CLI `fbrain put <slug> --type <type> < body.md`, or " +
  "split the write into smaller records.";

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

// One search/ask match: `{slug, score, type, title, snippet}` (mirrors
// SearchHitJson). `type` is the canonical lowercase RecordType so a client
// can match it against the input `type` filter verbatim; `score` is the
// 6-decimal-rounded relevance (a cosine for search, a fused RRF score for
// ask) and is `null` only when the node reported no score for a search hit.
// `snippet` is a short deterministic body extract (a window around the first
// matching query term, or the body head for a pure-vector hit) so an agent
// can read the answer inline without a follow-up `fbrain_get`.
const matchSchema = z.object({
  slug: z.string().describe("Record slug."),
  score: z
    .number()
    .nullable()
    .describe("Relevance score (cosine for search, fused RRF for ask). Null when unscored."),
  type: z.enum(RECORD_TYPES).describe("Canonical lowercase record type."),
  title: z.string().describe("Record title."),
  snippet: z
    .string()
    .describe(
      "Short body extract (~120 chars) around the first matching query term — or the body head for a pure-vector hit — so the answer is visible inline without a follow-up fbrain_get. Empty only when the record body is empty.",
    ),
});

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
  body: z.string().describe("Markdown body."),
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

export function createFbrainMcpServer(opts: CreateServerOptions): McpServer {
  // Normalize both option shapes to a single lazy loader. When an eager `cfg`
  // is supplied it's wrapped in a thunk that just returns it, so the resolution
  // path is identical whether config was loaded up-front (CLI subcommand,
  // tests) or is deferred until first tool call (the `fbrain-mcp` bin, where
  // the server must start even with no config on disk).
  const getCfg: () => Config = opts.getCfg ?? (() => opts.cfg);
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

  server.registerTool(
    "fbrain_search",
    {
      title: "Search fbrain",
      description:
        "Pure-vector semantic search across indexed fbrain records (designs, tasks, concepts, preferences, references, agents, projects, spikes). Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 8. Returns one line per match: `slug · score · type · title`, with a short matching body snippet under each. `structuredContent.matches[]` carries `{slug, score, type, title, snippet}` — the `snippet` is a deterministic ~120-char body extract around the first matching query term (body head for a pure-vector hit), so you can read the answer inline without a follow-up `fbrain_get`. For better recall — especially on rare tokens, acronyms, and exact keyword matches that pure-vector ranks out — prefer `fbrain_ask`, which fuses BM25 + vector (the eval-winning hybrid). Escalate to `fbrain_ask` when this returns weak or missing matches.",
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
      // `structuredContent` is `{ matches: [{slug,score,type,title}, …] }` —
      // the SAME array the CLI `--json` emits, wrapped under `matches`
      // because MCP requires structuredContent to be an object.
      outputSchema: {
        matches: z
          .array(matchSchema)
          .describe("Matches, highest score first (empty array on no matches)."),
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
        (matches) => ({ matches }),
      ),
  );

  server.registerTool(
    "fbrain_ask",
    {
      title: "Ask fbrain (hybrid retrieval)",
      description:
        "Hybrid retrieval over fbrain records: runs BM25 (keyword) AND vector (semantic) ranking and fuses them via Reciprocal Rank Fusion (RRF). This is the eval-winning, recommended primitive for recall — vector handles paraphrase while BM25 catches rare tokens, acronyms, and exact-keyword matches the embedding model misses, so `fbrain_ask` surfaces keyword-relevant records that pure-vector `fbrain_search` ranks out of the top results. Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 8. Returns one line per match: `slug · score · type · title`, with a short matching body snippet under each. `structuredContent.matches[]` carries `{slug, score, type, title, snippet}` — the `snippet` is a deterministic ~120-char body extract around the first matching query term (body head for a pure-vector hit), so you can read the answer inline without a follow-up `fbrain_get`. Needs no API key (LLM query expansion is intentionally not used here). Prefer this over `fbrain_search` when you want the best recall.",
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
          .describe("Max results (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is `{ matches: [{slug,score,type,title}, …] }` —
      // identical shape to `fbrain_search`; `score` here is the fused RRF
      // score (always non-null for ask hits).
      outputSchema: {
        matches: z
          .array(matchSchema)
          .describe("Fused (BM25 + vector) matches, highest score first (empty on no matches)."),
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
        (matches) => ({ matches }),
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
        "multiple types.",
      inputSchema: {
        slug: requiredText("Record slug."),
        type: typeEnum
          .optional()
          .describe(
            "Restrict lookup to one record type. Omit to search all types.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      // `structuredContent` is the single record object (the SAME shape the
      // CLI `get --json` emits). Unlike the array tools there's nothing to
      // wrap — the record is already an object.
      outputSchema: recordSchema.shape,
    },
    (args) =>
      runReadTool<RecordJson>(
        getCfg,
        (cfg, print, onResult) =>
          getRecord({
            cfg,
            slug: args.slug,
            print,
            type: args.type,
            onResult,
          }),
        (record) => record as unknown as Record<string, unknown>,
      ),
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
        "body, stage it to a file and pass `body_path` instead of inlining " +
        "`body` — a long inline `body` can be silently dropped in transit in " +
        "long sessions, whereas a short path always survives. Returns " +
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
              "large body prefer `body_path` — a long inline `body` can be " +
              "dropped in transit. Mutually exclusive with `body_path`.",
          ),
        body_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to a UTF-8 file whose contents become the body. " +
              "Use this instead of `body` for large records: a path is a " +
              "short argument that survives the input-dropping that truncates " +
              "a long inline `body` in long agent sessions. Mutually " +
              "exclusive with `body`.",
          ),
        status: z
          .string()
          .optional()
          .describe(
            "Status enum value for the type. Valid values DIFFER per type — " +
              "`active` is accepted by concept/preference/reference/agent/spike " +
              "but is NOT valid for project, design, or task. Per type: " +
              "design = draft|reviewed|approved|implemented|archived; " +
              "task = open|in_progress|blocked|done|cancelled; " +
              "project = planning|in_progress|done|archived; " +
              "concept/agent = active|archived; " +
              "preference = active|superseded; " +
              "reference = active|broken|archived; " +
              "spike = active|concluded. Omit to use the type's default " +
              "(first enum value). Synthesized into the put's frontmatter so " +
              "it lands atomically in the same mutation and is validated " +
              "against the type's enum BEFORE any HTTP write — an invalid " +
              "status errors out without persisting a partial record. Ignored " +
              "when raw `frontmatter` is supplied (set `status:` in the " +
              "frontmatter directly).",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tag list. Replaces existing tags on update."),
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
      runWriteTool(getCfg, async (cfg, print, onResult) => {
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
      runWriteTool(getCfg, (cfg, print, onResult) =>
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
      runWriteTool(getCfg, async (cfg, print, onResult) => {
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
  tags?: string[];
  frontmatter?: string;
};

// When `body_path` is set, read the body from that file. A path is a short
// string immune to the large-inline-argument truncation that silently drops a
// long `body` before it reaches the server (the case DROPPED_INPUT_HINT warns
// about) — so an arbitrarily large record can always be written by staging it
// to a file first. `body` and `body_path` are mutually exclusive. Returns a
// normalized PutArgs (no `body_path`) so buildPutInput stays a pure function.
export function resolvePutBody(args: PutArgs & { body_path?: string }): PutArgs {
  const { body_path, ...rest } = args;
  if (body_path === undefined) return rest;
  if (rest.body !== undefined) {
    throw new FbrainError({
      code: "body_and_body_path",
      message: "fbrain_put: pass either `body` or `body_path`, not both.",
      hint: "Use `body_path` alone for large bodies; inline `body` for small ones.",
    });
  }
  let body: string;
  try {
    body = readFileSync(body_path, "utf8");
  } catch (err) {
    throw new FbrainError({
      code: "body_path_unreadable",
      message:
        `fbrain_put: could not read body_path '${body_path}': ` +
        (err instanceof Error ? err.message : String(err)),
      hint: "Pass an absolute path to a readable UTF-8 file.",
    });
  }
  return { ...rest, body };
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
      hint: "One of: design | task | concept | preference | reference | agent | project | spike.",
    });
  }
  const lines: string[] = [];
  lines.push(`type: ${args.type}`);
  if (args.title !== undefined && args.title.length > 0) {
    lines.push(`title: ${yamlScalar(args.title)}`);
  }
  if (args.tags !== undefined) {
    const items = args.tags.map((t) => yamlScalar(t)).join(", ");
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
  fn: (
    cfg: Config,
    print: (line: string) => void,
    onResult: (payload: Record<string, unknown>) => void,
  ) => Promise<void> | void,
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
        structured = payload;
      },
    );
  } catch (err) {
    return errorResult(err);
  }
  const result = textResult(lines.join("\n"));
  if (structured !== undefined) result.structuredContent = structured;
  return result;
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
