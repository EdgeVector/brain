// Pins `--usage-window` validation on `fbrain doctor` — symmetric with
// `ask --limit` / `list -n` / `search -n` (PRs #87, #88). The post-parseArgs
// check only rejected NaN / <=0; it silently parseInt'd `--usage-window 3.5`
// to 3 and `--usage-window 5abc` to 5, and `--usage-window -1` produced
// parseArgs's cryptic "Option '--usage-window' argument is ambiguous"
// (it sees `-1` as another option). Moving the validation pre-parseArgs with
// the strict `String(n) === raw.trim()` check fixes all three.
//
// Spawn-based so we exercise the real argv → runDoctor path. HOME points at
// an empty dir so the doctor() runner would surface "no ~/.fbrain/config.json"
// — sharper assertion: if we EVER see that message, we know the
// --usage-window validation didn't fire first.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-cli-usage-window-"));
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

describe("fbrain doctor --usage-window validation", () => {
  test("`--usage-window 0` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["doctor", "--usage", "--usage-window", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window must be a positive integer");
    expect(stderr).toContain("0");
    // The check runs before doctor() ever touches config.
    expect(stderr).not.toContain("~/.fbrain/config.json");
  });

  test("`--usage-window -1` exits 1 with a clean message (was parseArgs's ambiguous-option error)", async () => {
    const { code, stderr } = await runCli(["doctor", "--usage", "--usage-window", "-1"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window must be a positive integer");
    expect(stderr).toContain("-1");
    // No leakage of the parseArgs cryptic error.
    expect(stderr).not.toContain("ambiguous");
  });

  test("`--usage-window abc` exits 1 with the validation message", async () => {
    const { code, stderr } = await runCli(["doctor", "--usage", "--usage-window", "abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window must be a positive integer");
    expect(stderr).toContain("abc");
  });

  test("`--usage-window 3.5` rejects decimals (was silently parsed as 3)", async () => {
    const { code, stderr } = await runCli(["doctor", "--usage", "--usage-window", "3.5"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window must be a positive integer");
    expect(stderr).toContain("3.5");
    expect(stderr).not.toContain("~/.fbrain/config.json");
  });

  test("`--usage-window 5abc` rejects trailing junk (was silently parsed as 5)", async () => {
    const { code, stderr } = await runCli(["doctor", "--usage", "--usage-window", "5abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--usage-window must be a positive integer");
    expect(stderr).toContain("5abc");
    expect(stderr).not.toContain("~/.fbrain/config.json");
  });
});
