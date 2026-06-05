// Pins the dispatcher's flag-in-command-position guard.
//
// Background (2026-06-05 dogfood, fbrain 0.8.3 / HEAD #164): running
// `fbrain --node-url http://127.0.0.1:9100 doctor` reported
// "Unknown command: --node-url" and dumped the full TOP_HELP — both
// wrong. `--node-url` is an *option*, not a command, and the user's
// real mistake is flag placement (flags go AFTER the subcommand,
// per the README). The global flags consumed before this guard
// (`--verbose`, `--version`/`-V`, `--help`/`-h`) are stripped, so any
// `-`-prefixed token reaching the unknown-command branch is an option
// in the wrong slot.
//
// What we pin:
//   1. A `-`-prefixed token in command position emits an option-aware
//      error ("looks like an option" + "Flags go after the subcommand"
//      hint), exits 1, and does NOT print "Unknown command" or TOP_HELP.
//   2. Genuine typos (`serach`) STILL produce the "Did you mean: search?"
//      hint — guard against regressing the well-loved suggest path.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, FBRAIN_NO_STDIN: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("flag in command position", () => {
  test("`fbrain --node-url http://x doctor` emits option-aware error, not 'Unknown command'", async () => {
    const { code, stdout, stderr } = await runCli(["--node-url", "http://x", "doctor"]);
    expect(code).toBe(1);
    expect(stderr).toContain("`--node-url` looks like an option, but it's in the command position.");
    expect(stderr).toContain("Flags go after the subcommand");
    expect(stderr).not.toContain("Unknown command");
    expect(stderr).not.toContain("Commands:");
    expect(stdout).toBe("");
  });

  test("`fbrain -x doctor` (short-flag form) also triggers the option-aware error", async () => {
    const { code, stderr } = await runCli(["-x", "doctor"]);
    expect(code).toBe(1);
    expect(stderr).toContain("`-x` looks like an option, but it's in the command position.");
    expect(stderr).not.toContain("Unknown command");
    expect(stderr).not.toContain("Commands:");
  });

  test("`fbrain serach x` still suggests `search` (typo path preserved)", async () => {
    const { code, stderr } = await runCli(["serach", "x"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command: serach. Did you mean: search?");
    expect(stderr).not.toContain("looks like an option");
  });
});
