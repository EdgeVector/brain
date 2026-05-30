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
// check now errors with the orphan flag named; the test uses a fake HOME so
// that if the check regresses we'd see the config-missing path on the
// `--usage`-paired regression guard instead.
//
// Same flavor as the migrate orphan-flag guard in PR #94 and the migrate
// mode-conflict guard in PR #93.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-doctor-orphan-"));
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

describe("fbrain doctor --usage-window / --usage-path require --usage", () => {
  test("`--usage-window 14` exits 1 naming --usage-window (was silent no-op)", async () => {
    const { code, stdout, stderr } = await runCli(["doctor", "--usage-window", "14"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--usage-window");
    expect(stderr).toContain("--usage");
    // The check runs before doctor() ever touches config or the network.
    // doctor() prints its config-missing line to stdout — its absence on
    // either stream proves the orphan check fired first.
    expect(stdout).not.toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("~/.fbrain/config.json");
  });

  test("`--usage-path /tmp/u.jsonl` exits 1 naming --usage-path (was silent no-op)", async () => {
    const { code, stdout, stderr } = await runCli([
      "doctor",
      "--usage-path",
      "/tmp/u.jsonl",
    ]);
    expect(code).toBe(1);
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
    expect(code).toBe(1);
    expect(stderr).toContain("--usage-window");
    expect(stderr).toContain("--usage-path");
    expect(stderr).toContain("--usage");
  });

  test("`--usage --usage-window 14` passes the orphan check (regression guard)", async () => {
    // With a non-existent HOME, the next failure point is doctor()'s config
    // check — seeing the config-missing line on stdout proves the orphan
    // check accepted --usage-window when paired with --usage.
    const { code, stdout, stderr } = await runCli([
      "doctor",
      "--usage",
      "--usage-window",
      "14",
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("only applies");
    expect(stderr).not.toContain("only apply");
  });

  test("bare `--usage` still passes the orphan check (regression guard)", async () => {
    const { code, stdout, stderr } = await runCli(["doctor", "--usage"]);
    expect(code).toBe(1);
    expect(stdout).toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("only applies");
    expect(stderr).not.toContain("only apply");
  });

  test("bare `doctor` (no usage flags) still runs (regression guard)", async () => {
    // No orphan flags set — the check should be inert; doctor() then runs
    // its normal sequence which hits the missing config first.
    const { code, stdout, stderr } = await runCli(["doctor"]);
    expect(code).toBe(1);
    expect(stdout).toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("only applies");
    expect(stderr).not.toContain("only apply");
  });
});
