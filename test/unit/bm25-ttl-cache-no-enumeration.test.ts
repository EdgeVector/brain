// Pins: warm BM25 load never enumerates keys/bodies (TTL freshness).
// Card: brain-search-drop-per-query-corpus-enumeration.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isBm25CacheFresh,
  loadOrBuildBm25Index,
  saveCachedIndex,
  BM25Index,
  type BM25Document,
} from "../../src/retrieval/bm25.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";
import type { NodeClient } from "../../src/client.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";

let cacheDir = "";
let savedCacheEnv: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "bm25-ttl-"));
  savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
  process.env.FBRAIN_CACHE_DIR = cacheDir;
});

afterEach(() => {
  if (savedCacheEnv === undefined) delete process.env.FBRAIN_CACHE_DIR;
  else process.env.FBRAIN_CACHE_DIR = savedCacheEnv;
  rmSync(cacheDir, { recursive: true, force: true });
});

function countingNode(): NodeClient & { queryAllCalls: number } {
  const node = {
    queryAllCalls: 0,
    async listRecordKeys() {
      node.queryAllCalls++;
      return { keys: [{ hash: "d1" }], nextCursor: null, hasMore: false };
    },
    async queryByKey() {
      node.queryAllCalls++;
      return {
        fields: {
          slug: "d1",
          title: "T-d1",
          body: "octopus",
          status: "draft",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        key: { hash: "d1", range: null },
      };
    },
    async queryAll() {
      node.queryAllCalls++;
      return {
        results: [
          {
            fields: {
              slug: "d1",
              title: "T-d1",
              body: "octopus",
              status: "draft",
              tags: [],
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            key: { hash: "d1", range: null },
          },
        ],
        total_count: 1,
        returned_count: 1,
      };
    },
  } as unknown as NodeClient & { queryAllCalls: number };
  return node;
}

describe("isBm25CacheFresh", () => {
  test("fresh within TTL, stale after", () => {
    const now = 1_000_000;
    expect(isBm25CacheFresh(now - 1000, now, 15_000)).toBe(true);
    expect(isBm25CacheFresh(now - 20_000, now, 15_000)).toBe(false);
    expect(isBm25CacheFresh(now - 1, now, 0)).toBe(false);
  });
});

describe("loadOrBuildBm25Index TTL warm path", () => {
  test("second load within TTL issues zero queryAll (no key/body enumeration)", async () => {
    const cfg = buildTestCfg();
    // Restrict to design so the cold rebuild only drains one type's hash.
    const types = ["design"] as const;
    const node = countingNode();

    const cold = await loadOrBuildBm25Index(node, cfg, types, {
      seedListIndex: false,
      ttlMs: 60_000,
    });
    expect(cold.cacheHit).toBe(false);
    expect(cold.corpusSize).toBeGreaterThan(0);
    const coldCalls = node.queryAllCalls;
    expect(coldCalls).toBeGreaterThan(0);

    node.queryAllCalls = 0;
    const warm = await loadOrBuildBm25Index(node, cfg, types, {
      seedListIndex: false,
      ttlMs: 60_000,
    });
    expect(warm.cacheHit).toBe(true);
    expect(node.queryAllCalls).toBe(0);
    expect(warm.fingerprint).toBe(cold.fingerprint);
  });

  test("forceRebuild ignores TTL and re-enumerates", async () => {
    const cfg = buildTestCfg();
    const types = ["design"] as const;
    const node = countingNode();
    await loadOrBuildBm25Index(node, cfg, types, {
      seedListIndex: false,
      ttlMs: 60_000,
    });
    node.queryAllCalls = 0;
    const forced = await loadOrBuildBm25Index(node, cfg, types, {
      seedListIndex: false,
      ttlMs: 60_000,
      forceRebuild: true,
    });
    expect(forced.cacheHit).toBe(false);
    expect(node.queryAllCalls).toBeGreaterThan(0);
  });

  test("expired TTL rebuilds", async () => {
    const cfg = buildTestCfg();
    const types = ["design"] as const;
    const node = countingNode();
    const t0 = Date.now();
    await loadOrBuildBm25Index(node, cfg, types, {
      seedListIndex: false,
      ttlMs: 5_000,
      nowMs: t0,
    });
    node.queryAllCalls = 0;
    // Advance the virtual clock past TTL; builtAt is ~t0 from generatedAt.
    const stale = await loadOrBuildBm25Index(node, cfg, types, {
      seedListIndex: false,
      ttlMs: 5_000,
      nowMs: t0 + 10_000,
    });
    expect(stale.cacheHit).toBe(false);
    expect(node.queryAllCalls).toBeGreaterThan(0);
  });
});

// Silence unused imports if tree-shaken oddly
void RECORD_TYPES;
void TEST_HASHES;
void saveCachedIndex;
void BM25Index;
void (null as unknown as BM25Document);
