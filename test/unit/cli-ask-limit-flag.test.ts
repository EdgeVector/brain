// Pins `--limit` validation on `fbrain ask` — symmetric with `list -n` /
// `search -n` (PR #87). `ask --limit` is the same family of "max results"
// flag and was the missing third sibling: `--limit 3.5` was silently
// parseInt'd to 3 and `--limit 5abc` to 5, where list/search both reject
// trailing-junk values. This locks the symmetric rejection.
//
// Spawn-based so we exercise the real argv → parseArgs → runAsk path.
// HOME points at an empty dir so readConfig() would throw if it ran —
// this is sharper: if we EVER see the config-missing error, we know the
// --limit validation didn't run first.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-ask-limit-"));
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

describe("fbrain ask --limit validation", () => {
  test("`fbrain ask foo --limit 0` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["ask", "foo", "--limit", "0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain("0");
    // The check runs before config — never the config-missing path.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain ask foo --limit -1` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["ask", "foo", "--limit", "-1"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain("-1");
  });

  test("`fbrain ask foo --limit abc` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["ask", "foo", "--limit", "abc"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain("abc");
  });

  test("`fbrain ask foo --limit 3.5` rejects decimals (was silently parsed as 3)", async () => {
    const { code, stderr } = await runCli(["ask", "foo", "--limit", "3.5"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain("3.5");
    expect(stderr).not.toContain("config");
  });

  test("`fbrain ask foo --limit 5abc` rejects trailing junk (was silently parsed as 5)", async () => {
    const { code, stderr } = await runCli(["ask", "foo", "--limit", "5abc"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain("5abc");
    expect(stderr).not.toContain("config");
  });
});
