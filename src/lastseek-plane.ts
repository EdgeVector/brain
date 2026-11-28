/**
 * LastSeek plane client — the Rust successor to the TypeScript Search app.
 *
 * LastSeek is an app that sits ON TOP of LastDB, same posture as Search, with
 * its own local regenerable index (`lastdb:///lastseek`). It is preferred over
 * Search when its binary and index are present, and absent/unbuilt it returns
 * null so `search-plane.ts` falls through to the incumbent unchanged. That is
 * the whole rollout strategy: no flag day, no cutover moment.
 *
 * # Why a subprocess and not a warm server
 *
 * A cold `lastseek search` — fork, load bge-small-en-v1.5, mmap the index,
 * embed, score, print — is **~100 ms**, measured. The reason the incumbent
 * needed a resident process was Node + transformers.js startup, which `ort`
 * does not have. A daemon here would add a lifecycle to supervise and buy
 * nothing.
 *
 * # Why the spawn is bounded, and bounded THIS low
 *
 * That ~100 ms is the measurement this file was written against, and it is
 * still right on a warm machine. The original deadline was 60 s per spawn,
 * which is not a deadline so much as a promise never to give up: it sits above
 * every caller's budget. An agent's Bash step is 45 s, and `brain ask` spawns
 * once per query phrasing — original plus expansions — so four slow spawns
 * could block for four minutes with nothing named.
 *
 * That is not hypothetical. On 2026-09-03 a slow spawn held `brain ask` for
 * 35.1 s; the harness backgrounded the call at 45 s, and two routines
 * (`pr-reaper`, `owner-lastdb-data-lifecycle`) then sat to their 50-minute
 * timeouts waiting on a background task a one-turn dispatch can never receive.
 * Node service time for the same call was 5.5 s, so nothing was wrong with the
 * database
 * (`papercut-brain-ask-pre-send-35s-exceeds-agent-45s-bash-timeout-routines-idle-to-50-min-timeout-20260903`).
 *
 * So: a per-spawn deadline of 10 s (100x the measured cost) and a cumulative
 * budget of 20 s across the whole CLI invocation, both overridable. Blowing
 * either is not an error — this tier is already designed to return null and
 * fall through to the incumbent, which is the papercut's own suggested fix:
 * degrade to the cheaper ranker and SAY SO. The saying-so is the part that
 * was missing; a silent degrade would be a worse bug than the stall.
 *
 * # Why an unknown schema is thrown, not swallowed
 *
 * LastSeek's central fix is that a scope term resolving to nothing is an ERROR
 * rather than an empty hit list — the predecessor returned `Ok([])` for both
 * "you named a schema that does not exist" and "that schema holds no rows",
 * live, on this app's own corpus. If this client caught that error and returned
 * null, `search-plane.ts` would fall through to the incumbent, which answers
 * the same query with `[]`, and the confident-empty answer would be right back
 * — reintroduced at the integration layer by the code meant to remove it. So a
 * resolution failure propagates and anything else (no binary, index not ready)
 * returns null.
 *
 * Exit 3 with `index_not_ready` is not that error. The index is absent, still
 * building, or the last build failed. Search uses the keyword fallback and
 * says so. It does not start a build.
 */

import { spawnSync } from "node:child_process";
import { BRAIN_INDEX_COMMAND, LASTSEEK_APP_NAME } from "./lastseek-schemas.ts";
import { beginSubprocess, endSubprocess, subprocessMsSoFar } from "./slow-call.ts";

/** Per-spawn deadline. 100x the measured cold-query cost. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Cumulative deadline across one CLI invocation, over all spawns. */
const DEFAULT_BUDGET_MS = 20_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Per-spawn deadline shared by `lastseek search` and the non-waiting index call. */
export function lastSeekTimeoutMs(): number {
  return envMs("LASTSEEK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

/** The one stderr voice of this tier. Only the degrade paths speak: a caller
 * that silently loses the better ranker cannot tell a good answer from a
 * cheaper one. */
function notice(line: string): void {
  try {
    console.error(`brain: ${line}`);
  } catch {
    // A notice must never turn a green exit red.
  }
}

export type LastSeekHit = {
  /** The canonical schema identity the row is keyed on. */
  schema_identity: string;
  /** Readable schema name when LastSeek reports one. */
  schema: string | null;
  key_hash: string | null;
  key_range: string | null;
  fragment_key: string;
  score: number;
  text: string;
};

export type LastSeekQueryOpts = {
  query: string;
  k?: number;
  /** Stable process role for LastSeek operator metrics. */
  caller?: string;
  /**
   * Scope terms. LastSeek accepts a readable name (`Card`), a schema identity
   * hash, or a registry name, and resolves all three through its Schema
   * Service table — so an app can pass the hashes from its own config without
   * translating anything.
   */
  schemas?: string[];
  /**
   * Kept for callers. LastSeek search has no `--exact` flag; Brain checks
   * the phrase against the records it reads back.
   */
  exact?: boolean;
  min_score?: number;
  verbose?: (line: string) => void;
};

export type LastSeekAppStatus = {
  state: string;
  error: string | null;
};

/** Thrown when LastSeek cannot resolve a scope term. Never swallowed. */
export class LastSeekUnknownSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastSeekUnknownSchemaError";
  }
}

export function lastSeekBin(): string {
  return process.env.LASTSEEK_BIN?.trim() || "lastseek";
}

type LastSeekSpawn = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
};

/** Environment for a LastSeek command.
 *
 * LastSeek is another app. Its own launcher sets LASTDB_APP and
 * LASTDB_SOCKET_PATH. Brain does not hand over its own.
 */
export function lastSeekChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.LASTDB_APP;
  delete next.LASTDB_SOCKET_PATH;
  return next;
}

function spawnLastSeek(args: string[], env: NodeJS.ProcessEnv, label: string): LastSeekSpawn {
  const timeoutMs = lastSeekTimeoutMs();
  const started = beginSubprocess();
  const result = spawnSync(lastSeekBin(), args, {
    encoding: "utf8",
    env: lastSeekChildEnv(env),
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  });
  endSubprocess(started, label);
  const error = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = error?.code === "ETIMEDOUT" || (result.status === null && result.signal !== null);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim(),
    timedOut,
    ...(error ? { error } : {}),
  };
}

function parseObject(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Exit 2 names a schema the index does not hold. That must not become an empty answer. */
function unknownSchemaDetail(stdout: string, stderr: string): string | null {
  if (/unknown schema/i.test(stderr)) return stderr;
  const body = parseObject(stdout);
  if (!body) return /unknown schema/i.test(stdout) ? stdout.trim() : null;
  const blob = [body.code, body.message, body.error].filter((part) => typeof part === "string").join(" ");
  if (/unknown.?schema/i.test(blob) || /unknown schema/i.test(stdout)) {
    const message = body.message ?? body.error;
    return typeof message === "string" && message.length > 0 ? message : stdout.trim();
  }
  return null;
}

function indexNotReadyNotice(state: string): string {
  if (state === "absent" || state === "failed") {
    return (
      `lastseek: index is ${state}. Run \`${BRAIN_INDEX_COMMAND}\`. ` +
      "This command uses the keyword-head sample."
    );
  }
  return "lastseek: the index is still building. This command uses the keyword-head sample.";
}

function overBudget(): boolean {
  const budgetMs = envMs("LASTSEEK_BUDGET_MS", DEFAULT_BUDGET_MS);
  const spentMs = subprocessMsSoFar();
  if (!(budgetMs > 0 && spentMs >= budgetMs)) return false;
  notice(
    `lastseek: skipped — this call already spent ${(spentMs / 1000).toFixed(1)}s of its ` +
      `${(budgetMs / 1000).toFixed(1)}s helper budget (LASTSEEK_BUDGET_MS); ` +
      "this command uses the keyword-head sample.",
  );
  return true;
}

function hitFromResult(row: unknown): LastSeekHit | null {
  if (!row || typeof row !== "object") return null;
  const item = row as Record<string, unknown>;
  const schema = typeof item.schema === "string" ? item.schema : null;
  const identity =
    typeof item.schema_identity === "string" && item.schema_identity.length > 0
      ? item.schema_identity
      : schema;
  if (!identity) return null;
  return {
    schema_identity: identity,
    schema,
    key_hash: typeof item.key_hash === "string" ? item.key_hash : null,
    key_range: typeof item.key_range === "string" ? item.key_range : null,
    fragment_key: typeof item.fragment_key === "string" ? item.fragment_key : "",
    score: typeof item.score === "number" ? item.score : 0,
    text: typeof item.text === "string" ? item.text : "",
  };
}

/**
 * Read `lastseek status --app brain`. Null when LastSeek is disabled, missing,
 * or does not print its status object. Every index state is exit 0.
 */
export function lastSeekAppStatus(): LastSeekAppStatus | null {
  if (process.env.LASTSEEK_DISABLE === "1") return null;
  const spawned = spawnLastSeek(
    ["status", "--app", LASTSEEK_APP_NAME],
    process.env,
    "lastseek status",
  );
  if (spawned.error?.code === "ENOENT" || spawned.timedOut || spawned.status !== 0) return null;
  const body = parseObject(spawned.stdout);
  if (!body || body.ok !== true || typeof body.state !== "string" || body.state.length === 0) return null;
  const error = typeof body.error === "string" ? body.error : null;
  return { state: body.state, error };
}

/**
 * Search LastSeek. Returns null when the plane is unavailable or the index
 * is not ready, `[]` when it is up and genuinely has no matches, and throws
 * on an unresolvable schema.
 */
export function queryLastSeek(opts: LastSeekQueryOpts): LastSeekHit[] | null {
  const verbose = opts.verbose ?? (() => {});
  if (process.env.LASTSEEK_DISABLE === "1") return null;

  const args = ["search", "--app", LASTSEEK_APP_NAME, opts.query, "--k", String(opts.k ?? 25)];
  for (const schema of opts.schemas ?? []) args.push("--schema", schema);
  if (opts.min_score !== undefined) args.push("--min-score", String(opts.min_score));

  // Budget check BEFORE the spawn: once this invocation has spent its helper
  // time, further phrasings are not worth another caller-visible stall.
  if (overBudget()) return null;

  const env = opts.caller ? { ...process.env, LASTSEEK_CALLER: opts.caller } : process.env;
  const spawned = spawnLastSeek(args, env, "lastseek search");
  const timeoutMs = lastSeekTimeoutMs();

  if (spawned.timedOut) {
    notice(
      `lastseek: search exceeded its ${(timeoutMs / 1000).toFixed(1)}s deadline ` +
        "(LASTSEEK_TIMEOUT_MS) and was stopped; this command uses the keyword-head sample.",
    );
    return null;
  }

  if (spawned.status !== 0) {
    const unknown = unknownSchemaDetail(spawned.stdout, spawned.stderr);
    if (unknown) {
      // Name the command. Do not start a build here.
      throw new LastSeekUnknownSchemaError(
        `${unknown}\nRun \`${BRAIN_INDEX_COMMAND}\` to register Brain's schemas with LastSeek.`,
      );
    }
    if (spawned.status === 3) {
      const body = parseObject(spawned.stdout);
      if (body?.code === "index_not_ready") {
        const state = typeof body.state === "string" && body.state.length > 0 ? body.state : "absent";
        notice(indexNotReadyNotice(state));
        return null;
      }
    }
    verbose(
      `lastseek: unavailable (${spawned.error?.message ?? `exit ${spawned.status}`}${spawned.stderr ? `: ${spawned.stderr}` : ""})`,
    );
    return null;
  }

  const parsed = parseObject(spawned.stdout);
  if (!parsed || !Array.isArray(parsed.results)) {
    verbose("lastseek: returned non-JSON");
    return null;
  }
  const hits: LastSeekHit[] = [];
  for (const row of parsed.results) {
    const hit = hitFromResult(row);
    if (hit) hits.push(hit);
  }
  if (parsed.results.length > 0 && hits.length === 0) {
    verbose("lastseek: results had no schema");
    return null;
  }
  verbose(`lastseek: hits=${hits.length}${parsed.stale === true ? " stale" : ""}`);
  return hits;
}
