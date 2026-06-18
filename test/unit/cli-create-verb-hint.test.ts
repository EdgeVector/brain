// Pins the recovery hint for the top-level create-verbs `new` / `create` /
// `add`.
//
// fbrain creates records *per type* (`fbrain <type> new <slug>`), but a new
// dev's muscle memory from git/gh/cargo/npm/fkanban is a top-level
// `new`/`create`/`add`. Pure Levenshtein used to land these on an unrelated
// read/search verb — `new`→`get`, `add`→`ask` — which is actively misleading
// on the highest-traffic new-dev action (init's "Next steps" step 1 is "Create
// your first record"). This guard turns the dead-end into a pointer at the real
// `<type> new` family.
//
// Same accepted "recovery hint" UX pattern as cli-tags-flag-hint.test.ts and
// cli-status-verb-hint.test.ts. The hint must NOT absorb genuine typos
// (`lst`→`list`, `serach`→`search` keep their Levenshtein suggestion), and the
// type list is derived from RECORD_TYPES so a future record type stays in sync.
//
// Spawn-based so we exercise the real argv path. HOME points at an empty dir so
// readConfig() would throw if it ran — the hint MUST fire before readConfig,
// otherwise a brand-new uninit'd machine would never reach the actionable hint.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECORD_TYPES } from "../../src/schemas.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-create-hint-"));
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1", HOME: fakeHome },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("fbrain new/create/add → create-family recovery hint", () => {
  for (const verb of ["new", "create", "add"]) {
    test(`\`fbrain ${verb} foo\` points at the \`<type> new\` family`, async () => {
      const { code, stderr, stdout } = await runCli([verb, "foo"]);
      expect(code).toBe(2);
      // Points at the real create family with a concrete example.
      expect(stderr).toContain("fbrain <type> new <slug>");
      expect(stderr).toContain("fbrain design new my-first-idea");
      // The misleading nearest-match read/search verbs must be gone.
      expect(stderr).not.toContain("Did you mean: get?");
      expect(stderr).not.toContain("Did you mean: ask?");
      expect(stderr).not.toContain("Did you mean:");
      // Fires before readConfig — empty HOME would otherwise shadow the hint.
      expect(stderr).not.toMatch(/config not found/i);
      expect(stdout).toBe("");
    });
  }

  test("the hint lists every record type, derived from RECORD_TYPES", async () => {
    const { stderr } = await runCli(["new", "foo"]);
    for (const t of RECORD_TYPES) {
      expect(stderr).toContain(t);
    }
    // Spot-check the join shape too so a regression in the list is obvious.
    expect(stderr).toContain(RECORD_TYPES.join(" | "));
  });

  test("the hint mentions the `put` markdown-pipe alternative", async () => {
    const { stderr } = await runCli(["create", "foo"]);
    expect(stderr).toContain("fbrain put <slug> --type <type>");
  });

  // Regression: the create-verb special-case must NOT swallow genuine typos —
  // the existing Levenshtein path still fires for everything else.
  test("`fbrain lst` still suggests `list`", async () => {
    const { code, stderr } = await runCli(["lst"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Did you mean: list?");
  });

  test("`fbrain serach` still suggests `search`", async () => {
    const { code, stderr } = await runCli(["serach", "phase 6"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Did you mean: search?");
  });
});
