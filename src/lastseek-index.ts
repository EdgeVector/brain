// Register Brain's record schemas with LastSeek and build the Brain index.
//
// LastSeek keeps no schema list of its own. `lastseek rebuild --schema` is
// how an app names the schemas to embed. Query routing, with no `--home` and
// no inbox, uses this directory:
//
// - `$LASTSEEK_HOME` when it is set. LastSeek then skips the sibling index
//   and serves the query from that home.
// - otherwise `brain-index` beside the default home: `$LASTDB_APP_DATA/brain-index`
//   when the launcher sets app data, else `~/.lastseek/brain-index`.
//
// Coverage is the published online checkpoint, which is what LastSeek's
// `covers` check reads. `lastseek status` reports `needs_rebuild` but not the
// schema names, so it cannot answer "does this index cover the list".

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BrainError } from "./client.ts";
import { lastSeekBin } from "./lastseek-plane.ts";
import { BRAIN_INDEX_COMMAND, lastSeekSchemaNames } from "./lastseek-schemas.ts";

const VERSION_TIMEOUT_MS = 10_000;
/** LastSeek stops a rebuild at 30 minutes. Stop a wedged child after that. */
const REBUILD_TIMEOUT_MS = 35 * 60 * 1000;
const NOT_INSTALLED_LINE =
  "LastSeek is not installed; search uses keyword heads until it is.";

type SchemaConfig = { schemaHashes: Record<string, string> };

export function lastSeekBrainIndexDir(): string {
  const override = process.env.LASTSEEK_HOME;
  if (override && override.length > 0) return override;
  const appData = process.env.LASTDB_APP_DATA;
  if (appData && appData.length > 0) return join(appData, "brain-index");
  const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : ".";
  return join(home, ".lastseek", "brain-index");
}

type InstallProbe = { kind: "ready" } | { kind: "missing" } | { kind: "unusable"; detail: string };

function probeLastSeek(): InstallProbe {
  const bin = lastSeekBin();
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") return { kind: "missing" };
  if (result.status === 0) return { kind: "ready" };
  const detail = (result.stderr ?? "").trim() || error?.message || `exit ${result.status ?? "unknown"}`;
  return { kind: "unusable", detail };
}

/** Schema names in the published checkpoint. Absent when there is no online index. */
export function publishedIndexSchemas(dir: string): string[] | null {
  let slot: string;
  try {
    slot = readFileSync(join(dir, ".lastseek-online", "active"), "utf8").trim();
  } catch {
    return null;
  }
  if (slot !== "a" && slot !== "b") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, ".lastseek-online", slot, "checkpoint.json"), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const projections = (parsed as { projections?: unknown }).projections;
  if (!projections || typeof projections !== "object" || Array.isArray(projections)) return null;
  return Object.keys(projections as Record<string, unknown>);
}

export function indexCovers(dir: string, schemas: readonly string[]): boolean {
  if (!existsSync(dir) || schemas.length === 0) return false;
  const published = publishedIndexSchemas(dir);
  if (!published) return false;
  const known = new Set(published);
  return schemas.every((schema) => known.has(schema));
}

type RebuildResult = {
  stdout: string;
  parsed: unknown;
};

function summarize(parsed: unknown, home: string, schemaCount: number): string {
  const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const schemas = Array.isArray(body.schemas) ? body.schemas.length : schemaCount;
  const rows = typeof body.committed_rows === "number" ? `, ${body.committed_rows} rows` : "";
  return `LastSeek index ready: ${schemas} schemas${rows} in ${home}.`;
}

function runRebuild(
  bin: string,
  args: string[],
  onProgress: (line: string) => void,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: {
      status: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      spawnError?: NodeJS.ErrnoException;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, REBUILD_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("lastseek rebuild:")) onProgress(line);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ status: null, stdout, stderr: stderr || error.message, timedOut, spawnError: error });
    });
    child.on("close", (status) => {
      if (pending.startsWith("lastseek rebuild:")) onProgress(pending);
      finish({ status, stdout, stderr, timedOut });
    });
  });
}

async function rebuild(opts: {
  schemas: readonly string[];
  home: string;
  socketPath: string;
  onProgress: (line: string) => void;
}): Promise<RebuildResult> {
  const bin = lastSeekBin();
  const args = ["rebuild", "--home", opts.home, "--lastdb-socket", opts.socketPath];
  for (const schema of opts.schemas) args.push("--schema", schema);
  const result = await runRebuild(bin, args, opts.onProgress);
  if (result.spawnError?.code === "ENOENT") {
    throw new BrainError({
      code: "lastseek_missing",
      message: NOT_INSTALLED_LINE,
      hint: `Install LastSeek, then run \`${BRAIN_INDEX_COMMAND}\`.`,
    });
  }
  if (result.timedOut) {
    throw new BrainError({
      code: "lastseek_index_failed",
      message: "lastseek rebuild exceeded 35 minutes and was stopped.",
      hint: `Run \`${BRAIN_INDEX_COMMAND}\` when the node is up.`,
    });
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`;
    throw new BrainError({
      code: "lastseek_index_failed",
      message: detail,
      hint: `Run \`${BRAIN_INDEX_COMMAND}\` to retry. LastSeek reads every record of each named schema.`,
    });
  }
  const text = result.stdout.trim();
  try {
    return { stdout: text, parsed: JSON.parse(text) as unknown };
  } catch (error) {
    throw new BrainError({
      code: "lastseek_index_failed",
      message: "lastseek rebuild exited 0 but did not print a JSON result.",
      hint: text.slice(0, 500) || (error instanceof Error ? error.message : "empty stdout"),
    });
  }
}

function requireSchemaNames(cfg: SchemaConfig): string[] {
  const schemas = lastSeekSchemaNames(cfg);
  if (schemas.length === 0) {
    throw new BrainError({
      code: "lastseek_schema_pin",
      message: "Brain has no record-type schema pins to register with LastSeek.",
      hint: `Run \`brain init\`, then \`${BRAIN_INDEX_COMMAND}\`.`,
    });
  }
  const foreign = schemas.filter((schema) => !schema.startsWith("brain/"));
  if (foreign.length > 0) {
    throw new BrainError({
      code: "lastseek_schema_pin",
      message: `Brain's schema pins are not brain/<Name> names (${foreign.join(", ")}).`,
      hint: `Run \`brain init\` so search passes brain/<Name> schema names, then \`${BRAIN_INDEX_COMMAND}\`.`,
    });
  }
  return schemas;
}

/**
 * Build the Brain index. `if-needed` is the init path: a missing LastSeek is
 * one line and a return; an index that already covers the list is left alone.
 * `always` is `brain index`: it rebuilds and prints LastSeek's JSON result.
 */
export async function registerLastSeekSchemas(opts: {
  cfg: SchemaConfig;
  socketPath: string;
  print: (line: string) => void;
  printErr?: (line: string) => void;
  when: "always" | "if-needed";
}): Promise<void> {
  const report = opts.printErr ?? opts.print;
  const probe = probeLastSeek();
  if (probe.kind === "missing") {
    if (opts.when === "if-needed") {
      opts.print(NOT_INSTALLED_LINE);
      return;
    }
    throw new BrainError({
      code: "lastseek_missing",
      message: NOT_INSTALLED_LINE,
      hint: `Install LastSeek, then run \`${BRAIN_INDEX_COMMAND}\`.`,
    });
  }
  if (probe.kind === "unusable") {
    const line = `LastSeek did not answer \`lastseek --version\` (${probe.detail}).`;
    if (opts.when === "if-needed") {
      opts.print(`${line} Search uses keyword heads until it runs.`);
      return;
    }
    throw new BrainError({
      code: "lastseek_missing",
      message: line,
      hint: `Fix LastSeek, then run \`${BRAIN_INDEX_COMMAND}\`.`,
    });
  }

  const schemas = requireSchemaNames(opts.cfg);
  const home = lastSeekBrainIndexDir();
  if (opts.when === "if-needed" && indexCovers(home, schemas)) return;

  report(
    `Registering ${schemas.length} schemas with LastSeek in ${home}. This can take minutes.`,
  );
  const result = await rebuild({
    schemas,
    home,
    socketPath: opts.socketPath,
    onProgress: report,
  });
  report(summarize(result.parsed, home, schemas.length));
  if (opts.when === "always") opts.print(result.stdout);
}
