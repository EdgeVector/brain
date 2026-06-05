// Pins the targeted hint for `fbrain put <slug> --title "X"`.
//
// `put` is intentionally frontmatter-driven (title comes from `title:` in
// the leading `---` block or the first `# H1`), but every `<type> new`
// subcommand takes `--title`. A fresh user who's already used
// `design new <slug> --title "X"` reflexively tries the same shape on
// `put` and, before this guard, dead-ended on parseArgs's bare
// "Unknown option '--title'" with no nudge toward the right invocation.
//
// Same papercut shape as #148/#149/#151: turn a raw parseArgs failure
// into a targeted FbrainError with a hint. The bare parseArgs message
// must NOT leak through — replaced entirely with the explanation +
// `fbrain <type> new <slug> --title "..."` suggestion.
//
// Spawn-based so we exercise the real argv → parseArgs → runPut path.
// HOME points at an empty dir so readConfig() would throw a
// ConfigMissingError if it ran — the hint MUST fire before readConfig,
// otherwise a brand-new uninit'd machine would see the config error
// instead.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-put-title-hint-"));
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

describe("fbrain put --title → frontmatter hint", () => {
  test("`fbrain put foo --title X` exits 1 with a frontmatter + `<type> new foo` hint", async () => {
    const { code, stderr } = await runCli(["put", "foo", "--title", "X"]);
    expect(code).toBe(1);
    // The bare parseArgs error must be replaced — not just appended to.
    // A user who sees "Unknown option '--title'" assumes --title is wrong
    // when it's actually right (just on the wrong subcommand).
    expect(stderr).not.toContain("Unknown option");
    // Explains why --title isn't accepted on `put`.
    expect(stderr).toContain("frontmatter");
    expect(stderr).toContain("H1");
    // Nudges at the right invocation, with the user's slug threaded in.
    expect(stderr).toContain("fbrain <type> new foo --title");
    // Fires before readConfig — the empty-HOME would otherwise produce a
    // config-missing error and shadow the hint.
    expect(stderr).not.toMatch(/config not found/i);
  });

  test("hint also nudges when --type is interleaved before --title", async () => {
    // `fbrain put my-slug --type concept --title X` — same papercut, the
    // hint still finds the slug (scans args before `--title`).
    const { code, stderr } = await runCli([
      "put",
      "my-slug",
      "--type",
      "concept",
      "--title",
      "X",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("fbrain <type> new my-slug --title");
    expect(stderr).not.toContain("Unknown option");
  });

  test("`fbrain put --title X` (no slug) falls back to `<slug>` in the hint", async () => {
    // The slug-recovery scan only looks at args BEFORE `--title`. With no
    // positional, it falls back to the literal `<slug>` placeholder rather
    // than mis-treating the `--title` VALUE ("X") as a slug.
    const { code, stderr } = await runCli(["put", "--title", "X"]);
    expect(code).toBe(1);
    expect(stderr).toContain("fbrain <type> new <slug> --title");
    // Critically, the title VALUE ("X") must not appear as a slug suggestion.
    expect(stderr).not.toContain("fbrain <type> new X");
    expect(stderr).not.toContain("Unknown option");
  });

  test("unrelated unknown options on put still surface parseArgs's message", async () => {
    // The targeted hint is only for `--title`. A truly unknown option like
    // `--bogus` should fall through to the bare parseArgs error — otherwise
    // we'd be silently absorbing every typo.
    const { code, stderr } = await runCli(["put", "foo", "--bogus"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown option '--bogus'");
    // And critically, no misleading title hint.
    expect(stderr).not.toContain("frontmatter");
    expect(stderr).not.toContain("<type> new");
  });
});
