/**
 * Search plane client — primary path for brain ask/search.
 *
 * Semantic, schema-scoped k-NN. When the plane is unavailable, returns null so
 * callers keep node.search / BM25 rescue instead of inventing capability
 * failures.
 *
 * Resolution order:
 *   0. LastSeek (`lastseek query`) — the Rust successor, preferred when its
 *      binary and index are present
 *   1. LASTDB_SEARCH_SEMANTIC_MODULE — path to search package semantic.ts
 *   2. host-track search semantic.ts
 *   3. LASTDB_SEARCH_BIN / `search semantic-query --json` (or `search query`)
 *
 * LastSeek goes first rather than replacing the rest, so the cutover is a
 * property of what is installed rather than a flag day. `LASTSEEK_DISABLE=1`
 * pins the incumbent.
 *
 * The scope hashes brain passes (`uniqueSchemaHashes`) are the registry names
 * LastSeek's Schema Service table resolves directly — `reference` is
 * `5c691083…` in both — so this tier needs no translation.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { queryLastSeek } from "./lastseek-plane.ts";

export type SearchPlaneHit = {
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  score: number;
  text: string;
  mutation_id?: string;
};

export type SearchPlaneQueryOpts = {
  query: string;
  k?: number;
  schemas?: string[];
  exact?: boolean;
  min_score?: number;
  /** Drain Search inbox before query when supported by the semantic session. */
  drain?: boolean;
  lastDbHome?: string;
  searchHome?: string;
  verbose?: (line: string) => void;
};

export function resolveSemanticModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_SEMANTIC_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  const hostTrack = `${process.env.HOME ?? ""}/.host-track/apps/search/current/src/semantic.ts`;
  if (hostTrack && existsSync(hostTrack)) return hostTrack;
  return null;
}

type SearchPlaneHomeOpts = {
  lastDbHome?: string;
  searchHome?: string;
};

function resolveSearchHome(opts: SearchPlaneHomeOpts = {}): string {
  if (opts.searchHome) return opts.searchHome;
  if (process.env.SEARCH_HOME?.trim()) return process.env.SEARCH_HOME.trim();
  const home =
    opts.lastDbHome ||
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
    `${process.env.HOME ?? ""}/.lastdb`;
  return resolve(home, "apps/search");
}

async function querySemanticInProcess(
  opts: SearchPlaneQueryOpts,
): Promise<SearchPlaneHit[] | null> {
  const verbose = opts.verbose ?? (() => {});
  const modPath = resolveSemanticModulePath();
  if (!modPath) return null;
  try {
    const mod = (await import(pathToFileURL(modPath).href)) as {
      openSearchSession?: (o?: {
        lastDbHome?: string;
        embedder?: unknown;
      }) => {
        semantic: {
          query: (
            q: string,
            o?: {
              k?: number;
              schemas?: string[];
              exact?: boolean;
              min_score?: number;
            },
          ) => Promise<SearchPlaneHit[]>;
          ensureReady: () => Promise<void>;
          health: () => { state: string; vectors: number };
        };
      };
      openSemanticPlane?: (
        home: string,
        o?: unknown,
      ) => {
        query: (
          q: string,
          o?: {
            k?: number;
            schemas?: string[];
            exact?: boolean;
            min_score?: number;
          },
        ) => Promise<SearchPlaneHit[]>;
        ensureReady: () => Promise<void>;
      };
    };
    if (typeof mod.openSearchSession === "function") {
      const session = mod.openSearchSession({ lastDbHome: opts.lastDbHome });
      await session.semantic.ensureReady();
      const hits = await session.semantic.query(opts.query, {
        k: opts.k ?? 50,
        schemas: opts.schemas,
        exact: opts.exact,
        min_score: opts.min_score,
      });
      verbose(
        `search-plane: semantic in-process hits=${hits.length} vectors=${session.semantic.health().vectors}`,
      );
      return hits.map((h) => ({
        schema_name: h.schema_name,
        key_hash: h.key_hash,
        key_range: h.key_range,
        score: h.score,
        text: h.text,
        mutation_id: h.mutation_id,
      }));
    }
    if (typeof mod.openSemanticPlane === "function") {
      const plane = mod.openSemanticPlane(resolveSearchHome(opts));
      await plane.ensureReady();
      const hits = await plane.query(opts.query, {
        k: opts.k ?? 50,
        schemas: opts.schemas,
        exact: opts.exact,
        min_score: opts.min_score,
      });
      verbose(`search-plane: semantic plane hits=${hits.length}`);
      return hits;
    }
  } catch (e) {
    verbose(
      `search-plane: semantic in-process failed: ${e instanceof Error ? e.message : e}`,
    );
  }
  return null;
}

function querySemanticCli(opts: SearchPlaneQueryOpts): SearchPlaneHit[] | null {
  const verbose = opts.verbose ?? (() => {});
  const bin = process.env.LASTDB_SEARCH_BIN?.trim() || "search";
  const args = [
    "semantic-query",
    opts.query,
    "--json",
    "--k",
    String(opts.k ?? 50),
  ];
  for (const s of opts.schemas ?? []) {
    args.push("--schema", s);
  }
  if (opts.exact) args.push("--exact");
  if (opts.min_score !== undefined) {
    args.push("--min-score", String(opts.min_score));
  }
  if (opts.lastDbHome) {
    args.push("--last-db-home", opts.lastDbHome);
  } else if (process.env.LASTDB_HOME?.trim()) {
    args.push("--last-db-home", process.env.LASTDB_HOME.trim());
  }
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    // The index records the embedder that created it. Let Search reopen that
    // initialized plane instead of silently forcing the deterministic test
    // embedder over a normal MiniLM index. An explicit SEARCH_EMBEDDER still
    // passes through via process.env for tests and deliberate overrides.
    env: process.env,
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) {
    verbose(
      `search-plane: semantic CLI unavailable (${r.error?.message ?? `exit ${r.status}`})`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      hits?: SearchPlaneHit[];
      mode?: string;
    };
    if (!Array.isArray(parsed.hits)) return [];
    verbose(
      `search-plane: semantic CLI mode=${parsed.mode ?? "?"} hits=${parsed.hits.length}`,
    );
    return parsed.hits;
  } catch {
    verbose("search-plane: semantic CLI returned non-JSON");
    return null;
  }
}

/**
 * Query the Search semantic plane. Returns null when Search is completely
 * unavailable. Empty arrays mean plane up, no matches.
 */
export async function querySearchPlane(
  opts: SearchPlaneQueryOpts,
): Promise<SearchPlaneHit[] | null> {
  const verbose = opts.verbose ?? (() => {});

  // 0) LastSeek — preferred when its query can answer.
  //
  // An unresolvable schema throws out of here on purpose. Catching it and
  // falling through would land on the incumbent, which answers the same query
  // with `[]`, and the confident-empty answer this whole plane exists to remove
  // would be back — reintroduced by the fallback.
  const seek = queryLastSeek({
    query: opts.query,
    k: opts.k,
    schemas: opts.schemas,
    exact: opts.exact,
    min_score: opts.min_score,
    verbose,
  });
  if (seek !== null) {
    verbose(`search-plane: lastseek answered hits=${seek.length}`);
    return seek.map((h) => ({
      // Callers compare `schema_name` against the hashes they passed, so it
      // carries the identity, not the readable label.
      schema_name: h.schema_identity,
      key_hash: h.key_hash,
      key_range: h.key_range,
      score: h.score,
      text: h.text,
    }));
  }

  // 1) Semantic in-process
  const sem = await querySemanticInProcess(opts);
  if (sem !== null) return sem;

  // 2) Semantic CLI
  const cli = querySemanticCli(opts);
  if (cli !== null) return cli;

  verbose("search-plane: unavailable (semantic plane not found)");
  return null;
}
