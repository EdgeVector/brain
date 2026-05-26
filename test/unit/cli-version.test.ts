// Pins `fbrain --version` and `fbrain -v` to print the package.json
// version on stdout and exit 0. Regression guard for the dogfood report
// where these flags were unrecognized and dumped help to stderr with
// exit 1.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import pkg from "../../package.json" with { type: "json" };

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

describe("fbrain --version / -v", () => {
  test("--version prints package.json version and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
    expect(stderr).toBe("");
  });

  test("-v prints package.json version and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["-v"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
    expect(stderr).toBe("");
  });
});
