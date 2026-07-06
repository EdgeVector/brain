#!/usr/bin/env bun
// fbrain MCP server entrypoint — speaks the Model Context Protocol over
// stdio. Register with Claude Code (the global `bun add -g
// github:EdgeVector/fbrain` install from the README Quick start already put
// `fbrain-mcp` on PATH):
//   claude mcp add fbrain fbrain-mcp
// Contributing from a source checkout? `bun link` puts the same bin on PATH.
// Don't want to link? Path-based fallback:
//   claude mcp add fbrain bun /path/to/fbrain/src/mcp/main.ts
//
// Reads ~/.fbrain/config.json (same as the CLI), but LAZILY: the server
// always starts and completes the MCP handshake (`initialize` + `tools/list`)
// even when no config exists yet — the common new-developer case where
// `claude mcp add fbrain fbrain-mcp` is run before `fbrain init`. Config is
// loaded on demand the first time a tool is CALLED; a missing/invalid config
// then surfaces as a clean per-tool "run `fbrain init` first" `isError` result
// in the client, instead of a server that dies on startup with only a buried
// stderr line in the MCP client logs.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readConfig } from "../config.ts";
import { createFbrainMcpServer, makeIdleReaper, mcpIdleTimeoutMs, withIdleReaper } from "./server.ts";

export async function runMcp(): Promise<number> {
  // Pass a config *loader* rather than an eager config: `readConfig()` runs
  // only when a tool handler asks for it, so the handshake succeeds with no
  // config on disk and the "run `fbrain init`" guidance lands per tool call
  // (where the client surfaces it to the user) rather than as a startup crash.
  const server = createFbrainMcpServer({ getCfg: () => readConfig() });
  const transport = new StdioServerTransport();
  const reaper = makeIdleReaper({ idleMs: mcpIdleTimeoutMs() });
  await server.connect(withIdleReaper(transport, reaper));
  reaper.touch();
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
