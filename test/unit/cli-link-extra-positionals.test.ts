// Pins the extra-positional guard on `fbrain link`. Before this guard,
// `fbrain link t1 d1 t2 d2` silently dropped the trailing pair and only
// linked t1→d1, while the user thought both pairs landed — same silent
// partial-action shape as delete (PR #112) and put (PR #177). Reject the
// silently-dropped input loudly before any I/O so the user fixes the
// invocation instead of discovering the unlinked pair later.
//
// Spawn-based so we exercise the real argv → parseArgs → runLink path.
// HOME points at an empty dir so readConfig() would throw if it ran — the
// guard MUST fire before readConfig (un-init'd machines still get the
// clear validation error, not "config missing").

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-link-extra-"));
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

describe("fbrain link extra-positional guard", () => {
  test("`fbrain link t1 d1 t2 d2` exits 1 with a clear validation message", async () => {
    // The headline case: two pairs on one invocation. Before the guard,
    // this silently linked t1→d1 and threw t2,d2 away. The guard must fire
    // BEFORE readConfig — proven by the empty HOME, which would otherwise
    // produce a config-missing error and shadow the validation message.
    const { code, stderr } = await runCli(["link", "t1", "d1", "t2", "d2"]);
    expect(code).toBe(1);
    expect(stderr).toContain("link takes exactly two positionals");
    expect(stderr).toContain("4");
    // All surplus tokens surfaced so the user sees exactly what got rejected.
    expect(stderr).toContain("t1");
    expect(stderr).toContain("d1");
    expect(stderr).toContain("t2");
    expect(stderr).toContain("d2");
    // Hint nudges toward the per-pair loop.
    expect(stderr).toContain("once per pair");
    // The check runs before config — never the config-missing path.
    expect(stderr).not.toMatch(/config not found/i);
  });

  test("`fbrain link t1 d1 extra` (three positionals) reports all extras", async () => {
    const { code, stderr } = await runCli(["link", "t1", "d1", "extra"]);
    expect(code).toBe(1);
    expect(stderr).toContain("link takes exactly two positionals");
    expect(stderr).toContain("3");
    expect(stderr).toContain("t1, d1, extra");
  });

  test("`fbrain link t1 d1` (the canonical two positionals) does NOT trip the guard", async () => {
    // The two-slug invocation must still get past the guard; it will then
    // fail at readConfig (HOME points at an empty dir) — a config error,
    // not a validation error. That proves the guard let the valid form through.
    const { code, stderr } = await runCli(["link", "t1", "d1"]);
    expect(code).toBe(1);
    expect(stderr).not.toContain("link takes exactly two positionals");
    expect(stderr.toLowerCase()).toContain("config");
  });
});
