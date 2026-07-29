/**
 * Search plane client — primary path for brain ask/search.
 *
 * Prefers the first-party Search app **semantic** plane (MiniLM vectors,
 * schema-scoped k-NN). Falls back to keyword vendor engine, then `search`
 * CLI. Does not treat Mini native empty-success as a good plane result —
 * callers may still fall back to node.search and BM25.
 *
 * Resolution order:
 *   1. LASTDB_SEARCH_SEMANTIC_MODULE — path to search package semantic.ts / vector plane
 *   2. LASTDB_SEARCH_MODULE — engine.ts (keyword)
 *   3. vendor/edgevector-search keyword engine
 *   4. LASTDB_SEARCH_BIN / `search semantic-query --json`
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Drain inbox before query (default true for keyword path). */
  drain?: boolean;
  lastDbHome?: string;
  searchHome?: string;
  verbose?: (line: string) => void;
};

export type SearchPlaneStatus = {
  available: boolean;
  reason?: string;
  docs?: number;
  home?: string;
  vector_state?: string;
};

type EngineHandle = {
  search: (
    q: string,
    opts?: { k?: number; schemas?: string[] },
  ) => SearchPlaneHit[];
  size: number;
  persist: () => void;
  applyChangeBatch: (b: unknown) => number;
};

type EngineModule = {
  openSearchEngine: (indexDir: string) => EngineHandle;
};

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveSearchModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  const vendorEngine = join(
    packageRoot(),
    "vendor",
    "edgevector-search",
    "src",
    "engine.ts",
  );
  if (existsSync(vendorEngine)) return vendorEngine;
  return null;
}

function resolveSemanticModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_SEMANTIC_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  // Host-track / worktree search package
  const candidates = [
    join(packageRoot(), "vendor", "edgevector-search", "src", "semantic.ts"),
    `${process.env.HOME ?? ""}/.host-track/apps/search/current/src/semantic.ts`,
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

type SearchPlaneHomeOpts = {
  lastDbHome?: string;
  searchHome?: string;
};

function resolveIndexDir(opts: SearchPlaneHomeOpts = {}): string {
  if (process.env.SEARCH_INDEX_DIR?.trim()) {
    return process.env.SEARCH_INDEX_DIR.trim();
  }
  if (opts.searchHome) return resolve(opts.searchHome, "index");
  if (process.env.SEARCH_HOME?.trim()) {
    return resolve(process.env.SEARCH_HOME.trim(), "index");
  }
  const home =
    opts.lastDbHome ||
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
    `${process.env.HOME ?? ""}/.lastdb`;
  return resolve(home, "apps/search/index");
}

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

function resolveInboxDir(opts: SearchPlaneHomeOpts = {}): string {
  if (process.env.SEARCH_INBOX?.trim()) return process.env.SEARCH_INBOX.trim();
  if (opts.searchHome) return resolve(opts.searchHome, "inbox");
  if (process.env.SEARCH_HOME?.trim()) {
    return resolve(process.env.SEARCH_HOME.trim(), "inbox");
  }
  const home =
    opts.lastDbHome ||
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
    `${process.env.HOME ?? ""}/.lastdb`;
  return resolve(home, "apps/search/inbox");
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
    env: { ...process.env, SEARCH_EMBEDDER: process.env.SEARCH_EMBEDDER ?? "deterministic" },
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
 * Query the Search plane (semantic preferred). Returns null when Search is
 * completely unavailable. Empty arrays mean plane up, no matches.
 */
export async function querySearchPlane(
  opts: SearchPlaneQueryOpts,
): Promise<SearchPlaneHit[] | null> {
  const verbose = opts.verbose ?? (() => {});

  // 1) Semantic in-process
  const sem = await querySemanticInProcess(opts);
  if (sem !== null) return sem;

  // 2) Semantic CLI
  const cli = querySemanticCli(opts);
  if (cli !== null) return cli;

  // 3) Keyword vendor / module fallback
  const modPath = resolveSearchModulePath();
  if (modPath) {
    try {
      const engMod = (await import(pathToFileURL(modPath).href)) as EngineModule;
      if (typeof engMod.openSearchEngine === "function") {
        const eng = engMod.openSearchEngine(resolveIndexDir(opts));
        const inboxPath = modPath.replace(/engine\.ts$/, "inbox.ts");
        if (opts.drain !== false && existsSync(inboxPath)) {
          const inboxMod = (await import(pathToFileURL(inboxPath).href)) as {
            drainInbox: (e: EngineHandle, d: string) => unknown;
          };
          inboxMod.drainInbox(eng, resolveInboxDir(opts));
        }
        const hits = eng.search(opts.query, {
          k: opts.k ?? 50,
          schemas: opts.schemas,
        });
        verbose(`search-plane: keyword fallback hits=${hits.length}`);
        return hits;
      }
    } catch (e) {
      verbose(
        `search-plane: keyword fallback failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  verbose("search-plane: unavailable");
  return null;
}

export async function searchPlaneStatus(
  opts: { lastDbHome?: string; searchHome?: string } = {},
): Promise<SearchPlaneStatus> {
  const bin = process.env.LASTDB_SEARCH_BIN?.trim() || "search";
  const args = ["vector-status"];
  if (opts.lastDbHome) args.push("--last-db-home", opts.lastDbHome);
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (r.status === 0) {
    try {
      const body = JSON.parse(r.stdout) as {
        vector?: { state?: string; vectors?: number };
        docs?: number;
        home?: string;
      };
      return {
        available: true,
        docs: body.vector?.vectors ?? body.docs,
        home: body.home,
        vector_state: body.vector?.state,
      };
    } catch {
      /* fall through */
    }
  }
  const modPath = resolveSearchModulePath();
  if (!modPath) {
    return {
      available: false,
      reason: "Search plane not found (semantic CLI or LASTDB_SEARCH_MODULE)",
    };
  }
  try {
    const engMod = (await import(pathToFileURL(modPath).href)) as EngineModule;
    const eng = engMod.openSearchEngine(resolveIndexDir(opts));
    return { available: true, docs: eng.size, home: resolveIndexDir(opts) };
  } catch (e) {
    return {
      available: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
