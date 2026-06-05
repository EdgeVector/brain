// Pins `--limit` as an alias for `-n` on `fbrain list`. Before this fix `list`
// declared only `n: { type: "string" }` (no long form), so a user who had
// learned `search --limit N` / `ask --limit N` and reflexively typed
// `list --limit N` hit parseArgs's "Unknown option '--limit'". search/ask both
// accept `-n` and `--limit` as aliases — list now matches.
//
// Two layers of coverage, same shape as cli-ask-n-alias.test.ts:
//   1. parseArgs-level: short/long route to the same `values.limit` key,
//      with last-wins when both are passed.
//   2. spawn-level: the real CLI accepts `--limit` on list without erroring
//      out with "Unknown option" before the positive-int validation gate.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CLI_SPEC } from "../../src/cli.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-list-limit-"));
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

describe("list: -n and --limit are aliases", () => {
  test("-n N parses identically to --limit N", () => {
    const a = parseArgs({
      args: ["-n", "7"],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.list,
    });
    const b = parseArgs({
      args: ["--limit", "7"],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.list,
    });
    expect(a.values.limit).toBe("7");
    expect(b.values.limit).toBe("7");
    expect(a.values).toEqual(b.values);
  });

  test("last wins when both -n and --limit are passed", () => {
    const nThenLimit = parseArgs({
      args: ["-n", "3", "--limit", "5"],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.list,
    });
    const limitThenN = parseArgs({
      args: ["--limit", "5", "-n", "3"],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.list,
    });
    expect(nThenLimit.values.limit).toBe("5");
    expect(limitThenN.values.limit).toBe("3");
  });

  test("`fbrain list --limit 0` reaches the positive-int validator (no 'Unknown option')", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "0"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).toContain("must be a positive integer");
    expect(stderr).toContain("0");
    // The check runs before config — never the config-missing path.
    expect(stderr).not.toContain("config");
  });

  test("`fbrain list --limit -1` errors clearly (not parseArgs's ambiguous message)", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "-1"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).toContain("must be a positive integer");
    expect(stderr).not.toContain("ambiguous");
  });
});
