// Pins `-n` validation on `fbrain list`:
//   1. `-n 0` errors with a clear message AND exits 1 (the old guard
//      silently returned every record because the guard used
//      `opts.limit && opts.limit > 0` and 0 is falsy).
//   2. `-n -1` errors with the same clear message instead of
//      parseArgs's cryptic "Option -n argument is ambiguous" (it sees
//      `-1` as a new short option, not -n's value).
//   3. `-n abc` is rejected too — non-numeric values had been silently
//      dropped to NaN before, which then fell through the limit check.
//
// Spawn-based so we exercise the real argv → parseArgs → runList path.
// HOME points at an empty dir so readConfig() would throw if it ran —
// this is sharper: if we EVER see the config-missing error, we know
// the -n validation didn't run first.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-list-n-"));
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

describe("fbrain list -n validation", () => {
  test("`fbrain list -n 0` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["list", "-n", "0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("-n must be a positive integer");
    expect(stderr).toContain("0");
    // The check runs before config — never the config-missing path.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain list -n -1` exits 1 with the validation message (not parseArgs's cryptic one)", async () => {
    const { code, stderr } = await runCli(["list", "-n", "-1"]);
    expect(code).toBe(1);
    expect(stderr).toContain("-n must be a positive integer");
    expect(stderr).toContain("-1");
    // No leaky parseArgs "Option -n argument is ambiguous" message.
    expect(stderr).not.toContain("ambiguous");
  });

  test("`fbrain list -n abc` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["list", "-n", "abc"]);
    expect(code).toBe(1);
    expect(stderr).toContain("-n must be a positive integer");
    expect(stderr).toContain("abc");
  });
});
