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
  test("`fbrain put foo --title X` exits 1 with a frontmatter + concrete-type hint", async () => {
    const { code, stderr } = await runCli(["put", "foo", "--title", "X"]);
    expect(code).toBe(2);
    // The bare parseArgs error must be replaced — not just appended to.
    // A user who sees "Unknown option '--title'" assumes --title is wrong
    // when it's actually right (just on the wrong subcommand).
    expect(stderr).not.toContain("Unknown option");
    // Explains why --title isn't accepted on `put`.
    expect(stderr).toContain("frontmatter");
    expect(stderr).toContain("H1");
    // With no `--type` in args, the hint falls back to a concrete example
    // (`concept`) so the suggestion is copy-pasteable. The literal `<type>`
    // placeholder must NEVER appear — a fresh user would copy it verbatim.
    expect(stderr).toContain("fbrain concept new foo --title");
    expect(stderr).not.toContain("<type>");
    // Fires before readConfig — the empty-HOME would otherwise produce a
    // config-missing error and shadow the hint.
    expect(stderr).not.toMatch(/config not found/i);
  });

  test("hint threads the user's `--type <T>` into the suggested form", async () => {
    // `fbrain put my-slug --type concept --title X` — the actual type is
    // RIGHT THERE in the args; the hint must use it verbatim so the
    // suggestion is copy-pasteable.
    const { code, stderr } = await runCli([
      "put",
      "my-slug",
      "--type",
      "concept",
      "--title",
      "X",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain concept new my-slug --title");
    expect(stderr).not.toContain("<type>");
    expect(stderr).not.toContain("Unknown option");
  });

  test("hint threads a non-default `--type <T>` (design) verbatim too", async () => {
    // Sanity: any of the 8 record types should thread through, not just
    // the `concept` fallback.
    const { code, stderr } = await runCli([
      "put",
      "my-slug",
      "--type",
      "design",
      "--title",
      "X",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain design new my-slug --title");
    expect(stderr).not.toContain("<type>");
  });

  test("`--type=<T>` (equals form) also threads through to the hint", async () => {
    // parseArgs accepts `--type=concept` as a synonym for `--type concept`;
    // the recovery scan must handle both forms or the hint regresses to the
    // fallback when users use the equals shape.
    const { code, stderr } = await runCli([
      "put",
      "my-slug",
      "--type=design",
      "--title",
      "X",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain design new my-slug --title");
    expect(stderr).not.toContain("<type>");
  });

  test("an invalid `--type <T>` falls back to the concrete `concept` example", async () => {
    // `--type bogus` is not a real record type — the recovery scan would
    // otherwise emit a garbage suggestion. Fall back to the `concept`
    // example instead so the hint stays copy-pasteable.
    const { code, stderr } = await runCli([
      "put",
      "my-slug",
      "--type",
      "bogus",
      "--title",
      "X",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain concept new my-slug --title");
    expect(stderr).not.toContain("fbrain bogus new");
    expect(stderr).not.toContain("<type>");
  });

  test("flags-first: `put --type design my-note --title X` recovers the SLUG, not the --type value", async () => {
    // The slug positional comes AFTER `--type design` here. A naive
    // "first non-flag token before --title" scan grabs `design` (the VALUE
    // of `--type`) as the slug, mis-directing the user to create a record
    // literally slugged `design`. The recovery must skip an option's value
    // and recover the real slug `my-note`.
    const { code, stderr } = await runCli([
      "put",
      "--type",
      "design",
      "my-note",
      "--title",
      "X",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain design new my-note --title");
    // The --type VALUE must NOT be mistaken for the slug.
    expect(stderr).not.toContain("fbrain design new design");
    expect(stderr).not.toContain("<type>");
  });

  test("flags-first, no slug: `put --type concept --title X` falls back to `<slug>`", async () => {
    // Only `--type concept` precedes `--title`, and `concept` is the VALUE
    // of `--type` — not a positional. With no real slug, the recovery must
    // fall back to the literal `<slug>` placeholder, NOT grab `concept`.
    const { code, stderr } = await runCli([
      "put",
      "--type",
      "concept",
      "--title",
      "X",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain concept new <slug> --title");
    expect(stderr).not.toContain("fbrain concept new concept");
    expect(stderr).not.toContain("<type>");
  });

  test("`fbrain put --title X` (no slug) falls back to `<slug>` and `concept` in the hint", async () => {
    // The slug-recovery scan only looks at args BEFORE `--title`. With no
    // positional, it falls back to the literal `<slug>` placeholder rather
    // than mis-treating the `--title` VALUE ("X") as a slug. The type, with
    // no `--type` in args, falls back to the concrete `concept` example.
    const { code, stderr } = await runCli(["put", "--title", "X"]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain concept new <slug> --title");
    // Critically, the title VALUE ("X") must not appear as a slug suggestion.
    expect(stderr).not.toContain("fbrain concept new X");
    // And the literal `<type>` placeholder must never leak through.
    expect(stderr).not.toContain("<type>");
    expect(stderr).not.toContain("Unknown option");
  });

  test("unrelated unknown options on put get the clean no-suggestion error, not the title hint or the raw parseArgs string", async () => {
    // The targeted hint is only for `--title`. A truly unknown option like
    // `--bogus` must NOT trigger the title hint — and must NOT leak Node's raw
    // parseArgs string either. It falls through to the generic no-suggestion
    // branch: a clean error + valid-options hint pointing at `fbrain help put`.
    const { code, stderr } = await runCli(["put", "foo", "--bogus"]);
    expect(code).toBe(2);
    // Clean backtick-quoted message — NOT Node's single-quoted bare string.
    expect(stderr).toContain("Unknown option `--bogus`.");
    expect(stderr).not.toContain("Unknown option '--bogus'");
    expect(stderr).not.toContain("place it at the end");
    // No misleading title hint.
    expect(stderr).not.toContain("frontmatter");
    expect(stderr).not.toContain("<type> new");
    // The generic valid-options hint instead.
    expect(stderr).toContain("Valid options:");
    expect(stderr).toContain("fbrain help put");
  });
});
