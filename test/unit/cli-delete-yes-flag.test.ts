// Pins `--yes` / `-y` on `fbrain delete` as a documented harmless no-op.
//
// `delete` is non-interactive — it has no confirmation prompt — but apt /
// npm / rm muscle memory reaches for `-y` to suppress one, and scripts that
// uniformly pass `-y` to destructive commands shouldn't dead-end on
// parseArgs's bare "Unknown option '--yes'". Accept the flag silently so
// the invocation works; the user (or script) gets exactly the same
// behavior as plain `delete <slug>`.
//
// Same papercut shape as #151's `-n` / `--limit` alias on list: declare
// the alias in the option set so parseArgs accepts it; the runXxx code
// just doesn't look at the value.
//
// Spawn-based so we exercise the real argv → parseArgs → runDelete path.
// HOME points at an empty dir: with the flag accepted, control falls
// through to readConfig() and trips ConfigMissingError. That proves
// parseArgs got past the flag without erroring — the failure path is the
// same as plain `fbrain delete <slug>` on an uninit'd machine.

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
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-delete-yes-"));
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

describe("delete: --yes / -y are documented no-ops", () => {
  test("--yes and -y parse identically (both populate values.yes)", () => {
    // Belt-and-braces: parseArgs at the CLI_SPEC layer accepts both
    // spellings — pins the option set, not just the spawn behavior.
    const long = parseArgs({
      args: ["--yes"],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.delete,
    });
    const short = parseArgs({
      args: ["-y"],
      strict: true,
      allowPositionals: false,
      options: CLI_SPEC.delete,
    });
    expect(long.values.yes).toBe(true);
    expect(short.values.yes).toBe(true);
  });

  test("`fbrain delete foo --yes` parses without 'Unknown option'", async () => {
    const { code, stderr } = await runCli(["delete", "foo", "--yes"]);
    expect(code).toBe(1);
    // The flag is accepted — no parseArgs error.
    expect(stderr).not.toContain("Unknown option");
    // Control reached readConfig(); empty HOME → config-missing error.
    // That's the same failure plain `delete foo` produces on an uninit'd
    // machine — proves --yes is a true no-op, not a behavior change.
    expect(stderr.toLowerCase()).toContain("config");
  });

  test("`fbrain delete foo -y` (short alias) parses without 'Unknown option'", async () => {
    const { code, stderr } = await runCli(["delete", "foo", "-y"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr.toLowerCase()).toContain("config");
  });

  test("`--yes` plays nicely with --type and --force on the same command line", async () => {
    // Scripts pass `-y --force --type design` together. None of them should
    // collide with --yes's no-op semantics.
    const { code, stderr } = await runCli([
      "delete",
      "foo",
      "--type",
      "design",
      "--force",
      "--yes",
    ]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unknown option");
    expect(stderr.toLowerCase()).toContain("config");
  });

  test("`fbrain help delete` documents --yes / -y as a no-op", async () => {
    // Discoverability gate: a user who hits the flag once should be able
    // to confirm via `help delete` that it's intentional and harmless.
    const { code, stdout } = await runCli(["help", "delete"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--yes");
    expect(stdout).toContain("-y");
    // Phrasing the user can grok: it's a no-op because delete is
    // non-interactive. Don't over-specify the exact wording — pin the
    // intent ("no-op" + "non-interactive") so the help can evolve.
    expect(stdout).toMatch(/no-op/i);
    expect(stdout).toMatch(/non-interactive/i);
  });
});
