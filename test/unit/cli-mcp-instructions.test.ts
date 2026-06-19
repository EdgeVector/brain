// `fbrain mcp instructions` is the one-step agent on-ramp: after
// `claude mcp add fbrain fbrain-mcp`, a new dev runs
// `fbrain mcp instructions >> CLAUDE.md` (or `| pbcopy`) to wire the brain into
// their agent — instead of opening docs/agent-instructions.md and hand-selecting
// the fenced block.
//
// These tests pin the delivery contract:
//   - stdout is EXACTLY the copy-paste CLAUDE.md block (buildAgentInstructionsBlock),
//     with a single trailing newline, nothing on stderr, exit 0 — so it is
//     paste-ready under `>>` / `| pbcopy`.
//   - the block is byte-for-byte the fenced ```markdown block in
//     docs/agent-instructions.md (drift guard — the command and the doc render
//     from the SAME builder, so they can't diverge).
//   - no node/config is required: it prints offline (pure presentation).
//   - an unknown `fbrain mcp <sub>` is a usage error (exit 2), not a silent
//     server start.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { buildAgentInstructionsBlock } from "../../src/schemas.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "agent-instructions.md");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // No FBRAIN config / node URL in env: the command must print offline.
    env: { ...process.env, FBRAIN_NO_STDIN: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("fbrain mcp instructions", () => {
  test("prints ONLY the copy-paste block (block + trailing newline), nothing on stderr, exit 0", async () => {
    const { code, stdout, stderr } = await runCli(["mcp", "instructions"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    // Exactly the builder block plus a single trailing newline — paste-ready.
    expect(stdout).toBe(`${buildAgentInstructionsBlock()}\n`);
  });

  test("output is the agent usage-loop + record-type table, no wrapper prose", async () => {
    const { stdout } = await runCli(["mcp", "instructions"]);
    // The pasteable heading is the first line — no intro prose above it.
    expect(stdout.startsWith("## fbrain (persistent memory)")).toBe(true);
    // Usage-loop + table markers present.
    expect(stdout).toContain("1. **Recall first.**");
    expect(stdout).toContain("3. **Pick the right type.**");
    expect(stdout).toContain("| Type | Use it for |");
    // None of the doc's surrounding prose leaks in.
    expect(stdout).not.toContain("# Use fbrain with your AI agent");
    expect(stdout).not.toContain("## Copy-paste block");
    expect(stdout).not.toContain("```markdown");
  });

  test("matches the fenced markdown block in docs/agent-instructions.md (drift guard)", async () => {
    const doc = await Bun.file(DOC_PATH).text();
    const m = doc.match(/```markdown\n([\s\S]*?)\n```/);
    expect(m).not.toBeNull();
    const fenced = m![1]!;
    // The doc's fenced block and the command's output share one builder.
    expect(fenced).toBe(buildAgentInstructionsBlock());

    const { stdout } = await runCli(["mcp", "instructions"]);
    expect(stdout.trimEnd()).toBe(fenced);
  });

  test("an unknown mcp subcommand is a usage error (exit 2), not a silent server start", async () => {
    const { code, stdout, stderr } = await runCli(["mcp", "bogus"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown mcp subcommand");
  });
});
