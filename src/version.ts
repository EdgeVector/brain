// Single-source version string for `fbrain --version` (cli.ts) and the MCP
// `serverInfo.version` (mcp/server.ts). Appends a git short-SHA suffix when
// the running source lives in a git checkout — the `fbrain` bin runs
// src/cli.ts directly out of the repo (`package.json` `bin.fbrain =
// "src/cli.ts"`), so the SHA distinguishes one downloaded build from
// another in bug reports. Falls back to bare `pkg.version` when git or
// `.git` is unavailable (installed outside a repo, sandboxed run, etc.).

import { execFileSync } from "node:child_process";

import pkg from "../package.json" with { type: "json" };

const GIT_TIMEOUT_MS = 500;

export type VersionOptions = {
  // Override the directory to anchor the `git -C <dir>` lookup. Defaults
  // to the directory containing this file (`import.meta.dir`), which is
  // the right anchor because the CLI runs from the source checkout. Used
  // by tests to point at a non-repo directory.
  anchorDir?: string;
};

export function getFbrainVersion(opts: VersionOptions = {}): string {
  const suffix = gitSuffix(opts.anchorDir ?? import.meta.dir);
  return suffix ? `${pkg.version} (${suffix})` : pkg.version;
}

function gitSuffix(dir: string): string | undefined {
  try {
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024,
    }).trim();
    if (sha.length === 0) return undefined;
    return isDirty(dir) ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
}

function isDirty(dir: string): boolean {
  try {
    const out = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024,
    });
    return out.length > 0;
  } catch {
    return false;
  }
}
