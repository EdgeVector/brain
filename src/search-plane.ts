/**
 * Search plane client — primary path for brain ask/search plane retrieval.
 *
 * Resolution order for the engine module:
 *   1. LASTDB_SEARCH_MODULE — explicit path to engine.ts
 *   2. Vendor package at vendor/edgevector-search/src/engine.ts (shipped with brain)
 *   3. LASTDB_SEARCH_BIN CLI (`search query --json`)
 *
 * Does not call FastEmbed. Keyword plane only until Search adds optional
 * embeddings. When the plane is unavailable, returns null so callers keep
 * BM25 / node fallback instead of inventing capability failures.
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
  // src/search-plane.ts → package root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Resolve engine.ts for in-process Search plane (no worktree-name hardcoding). */
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
 * Empty arrays mean the plane is up but found nothing (callers may still
 * choose to fall back to node search).
 */
export async function querySearchPlane(
  opts: SearchPlaneQueryOpts,
): Promise<SearchPlaneHit[] | null> {
  const verbose = opts.verbose ?? (() => {});
  const engMod = await loadEngine();
  if (engMod) {
    try {
      const engPath = resolveSearchModulePath()!;
      const inboxPath = engPath.replace(/engine\.ts$/, "inbox.ts");
      const eng = engMod.openSearchEngine(resolveIndexDir(opts));
      if (opts.drain !== false && existsSync(inboxPath)) {
        const inboxMod = (await import(pathToFileURL(inboxPath).href)) as {
          drainInbox: (eng: EngineHandle, dir: string) => unknown;
        };
        inboxMod.drainInbox(eng, resolveInboxDir(opts));
      }
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
      reason:
        "Search engine not found (vendor/edgevector-search or LASTDB_SEARCH_MODULE)",
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
