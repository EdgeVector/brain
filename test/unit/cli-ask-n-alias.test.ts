// Pins `-n` as an alias for `--limit` on `fbrain ask` (and `--limit` as an
// alias for `-n` on `fbrain search`). Before this fix `ask` rejected `-n`
// with parseArgs's "Unknown option '-n'" — a papercut for users who had
// already learned `search -n N` and reflexively typed `ask -n N`.
//
// Two layers of coverage:
//   1. parseArgs-level: short/long route to the same `values.limit` key,
//      with last-wins when both are passed.
//   2. spawn-level: the real CLI accepts `-n` on ask and `--limit` on
//      search without erroring out before the validation gate.

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
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-ask-n-alias-"));
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

describe("ask: -n and --limit are aliases", () => {
  test("-n N parses identically to --limit N", () => {
    const a = parseArgs({
      args: ["foo", "-n", "7"],
      strict: true,
      allowPositionals: true,
      options: CLI_SPEC.ask,
    });
    const b = parseArgs({
      args: ["foo", "--limit", "7"],
      strict: true,
      allowPositionals: true,
      options: CLI_SPEC.ask,
    });
    expect(a.values.limit).toBe("7");
    expect(b.values.limit).toBe("7");
    expect(a.values).toEqual(b.values);
  });

  test("last wins when both -n and --limit are passed", () => {
    const nThenLimit = parseArgs({
      args: ["foo", "-n", "3", "--limit", "5"],
      strict: true,
      allowPositionals: true,
      options: CLI_SPEC.ask,
    });
    const limitThenN = parseArgs({
      args: ["foo", "--limit", "5", "-n", "3"],
      strict: true,
      allowPositionals: true,
      options: CLI_SPEC.ask,
    });
    expect(nThenLimit.values.limit).toBe("5");
    expect(limitThenN.values.limit).toBe("3");
  });

  test("`fbrain ask foo -n 0` reaches --limit's positive-int validator (no 'Unknown option')", async () => {
    const { code, stderr } = await runCli(["ask", "foo", "-n", "0"]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).toContain("must be a positive integer");
    expect(stderr).toContain("0");
  });
});

describe("search: --limit and -n are aliases", () => {
  test("--limit N parses identically to -n N", () => {
    const a = parseArgs({
      args: ["foo", "--limit", "7"],
      strict: true,
      allowPositionals: true,
      options: CLI_SPEC.search,
    });
    const b = parseArgs({
      args: ["foo", "-n", "7"],
      strict: true,
      allowPositionals: true,
      options: CLI_SPEC.search,
    });
    expect(a.values.limit).toBe("7");
    expect(b.values.limit).toBe("7");
    expect(a.values).toEqual(b.values);
  });

  test("`fbrain search foo --limit 0` reaches the positive-int validator (no 'Unknown option')", async () => {
    const { code, stderr } = await runCli(["search", "foo", "--limit", "0"]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).toContain("must be a positive integer");
    expect(stderr).toContain("0");
  });
});
