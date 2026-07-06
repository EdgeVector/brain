// Pins the CLI-level argument routing for filter-mode (bulk) delete:
//   - a bare `fbrain delete` (no slug, no filter) is refused with the usage
//     error (NOT an "unbounded delete everything");
//   - `fbrain delete <slug> --tag T` (slug AND a filter) is a contradiction
//     and is rejected loudly rather than silently ignoring the filter;
//   - `fbrain delete --tag T` (filter, no slug) gets PAST argument validation
//     and falls through to the config/SDK path — proving the filter route is
//     wired (the validation guards fired correctly and let a valid invocation
//     through).
//
// Spawn-based so we exercise the real argv → parseArgs → runDelete path. HOME
// points at an empty dir so readConfig() would throw if reached — the argument
// guards MUST fire before any I/O.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-delete-filter-"));
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

describe("fbrain delete filter-mode argument routing", () => {
  test("bare `fbrain delete` (no slug, no filter) prints usage and exits 2", async () => {
    const { code, stderr } = await runCli(["delete"]);
    expect(code).toBe(2);
    // The usage block, not a destructive everything-delete.
    expect(stderr).toContain("fbrain delete");
    expect(stderr).toContain("--tag");
  });

  test("`fbrain delete <slug> --tag T` (slug AND filter) is rejected", async () => {
    const { code, stderr } = await runCli(["delete", "some-slug", "--tag", "junk"]);
    expect(code).toBe(2);
    expect(stderr).toContain("EITHER a <slug> OR filter selectors");
    expect(stderr).toContain("some-slug");
    // Never reaches config — guard fires before any I/O.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain delete --tag T` (filter, no slug) passes validation and reaches the node path", async () => {
    const { stderr } = await runCli(["delete", "--tag", "junk"]);
    // It must NOT trip either validation guard — it's a valid filter invocation.
    expect(stderr).not.toContain("EITHER a <slug> OR filter selectors");
    expect(stderr).not.toContain("delete takes exactly one slug");
    // With an empty HOME it falls through to config/SDK resolution, which is
    // exactly what we want to confirm: the filter route is wired and tried to
    // talk to the node rather than erroring out at argument parsing.
  });

  test("`fbrain delete --status S` (status-only filter, no slug) is also a valid route", async () => {
    const { stderr } = await runCli(["delete", "--status", "archived"]);
    expect(stderr).not.toContain("EITHER a <slug> OR filter selectors");
    expect(stderr).not.toMatch(/^error: fbrain delete <slug>/);
  });
});
