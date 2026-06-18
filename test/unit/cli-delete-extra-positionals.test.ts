// Pins the extra-positional guard on `fbrain delete`. Before this guard,
// `fbrain delete slug1 slug2` silently soft-deleted slug1 and dropped
// slug2 with no warning — worst class of silent drop because delete is
// destructive (the user thought they bulk-deleted; only one record went).
// Same papercut shape as PRs #93/#94/#96/#108: reject the silently-dropped
// input loudly before any I/O so the user can fix the invocation.
//
// Spawn-based so we exercise the real argv → parseArgs → runDelete path.
// HOME points at an empty dir so readConfig() would throw if it ran — the
// guard MUST fire before readConfig (un-init'd machines still get the
// clear validation error, not "config missing").

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-delete-extra-"));
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

describe("fbrain delete extra-positional guard", () => {
  test("`fbrain delete slug1 slug2` exits 1 with a clear validation message", async () => {
    const { code, stderr } = await runCli(["delete", "slug1", "slug2"]);
    expect(code).toBe(2);
    expect(stderr).toContain("delete takes exactly one slug");
    expect(stderr).toContain("2");
    // Both slugs surfaced so the user sees what got dropped.
    expect(stderr).toContain("slug1");
    expect(stderr).toContain("slug2");
    // Hint nudges toward the per-record loop.
    expect(stderr).toContain("once per record");
    // The check runs before config — never the config-missing path.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain delete slug1 slug2 slug3` exits 1 and reports all extras", async () => {
    const { code, stderr } = await runCli(["delete", "slug1", "slug2", "slug3"]);
    expect(code).toBe(2);
    expect(stderr).toContain("delete takes exactly one slug");
    expect(stderr).toContain("3");
    expect(stderr).toContain("slug1");
    expect(stderr).toContain("slug3");
  });

  test("`fbrain delete --type design slug1 slug2` (extras after a flag) is still rejected", async () => {
    // The guard counts positionals after parseArgs has split flags off, so
    // a --type flag mixed in does not change the result: still 2 slugs, still
    // rejected.
    const { code, stderr } = await runCli([
      "delete",
      "--type",
      "design",
      "slug1",
      "slug2",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("delete takes exactly one slug");
    expect(stderr).toContain("slug1");
    expect(stderr).toContain("slug2");
  });

  test("`fbrain delete slug1` (single positional) does NOT trip the guard", async () => {
    // The single-slug invocation must still get past the guard; it will
    // then fail at readConfig (HOME points at an empty dir) — a config
    // error, not a validation error. That proves the guard didn't fire.
    const { code, stderr } = await runCli(["delete", "slug1"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("delete takes exactly one slug");
    // Falls through to the config-missing path, confirming the guard let
    // a valid invocation through.
    expect(stderr.toLowerCase()).toContain("config");
  });
});
