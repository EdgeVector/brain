import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const configPath = join(REPO_ROOT, ".lastgit", "artifacts.json");

type ArtifactConfig = {
  artifacts?: Array<{ app?: string; paths?: string[] }>;
};

describe("LastGit artifact bundle", () => {
  test("publishes Brain as a Host Track installable bundle", () => {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ArtifactConfig;
    const entry = parsed.artifacts?.find((artifact) => artifact.app === "brain");
    expect(entry).toBeDefined();

    const paths = entry?.paths ?? [];
    expect(paths).toContain("bin");
    expect(paths).toContain("src");
    expect(paths).toContain("vendor");
    expect(paths).toContain("package.json");
    expect(paths).toContain("bun.lock");
    expect(paths).toContain("folddb.toml");
    expect(paths).not.toContain("node_modules");

    for (const rel of paths) {
      const absolute = join(REPO_ROOT, rel);
      expect(existsSync(absolute), `${rel} exists`).toBe(true);
      expect(lstatSync(absolute).isSymbolicLink(), `${rel} is not a symlink`).toBe(false);
    }
  });

  test("carries an executable Host Track post-install hook", () => {
    const hook = join(REPO_ROOT, "bin", "brain-host-track-post-install");
    const stat = lstatSync(hook);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o100).not.toBe(0);
  });
});
