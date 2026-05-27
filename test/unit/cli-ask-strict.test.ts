// Pins the strict rejection of `fbrain ask --explain --no-llm`: the
// combination is contradictory (there are no LLM expansions to explain
// when expansion is skipped), so the CLI must exit 2 with a clear error
// before any retrieval runs. Regression guard for the dogfood report
// where `--explain --no-llm` was a silent no-op.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("fbrain ask --explain + --no-llm strict rejection", () => {
  test("exits 2 with the prescribed error message", async () => {
    const { code, stdout, stderr } = await runCli([
      "ask",
      "anything",
      "--no-llm",
      "--explain",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain(
      "error: --explain requires LLM expansion; remove --no-llm or drop --explain.",
    );
    // No retrieval may run — stdout must be empty.
    expect(stdout).toBe("");
  });

  test("flag order does not matter — --explain before --no-llm still rejected", async () => {
    const { code, stderr } = await runCli([
      "ask",
      "anything",
      "--explain",
      "--no-llm",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--explain requires LLM expansion");
  });
});
