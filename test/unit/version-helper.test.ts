// Unit tests for getFbrainVersion() — the single-sourced version string
// used by `fbrain --version` (cli.ts) and the MCP serverInfo (mcp/server.ts).
//
// What we pin:
//   1. The returned string always starts with `pkg.version` (never a bare
//      SHA, never empty). Build-identifier suffix is optional.
//   2. The fallback path (no `.git` discoverable from the anchor dir) does
//      NOT throw — version reporting must never crash the CLI. We simulate
//      this by anchoring at a tmpdir outside any git repo.
//   3. The in-repo path (anchored at this test file's dir) appends a
//      `(<shortSha>[-dirty])` suffix on machines where git is available.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../../package.json" with { type: "json" };
import { getFbrainVersion } from "../../src/version.ts";

describe("getFbrainVersion", () => {
  test("returns a string that starts with pkg.version", () => {
    const v = getFbrainVersion();
    expect(typeof v).toBe("string");
    expect(v.startsWith(pkg.version)).toBe(true);
  });

  test("does not throw and falls back to bare pkg.version when anchored outside a git repo", () => {
    // mkdtempSync() lands in the OS tmpdir, which is not a git checkout.
    // `git -C <tmp> rev-parse` exits non-zero ("not a git repository") —
    // the helper's try/catch must swallow that and return bare pkg.version.
    const dir = mkdtempSync(join(tmpdir(), "fbrain-version-no-git-"));
    try {
      const v = getFbrainVersion({ anchorDir: dir });
      expect(v).toBe(pkg.version);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends a `(<sha>[-dirty])` build identifier when anchored inside this git checkout", () => {
    // This test file lives inside the repo, so its dir is a valid anchor.
    const v = getFbrainVersion({ anchorDir: import.meta.dir });
    const rest = v.slice(pkg.version.length);
    // Either bare (env without git) or with the expected suffix shape.
    expect(rest === "" || /^ \([0-9a-f]{7,}(-dirty)?\)$/.test(rest)).toBe(true);
  });
});
