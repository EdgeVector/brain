// Pins the extra-positional guard on `fbrain <type> new`. Before this guard,
// `fbrain task new my-slug extra` silently dropped "extra" and `fbrain task
// new my-slug --tag a b` silently dropped "b" (user thought both tags
// landed; only "a" did). All 8 record types share runRecordNew, so a single
// guard fixes design/task/concept/preference/reference/agent/project/spike
// at once. Same papercut shape as PRs #177 (put) / #181 (link) / #112
// (delete): reject the silently-dropped input loudly before any I/O so the
// user can fix the invocation instead of debugging a half-created record.
//
// Spawn-based so we exercise the real argv → parseArgs → runRecordNew path.
// HOME points at an empty dir so readConfig() would throw if it ran — the
// guard MUST fire before readConfig (un-init'd machines still get the clear
// validation error, not "config missing").

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-record-new-extra-"));
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

describe("fbrain <type> new extra-positional guard", () => {
  test("`fbrain task new my-slug extra` exits 1 with a clear validation message", async () => {
    const { code, stderr } = await runCli(["task", "new", "my-slug", "extra"]);
    expect(code).toBe(1);
    expect(stderr).toContain("task new takes exactly one slug");
    expect(stderr).toContain("2");
    // Both positionals surfaced so the user sees what got dropped.
    expect(stderr).toContain("my-slug");
    expect(stderr).toContain("extra");
    // Hint explains the two most common causes (unquoted title, repeated tag).
    expect(stderr).toContain("--title");
    expect(stderr).toContain("--tag");
    // The check runs before readConfig — never the config-missing path.
    expect(stderr.toLowerCase()).not.toContain("config not found");
  });

  test("`fbrain task new my-slug --tag a b` (the classic silent-drop) is rejected", async () => {
    // parseArgs assigns `a` to --tag, then `b` becomes positional[1]. Before
    // the guard, the record was created with only ["a"] and "b" silently
    // dropped. Now the guard catches `b` as an extra positional.
    const { code, stderr } = await runCli([
      "task",
      "new",
      "my-slug",
      "--tag",
      "a",
      "b",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("task new takes exactly one slug");
    expect(stderr).toContain("my-slug");
    expect(stderr).toContain("b");
  });

  test("`fbrain task new my-slug --title two words` (unquoted title) is rejected", async () => {
    // parseArgs consumes `two` as the --title value, then `words` becomes
    // positional[1]. The guard catches it so the user notices the missing
    // quotes instead of creating a task titled "two".
    const { code, stderr } = await runCli([
      "task",
      "new",
      "my-slug",
      "--title",
      "two",
      "words",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("task new takes exactly one slug");
    expect(stderr).toContain("my-slug");
    expect(stderr).toContain("words");
  });

  test("`fbrain design new slug1 slug2 slug3` reports all extras", async () => {
    const { code, stderr } = await runCli([
      "design",
      "new",
      "slug1",
      "slug2",
      "slug3",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("design new takes exactly one slug");
    expect(stderr).toContain("3");
    expect(stderr).toContain("slug1");
    expect(stderr).toContain("slug3");
  });

  test("`fbrain concept new my-slug extra` (Phase-6 type) is also covered", async () => {
    // The 6 Phase-6 types (concept/preference/reference/agent/project/spike)
    // share DESIGN_OPTIONS; the guard must fire for them too.
    const { code, stderr } = await runCli([
      "concept",
      "new",
      "my-slug",
      "extra",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("concept new takes exactly one slug");
    expect(stderr).toContain("my-slug");
    expect(stderr).toContain("extra");
  });

  test("`fbrain task new my-slug` (single positional) does NOT trip the guard", async () => {
    // A valid single-slug invocation must still get past the guard; it will
    // then fail at readConfig (empty HOME) — a config error, not a validation
    // error. That proves the guard let a one-positional invocation through.
    const { code, stderr } = await runCli(["task", "new", "my-slug"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("task new takes exactly one slug");
    expect(stderr.toLowerCase()).toContain("config");
  });
});
