// Pins the user-exec bit on every package.json `bin` entrypoint.
//
// bun link symlinks ~/.bun/bin/<name> directly at the bin target (no wrapper
// script). macOS exec then needs the target itself to be +x, and the
// `#!/usr/bin/env bun` shebang to take effect. If these files ship at 100644,
// a fresh clone or any `git pull` that touches them reverts the mode and
// `fbrain --version` fails with `permission denied` until the user manually
// chmods. Easy to miss because git tracks mode separately from content.

import { describe, expect, test } from "bun:test";
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
