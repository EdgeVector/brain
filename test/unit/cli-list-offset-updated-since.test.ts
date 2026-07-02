// Pins argv-level validation on the `fbrain list` options added by card
// fbrain-list-updated-since-offset-count:
//   * `--offset` must be a non-negative integer (0 is legal — page from top).
//   * `--updated-since` must be an ISO timestamp or a relative window token.
// Both validators run BEFORE readConfig(), so an empty HOME must never
// surface the config-missing error — if it does, the guard didn't run first.
//
// Spawn-based so we exercise the real argv → parseArgs → runList path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-list-osus-"));
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

describe("fbrain list --offset validation", () => {
  test("`--offset -1` exits 2 with the non-negative message (not parseArgs's cryptic one)", async () => {
    const { code, stderr } = await runCli(["list", "--offset", "-1"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--offset must be a non-negative integer");
    expect(stderr).toContain("-1");
    expect(stderr).not.toContain("ambiguous");
    expect(stderr).not.toContain("config");
  });

  test("`--offset abc` exits 2 with the non-negative message", async () => {
    const { code, stderr } = await runCli(["list", "--offset", "abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--offset must be a non-negative integer");
    expect(stderr).toContain("abc");
  });

  test("`--offset 3.5` is rejected (junk tail), not silently floored", async () => {
    const { code, stderr } = await runCli(["list", "--offset", "3.5"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--offset must be a non-negative integer");
  });
});

describe("fbrain list --updated-since validation", () => {
  test("`--updated-since garbage` exits 2 naming the accepted forms", async () => {
    const { code, stderr } = await runCli([
      "list",
      "--updated-since",
      "garbage",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain(
      "not a valid ISO-8601 timestamp or relative window",
    );
    expect(stderr).not.toContain("config");
  });

  test("`--updated-since 7` (bare integer) exits 2 with the ambiguity hint", async () => {
    const { code, stderr } = await runCli(["list", "--updated-since", "7"]);
    expect(code).toBe(2);
    expect(stderr).toContain("ambiguous");
    expect(stderr).toContain("7d");
  });
});
