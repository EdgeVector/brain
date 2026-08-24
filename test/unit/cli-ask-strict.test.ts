// Pins the strict rejection of `fbrain ask --explain` without expansion.
//
// Post-flip (2026-06-15): LLM query expansion is OFF by default — the
// labeled eval showed it REDUCES relevance (gate doc §8). `--explain` prints
// the LLM-generated expansions, so it now REQUIRES `--expand` (alias --llm).
// `--explain` on its own — or paired with the back-compat `--no-llm` no-op —
// has nothing to explain and must exit 2 with a clear next step before any
// retrieval runs. Also pins that `--no-llm` contradicts an explicit
// `--expand`/`--llm`.
//
// Phase 3 (knowledge graph) gave `--explain` a SECOND thing to explain: the
// graph adjacency boost. `--explain --graph-boost` is therefore accepted, and
// the rejection now fires only when NEITHER source is on. The env switch
// `BRAIN_GRAPH_BOOST` is cleared in `runCli` so a developer who exported it
// cannot silently turn these rejection tests green.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      FBRAIN_NO_STDIN: "1",
      // Explicitly OFF: the boost is an alternative satisfier for --explain,
      // so an inherited env var would make the rejection tests vacuous.
      BRAIN_GRAPH_BOOST: "0",
      FBRAIN_GRAPH_BOOST: "0",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("fbrain ask --explain requires expansion (strict)", () => {
  test("--explain alone exits 2 — expansion is off by default, so add --expand", async () => {
    const { code, stdout, stderr } = await runCli(["ask", "anything", "--explain"]);
    expect(code).toBe(2);
    expect(stderr).toContain(
      "error: --explain requires LLM expansion or the graph boost; " +
        "add --expand (alias --llm) or --graph-boost.",
    );
    // No retrieval may run — stdout must be empty.
    expect(stdout).toBe("");
  });

  test("--explain --no-llm exits 2 (no-op flag can't satisfy --explain)", async () => {
    const { code, stderr } = await runCli(["ask", "anything", "--no-llm", "--explain"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--explain requires LLM expansion");
  });

  test("--no-llm contradicts --expand and exits 2", async () => {
    const { code, stderr } = await runCli(["ask", "anything", "--expand", "--no-llm"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--no-llm contradicts --expand/--llm");
  });

  test("--explain --graph-boost is accepted (the boost is explainable)", async () => {
    const { code, stderr } = await runCli(["ask", "anything", "--explain", "--graph-boost"]);
    // It may still fail later for want of a configured node on this machine —
    // what must NOT happen is the usage rejection.
    expect(stderr).not.toContain("--explain requires LLM expansion");
    expect(code).not.toBe(2);
  });

  test("--graph-boost-weight without --graph-boost exits 2", async () => {
    const { code, stderr } = await runCli(["ask", "anything", "--graph-boost-weight", "1.5"]);
    expect(code).toBe(2);
    expect(stderr).toContain("require --graph-boost");
  });

  test("--graph-boost-seeds without --graph-boost exits 2", async () => {
    const { code, stderr } = await runCli(["ask", "anything", "--graph-boost-seeds", "2"]);
    expect(code).toBe(2);
    expect(stderr).toContain("require --graph-boost");
  });
});
