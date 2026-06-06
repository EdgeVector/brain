// Pins the targeted hint for `fbrain put <slug> --body/--content/--text X`.
//
// `put`'s body intentionally comes from stdin (with optional YAML
// frontmatter) — there is no body flag. But a fresh user's first reflex is
// `fbrain put my-note --type concept --body "..."`, and before this guard
// they dead-ended on parseArgs's bare "Unknown option '--body'" with no
// nudge toward `echo ... | fbrain put`.
//
// Same papercut shape as the existing `--title` handler in cli-put-title-
// flag-hint.test.ts: turn a raw parseArgs failure into a targeted
// FbrainError with a hint. The bare parseArgs message must NOT leak through
// — replaced entirely with the explanation + stdin invocation.
//
// Spawn-based so we exercise the real argv → parseArgs → runPut path.
// HOME points at an empty dir so readConfig() would throw a
// ConfigMissingError if it ran — the hint MUST fire before readConfig.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-put-body-hint-"));
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

describe("fbrain put --body/--content/--text → stdin hint", () => {
  for (const flag of ["--body", "--content", "--text"] as const) {
    test(`\`fbrain put foo --type concept ${flag} X\` exits 1 with a stdin hint`, async () => {
      const { code, stderr } = await runCli([
        "put",
        "foo",
        "--type",
        "concept",
        flag,
        "X",
      ]);
      expect(code).toBe(1);
      // The bare parseArgs error must be replaced — not just appended to.
      expect(stderr).not.toContain("Unknown option");
      // Explains why the flag isn't accepted on `put`.
      expect(stderr).toContain(flag);
      expect(stderr).toContain("stdin");
      // Nudges at the right invocation, with the user's slug threaded in.
      expect(stderr).toContain("fbrain put foo --type concept");
      // Fires before readConfig — the empty-HOME would otherwise produce a
      // config-missing error and shadow the hint.
      expect(stderr).not.toMatch(/config not found/i);
    });
  }

  test("`fbrain put foo --type design --body X` threads the user's type into the hint", async () => {
    // The hint must reflect the `--type <T>` the user actually typed, not a
    // hardcoded `concept` — otherwise the suggested command contradicts the
    // intent. Mirrors the `--title` branch's recoverPutType() behavior.
    const { code, stderr } = await runCli([
      "put",
      "foo",
      "--type",
      "design",
      "--body",
      "X",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("fbrain put foo --type design");
    expect(stderr).not.toContain("--type concept");
    expect(stderr).not.toContain("Unknown option");
  });

  test("`fbrain put --body X` (no slug) falls back to `<slug>` in the hint", async () => {
    // The slug-recovery scan only looks at args BEFORE the body flag. With
    // no positional, it falls back to the literal `<slug>` placeholder
    // rather than mis-treating the flag VALUE ("X") as a slug.
    const { code, stderr } = await runCli(["put", "--body", "X"]);
    expect(code).toBe(1);
    expect(stderr).toContain("fbrain put <slug> --type concept");
    // Critically, the flag VALUE ("X") must not appear as the slug.
    expect(stderr).not.toContain("fbrain put X");
    expect(stderr).not.toContain("Unknown option");
  });

  test("the existing --title hint is still untouched by the body-flag arm", async () => {
    // Regression guard: extending the catch block must not break the
    // `--title` handler covered by cli-put-title-flag-hint.test.ts.
    const { code, stderr } = await runCli(["put", "foo", "--title", "X"]);
    expect(code).toBe(1);
    // No `--type` in args → the title hint falls back to the concrete
    // `concept` example (copy-pasteable, not the literal `<type>`).
    expect(stderr).toContain("fbrain concept new foo --title");
    expect(stderr).toContain("frontmatter");
    expect(stderr).not.toContain("Unknown option");
    // And it must not mention stdin / body — that's a different papercut.
    expect(stderr).not.toContain("stdin");
  });

  test("unrelated unknown options on put still surface parseArgs's message", async () => {
    // Same fall-through invariant as the --title test: an unrelated typo
    // like `--bogus` should NOT trigger the body hint.
    const { code, stderr } = await runCli(["put", "foo", "--bogus"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown option '--bogus'");
    expect(stderr).not.toContain("stdin");
  });
});
