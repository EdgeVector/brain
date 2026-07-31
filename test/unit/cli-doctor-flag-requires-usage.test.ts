// Pins strict rejection of `fbrain doctor` invocations where `--usage-window`
// or `--usage-path` is set without `--usage`. Both flags are documented only
// under the `--usage` form (COMMAND_HELP.doctor) — runDoctor's dispatcher
// only read them inside the `if (values.usage)` branch, so combos like:
//
//   fbrain doctor --usage-window 14
//     → ran the normal health-check sequence, silently dropped --usage-window.
//   fbrain doctor --usage-path /tmp/u.jsonl
//     → same, --usage-path was a no-op.
//
// Both were silent no-ops that hid the user's intent. The pre-readConfig
// check now errors with the orphan flag named; the test pins FBRAIN_CONFIG
// to a missing temp path so that if the check regresses we'd see the
// config-missing path on the `--usage`-paired regression guard instead.
//
// Same flavor as the migrate orphan-flag guard in PR #94 and the migrate
// mode-conflict guard in PR #93.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, parseDoctorOptions } from "../../src/cli.ts";

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-doctor-orphan-"));
  const missingConfig = join(fakeHome, "config.json");
  const originalLog = console.log;
  const originalError = console.error;
  const originalHome = process.env.HOME;
  const originalBrainConfig = process.env.BRAIN_CONFIG;
  const originalFbrainConfig = process.env.FBRAIN_CONFIG;
  const originalNoStdin = process.env.FBRAIN_NO_STDIN;
  const stdout: string[] = [];
  const stderr: string[] = [];

  console.log = ((line?: unknown) => stdout.push(String(line ?? ""))) as typeof console.log;
  console.error = ((line?: unknown) => stderr.push(String(line ?? ""))) as typeof console.error;
  process.env.HOME = fakeHome;
  process.env.FBRAIN_NO_STDIN = "1";
  delete process.env.BRAIN_CONFIG;
  process.env.FBRAIN_CONFIG = missingConfig;

  try {
    const code = await main(args);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalBrainConfig === undefined) delete process.env.BRAIN_CONFIG;
    else process.env.BRAIN_CONFIG = originalBrainConfig;
    if (originalFbrainConfig === undefined) delete process.env.FBRAIN_CONFIG;
    else process.env.FBRAIN_CONFIG = originalFbrainConfig;
    if (originalNoStdin === undefined) delete process.env.FBRAIN_NO_STDIN;
    else process.env.FBRAIN_NO_STDIN = originalNoStdin;
  }
}

describe("fbrain doctor --usage-window / --usage-path require --usage", () => {
  test("`--usage-window 14` exits 2 naming --usage-window (was silent no-op)", async () => {
    const { code, stdout, stderr } = await runCli(["doctor", "--usage-window", "14"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window");
    expect(stderr).toContain("--usage");
    // The check runs before doctor() ever touches config or the network.
    // doctor() prints its config-missing line to stdout — its absence on
    // either stream proves the orphan check fired first.
    expect(stdout).not.toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("~/.fbrain/config.json");
  });

  test("`--usage-path /tmp/u.jsonl` exits 2 naming --usage-path (was silent no-op)", async () => {
    const { code, stdout, stderr } = await runCli([
      "doctor",
      "--usage-path",
      "/tmp/u.jsonl",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-path");
    expect(stderr).toContain("--usage");
    expect(stdout).not.toContain("~/.fbrain/config.json");
  });

  test("both orphans together are both named in the error", async () => {
    const { code, stderr } = await runCli([
      "doctor",
      "--usage-window",
      "14",
      "--usage-path",
      "/tmp/u.jsonl",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window");
    expect(stderr).toContain("--usage-path");
    expect(stderr).toContain("--usage");
  });

  test("`--usage --usage-window 14` passes the orphan check (regression guard)", async () => {
    const opts = parseDoctorOptions(["--usage", "--usage-window", "14"]);
    expect(opts.usage).toBe(true);
    expect(opts.usageOptions?.windowDays).toBe(14);
  });

  test("bare `--usage` still passes the orphan check (regression guard)", async () => {
    const opts = parseDoctorOptions(["--usage"]);
    expect(opts.usage).toBe(true);
    expect(opts.usageOptions).toEqual({});
  });

  test("bare `doctor` (no usage flags) still runs (regression guard)", async () => {
    // No orphan flags set — the check should be inert.
    const opts = parseDoctorOptions([]);
    expect(opts.usage).toBeUndefined();
    expect(opts.usageOptions).toBeUndefined();
  });
});
