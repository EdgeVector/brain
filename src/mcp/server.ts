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

import type { Config } from "../config.ts";
import { searchCmd } from "../commands/search.ts";
import { getRecord } from "../commands/get.ts";
import { listCmd } from "../commands/list.ts";
import { putCmd } from "../commands/put.ts";
import { deleteRecord } from "../commands/delete.ts";
import { linkCmd } from "../commands/link.ts";
import { statusCmd } from "../commands/status.ts";
import { FbrainError } from "../client.ts";
import { isRecordType, RECORD_TYPES, type RecordType } from "../schemas.ts";

export const FBRAIN_MCP_NAME = "fbrain";
export const FBRAIN_MCP_VERSION = "0.0.1";

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
        "Semantic search across indexed fbrain records (designs, tasks, concepts, preferences, references, agents, projects, spikes). Returns one line per match: `slug · score · type · title`.",
      inputSchema: {
        query: z.string().min(1).describe("Search query."),
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
    async (args) => {
      const lines: string[] = [];
      const sOpts: Parameters<typeof searchCmd>[0] = {
        cfg,
        query: args.query,
        print: (l) => lines.push(l),
      };
      if (typeof args.limit === "number") sOpts.limit = args.limit;
      if (args.exact === true) sOpts.exact = true;
      if (typeof args.min_score === "number") sOpts.minScore = args.min_score;
      try {
        await searchCmd(sOpts);
      } catch (err) {
        return errorResult(err);
      }
      return textResult(lines.join("\n"));
    },
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
    async (args) => {
      const lines: string[] = [];
      const gOpts: Parameters<typeof getRecord>[0] = {
        cfg,
        slug: args.slug,
        print: (l) => lines.push(l),
      };
      if (args.type) gOpts.type = args.type as RecordType;
      try {
        await getRecord(gOpts);
      } catch (err) {
        return errorResult(err);
      }
      return textResult(lines.join("\n"));
    },
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
    async (args) => {
      const lines: string[] = [];
      const lOpts: Parameters<typeof listCmd>[0] = {
        cfg,
        print: (l) => lines.push(l),
      };
      if (args.type) lOpts.type = args.type as RecordType;
      if (args.status) lOpts.status = args.status;
      if (args.tag) lOpts.tag = args.tag;
      if (typeof args.limit === "number") lOpts.limit = args.limit;
      try {
        await listCmd(lOpts);
      } catch (err) {
        return errorResult(err);
      }
      return textResult(lines.join("\n"));
    },
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
            "Status enum value for the type. Set in a follow-up `status` " +
              "mutation after the put. Validated against the type's enum.",
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
    async (args) => {
      const lines: string[] = [];
      try {
        const input = buildPutInput(args);
        const result = await putCmd({ cfg, slug: args.slug, input });
        lines.push(`${result.action} ${result.type} ${result.slug}`);
        if (typeof args.status === "string" && args.status.length > 0) {
          await statusCmd({
            cfg,
            slug: args.slug,
            type: result.type,
            newStatus: args.status,
            print: (l) => lines.push(l),
          });
        }
      } catch (err) {
        return errorResult(err);
      }
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "fbrain_delete",
    {
      title: "Delete fbrain record",
      description:
        "Soft-delete a record. fold_db is append-only — the workaround " +
        "stamps a tombstone tag so every fbrain read path treats the " +
        "record as gone. Without `type`, probes every type and errors if " +
        "the slug exists in multiple. The slug becomes reusable after " +
        "delete.",
      inputSchema: {
        slug: z.string().min(1).describe("Record slug."),
        type: typeEnum
          .optional()
          .describe(
            "Restrict delete to one record type. Omit to probe all types " +
              "(errors on ambiguous slug).",
          ),
      },
    },
    async (args) => {
      const lines: string[] = [];
      const dOpts: Parameters<typeof deleteRecord>[0] = {
        cfg,
        slug: args.slug,
        print: (l) => lines.push(l),
      };
      if (args.type) dOpts.type = args.type as RecordType;
      try {
        await deleteRecord(dOpts);
      } catch (err) {
        return errorResult(err);
      }
      return textResult(lines.join("\n"));
    },
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
    async (args) => {
      const lines: string[] = [];
      try {
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
          print: (l) => lines.push(l),
        });
      } catch (err) {
        return errorResult(err);
      }
      return textResult(lines.join("\n"));
    },
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
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function yamlScalar(value: string): string {
  // Quote anything that contains a YAML-significant character so the
  // frontmatter parser reads it as a scalar — keeps things robust without
  // pulling in a full YAML serializer.
  if (/^[A-Za-z0-9 _.\-]+$/.test(value) && !value.startsWith(" ") && !value.endsWith(" ")) {
    return value;
  }
  // Use double quotes, escape embedded quotes and backslashes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text: text.length === 0 ? "(empty)" : text }],
  };
}

function errorResult(err: unknown): ToolResult {
  let message: string;
  if (err instanceof FbrainError) {
    message = err.hint ? `${err.message} (hint: ${err.hint})` : err.message;
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

// Exported so tests / callers can validate a `type` arg outside the SDK
// schema layer. The SDK enforces the enum at parse time, but tests
// bypass that path by calling the captured handler directly.
export function ensureRecordType(raw: string | undefined): RecordType | undefined {
  if (raw === undefined) return undefined;
  if (isRecordType(raw)) return raw;
  throw new FbrainError({
    code: "invalid_type",
    message: `type must be one of ${RECORD_TYPES.join(" | ")} (got "${raw}").`,
  });
}
