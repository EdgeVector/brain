// Pins the recovery hint for `fbrain status set/update <slug> <value>`.
//
// The CLI is noun-verb everywhere a new dev looks (`design new`, `task new`,
// `mcp install`), so `status` *looks* like it should take a `set`/`update`
// verb. It doesn't — the real form is `fbrain status <slug> [<new-status>]`.
// The natural guess used to dead-end confusingly: `set` parsed as the slug
// positional and resolveBySlug failed with the misleading
// `No record with slug "set"` hint that sends devs to `fbrain list` (the wrong
// remedy — the fix is to *drop* the verb). This guard turns the dead-end into a
// self-correcting nudge toward the real verb, without auto-performing the
// update (the explicit verb is intentional).
//
// Twin of cli-status-verb-hint.test.ts, which pins the symmetric
// `fbrain <type> <slug> --status <value>` recovery — same intent, same message
// shape. A legitimately-slugged `set`/`update` record (no following positional)
// MUST still resolve via the unambiguous bare path.
//
// Spawn-based so we exercise the real argv → runStatus path. HOME points at an
// empty dir so readConfig() would throw a ConfigMissingError if it ran — the
// hint MUST fire before readConfig, otherwise a brand-new uninit'd machine
// would see the config error and never reach the actionable hint.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-status-set-hint-"));
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

describe("fbrain status set/update <slug> <value> → status verb recovery hint", () => {
  for (const verb of ["set", "update"]) {
    test(`\`fbrain status ${verb} auth-redesign approved\` points at \`fbrain status ...\``, async () => {
      const { code, stderr } = await runCli([
        "status",
        verb,
        "auth-redesign",
        "approved",
      ]);
      expect(code).toBe(2);
      // Points at the real verb with the slug + status echoed back.
      expect(stderr).toContain("fbrain status auth-redesign approved");
      // The misleading `No record with slug "set"` dead-end must NOT leak.
      expect(stderr).not.toContain('No record with slug');
      // Acknowledges what they typed.
      expect(stderr).toContain('you asked to set "auth-redesign" → "approved"');
      // Fires before readConfig — empty HOME would otherwise shadow the hint.
      expect(stderr).not.toMatch(/config not found/i);
    });
  }

  test("`fbrain status set <slug>` (no value) still nudges with a placeholder", async () => {
    const { code, stderr } = await runCli(["status", "set", "auth-redesign"]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain status auth-redesign <new-status>");
    // No echo when no value was supplied.
    expect(stderr).not.toContain("you asked to set");
  });

  test("a record literally slugged `set` (bare, no following positional) is unaffected", async () => {
    // `fbrain status set` with a single positional is the unambiguous path —
    // it must NOT be absorbed by the hint and should proceed to readConfig
    // (which fails only because HOME is empty).
    const { code, stderr } = await runCli(["status", "set"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Did you mean to change status");
    expect(stderr).toMatch(/config not found/i);
  });

  test("the correct `fbrain status <slug> <value>` form is unaffected", async () => {
    // A normal slug + status proceeds to readConfig (fails only on empty HOME).
    const { code, stderr } = await runCli(["status", "auth-redesign", "approved"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Did you mean to change status");
    expect(stderr).toMatch(/config not found/i);
  });
});
