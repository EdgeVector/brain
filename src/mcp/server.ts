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
import type { Config } from "../config.ts";
import { searchCmd } from "../commands/search.ts";
import { askCmd } from "../commands/ask.ts";
import { getRecord } from "../commands/get.ts";
import { listCmd } from "../commands/list.ts";
import { putCmd } from "../commands/put.ts";
import { deleteRecord } from "../commands/delete.ts";
import { linkCmd } from "../commands/link.ts";
import { FbrainError, stripDoctorTip } from "../client.ts";
import { RECORD_TYPES } from "../schemas.ts";

export const FBRAIN_MCP_NAME = "fbrain";
// Single-sourced via getFbrainVersion() so `fbrain --version` (cli.ts) and
// the MCP `serverInfo.version` reported here can't drift. Includes the git
// short-SHA suffix when the running source lives in a git checkout, so MCP
// clients (Claude Code, Codex) see the same build identifier the CLI does.
export const FBRAIN_MCP_VERSION: string = getFbrainVersion();

export type CreateServerOptions = {
  cfg: Config;
};

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

export function createFbrainMcpServer(opts: CreateServerOptions): McpServer {
  const { cfg } = opts;
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
        "Pure-vector semantic search across indexed fbrain records (designs, tasks, concepts, preferences, references, agents, projects, spikes). Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 8. Returns one line per match: `slug · score · type · title`. For better recall — especially on rare tokens, acronyms, and exact keyword matches that pure-vector ranks out — prefer `fbrain_ask`, which fuses BM25 + vector (the eval-winning hybrid). Escalate to `fbrain_ask` when this returns weak or missing matches.",
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
    },
    (args) =>
      runTool((print) =>
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
        }),
      ),
  );

  server.registerTool(
    "fbrain_ask",
    {
      title: "Ask fbrain (hybrid retrieval)",
      description:
        "Hybrid retrieval over fbrain records: runs BM25 (keyword) AND vector (semantic) ranking and fuses them via Reciprocal Rank Fusion (RRF). This is the eval-winning, recommended primitive for recall — vector handles paraphrase while BM25 catches rare tokens, acronyms, and exact-keyword matches the embedding model misses, so `fbrain_ask` surfaces keyword-relevant records that pure-vector `fbrain_search` ranks out of the top results. Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 8. Returns one line per match: `slug · score · type · title`. Needs no API key (LLM query expansion is intentionally not used here). Prefer this over `fbrain_search` when you want the best recall.",
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
    },
    (args) =>
      runTool(async (print) => {
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
          // LLM query expansion stays OFF (the default): the eval winner is
          // plain BM25 + vector + RRF, and keeping it off means the tool
          // works for any agent with zero extra config (no API key). A
          // follow-up can add an optional `expand` param if wanted.
        });
      }),
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
    },
    (args) =>
      runTool((print) =>
        getRecord({
          cfg,
          slug: args.slug,
          print,
          type: args.type,
        }),
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
    },
    (args) =>
      runTool((print) =>
        listCmd({
          cfg,
          print,
          type: args.type,
          status: args.status,
          tag: args.tag,
          limit: args.limit,
        }),
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
        "one line: `created|updated <type> <slug>`.",
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
    },
    (args) =>
      runTool(async (print) => {
        const input = buildPutInput(resolvePutBody(args));
        const result = await putCmd({ cfg, slug: args.slug, input });
        print(`${result.action} ${result.type} ${result.slug}`);
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
    },
    (args) =>
      runTool((print) =>
        deleteRecord({
          cfg,
          slug: args.slug,
          print,
          type: args.type,
          force: args.force,
        }),
      ),
  );

  server.registerTool(
    "fbrain_link",
    {
      title: "Link fbrain records",
      description:
        "Link a task to a parent design. v0 supports task → design only; " +
        "any other type pair errors with `unsupported_link_pair`.",
      inputSchema: {
        from_type: typeEnum.describe("Source record type (must be `task`)."),
        from_slug: requiredText("Source slug (the task)."),
        to_type: typeEnum.describe("Target record type (must be `design`)."),
        to_slug: requiredText("Target slug (the design)."),
      },
    },
    (args) =>
      runTool(async (print) => {
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
  isError?: boolean;
};

// Every tool handler follows the same shape: collect printed lines from
// the underlying command, return them as one text block, and map any
// thrown error into an `isError` envelope. `runTool` is that shape.
async function runTool(
  fn: (print: (line: string) => void) => Promise<void>,
): Promise<ToolResult> {
  const lines: string[] = [];
  try {
    await fn((l) => lines.push(l));
  } catch (err) {
    return errorResult(err);
  }
  return textResult(lines.join("\n"));
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
