// Compound prevention: a BM25 rebuild must not replace a complete active
// corpus with a candidate whose type partition enumerates short while exact
// keyed reads still prove the omitted records are live.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeClient, QueryRow } from "../../src/client.ts";
import {
  loadCachedIndex,
  loadOrBuildBm25Index,
} from "../../src/retrieval/bm25.ts";
import {
  TEST_RECORD_LIST_ENTRY_HASH,
  buildTestCfg,
  typeListIndexPartitionRows,
} from "../util.ts";

const TYPES = ["preference", "reference"] as const;

const preferenceFields = {
  slug: "preference-search-reachability",
  title: "Search must preserve preference reachability",
  body: "distinctive narwhal sentence proves preference body retrieval",
  status: "active",
  tags: [],
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

const referenceFields = {
  slug: "reference-search-control",
  title: "Search reachability control record",
  body: "distinctive wombat sentence proves control body retrieval",
  status: "active",
  tags: [],
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

let cacheDir = "";
let savedCacheEnv: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "brain-search-reachability-"));
  savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
  process.env.FBRAIN_CACHE_DIR = cacheDir;
});

afterEach(() => {
  if (savedCacheEnv === undefined) delete process.env.FBRAIN_CACHE_DIR;
  else process.env.FBRAIN_CACHE_DIR = savedCacheEnv;
  rmSync(cacheDir, { recursive: true, force: true });
});

function inconsistentListNode(state: { omitPreferenceFromPartition: boolean }): NodeClient {
  const fieldsByType: Record<(typeof TYPES)[number], Array<Record<string, unknown>>> = {
    preference: [preferenceFields],
    reference: [referenceFields],
  };

  return {
    async queryAll(args: {
      schemaHash: string;
      filter?: {
        HashKey?: unknown;
        HashRangeKey?: { hash?: unknown; range?: unknown };
      };
    }) {
      expect(args.schemaHash).toBe(TEST_RECORD_LIST_ENTRY_HASH);
      const exact = args.filter?.HashRangeKey;
      if (typeof exact?.hash === "string" && typeof exact.range === "string") {
        const type = exact.hash as (typeof TYPES)[number];
        // The incident shape: the partition enumeration below can omit the
        // preference while this exact keyed lookup still proves it is live.
        const rows = typeListIndexPartitionRows(type, fieldsByType[type] ?? []);
        const match = rows.find((row) => row.key.range === exact.range);
        return queryResult(match ? [match] : []);
      }

      const type = args.filter?.HashKey as (typeof TYPES)[number];
      const fields =
        type === "preference" && state.omitPreferenceFromPartition
          ? []
          : fieldsByType[type] ?? [];
      return queryResult(typeListIndexPartitionRows(type, fields));
    },
  } as unknown as NodeClient;
}

function queryResult(rows: QueryRow[]) {
  return {
    results: rows,
    total_count: rows.length,
    returned_count: rows.length,
  };
}

function expectReachable(index: NonNullable<ReturnType<typeof loadCachedIndex>>) {
  expect(index.search("preserve preference reachability", 5).map((hit) => hit.slug)).toContain(
    preferenceFields.slug,
  );
  expect(index.search("distinctive narwhal sentence", 5).map((hit) => hit.slug)).toContain(
    preferenceFields.slug,
  );
  expect(index.search("control record", 5).map((hit) => hit.slug)).toContain(
    referenceFields.slug,
  );
  expect(index.search("distinctive wombat sentence", 5).map((hit) => hit.slug)).toContain(
    referenceFields.slug,
  );
}

describe("BM25 candidate activation reachability gate", () => {
  test("rejects a type-omitting candidate, preserves the active cache, then accepts a repaired rebuild", async () => {
    const cfg = buildTestCfg();
    const state = { omitPreferenceFromPartition: false };
    const node = inconsistentListNode(state);

    const initial = await loadOrBuildBm25Index(node, cfg, TYPES, {
      forceRebuild: true,
    });
    expect(initial.corpusSize).toBe(2);
    expectReachable(initial.index);

    state.omitPreferenceFromPartition = true;
    await expect(
      loadOrBuildBm25Index(node, cfg, TYPES, { forceRebuild: true }),
    ).rejects.toThrow("candidate omitted live preference record");

    // Candidate activation is atomic: the last complete cache is still the
    // persisted active cache and both title/body probes remain top-k reachable.
    const preserved = loadCachedIndex(cfg.userHash, TYPES);
    expect(preserved).not.toBeNull();
    expectReachable(preserved!);

    state.omitPreferenceFromPartition = false;
    const repaired = await loadOrBuildBm25Index(node, cfg, TYPES, {
      forceRebuild: true,
    });
    expect(repaired.corpusSize).toBe(2);
    expectReachable(repaired.index);

    const manifest = repaired.index.toJSON();
    expect(manifest.requestedTypes).toEqual([...TYPES]);
    expect(manifest.typeCounts).toEqual({ preference: 1, reference: 1 });
  });
});
