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
 * A cold `lastseek query` — fork, load bge-small-en-v1.5, mmap the index,
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
 * resolution failure propagates and anything else (no binary, no index)
 * returns null.
 */

import { spawnSync } from "node:child_process";
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
  /** Readable name, when the Schema Service table knows one. */
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
  /**
   * Scope terms. LastSeek accepts a readable name (`Card`), a schema identity
   * hash, or a registry name, and resolves all three through its Schema
   * Service table — so an app can pass the hashes from its own config without
   * translating anything.
   */
  schemas?: string[];
  exact?: boolean;
  min_score?: number;
  verbose?: (line: string) => void;
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

/**
 * Query LastSeek. Returns null when the plane is unavailable, `[]` when it is
 * up and genuinely has no matches, and throws on an unresolvable schema.
 */
export function queryLastSeek(opts: LastSeekQueryOpts): LastSeekHit[] | null {
  const verbose = opts.verbose ?? (() => {});
  if (process.env.LASTSEEK_DISABLE === "1") return null;

  const args = ["query", opts.query, "--k", String(opts.k ?? 50)];
  for (const s of opts.schemas ?? []) args.push("--schema", s);
  if (opts.exact) args.push("--exact");
  if (opts.min_score !== undefined) {
    args.push("--min-score", String(opts.min_score));
  }

  const timeoutMs = envMs("LASTSEEK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const budgetMs = envMs("LASTSEEK_BUDGET_MS", DEFAULT_BUDGET_MS);

  // Budget check BEFORE the spawn: once this invocation has spent its helper
  // time, further phrasings are not worth another caller-visible stall. The
  // incumbent ranker still answers them.
  const spentMs = subprocessMsSoFar();
  if (budgetMs > 0 && spentMs >= budgetMs) {
    notice(
      `lastseek: skipped — this call already spent ${(spentMs / 1000).toFixed(1)}s of its ` +
        `${(budgetMs / 1000).toFixed(1)}s helper budget (LASTSEEK_BUDGET_MS); ` +
        "ranking this query with the incumbent search plane instead.",
    );
    return null;
  }

  const started = beginSubprocess();
  const r = spawnSync(lastSeekBin(), args, {
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  });
  endSubprocess(started, "lastseek query");

  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    if (/unknown schema/i.test(stderr)) {
      throw new LastSeekUnknownSchemaError(stderr);
    }
    // A deadline miss is reported on stderr, not swallowed into `verbose`.
    // `spawnSync` signals a timeout as ETIMEDOUT (Bun/Node set `error` and
    // leave `status` null), and the SIGTERM'd child is indistinguishable from
    // a crash by exit code alone.
    const timedOut =
      (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      (r.status === null && r.signal !== null);
    if (timedOut) {
      notice(
        `lastseek: query exceeded its ${(timeoutMs / 1000).toFixed(1)}s deadline ` +
          "(LASTSEEK_TIMEOUT_MS) and was stopped; ranking with the incumbent search " +
          "plane instead. Results are the cheaper ranker's, not LastSeek's.",
      );
      return null;
    }
    verbose(
      `lastseek: unavailable (${r.error?.message ?? `exit ${r.status}`}${stderr ? `: ${stderr}` : ""})`,
    );
    return null;
  }

  try {
    const parsed = JSON.parse(r.stdout) as { results?: LastSeekHit[] };
    if (!Array.isArray(parsed.results)) return null;
    verbose(`lastseek: hits=${parsed.results.length}`);
    return parsed.results;
  } catch {
    verbose("lastseek: returned non-JSON");
    return null;
  }
}
