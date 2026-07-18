import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWhichResult, formatWhich } from "../../src/commands/which.ts";

describe("brain which", () => {
  test("reports a host-track managed source root", () => {
    const root = mkdtempSync(join(tmpdir(), "fbrain-which-host-track-"));
    const hostTrackRoot = join(root, ".host-track");
    const sourceRoot = join(hostTrackRoot, "brain");
    const binPath = join(sourceRoot, "bin", "brain");
    mkdirSync(join(sourceRoot, "bin"), { recursive: true });
    symlinkSync(process.execPath, binPath);

    const result = buildWhichResult({
      hostTrackRoot,
      sourceRoot,
      whichBin: () => binPath,
    });

    expect(result.hostTrack).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.realPath).toBe(process.execPath);
    expect(result.sourceRealPath).toBe(realpathSync(sourceRoot));
  });

  test("flags a workspace source root as not host-track managed", () => {
    const root = mkdtempSync(join(tmpdir(), "fbrain-which-workspace-"));
    const hostTrackRoot = join(root, ".host-track");
    const sourceRoot = join(root, "code", "edgevector", "brain");
    mkdirSync(sourceRoot, { recursive: true });

    const result = buildWhichResult({
      hostTrackRoot,
      sourceRoot,
      whichBin: () => null,
    });

    expect(result.hostTrack).toBe(false);
    expect(result.path).toBeNull();
    expect(result.issues).toContain("brain is not on PATH");
    expect(result.issues).toContain(`brain is not running from ${hostTrackRoot}`);
    expect(formatWhich(result)).toContain("host_track: no");
  });
});
