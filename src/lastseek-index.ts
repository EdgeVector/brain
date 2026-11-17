// Name Brain's record schemas to LastSeek.
//
// `lastseek index --app brain --schema <each name>` returns as soon as
// LastSeek has accepted the schema set. It starts a build only when the
// published index does not already cover that set, and the build runs
// detached unless `--wait` is passed. Brain does not read LastSeek's
// directory, checkpoint, or state file. What Brain needs to know comes
// back as the one JSON object on stdout, or from `lastseek status --app brain`.

import { spawnSync } from "node:child_process";

import { BrainError } from "./client.ts";
import { lastSeekBin, lastSeekTimeoutMs } from "./lastseek-plane.ts";
import {
  BRAIN_INDEX_COMMAND,
  LASTSEEK_APP_NAME,
  lastSeekSchemaNames,
} from "./lastseek-schemas.ts";
import { beginSubprocess, endSubprocess } from "./slow-call.ts";

export const LASTSEEK_NOT_INSTALLED_LINE =
  "LastSeek is not installed; search uses keyword heads until it is.";

type SchemaConfig = { schemaHashes: Record<string, string> };

export type LastSeekIndexResult =
  | { kind: "ok"; state: string; json: string }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
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

function indexEnv(socketPath: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The detached build inherits this environment. LastSeek reads LastDB
  // through LASTDB_SOCKET_PATH and LASTDB_APP_SESSION. Brain's resolved
  // socket is that path when the launcher did not already set one.
  if (socketPath && socketPath.length > 0 && !env.LASTDB_SOCKET_PATH) {
    env.LASTDB_SOCKET_PATH = socketPath;
  }
  return env;
}

function parseIndexStdout(stdout: string): { state: string; json: string } | null {
  const json = stdout.trim();
  if (json.length === 0) return null;
  try {
    const body = JSON.parse(json) as { ok?: unknown; state?: unknown };
    if (body.ok !== true || typeof body.state !== "string" || body.state.length === 0) return null;
    return { state: body.state, json };
  } catch {
    return null;
  }
}

/**
 * Run `lastseek index --app brain`. Without `wait`, LastSeek returns as soon
 * as it has recorded the request. With `wait`, the build stays in this process.
 */
export function requestLastSeekIndex(opts: {
  cfg: SchemaConfig;
  socketPath?: string;
  wait?: boolean;
}): LastSeekIndexResult {
  const schemas = requireSchemaNames(opts.cfg);
  const args = ["index", "--app", LASTSEEK_APP_NAME];
  for (const schema of schemas) args.push("--schema", schema);
  if (opts.wait) args.push("--wait");

  // The search deadline bounds the non-waiting call, which returns at once.
  // `--wait` stays until LastSeek exits; that build is not a search.
  const timeoutMs = opts.wait ? 0 : lastSeekTimeoutMs();
  const started = beginSubprocess();
  const result = spawnSync(lastSeekBin(), args, {
    encoding: "utf8",
    env: indexEnv(opts.socketPath),
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    stdio: ["ignore", "pipe", opts.wait ? "inherit" : "pipe"],
  });
  endSubprocess(started, opts.wait ? "lastseek index --wait" : "lastseek index");

  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") return { kind: "missing" };

  const timedOut = error?.code === "ETIMEDOUT" || (result.status === null && result.signal !== null);
  if (result.status === 0 && !timedOut) {
    const parsed = parseIndexStdout(result.stdout ?? "");
    if (parsed) return { kind: "ok", state: parsed.state, json: parsed.json };
    return {
      kind: "error",
      detail: "lastseek index exited 0 but did not print a JSON state",
    };
  }

  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const stdout = result.stdout ?? "";
  const detail =
    timedOut && timeoutMs > 0
      ? `lastseek index exceeded its ${(timeoutMs / 1000).toFixed(1)}s deadline`
      : oneLine(stderr || stdout || error?.message || `exit ${result.status ?? "unknown"}`);
  return { kind: "error", detail: detail || `exit ${result.status ?? "unknown"}` };
}
