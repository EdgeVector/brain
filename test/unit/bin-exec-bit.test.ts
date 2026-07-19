// Pins the user-exec bit on every package.json `bin` entrypoint.
//
// bun link symlinks ~/.bun/bin/<name> directly at the bin target. macOS exec
// then needs the target itself to be +x. If these files ship at 100644, a fresh
// clone or any `git pull` that touches them reverts the mode and `brain
// --version` fails with `permission denied` until the user manually chmods.
// Easy to miss because git tracks mode separately from content.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import pkg from "../../package.json" with { type: "json" };

const REPO_ROOT = join(import.meta.dir, "..", "..");

const binEntries = Object.entries(pkg.bin as Record<string, string>);

describe("package.json bin entrypoints are committed +x", () => {
  for (const [name, relPath] of binEntries) {
    test(`${name} (${relPath}) has the user-exec bit set`, async () => {
      const s = await stat(join(REPO_ROOT, relPath));
      expect(s.mode & 0o100).not.toBe(0);
    });
  }
});

describe("brain global shim", () => {
  test("finds ~/.bun/bin/bun when launched with a GUI-style minimal PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "brain-shim-home-"));
    const bunDir = join(home, ".bun", "bin");
    mkdirSync(bunDir, { recursive: true });
    symlinkSync(process.execPath, join(bunDir, "bun"));

    const res = spawnSync(join(REPO_ROOT, "bin", "brain"), ["--version"], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        FBRAIN_NO_STDIN: "1",
      },
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toStartWith(`brain ${pkg.version}`);
    expect(res.stderr).toBe("");
  });
});
