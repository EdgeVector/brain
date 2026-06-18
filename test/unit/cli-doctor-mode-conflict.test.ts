// Pins strict rejection of `fbrain doctor --usage --freshness`. `--usage`
// diverts into the team-adoption report and the `if (opts.usage)`
// short-circuit in `doctor()` returns before the freshness probes ever
// run — so pairing the two silently dropped --freshness:
//
//   fbrain doctor --usage --freshness
//     → ran the usage report, silently ignored --freshness; no freshness
//       or pollution probe lines in the output.
//
// Same flavor as the migrate mode-conflict guard (PR #93) and the
// `ask --explain --no-llm` guard (PR #56). The pre-readConfig check
// errors with both flags named; the test uses a fake HOME so that if the
// check ever regresses we'd see doctor()'s config-missing path on the
// `--usage` single-flag regression guard instead.
//
// Spawn-based so we exercise the real argv → runDoctor path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-doctor-mode-"));
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

describe("fbrain doctor --usage / --freshness conflict", () => {
  test("`--usage --freshness` exits 1 with both flags named (was silent no-op)", async () => {
    const { code, stdout, stderr } = await runCli([
      "doctor",
      "--usage",
      "--freshness",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage");
    expect(stderr).toContain("--freshness");
    expect(stderr).toContain("mutually exclusive");
    // The check runs before doctor() ever touches config or the network;
    // doctor()'s config-missing line lives on stdout. Its absence on either
    // stream proves the conflict check fired first.
    expect(stdout).not.toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("~/.fbrain/config.json");
  });

  test("flag order doesn't matter — `--freshness --usage` is rejected too", async () => {
    const { code, stderr } = await runCli([
      "doctor",
      "--freshness",
      "--usage",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage");
    expect(stderr).toContain("--freshness");
    expect(stderr).toContain("mutually exclusive");
  });

  test("bare `--usage` still passes the conflict check (regression guard)", async () => {
    // With a non-existent HOME, the next failure point is doctor()'s
    // config check — seeing the config-missing line on stdout proves the
    // conflict check accepted a lone --usage and fell through.
    const { code, stdout, stderr } = await runCli(["doctor", "--usage"]);
    expect(code).toBe(1);
    expect(stdout).toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("mutually exclusive");
  });

  test("bare `--freshness` still passes the conflict check (regression guard)", async () => {
    const { code, stdout, stderr } = await runCli(["doctor", "--freshness"]);
    expect(code).toBe(1);
    expect(stdout).toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("mutually exclusive");
  });

  test("bare `doctor` (no mode flags) still runs (regression guard)", async () => {
    // No conflicting flags set — the check should be inert; doctor()
    // then runs its normal sequence which hits the missing config first.
    const { code, stdout, stderr } = await runCli(["doctor"]);
    expect(code).toBe(1);
    expect(stdout).toContain("~/.fbrain/config.json");
    expect(stderr).not.toContain("mutually exclusive");
  });
});
