import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export type WhichResult = {
  command: "brain";
  path: string | null;
  realPath: string | null;
  sourceRoot: string;
  sourceRealPath: string;
  hostTrackRoot: string;
  hostTrack: boolean;
  stale: "unknown";
  issues: string[];
};

export type WhichOptions = {
  whichBin?: (name: string) => string | null | undefined;
  sourceRoot?: string;
  hostTrackRoot?: string;
};

const DEFAULT_SOURCE_ROOT = resolve(import.meta.dir, "..", "..");

export function buildWhichResult(opts: WhichOptions = {}): WhichResult {
  const commandPath = opts.whichBin ? (opts.whichBin("brain") ?? null) : defaultWhich("brain");
  const realCommandPath = commandPath ? safeRealpath(commandPath) : null;
  const sourceRoot = resolve(opts.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const sourceRealPath = safeRealpath(sourceRoot) ?? sourceRoot;
  const hostTrackRoot = resolve(
    opts.hostTrackRoot ?? process.env.HOST_TRACK_ROOT ?? `${homedir()}/.host-track`,
  );
  const hostTrackRealRoot = safeRealpath(hostTrackRoot) ?? hostTrackRoot;

  const hostTrack =
    isPathWithin(sourceRealPath, hostTrackRealRoot) ||
    (realCommandPath !== null && isPathWithin(realCommandPath, hostTrackRealRoot));
  const issues: string[] = [];
  if (commandPath === null) {
    issues.push("brain is not on PATH");
  }
  if (!hostTrack) {
    issues.push(`brain is not running from ${hostTrackRoot}`);
  }

  return {
    command: "brain",
    path: commandPath,
    realPath: realCommandPath,
    sourceRoot,
    sourceRealPath,
    hostTrackRoot,
    hostTrack,
    stale: "unknown",
    issues,
  };
}

export function formatWhich(result: WhichResult): string {
  return [
    "brain which",
    `  path: ${result.path ?? "(not found)"}`,
    `  real_path: ${result.realPath ?? "(not found)"}`,
    `  source_root: ${result.sourceRealPath}`,
    `  host_track_root: ${result.hostTrackRoot}`,
    `  host_track: ${result.hostTrack ? "yes" : "no"}`,
    "  stale: unknown",
  ].join("\n");
}

function defaultWhich(name: string): string | null {
  return Bun.which(name) ?? null;
}

function safeRealpath(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isPathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
