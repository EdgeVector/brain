// Pins the friendly hint for `fbrain <type> new --tags foo,bar`.
//
// `--tags` (plural, comma-list) is an extremely natural guess — npm, cargo, and
// git all accept comma lists somewhere — but fbrain's tag flag is the singular,
// repeatable `--tag`. Before this guard, the `<type> new` path dead-ended on
// parseArgs's bare "Unknown option '--tags'" with no nudge toward the right
// flag, even though the `put` path already recovered gracefully (#149/#151).
// This turns the raw parseArgs failure into a targeted FbrainError that names
// the closest known flag and gives a copy-pasteable repeatable example.
//
// Same papercut shape as the `--node-url` / `put --title` / `put --body`
// nudges. The bare parseArgs message must NOT leak through, and the fix is
// table-driven across every record type (they all funnel through the shared
// parseCommandArgs helper), so we assert the hint fires for several types —
// not just `concept`.
//
// Spawn-based so we exercise the real argv → parseArgs → runRecordNew path.
// HOME points at an empty dir so readConfig() would throw a ConfigMissingError
// if it ran — the hint MUST fire before readConfig, otherwise a brand-new
// uninit'd machine would see the config error and never reach the actionable
// hint.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-tags-hint-"));
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

describe("fbrain <type> new --tags → repeatable --tag hint", () => {
  // Table-driven: the fix lives in the shared parseCommandArgs helper, so the
  // hint must fire identically for every record type's `new` subcommand.
  for (const type of ["concept", "task", "design", "preference", "project"]) {
    test(`\`fbrain ${type} new --tags foo,bar <slug>\` emits the --tag hint`, async () => {
      const { code, stderr } = await runCli([
        type,
        "new",
        "--tags",
        "foo,bar",
        "some-slug",
      ]);
      expect(code).toBe(2);
      // The bare parseArgs error must be REPLACED, not appended to.
      expect(stderr).not.toContain("Unknown option '--tags'");
      // Names the closest known flag and gives the repeatable example.
      expect(stderr).toContain("--tag");
      expect(stderr).toContain("--tag foo --tag bar");
      // Fires before readConfig — empty HOME would otherwise shadow the hint.
      expect(stderr).not.toMatch(/config not found/i);
    });
  }

  test("the legitimate repeatable `--tag foo --tag bar` form does NOT trigger the hint", async () => {
    // `--tag` is a known flag, so parseArgs succeeds and we proceed to
    // readConfig (which fails only because HOME is empty). The point: no false
    // "did you mean --tag" hint when the user already used the right flag.
    const { code, stderr } = await runCli([
      "concept",
      "new",
      "--tag",
      "foo",
      "--tag",
      "bar",
      "good-slug",
    ]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Did you mean");
    // We got far enough to hit config resolution — proof the parse succeeded.
    expect(stderr).toMatch(/config not found/i);
  });

  test("the `-- \"--tags\"` positional escape hatch still treats --tags as the slug", async () => {
    // Tokens after `--` are positionals, so parseArgs never throws on them.
    // `concept new -- "--tags"` must take `--tags` as the slug and reach
    // readConfig — NOT emit the unknown-option hint.
    const { code, stderr } = await runCli(["concept", "new", "--", "--tags"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).not.toContain("Did you mean");
    expect(stderr).toMatch(/config not found/i);
  });

  test("a far-off unknown option gets a clean error + valid-options hint, never the raw parseArgs string", async () => {
    // The suggestion is Levenshtein-gated. `--xyzzy` is nowhere near any known
    // flag, so it must NOT be absorbed into a misleading "Did you mean". But it
    // must ALSO not leak Node's raw parseArgs string — instead it gets the same
    // clean error/hint contract every other unknown-input surface follows:
    // name the bad flag, list the command's valid flags, point at help.
    const { code, stderr } = await runCli([
      "concept",
      "new",
      "--xyzzy",
      "s",
    ]);
    expect(code).toBe(2);
    // Clean backtick-quoted message — NOT Node's single-quoted bare string.
    expect(stderr).toContain("Unknown option `--xyzzy`.");
    expect(stderr).not.toContain("Unknown option '--xyzzy'");
    // The misleading `--`-positional-escape advice must be gone.
    expect(stderr).not.toContain("place it at the end");
    // No false suggestion, but a genuine valid-options hint pointing at help.
    expect(stderr).not.toContain("Did you mean");
    expect(stderr).toContain("Valid options:");
    expect(stderr).toContain("fbrain help concept new");
  });
});
