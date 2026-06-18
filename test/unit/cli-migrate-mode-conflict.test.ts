// Pins strict rejection of `fbrain migrate` mode-flag conflicts. The three
// mode flags — `--status`, `--resume`, `--add-field` — pick mutually
// exclusive code paths, but the runMigrate dispatcher was `if / else if /
// else if`, so when more than one was set the first branch silently won
// and the others' args were dropped:
//
//   fbrain migrate --status --add-field concept urgency String
//     → ran --status, silently ignored the add-field args.
//   fbrain migrate --resume m-1234 --add-field concept urgency String
//     → ran --resume, silently ignored --add-field.
//
// Both were silent no-ops that masked the user's actual intent — same
// flavor as `ask --explain --no-llm` (PR #56). The pre-readConfig check
// errors with the explicit list of conflicting modes; the test uses a
// fake HOME so that if the check ever regresses we'd see the
// "Config not found" line instead of the validation message.
//
// Spawn-based so we exercise the real argv → runMigrate path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-migrate-mode-"));
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

describe("fbrain migrate mode-flag conflicts", () => {
  test("`--status --resume` exits 1 with both flags named (was silent no-op)", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--status",
      "--resume",
      "m-1234",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--status");
    expect(stderr).toContain("--resume");
    expect(stderr).toContain("mutually exclusive");
    // The check runs before readConfig — never the config-missing path.
    expect(stderr).not.toContain("Config not found");
  });

  test("`--status --add-field` exits 1 with both flags named (was silent no-op)", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--status",
      "--add-field",
      "concept",
      "urgency",
      "String",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--status");
    expect(stderr).toContain("--add-field");
    expect(stderr).toContain("mutually exclusive");
    expect(stderr).not.toContain("Config not found");
  });

  test("`--resume --add-field` exits 1 with both flags named (was silent no-op)", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--resume",
      "m-1234",
      "--add-field",
      "concept",
      "urgency",
      "String",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--resume");
    expect(stderr).toContain("--add-field");
    expect(stderr).toContain("mutually exclusive");
    expect(stderr).not.toContain("Config not found");
  });

  test("all three set lists all three in the error", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--status",
      "--resume",
      "m-1234",
      "--add-field",
      "concept",
      "urgency",
      "String",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--status");
    expect(stderr).toContain("--resume");
    expect(stderr).toContain("--add-field");
    expect(stderr).toContain("mutually exclusive");
  });

  test("a single mode passes the conflict check (regression guard)", async () => {
    // With a non-existent HOME, the next failure point is readConfig — so
    // seeing the config-missing error is proof the conflict check accepted
    // a lone `--status` and fell through.
    const { code, stderr } = await runCli(["migrate", "--status"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Config not found");
    expect(stderr).not.toContain("mutually exclusive");
  });
});
