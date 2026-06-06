// MCP server for fbrain — exposes both read (`fbrain_search`, `fbrain_get`,
// `fbrain_list`) and write (`fbrain_put`, `fbrain_delete`, `fbrain_link`)
// tools to MCP clients (Claude Code, Codex, etc.) over stdio.
//
// Each handler wraps the existing CLI command function and captures its
// printed output as a single text content block. No shell-out — the
// command functions are called in-process so the agent sees the same
// results as the matching `fbrain` subcommand from the terminal.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import type { Config } from "../config.ts";
import { searchCmd } from "../commands/search.ts";
import { getRecord } from "../commands/get.ts";
import { listCmd } from "../commands/list.ts";
import { putCmd } from "../commands/put.ts";
import { deleteRecord } from "../commands/delete.ts";
import { linkCmd } from "../commands/link.ts";
import { FbrainError, stripDoctorTip } from "../client.ts";
import { RECORD_TYPES } from "../schemas.ts";

export const FBRAIN_MCP_NAME = "fbrain";
// Single-sourced from package.json so `fbrain --version` (cli.ts) and the MCP
// `serverInfo.version` reported here can't drift. Bump the version in
// package.json — both surfaces follow.
export const FBRAIN_MCP_VERSION: string = pkg.version;

export type CreateServerOptions = {
  cfg: Config;
};

export function createFbrainMcpServer(opts: CreateServerOptions): McpServer {
  const { cfg } = opts;
  const server = new McpServer({
    name: FBRAIN_MCP_NAME,
    version: FBRAIN_MCP_VERSION,
  });

  const typeEnum = z.enum(RECORD_TYPES);

  server.registerTool(
    "fbrain_search",
    {
      title: "Search fbrain",
      description:
        "Semantic search across indexed fbrain records (designs, tasks, concepts, preferences, references, agents, projects, spikes). Pass `type` to restrict to one or more record types (mirrors the CLI's repeatable `--type` flag); omit to search all 8. Returns one line per match: `slug · score · type · title`.",
      inputSchema: {
        query: z.string().min(1).describe("Search query."),
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
          limit: args.limit,
          exact: args.exact,
          minScore: args.min_score,
          types: args.type,
        }),
      ),
  );

  server.registerTool(
    "fbrain_get",
    {
      title: "Get fbrain record",
      description:
        "Print a single fbrain record by slug. Without `type`, queries every registered schema and errors if the slug exists in multiple types.",
      inputSchema: {
        slug: z.string().min(1).describe("Record slug."),
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
        "synthesized from `type`, `title`, `tags`, and `status`. Returns " +
        "one line: `created|updated <type> <slug>`.",
      inputSchema: {
        slug: z.string().min(1).describe("Record slug (lowercase, [a-z0-9-_])."),
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
          .describe("Markdown body (indexed for search). Defaults to empty."),
        status: z
          .string()
          .optional()
          .describe(
            "Status enum value for the type. Synthesized into the put's " +
              "frontmatter so it lands atomically in the same mutation and " +
              "is validated against the type's enum BEFORE any HTTP write — " +
              "an invalid status errors out without persisting a partial " +
              "record. Ignored when raw `frontmatter` is supplied (set " +
              "`status:` in the frontmatter directly).",
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
        const input = buildPutInput(args);
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
        slug: z.string().min(1).describe("Record slug."),
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
        from_slug: z.string().min(1).describe("Source slug (the task)."),
        to_type: typeEnum.describe("Target record type (must be `design`)."),
        to_slug: z.string().min(1).describe("Target slug (the design)."),
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
