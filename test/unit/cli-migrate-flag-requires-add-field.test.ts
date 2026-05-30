// Pins strict rejection of `fbrain migrate` invocations where `--default` or
// `--dry-run` is set without `--add-field`. Both flags are documented only
// under the `--add-field` form (COMMAND_HELP.migrate) — runMigrate's old
// dispatcher only read them inside the `--add-field` branch, so combos like:
//
//   fbrain migrate --status --default foo
//     → ran a normal --status listing, silently dropped --default.
//   fbrain migrate --status --dry-run
//     → same, --dry-run was a no-op.
//   fbrain migrate --resume m-1234 --default foo
//     → resumed the manifest, silently dropped --default.
//
// All three were silent no-ops that hid the user's intent. The pre-readConfig
// check now errors with the orphan flag named; the test uses a fake HOME so
// that if the check regresses we'd see "Config not found" instead.
//
// Same flavor as the mode-conflict guard in PR #93 and the explain/no-llm
// guard in PR #56.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-migrate-orphan-"));
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

describe("fbrain migrate --default / --dry-run require --add-field", () => {
  test("`--status --default foo` exits 1 naming --default (was silent no-op)", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--status",
      "--default",
      "foo",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--default");
    expect(stderr).toContain("--add-field");
    // The check runs before readConfig — never the config-missing path.
    expect(stderr).not.toContain("Config not found");
  });

  test("`--status --dry-run` exits 1 naming --dry-run (was silent no-op)", async () => {
    const { code, stderr } = await runCli(["migrate", "--status", "--dry-run"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--dry-run");
    expect(stderr).toContain("--add-field");
    expect(stderr).not.toContain("Config not found");
  });

  test("`--resume --default foo` exits 1 naming --default (was silent no-op)", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--resume",
      "m-1234",
      "--default",
      "foo",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--default");
    expect(stderr).toContain("--add-field");
    expect(stderr).not.toContain("Config not found");
  });

  test("`--resume --dry-run` exits 1 naming --dry-run (was silent no-op)", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--resume",
      "m-1234",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--dry-run");
    expect(stderr).toContain("--add-field");
    expect(stderr).not.toContain("Config not found");
  });

  test("`--status --default foo --dry-run` lists both orphans in the error", async () => {
    const { code, stderr } = await runCli([
      "migrate",
      "--status",
      "--default",
      "foo",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("--default");
    expect(stderr).toContain("--dry-run");
    expect(stderr).toContain("--add-field");
  });

  test("`--add-field … --default foo --dry-run` passes the orphan check (regression guard)", async () => {
    // With a non-existent HOME, the next failure point is readConfig — so
    // seeing the config-missing error is proof the orphan check accepted
    // these flags when paired with --add-field.
    const { code, stderr } = await runCli([
      "migrate",
      "--add-field",
      "concept",
      "urgency",
      "String",
      "--default",
      "normal",
      "--dry-run",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("Config not found");
    expect(stderr).not.toContain("only applies");
    expect(stderr).not.toContain("only apply");
  });

  test("bare `--status` still passes the orphan check (regression guard)", async () => {
    const { code, stderr } = await runCli(["migrate", "--status"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Config not found");
    expect(stderr).not.toContain("only applies");
    expect(stderr).not.toContain("only apply");
  });
});
