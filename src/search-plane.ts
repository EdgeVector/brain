/**
 * Search plane client — primary path for brain ask/search vector-ish retrieval.
 *
 * Uses the first-party Search app (`@edgevector/search` / `search` CLI):
 *   - LASTDB_SEARCH_MODULE: path to engine.ts for in-process openSearchEngine
 *   - LASTDB_SEARCH_BIN: path to search CLI (default: "search" on PATH)
 *   - SEARCH_HOME / LASTDB_HOME: index + inbox roots
 *
 * Does not call FastEmbed. Keyword plane only until Search adds optional
 * embeddings. When the plane is unavailable, returns null so callers keep
 * BM25 / degraded notes instead of inventing capability failures.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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
  /** Drain inbox before query (default true). */
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
};

type EngineModule = {
  openSearchEngine: (indexDir: string) => {
    search: (
      q: string,
      opts?: { k?: number; schemas?: string[] },
    ) => SearchPlaneHit[];
    size: number;
    persist: () => void;
    applyChangeBatch: (b: unknown) => number;
  };
};

function resolveSearchModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  // Sibling worktree / install layout when running from a brain checkout.
  const candidates = [
    resolve(
      import.meta.dirname,
      "../../search-kanban-search-as-app-implement/src/engine.ts",
    ),
    resolve(
      import.meta.dirname,
      "../../../search-kanban-search-as-app-implement/src/engine.ts",
    ),
    resolve(import.meta.dirname, "../../../../search/src/engine.ts"),
    resolve(process.cwd(), "../search/src/engine.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function loadEngine(): Promise<EngineModule | null> {
  const modPath = resolveSearchModulePath();
  if (!modPath) return null;
  try {
    const mod = (await import(pathToFileURL(modPath).href)) as EngineModule;
    if (typeof mod.openSearchEngine !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

function resolveIndexDir(opts: SearchPlaneQueryOpts): string {
  if (process.env.SEARCH_INDEX_DIR?.trim()) {
    return process.env.SEARCH_INDEX_DIR.trim();
  }
  if (opts.searchHome) {
    return resolve(opts.searchHome, "index");
  }
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

function resolveInboxDir(opts: SearchPlaneQueryOpts): string {
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

/**
 * Query the Search plane. Returns null when Search is not installed / cannot
 * open — callers must not treat that as "zero hits".
 */
export async function querySearchPlane(
  opts: SearchPlaneQueryOpts,
): Promise<SearchPlaneHit[] | null> {
  const verbose = opts.verbose ?? (() => {});
  const engMod = await loadEngine();
  if (engMod) {
    try {
      // Drain inbox via dynamic import of inbox module next to engine.
      const engPath = resolveSearchModulePath()!;
      const inboxPath = engPath.replace(/engine\.ts$/, "inbox.ts");
      if (opts.drain !== false && existsSync(inboxPath)) {
        const inboxMod = (await import(pathToFileURL(inboxPath).href)) as {
          drainInbox: (
            eng: ReturnType<EngineModule["openSearchEngine"]>,
            dir: string,
          ) => unknown;
        };
        const eng = engMod.openSearchEngine(resolveIndexDir(opts));
        inboxMod.drainInbox(eng, resolveInboxDir(opts));
        const hits = eng.search(opts.query, {
          k: opts.k ?? 50,
          schemas: opts.schemas,
        });
        verbose(
          `search-plane: in-process query hits=${hits.length} docs=${eng.size}`,
        );
        return hits;
      }
      const eng = engMod.openSearchEngine(resolveIndexDir(opts));
      const hits = eng.search(opts.query, {
        k: opts.k ?? 50,
        schemas: opts.schemas,
      });
      verbose(
        `search-plane: in-process query hits=${hits.length} docs=${eng.size}`,
      );
      return hits;
    } catch (e) {
      verbose(
        `search-plane: in-process failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // CLI fallback
  const bin = process.env.LASTDB_SEARCH_BIN?.trim() || "search";
  const args = ["query", opts.query, "--json", "--k", String(opts.k ?? 50)];
  for (const s of opts.schemas ?? []) {
    args.push("--schema", s);
  }
  if (opts.lastDbHome) {
    args.push("--last-db-home", opts.lastDbHome);
  } else if (process.env.LASTDB_HOME?.trim()) {
    args.push("--last-db-home", process.env.LASTDB_HOME.trim());
  }
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (r.error || r.status !== 0) {
    verbose(
      `search-plane: CLI unavailable (${r.error?.message ?? `exit ${r.status}`})`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(r.stdout) as { hits?: SearchPlaneHit[] };
    return Array.isArray(parsed.hits) ? parsed.hits : [];
  } catch {
    verbose("search-plane: CLI returned non-JSON");
    return null;
  }
}

export async function searchPlaneStatus(
  opts: { lastDbHome?: string; searchHome?: string } = {},
): Promise<SearchPlaneStatus> {
  const engMod = await loadEngine();
  if (!engMod) {
    return {
      available: false,
      reason: "Search engine module not found (set LASTDB_SEARCH_MODULE)",
    };
  }
  try {
    const eng = engMod.openSearchEngine(resolveIndexDir(opts));
    return {
      available: true,
      docs: eng.size,
      home: resolveIndexDir(opts),
    };
  } catch (e) {
    return {
      available: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
