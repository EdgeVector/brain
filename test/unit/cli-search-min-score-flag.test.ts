// Pins `--min-score` validation on `fbrain search` — completes the
// CLI numeric-flag-hardening chain (`list -n` / `search -n` / `ask --limit` /
// `doctor --usage-window`, PRs #87–#89) for the only remaining
// post-parseArgs numeric flag.
//
// `Number("")` and `Number("  ")` both return 0 in JS — a notorious quirk.
// The existing `Number.isFinite(minScore)` guard treated 0 as valid, so:
//   fbrain search foo --min-score ""    # silently used min-score=0 (no filter)
//   fbrain search foo --min-score "  "  # silently used min-score=0 (no filter)
//   fbrain search foo --min-score=      # same — parseArgs maps `--k=` to ""
// All three masked a malformed invocation as a successful "no-floor" search.
// Tightening the pre-Number check (trim-length > 0) rejects them with the
// same one-liner as a non-numeric value.
//
// Spawn-based so we exercise the real argv → parseArgs → runSearch path.
// HOME points at an empty dir so readConfig() would throw `Config not found`
// if it ran — sharper assertion: if we EVER see that message, we know the
// --min-score validation didn't fire first.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-min-score-"));
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

describe("fbrain search --min-score validation", () => {
  test('`--min-score ""` exits 1 with the validation message (was silently parsed as 0)', async () => {
    const { code, stderr } = await runCli(["search", "foo", "--min-score", ""]);
    expect(code).toBe(1);
    expect(stderr).toContain("--min-score must be a number");
    // The check runs before doctor/readConfig — never the config-missing path.
    expect(stderr).not.toContain("Config not found");
  });

  test('`--min-score "   "` exits 1 with the validation message (was silently parsed as 0)', async () => {
    const { code, stderr } = await runCli(["search", "foo", "--min-score", "   "]);
    expect(code).toBe(1);
    expect(stderr).toContain("--min-score must be a number");
    expect(stderr).not.toContain("Config not found");
  });

  test("`--min-score=` (empty after `=`) exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["search", "foo", "--min-score="]);
    expect(code).toBe(1);
    expect(stderr).toContain("--min-score must be a number");
    expect(stderr).not.toContain("Config not found");
  });

  test("`--min-score abc` still rejected (regression guard on the existing NaN path)", async () => {
    const { code, stderr } = await runCli(["search", "foo", "--min-score", "abc"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--min-score must be a number");
    expect(stderr).toContain("abc");
  });

  test("`--min-score 0.5` passes validation (does not regress legitimate input)", async () => {
    // With a non-existent HOME, the next failure point is readConfig — so
    // seeing the config-missing error is proof the --min-score check
    // accepted 0.5 and fell through.
    const { code, stderr } = await runCli(["search", "foo", "--min-score", "0.5"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Config not found");
    expect(stderr).not.toContain("--min-score must be a number");
  });

  test("`--min-score 0` passes validation (the legitimate 'no floor' case)", async () => {
    const { code, stderr } = await runCli(["search", "foo", "--min-score", "0"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Config not found");
    expect(stderr).not.toContain("--min-score must be a number");
  });
});
