// Pins the "Did you mean?" hint produced for unknown commands and unknown
// design/task subcommands. Two-fold guard:
//
//   1. Single-char typos against the top-level COMMANDS list (e.g. `serch`,
//      `lst`, `doctir`) emit a one-line hint and DON'T dump TOP_HELP — that
//      noisy fallback was the dogfood complaint in fbrain 0.0.1.
//   2. Subcommand pairs (`design new`, `task new`) score as the full
//      two-token form so `desogn new` and `task nwe` suggest the compound,
//      not the bare verb.
//
// Truly unknown inputs (no candidate within the threshold) still fall back
// to TOP_HELP so cold-start discovery isn't penalized.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { levenshtein, suggestCommand } from "../../src/cli.ts";

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

describe("suggestCommand", () => {
  test("serch → search (single-token typo)", () => {
    expect(suggestCommand({ single: "serch" })).toBe("search");
  });

  test("lst → list (prefix typo)", () => {
    expect(suggestCommand({ single: "lst" })).toBe("list");
  });

  test("doctir → doctor (single-char swap)", () => {
    expect(suggestCommand({ single: "doctir" })).toBe("doctor");
  });

  test("desogn new → design new (compound beats single on tie)", () => {
    expect(suggestCommand({ single: "desogn", compound: "desogn new" })).toBe("design new");
  });

  test("task nwe → task new (compound-only, since `task` is itself valid)", () => {
    expect(suggestCommand({ compound: "task nwe" })).toBe("task new");
  });

  test("xyzzy → null (no candidate within threshold)", () => {
    expect(suggestCommand({ single: "xyzzy" })).toBeNull();
  });

  test("empty input → null", () => {
    expect(suggestCommand({})).toBeNull();
  });
});

describe("levenshtein", () => {
  test("identical strings → 0", () => {
    expect(levenshtein("design", "design")).toBe(0);
  });

  test("single substitution → 1", () => {
    expect(levenshtein("desogn", "design")).toBe(1);
  });

  test("transposition → 2 (classic Levenshtein, not Damerau)", () => {
    expect(levenshtein("nwe", "new")).toBe(2);
  });

  test("empty vs non-empty → length of the non-empty", () => {
    expect(levenshtein("", "search")).toBe(6);
    expect(levenshtein("search", "")).toBe(6);
  });
});

describe("CLI hint behaviour", () => {
  test("`fbrain serch` prints a one-line hint and NO TOP_HELP", async () => {
    const { code, stdout, stderr } = await runCli(["serch", "phase 6"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command: serch. Did you mean: search?");
    expect(stderr).not.toContain("Usage:");
    expect(stderr).not.toContain("Commands:");
    expect(stdout).toBe("");
  });

  test("`fbrain doctir` suggests doctor without dumping help", async () => {
    const { code, stderr } = await runCli(["doctir"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Did you mean: doctor?");
    expect(stderr).not.toContain("Commands:");
  });

  test("`fbrain desogn new x` suggests `design new` (compound form)", async () => {
    const { code, stderr } = await runCli(["desogn", "new", "x"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Did you mean: design new?");
    expect(stderr).not.toContain("Commands:");
  });

  test("`fbrain task nwe x` suggests `task new` via subcommand dispatch", async () => {
    const { code, stderr } = await runCli(["task", "nwe", "x"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown task subcommand: nwe. Did you mean: task new?");
  });

  test("`fbrain xyzzy` still dumps TOP_HELP — cold-start discovery preserved", async () => {
    const { code, stderr } = await runCli(["xyzzy"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command: xyzzy");
    expect(stderr).not.toContain("Did you mean:");
    expect(stderr).toContain("Commands:");
  });
});
