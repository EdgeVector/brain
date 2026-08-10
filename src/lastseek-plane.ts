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

  const r = spawnSync(lastSeekBin(), args, {
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });

  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    if (/unknown schema/i.test(stderr)) {
      throw new LastSeekUnknownSchemaError(stderr);
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
