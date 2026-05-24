// MCP read server for fbrain — exposes `fbrain_search`, `fbrain_get`,
// `fbrain_list` to MCP clients (Claude Code, Codex, etc.) over stdio.
//
// Each handler wraps the existing CLI command function and captures its
// printed output as a single text content block. No shell-out — the
// command functions are called in-process so the agent sees the same
// results as `fbrain search`/`get`/`list` from the terminal.
//
// G6 read scope only. Write-side (put, delete, link) lands in G6-write.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.ts";
import { searchCmd } from "../commands/search.ts";
import { getRecord } from "../commands/get.ts";
import { listCmd } from "../commands/list.ts";
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

  return server;
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
