// Pins `brain --version` and `brain -V` to print `brain <version>` on
// stdout (sourced from package.json — no pinned literal) and exit 0.
// Regression guard for the original dogfood report where these flags were
// unrecognized and dumped help to stderr with exit 1.
//
// The CLI also appends a `(shortSha[-dirty])` build identifier when the
// running source lives in a git checkout — this test runs inside one, so
// stdout matches `brain <pkg.version> (<sha>[-dirty])`. The bare-version
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

// Matches `brain <pkg.version>` optionally followed by ` (<sha>[-dirty])`.
// The SHA segment is `[0-9a-f]{7,}` — git defaults short SHAs to 7 chars
// but `core.abbrev` can widen them, so accept 7+. Anchored end-to-end so
// trailing junk fails.
const VERSION_PATTERN = new RegExp(
  `^brain ${escapeForRegex(pkg.version)}( \\([0-9a-f]{7,}(-dirty)?\\))?$`,
);

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("brain --version / -V", () => {
  test("--version prints `brain <pkg.version> [(sha[-dirty])]` and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(VERSION_PATTERN);
    expect(stderr).toBe("");
  });

  test("-V prints `brain <pkg.version> [(sha[-dirty])]` and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["-V"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(VERSION_PATTERN);
    expect(stderr).toBe("");
  });
});

describe("brain version / -v (muscle-memory aliases)", () => {
  // `brain version` (git/docker/go-style bare subcommand) aliases to
  // `--version`: same stdout, exit 0 — not the unknown-command help wall.
  test("bare `version` prints the version string and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(VERSION_PATTERN);
    expect(stderr).toBe("");
  });

  // `-v` (node/npm/bun muscle memory) is NOT silently aliased — it stays a
  // usage error (exit 2) but the hint points at the real spelling `-V` /
  // `--version` instead of the misleading generic flag-placement hint.
  test("`-v` exits 2 with a hint naming `-V` / `--version`", async () => {
    const { code, stdout, stderr } = await runCli(["-v"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("-V");
    expect(stderr).toContain("--version");
  });
});
