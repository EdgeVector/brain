// Pins the targeted hint for `fbrain put <slug> --tag/--tags X`.
//
// `put`'s tags intentionally come from the YAML frontmatter (`tags:` line) —
// there is no tag flag. But `<type> new` DOES take a repeatable `--tag`, so a
// fresh user reflexively carries it over (`fbrain put my-note --type concept
// --tags perf`) and — because `put` has no close Levenshtein match for
// `--tag(s)` among its own options — dead-ended on parseArgs's raw "Unknown
// option" message, which advises an actively-misleading `-- "--tag"`
// positional-escape trick and never points at the frontmatter path.
//
// Same papercut shape as the existing `--title` / `--body` handlers in
// cli-put-title-flag-hint.test.ts / cli-put-body-flag-hint.test.ts: turn a raw
// parseArgs failure into a targeted FbrainError with a frontmatter hint. The
// bare parseArgs message (and its `--` escape advice) must NOT leak through.
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
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-put-tag-hint-"));
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

describe("fbrain put --tag/--tags → frontmatter hint", () => {
  for (const flag of ["--tag", "--tags"] as const) {
    test(`\`fbrain put foo --type concept ${flag} perf\` exits 2 with a frontmatter hint`, async () => {
      const { code, stderr } = await runCli([
        "put",
        "foo",
        "--type",
        "concept",
        flag,
        "perf",
      ]);
      expect(code).toBe(2);
      // The bare parseArgs error must be replaced — not just appended to.
      expect(stderr).not.toContain("Unknown option");
      // And the actively-misleading `-- "--x"` escape advice must not leak.
      expect(stderr).not.toContain('place it at the end');
      expect(stderr).not.toContain('"--tag"');
      expect(stderr).not.toContain('"--tags"');
      // Explains why the flag isn't accepted on `put`, naming the flag typed.
      expect(stderr).toContain(flag);
      // Points at the frontmatter tag path.
      expect(stderr).toContain("frontmatter");
      expect(stderr).toContain("tags:");
      // Copy-pasteable hint threads the user's slug into a `put` invocation.
      expect(stderr).toContain("fbrain put foo");
      // Fires before readConfig — the empty-HOME would otherwise produce a
      // config-missing error and shadow the hint.
      expect(stderr).not.toMatch(/config not found/i);
    });
  }

  test("flags-first: `put --type design my-note --tags x` recovers the SLUG, not the --type value", async () => {
    // The slug positional comes AFTER `--type design`. The recovery must skip
    // an option's value and recover the real slug `my-note` — mirrors the
    // --body branch's recoverPutSlug() behavior.
    const { code, stderr } = await runCli([
      "put",
      "--type",
      "design",
      "my-note",
      "--tags",
      "x",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain put my-note");
    // The --type VALUE must NOT be mistaken for the slug.
    expect(stderr).not.toContain("fbrain put design");
    expect(stderr).not.toContain("Unknown option");
  });

  test("`fbrain put --tags x` (no slug) falls back to `<slug>` in the hint", async () => {
    // The slug-recovery scan only looks at args BEFORE the tag flag. With no
    // positional, it falls back to the literal `<slug>` placeholder rather
    // than mis-treating the flag VALUE ("x") as a slug.
    const { code, stderr } = await runCli(["put", "--tags", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain put <slug>");
    // Critically, the flag VALUE ("x") must not appear as the slug.
    expect(stderr).not.toContain("fbrain put x");
    expect(stderr).not.toContain("Unknown option");
  });

  test("the existing --title / --body hints are untouched by the tag-flag arm", async () => {
    // Regression guard: extending the catch block must not break the
    // sibling handlers. --title routes at `<type> new`; --body routes at stdin.
    const title = await runCli(["put", "foo", "--title", "X"]);
    expect(title.code).toBe(2);
    expect(title.stderr).toContain("fbrain concept new foo --title");
    expect(title.stderr).not.toContain("Unknown option");

    const body = await runCli(["put", "foo", "--type", "concept", "--body", "X"]);
    expect(body.code).toBe(2);
    expect(body.stderr).toContain("stdin");
    expect(body.stderr).not.toContain("Unknown option");
  });

  test("unrelated unknown options on put get the clean no-suggestion error, not the tag hint or the raw parseArgs string", async () => {
    // Same fall-through invariant as the --title/--body tests: an unrelated typo
    // like `--bogus` must NOT trigger the tag hint — and must NOT leak Node's
    // raw parseArgs string. It falls through to the generic no-suggestion branch.
    const { code, stderr } = await runCli(["put", "foo", "--bogus"]);
    expect(code).toBe(2);
    // Clean backtick-quoted message — NOT Node's single-quoted bare string.
    expect(stderr).toContain("Unknown option `--bogus`.");
    expect(stderr).not.toContain("Unknown option '--bogus'");
    expect(stderr).not.toContain("place it at the end");
    // No misleading tag hint.
    expect(stderr).not.toContain("Tags come from frontmatter");
    // The generic valid-options hint instead.
    expect(stderr).toContain("Valid options:");
    expect(stderr).toContain("fbrain help put");
  });
});
