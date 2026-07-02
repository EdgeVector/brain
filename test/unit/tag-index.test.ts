import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryResponse, QueryRow } from "../../src/client.ts";
import type { Config } from "../../src/config.ts";
import { findBySlugPointRead, schemaHashFor, TOMBSTONE_TAG, type FbrainRecord } from "../../src/record.ts";
import { TAG_INDEX_SCHEMA_KEY, type RecordType } from "../../src/schemas.ts";
import {
  indexRecordTags,
  readTagIndex,
  rebuildTagIndex,
  reconcileTagIndex,
  resolveRecordsByTag,
  tagIndexSlug,
  unindexRecordTags,
} from "../../src/tag-index.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });
const conceptHash = TEST_HASHES.concept;

function cfgWithoutIndex(): Config {
  const c = buildTestCfg({ userHash: "uh" });
  const hashes = { ...c.schemaHashes };
  delete hashes[TAG_INDEX_SCHEMA_KEY];
  return { ...c, schemaHashes: hashes };
}

type RowFields = Record<string, unknown>;

type MockState = {
  store: Map<string, Map<string, RowFields>>;
  counters: {
    queryAllCalls: number;
    queryAllRowsScanned: number;
    queryByKeyCalls: number;
  };
};

function newState(): MockState {
  return {
    store: new Map(),
    counters: { queryAllCalls: 0, queryAllRowsScanned: 0, queryByKeyCalls: 0 },
  };
}

function seed(state: MockState, schemaHash: string, slug: string, fields: RowFields): void {
  let rows = state.store.get(schemaHash);
  if (!rows) {
    rows = new Map();
    state.store.set(schemaHash, rows);
  }
  rows.set(slug, fields);
}

function recordFields(slug: string, tags: string[], over: RowFields = {}): RowFields {
  return {
    slug,
    title: `T ${slug}`,
    body: "b",
    status: "active",
    tags,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function mockNode(state: MockState): NodeClient {
  return {
    baseUrl: "mock",
    userHash: "uh",
    async autoIdentity() {
      return { provisioned: true, userHash: "uh" };
    },
    async health() {
      return { ok: true, uptime_s: 1 };
    },
    async bootstrap() {
      return { userHash: "uh" };
    },
    async requestConsent() {
      return { status: 202, body: { request_id: "r" } };
    },
    async consentStatus() {
      return { status: 200, body: { status: "granted" } };
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async listLoadedSchemas() {
      return [];
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      seed(state, schemaHash, keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      seed(state, schemaHash, keyHash, fields);
    },
    async deleteRecord() {},
    async queryAll({ schemaHash }): Promise<QueryResponse> {
      state.counters.queryAllCalls++;
      const rows = state.store.get(schemaHash);
      if (!rows) return { ok: true, results: [], total_count: 0, returned_count: 0 };
      state.counters.queryAllRowsScanned += rows.size;
      const results: QueryRow[] = [...rows.entries()].map(([hash, fields]) => ({
        fields,
        key: { hash, range: null },
      }));
      return { ok: true, results, total_count: results.length, returned_count: results.length };
    },
    async queryByKey({ schemaHash, keyHash }): Promise<QueryRow | null> {
      state.counters.queryByKeyCalls++;
      const fields = state.store.get(schemaHash)?.get(keyHash);
      return fields ? { fields, key: { hash: keyHash, range: null } } : null;
    },
    async search() {
      return [];
    },
    async rawCall() {
      return { status: 200, headers: new Headers(), body: "", json: null };
    },
  };
}

async function seedIndexed(
  state: MockState,
  node: NodeClient,
  type: RecordType,
  slug: string,
  tags: string[],
): Promise<void> {
  seed(state, schemaHashFor(type, cfg), slug, recordFields(slug, tags));
  await indexRecordTags(node, cfg, type, slug, tags);
}

describe("tag secondary index", () => {
  test("uses reserved stable slugs for tag records", () => {
    expect(tagIndexSlug("papercut")).toMatch(/^__tagidx__[0-9a-f]{64}$/);
    expect(tagIndexSlug("papercut")).toBe(tagIndexSlug("papercut"));
    expect(tagIndexSlug("papercut")).not.toBe(tagIndexSlug("incident"));
  });

  test("maintains membership on add, move, and delete", async () => {
    const state = newState();
    const node = mockNode(state);

    await reconcileTagIndex(node, cfg, "concept", "c1", [], ["a", "b"]);
    await reconcileTagIndex(node, cfg, "concept", "c1", ["a", "b"], ["b", "c"]);
    expect((await readTagIndex(node, cfg, "a"))?.members).toEqual([]);
    expect((await readTagIndex(node, cfg, "b"))?.members).toEqual(["concept:c1"]);
    expect((await readTagIndex(node, cfg, "c"))?.members).toEqual(["concept:c1"]);

    await unindexRecordTags(node, cfg, "concept", "c1", ["b", "c"]);
    expect((await readTagIndex(node, cfg, "b"))?.members).toEqual([]);
    expect((await readTagIndex(node, cfg, "c"))?.members).toEqual([]);
  });

  test("filters stale index entries through live membership checks", async () => {
    const state = newState();
    const node = mockNode(state);

    await seedIndexed(state, node, "concept", "c1", ["hot"]);
    seed(state, conceptHash, "c1", recordFields("c1", ["cold"]));
    await indexRecordTags(node, cfg, "concept", "c2", ["hot"]);
    seed(state, conceptHash, "c2", recordFields("c2", [TOMBSTONE_TAG]));

    const out = await resolveRecordsByTag(node, cfg, "hot", {
      findBySlug: (type, hash, slug) => findBySlugPointRead(node, type, hash, slug),
      schemaHashFor: (type) => schemaHashFor(type, cfg),
    });
    expect(out).toEqual([]);
  });

  test("rebuilds the index from a corpus scan", async () => {
    const state = newState();
    const node = mockNode(state);
    seed(state, conceptHash, "c1", recordFields("c1", ["a", "b"]));
    seed(state, conceptHash, "c2", recordFields("c2", ["a"]));
    seed(state, TEST_HASHES.reference, "r1", recordFields("r1", ["b"]));
    seed(state, conceptHash, "dead", recordFields("dead", [TOMBSTONE_TAG, "a"]));

    const result = await rebuildTagIndex(node, cfg, {
      listRecords: async (_type, hash) => {
        const rows = state.store.get(hash);
        if (!rows) return [];
        return [...rows.values()] as unknown as FbrainRecord[];
      },
      schemaHashFor: (type) => schemaHashFor(type, cfg),
    });

    expect(result).toEqual({ tagsIndexed: 2, membersIndexed: 4 });
    expect((await readTagIndex(node, cfg, "a"))?.members.sort()).toEqual([
      "concept:c1",
      "concept:c2",
    ]);
    expect((await readTagIndex(node, cfg, "b"))?.members.sort()).toEqual([
      "concept:c1",
      "reference:r1",
    ]);
  });

  test("feature off returns index miss without writes", async () => {
    const state = newState();
    const node = mockNode(state);
    const off = cfgWithoutIndex();
    await indexRecordTags(node, off, "concept", "c1", ["hot"]);
    expect(await readTagIndex(node, off, "hot")).toBeNull();
  });
});

describe("PERF: tag query cost scales with tag cardinality, not corpus size", () => {
  async function measure(
    corpusSize: number,
    taggedCount: number,
    useIndex: boolean,
  ): Promise<{ rowsScanned: number; pointReads: number; matched: number }> {
    const state = newState();
    const node = mockNode(state);
    const activeCfg = useIndex ? cfg : cfgWithoutIndex();

    for (let i = 0; i < corpusSize; i++) {
      const tags = i < taggedCount ? ["hot"] : ["cold"];
      seed(state, conceptHash, `c${i}`, recordFields(`c${i}`, tags));
      if (useIndex) await indexRecordTags(node, activeCfg, "concept", `c${i}`, tags);
    }

    state.counters.queryAllCalls = 0;
    state.counters.queryAllRowsScanned = 0;
    state.counters.queryByKeyCalls = 0;

    let matched = 0;
    if (useIndex) {
      const out = await resolveRecordsByTag(node, activeCfg, "hot", {
        findBySlug: (type, hash, slug) => findBySlugPointRead(node, type, hash, slug),
        schemaHashFor: (type) => schemaHashFor(type, activeCfg),
      });
      matched = out?.length ?? 0;
    } else {
      const res = await node.queryAll({ schemaHash: conceptHash, fields: [] });
      matched = res.results.filter((row) => {
        const tags = (row.fields as { tags?: string[] }).tags ?? [];
        return tags.includes("hot");
      }).length;
    }

    return {
      rowsScanned: state.counters.queryAllRowsScanned,
      pointReads: state.counters.queryByKeyCalls,
      matched,
    };
  }

  test("index path has the same small cost at 10, 100, and 1000 records", async () => {
    const tagged = 3;
    const small = await measure(10, tagged, true);
    const medium = await measure(100, tagged, true);
    const large = await measure(1000, tagged, true);

    expect(small.matched).toBe(tagged);
    expect(medium.matched).toBe(tagged);
    expect(large.matched).toBe(tagged);
    expect(small.rowsScanned).toBe(0);
    expect(medium.rowsScanned).toBe(0);
    expect(large.rowsScanned).toBe(0);
    expect(small.pointReads).toBe(tagged + 1);
    expect(medium.pointReads).toBe(tagged + 1);
    expect(large.pointReads).toBe(tagged + 1);
  });

  test("scan fallback grows with corpus size", async () => {
    const tagged = 3;
    const small = await measure(10, tagged, false);
    const large = await measure(1000, tagged, false);

    expect(small.matched).toBe(tagged);
    expect(large.matched).toBe(tagged);
    expect(small.rowsScanned).toBe(10);
    expect(large.rowsScanned).toBe(1000);
  });
});
