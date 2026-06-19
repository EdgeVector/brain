// Pins the clean error/hint contract for an unknown CLI option that has NO
// close match to any of the command's flags.
//
// Before this guard, the no-close-match case in `parseCommandArgs` fell through
// to `throw err`, re-throwing Node's bare `parseArgs` string verbatim. On
// commands that take positionals (e.g. `search`, `list` accepts none but `get`
// does) that string also carries actively-misleading advice about `--`
// positional escaping — `To specify a positional argument starting with a '-',
// place it at the end of the command after '--', as in '-- "--wombat"'` — which
// is irrelevant to a typo'd flag and internal jargon that steers a new dev
// toward a wrong fix. It was the one remaining unknown-input surface that
// dead-ended on a raw Node string instead of fbrain's `error:`/`hint:` pair.
//
// This now emits a clean FbrainError (code `unknown_option`, exit 2): names the
// bad flag, lists the command's valid long flags (sorted, `--`-prefixed), and
// points at `fbrain help <cmd>`. The misleading `--` advice never reaches the
// user.
//
// Spawn-based so we exercise the real argv → parseArgs → parseCommandArgs path
// in cli.ts. HOME points at an empty dir so readConfig() would throw a
// ConfigMissingError if it ran — the error MUST fire before readConfig (it's a
// pure invocation error), so a brand-new uninit'd machine still gets the clean
// guidance rather than the config error.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "fbrain-no-sugg-hint-"));
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

describe("fbrain <cmd> --<unknown-no-close-match> → clean error + valid-options hint", () => {
  // (a) Unknown flag with NO close match → clean FbrainError with the
  // valid-options hint, NOT the raw Node string, and NEVER the misleading
  // positional-escape advice. Exercise both a positionals-taking command
  // (`search`, where the raw string carried the `-- "..."` advice) and a
  // no-positionals one (`list`).
  test("`fbrain list --wombat` → clean error + valid-options hint, exit 2", async () => {
    const { code, stderr } = await runCli(["list", "--wombat"]);
    expect(code).toBe(2);
    // Clean backtick-quoted message — NOT Node's single-quoted bare string.
    expect(stderr).toContain("Unknown option `--wombat`.");
    expect(stderr).not.toContain("Unknown option '--wombat'");
    // The misleading positional-escape advice must be gone.
    expect(stderr).not.toContain("place it at the end");
    expect(stderr).not.toContain('-- "--');
    // Actionable hint: the command's valid flags + a pointer at help.
    expect(stderr).toContain("Valid options:");
    expect(stderr).toContain("fbrain help list");
    // No false suggestion when nothing is close.
    expect(stderr).not.toContain("Did you mean");
    // Fired before readConfig — empty HOME would otherwise shadow it.
    expect(stderr).not.toMatch(/config not found/i);
  });

  test("`fbrain search x --wombat` drops the misleading `-- \"...\"` positional advice", async () => {
    // `search` takes positionals, so the raw Node string carried the
    // actively-misleading `place it at the end ... -- "--wombat"` advice. That
    // is exactly what must no longer reach the user.
    const { code, stderr } = await runCli(["search", "x", "--wombat"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown option `--wombat`.");
    expect(stderr).not.toContain("Unknown option '--wombat'");
    expect(stderr).not.toContain("place it at the end");
    expect(stderr).not.toContain('-- "--');
    // Hint names search's valid flags and points at its help.
    expect(stderr).toContain("Valid options:");
    expect(stderr).toContain("fbrain help search");
    expect(stderr).not.toContain("Did you mean");
  });

  // (b) Unknown flag WITH a close match → the existing suggestion path is
  // untouched: still "Did you mean `--limit`?". No regression.
  test("`fbrain list --limt` still gives the close-match suggestion (no regression)", async () => {
    const { code, stderr } = await runCli(["list", "--limt"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Did you mean `--limit`?");
    // The suggestion path never emits the raw Node string or the generic list.
    expect(stderr).not.toContain("Unknown option '--limt'");
    expect(stderr).not.toContain("place it at the end");
    expect(stderr).not.toContain("Valid options:");
  });

  // (c) `--node-url` on a non-init command → still the init-only special case,
  // NOT the generic no-suggestion error. No regression.
  test("`fbrain list --node-url http://x` still gives the init-only error (no regression)", async () => {
    const { code, stderr } = await runCli(["list", "--node-url", "http://x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("fbrain init");
    expect(stderr).toContain("~/.fbrain/config.json");
    // Not the generic no-suggestion fallback.
    expect(stderr).not.toContain("Valid options:");
    expect(stderr).not.toContain("Unknown option");
  });

  // The hint names the SPECIFIC command (threaded via the commandName arg),
  // including the `<type> new` subcommand form.
  test("`fbrain concept new --wombat s` names `concept new` in the hint", async () => {
    const { code, stderr } = await runCli(["concept", "new", "--wombat", "s"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown option `--wombat`.");
    expect(stderr).toContain("fbrain help concept new");
    expect(stderr).not.toContain("place it at the end");
  });
});
