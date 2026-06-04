#!/usr/bin/env bun
// fbrain MCP server entrypoint — speaks the Model Context Protocol over
// stdio. Register with Claude Code (after `bun link` from the README
// Quick start, which puts `fbrain-mcp` on PATH):
//   claude mcp add fbrain fbrain-mcp
// Running from a source checkout without `bun link`? Path-based fallback:
//   claude mcp add fbrain bun /path/to/fbrain/src/mcp/main.ts
//
// Reads ~/.fbrain/config.json (same as the CLI). Exits non-zero if the
// config is missing — surface the error to the MCP client logs.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readConfig, ConfigMissingError } from "../config.ts";
import { createFbrainMcpServer } from "./server.ts";

export async function runMcp(): Promise<number> {
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    if (err instanceof ConfigMissingError) {
      console.error(`fbrain mcp: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const server = createFbrainMcpServer({ cfg });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect() returns once the transport is started; the process
  // stays alive because stdin is held open by the transport's reader.
  // No further work to do here — the SDK dispatches incoming RPCs.
  return 0;
}

if (import.meta.main) {
  runMcp().then(
    (code) => {
      if (code !== 0) process.exit(code);
      // Otherwise: stay alive serving stdio.
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
