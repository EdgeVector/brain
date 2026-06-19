// `fbrain mcp install` (alias `setup`) is the one-shot agent-wiring command:
// it collapses the three-step "connect fbrain to my agent" ritual (verify the
// `fbrain-mcp` entrypoint → `claude mcp add fbrain fbrain-mcp` → append the
// instructions block to ./CLAUDE.md) into a single command, gated by [Y/n]
// unless `--yes` (mirroring `init --grant-consent`).
//
// These tests drive runMcpInstall directly through its injection seams (the
// same pattern as init-consent.test.ts) so we never touch the real PATH,
// shell out to `claude`, or prompt — and assert the three contracts the brief
// calls out:
//   - entrypoint absent → prints the `bun link` fix and is a non-zero no-op
//     (no `claude mcp add`, no CLAUDE.md write).
//   - `claude` absent → prints the exact manual command and is a no-op on the
//     MCP config (only the CLAUDE.md append still runs).
//   - the CLAUDE.md append is idempotent: a second run does NOT duplicate the
//     block (stable `## fbrain (persistent memory)` marker).
//   - `--yes` skips the [Y/n] prompt (the `ask` seam is never called).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INSTRUCTIONS_MARKER,
  runMcpInstall,
  type ClaudeAddResult,
} from "../../src/commands/mcp-install.ts";
import { buildAgentInstructionsBlock } from "../../src/schemas.ts";

function tmpClaudeMd(): string {
  return join(mkdtempSync(join(tmpdir(), "fbrain-mcp-install-")), "CLAUDE.md");
}

// A `whichBin` stub: resolve only the names in `present` to a fake path.
function which(present: Record<string, string>) {
  return (name: string): string | null => present[name] ?? null;
}

describe("fbrain mcp install — entrypoint resolution", () => {
  test("fbrain-mcp absent → prints the bun link fix, exits non-zero, NO side effects", async () => {
    const lines: string[] = [];
    const claudeMd = tmpClaudeMd();
    let claudeAddCalled = false;
    const result = await runMcpInstall({
      yes: true,
      claudeMd,
      print: (l) => lines.push(l),
      whichBin: which({ claude: "/usr/bin/claude" }), // claude present, fbrain-mcp NOT
      runClaudeAdd: () => {
        claudeAddCalled = true;
        return { status: 0 };
      },
    });
    expect(result.code).not.toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("not on PATH");
    expect(out).toContain("bun link");
    // Hard prerequisite failed → no registration, no CLAUDE.md write.
    expect(claudeAddCalled).toBe(false);
    expect(() => readFileSync(claudeMd, "utf8")).toThrow();
  });
});

describe("fbrain mcp install — claude registration", () => {
  test("claude present → runs `claude mcp add` and appends the block", async () => {
    const lines: string[] = [];
    const claudeMd = tmpClaudeMd();
    let claudeAddCalled = false;
    const result = await runMcpInstall({
      yes: true,
      claudeMd,
      print: (l) => lines.push(l),
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      runClaudeAdd: (): ClaudeAddResult => {
        claudeAddCalled = true;
        return { status: 0 };
      },
    });
    expect(result.code).toBe(0);
    expect(claudeAddCalled).toBe(true);
    expect(lines.join("\n")).toContain("registered");
    expect(readFileSync(claudeMd, "utf8")).toContain(INSTRUCTIONS_MARKER);
  });

  test("claude absent → prints the exact manual command, no-op on MCP config", async () => {
    const lines: string[] = [];
    const claudeMd = tmpClaudeMd();
    const result = await runMcpInstall({
      yes: true,
      claudeMd,
      print: (l) => lines.push(l),
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp" }), // claude NOT present
      // runClaudeAdd intentionally omitted — it must never be reached.
    });
    expect(result.code).toBe(0);
    const out = lines.join("\n");
    // The exact command a user can copy-paste.
    expect(out).toContain("claude mcp add fbrain fbrain-mcp");
    // The path-based form for a source checkout without `bun link`.
    expect(out).toContain("realpath src/mcp/main.ts");
    // The CLAUDE.md append still runs even when claude is absent.
    expect(readFileSync(claudeMd, "utf8")).toContain(INSTRUCTIONS_MARKER);
  });

  test("already-registered result is a success skip, not an error", async () => {
    const lines: string[] = [];
    const result = await runMcpInstall({
      yes: true,
      claudeMd: tmpClaudeMd(),
      print: (l) => lines.push(l),
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      runClaudeAdd: (): ClaudeAddResult => ({
        status: 1,
        stderr: "Error: MCP server fbrain already exists in this scope",
      }),
    });
    expect(result.code).toBe(0);
    expect(lines.join("\n")).toContain("already registered");
  });
});

describe("fbrain mcp install — CLAUDE.md append idempotency", () => {
  test("a second run does NOT duplicate the instructions block", async () => {
    const claudeMd = tmpClaudeMd();
    const opts = {
      yes: true,
      claudeMd,
      print: () => {},
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      runClaudeAdd: (): ClaudeAddResult => ({ status: 0 }),
    };
    await runMcpInstall(opts);
    await runMcpInstall(opts);
    const body = readFileSync(claudeMd, "utf8");
    // The stable marker appears exactly once.
    const occurrences = body.split(INSTRUCTIONS_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  test("appends without clobbering existing CLAUDE.md content", async () => {
    const claudeMd = tmpClaudeMd();
    writeFileSync(claudeMd, "# My project\n\nSome existing instructions.\n");
    await runMcpInstall({
      yes: true,
      claudeMd,
      print: () => {},
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      runClaudeAdd: (): ClaudeAddResult => ({ status: 0 }),
    });
    const body = readFileSync(claudeMd, "utf8");
    expect(body).toContain("# My project");
    expect(body).toContain("Some existing instructions.");
    expect(body).toContain(buildAgentInstructionsBlock());
  });

  test("a fresh run with no prior CLAUDE.md creates it with the block", async () => {
    const claudeMd = tmpClaudeMd();
    await runMcpInstall({
      yes: true,
      claudeMd,
      print: () => {},
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      runClaudeAdd: (): ClaudeAddResult => ({ status: 0 }),
    });
    expect(readFileSync(claudeMd, "utf8")).toContain(INSTRUCTIONS_MARKER);
  });
});

describe("fbrain mcp install — gating", () => {
  test("--yes skips the [Y/n] prompt (ask is never called)", async () => {
    let asked = false;
    const result = await runMcpInstall({
      yes: true,
      claudeMd: tmpClaudeMd(),
      print: () => {},
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      runClaudeAdd: (): ClaudeAddResult => ({ status: 0 }),
      ask: async () => {
        asked = true;
        return "y";
      },
    });
    expect(result.code).toBe(0);
    expect(asked).toBe(false);
  });

  test("without --yes, declining at the prompt is a clean no-op", async () => {
    const claudeMd = tmpClaudeMd();
    let claudeAddCalled = false;
    const result = await runMcpInstall({
      claudeMd,
      print: () => {},
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      isTty: () => true,
      ask: async () => "n",
      runClaudeAdd: () => {
        claudeAddCalled = true;
        return { status: 0 };
      },
    });
    expect(result.code).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(claudeAddCalled).toBe(false);
    expect(() => readFileSync(claudeMd, "utf8")).toThrow();
  });

  test("without --yes in a non-TTY shell, it declines (no silent side effects)", async () => {
    const claudeMd = tmpClaudeMd();
    let claudeAddCalled = false;
    const result = await runMcpInstall({
      claudeMd,
      print: () => {},
      whichBin: which({ "fbrain-mcp": "/usr/bin/fbrain-mcp", claude: "/usr/bin/claude" }),
      isTty: () => false,
      runClaudeAdd: () => {
        claudeAddCalled = true;
        return { status: 0 };
      },
    });
    expect(result.code).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(claudeAddCalled).toBe(false);
    expect(() => readFileSync(claudeMd, "utf8")).toThrow();
  });
});
