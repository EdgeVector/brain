// Pins `fbrain --version` and `fbrain -V` to print `fbrain <version>` on
// stdout (sourced from package.json — no pinned literal) and exit 0.
// Regression guard for the original dogfood report where these flags were
// unrecognized and dumped help to stderr with exit 1.
//
// The CLI also appends a `(shortSha[-dirty])` build identifier when the
// running source lives in a git checkout — this test runs inside one, so
// stdout matches `fbrain <pkg.version> (<sha>[-dirty])`. The bare-version
// fallback (no git) is covered by version-helper.test.ts.
//
// Short form is `-V` (uppercase) to match bun/node/cargo convention and
// to leave `-v` free for a future `--verbose` short alias.

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

// Matches `fbrain <pkg.version>` optionally followed by ` (<sha>[-dirty])`.
// The SHA segment is `[0-9a-f]{7,}` — git defaults short SHAs to 7 chars
// but `core.abbrev` can widen them, so accept 7+. Anchored end-to-end so
// trailing junk fails.
const VERSION_PATTERN = new RegExp(
  `^fbrain ${escapeForRegex(pkg.version)}( \\([0-9a-f]{7,}(-dirty)?\\))?$`,
);

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("fbrain --version / -V", () => {
  test("--version prints `fbrain <pkg.version> [(sha[-dirty])]` and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(VERSION_PATTERN);
    expect(stderr).toBe("");
  });

  test("-V prints `fbrain <pkg.version> [(sha[-dirty])]` and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["-V"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(VERSION_PATTERN);
    expect(stderr).toBe("");
  });
});
