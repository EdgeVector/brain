// Bare `fbrain mcp` is the stdio MCP-server entrypoint: an AI client `exec`s it
// and speaks JSON-RPC over stdin. A human who instead types `fbrain mcp` at an
// interactive terminal (a very natural thing to try after seeing
// `fbrain mcp install` / `fbrain mcp instructions` in the help) used to get a
// silently frozen prompt — the server started and then blocked forever on
// `await new Promise(() => {})` with zero output, because interactive stdin
// never EOFs and no client ever speaks.
//
// These tests pin the TTY guard contract:
//   - with `process.stdin.isTTY === true`, bare `mcp` prints one-line guidance
//     to stderr pointing at install/instructions and returns the usage code
//     (2) WITHOUT importing/starting the server. We assert this in-process by
//     calling runMcpCmd directly: the guard returns BEFORE the lazy
//     `import("./mcp/main.ts")`, so a green test proves the server never loaded.
//   - with stdin NOT a TTY (piped/redirected — the real MCP-client case), bare
//     `mcp` still routes to runMcp() and prints NONE of the guidance. We assert
//     this out-of-process (a subprocess with piped stdin is genuinely non-TTY),
//     which is also the repo's idiom for the sibling `fbrain mcp instructions`
//     tests (mock.module is noted unstable in delete.test.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { runMcpCmd, USAGE_ERROR } from "../../src/cli.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

// process.stdin.isTTY is readonly in the type, but settable at runtime. Save
// the original so each test can restore it.
const stdin = process.stdin as unknown as { isTTY?: boolean };
const originalIsTTY = stdin.isTTY;

afterEach(() => {
  stdin.isTTY = originalIsTTY;
});

const GUIDANCE_MARKER = "stdio MCP server for AI clients";

describe("bare `fbrain mcp` interactive TTY guard", () => {
  test("stdin.isTTY=true: prints guidance to stderr, returns USAGE_ERROR, never starts the server", async () => {
    stdin.isTTY = true;

    const errs: string[] = [];
    const originalError = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    let code: number;
    try {
      // Reaching the server would lazily import ./mcp/main.ts and then block
      // forever on `await new Promise(() => {})`. That this call resolves AT ALL
      // (let alone with USAGE_ERROR) proves the guard short-circuited first.
      code = await runMcpCmd([]);
    } finally {
      console.error = originalError;
    }

    expect(code).toBe(USAGE_ERROR);
    const stderr = errs.join("\n");
    expect(stderr).toContain(GUIDANCE_MARKER);
    expect(stderr).toContain("fbrain mcp install");
    expect(stderr).toContain("fbrain mcp instructions");
  });

  test("piped (non-TTY) stdin: routes to the server path — NONE of the interactive guidance is printed", async () => {
    // A subprocess with a piped stdin is genuinely non-TTY. Pipe a single MCP
    // `initialize` request then close stdin: the server boots, answers, and —
    // because the SDK's stdio transport sees EOF — the process exits without
    // hanging. The point of the assertion is the *route*: the interactive
    // guidance must NOT appear (that only fires on a TTY).
    const proc = Bun.spawn(["bun", CLI_PATH, "mcp"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      // No node URL needed: the server starts and handshakes with config loaded
      // lazily (see src/mcp/main.ts), so this prints nothing about config here.
      env: { ...process.env },
    });
    const req =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tty-guard-test", version: "0" },
        },
      }) + "\n";
    proc.stdin.write(req);
    await proc.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    // The interactive guard did NOT fire (we took the server path).
    expect(stderr).not.toContain(GUIDANCE_MARKER);
    // The server answered the handshake on stdout (proves it actually started).
    expect(stdout).toContain('"jsonrpc"');
    expect(stdout).toContain('"serverInfo"');
  });
});
