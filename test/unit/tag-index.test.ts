import { describe, expect, test } from "bun:test";

import {
  FbrainError,
  type NodeClient,
  type QueryResponse,
  type QueryRow,
} from "../../src/client.ts";
import type { Config } from "../../src/config.ts";
import { findBySlug, schemaHashFor, TOMBSTONE_TAG, type FbrainRecord } from "../../src/record.ts";
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
    createRecordCalls: number;
    queryAllCalls: number;
    queryAllRowsScanned: number;
    queryByKeyCalls: number;
    updateRecordCalls: number;
  };
};

function newState(): MockState {
  return {
    store: new Map(),
    counters: {
      createRecordCalls: 0,
      queryAllCalls: 0,
      queryAllRowsScanned: 0,
      queryByKeyCalls: 0,
      updateRecordCalls: 0,
    },
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
      state.counters.createRecordCalls++;
      if (state.store.get(schemaHash)?.has(keyHash)) {
        throw new FbrainError({
          code: "node_http_409",
          message: `Record already exists: ${keyHash}`,
        });
      }
      seed(state, schemaHash, keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      state.counters.updateRecordCalls++;
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

  test("concurrent same-tag creates retry after collision and keep both members", async () => {
    const state = newState();
    const base = mockNode(state);
    const tagSlug = tagIndexSlug("hot");
    let createAttempts = 0;
    let createConflicts = 0;
    const pendingCreates: Array<() => void> = [];
    const node: NodeClient = {
      ...base,
      async createRecord(args) {
        if (args.keyHash === tagSlug) {
          createAttempts++;
          await new Promise<void>((resolve) => {
            pendingCreates.push(resolve);
            if (pendingCreates.length === 2) {
              for (const release of pendingCreates) release();
            }
          });
        }
        try {
          await base.createRecord(args);
        } catch (err) {
          createConflicts++;
          throw err;
        }
      },
    };

    await Promise.all([
      reconcileTagIndex(node, cfg, "concept", "c1", [], ["hot"]),
      reconcileTagIndex(node, cfg, "concept", "c2", [], ["hot"]),
    ]);

    expect(createAttempts).toBe(2);
    expect(createConflicts).toBe(1);
    expect((await readTagIndex(node, cfg, "hot"))?.members).toEqual([
      "concept:c1",
      "concept:c2",
    ]);

    seed(state, conceptHash, "c1", recordFields("c1", ["hot"]));
    seed(state, conceptHash, "c2", recordFields("c2", ["hot"]));
    const writesBeforeRebuild =
      state.counters.createRecordCalls + state.counters.updateRecordCalls;
    const rebuilt = await rebuildTagIndex(node, cfg, {
      listRecords: async (_type, hash) => {
        const rows = state.store.get(hash);
        if (!rows) return [];
        return [...rows.values()] as unknown as FbrainRecord[];
      },
      schemaHashFor: (type) => schemaHashFor(type, cfg),
    });

    expect(rebuilt).toEqual({ tagsIndexed: 1, membersIndexed: 2 });
    expect(state.counters.createRecordCalls + state.counters.updateRecordCalls).toBe(
      writesBeforeRebuild,
    );
  });

  test("reconcile continues sibling tags after one tag update fails", async () => {
    const state = newState();
    const base = mockNode(state);
    const lines: string[] = [];
    const node: NodeClient = {
      ...base,
      async createRecord(args) {
        if ((args.fields as { tag?: string }).tag === "bad") {
          throw new FbrainError({
            code: "injected_tag_failure",
            message: "boom",
          });
        }
        await base.createRecord(args);
      },
    };

    await reconcileTagIndex(
      node,
      cfg,
      "concept",
      "c1",
      [],
      ["bad", "good"],
      (line) => lines.push(line),
    );

    expect(await readTagIndex(node, cfg, "bad")).toBeNull();
    expect((await readTagIndex(node, cfg, "good"))?.members).toEqual(["concept:c1"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 tag update(s) failed");
    expect(lines[0]).toContain("add:bad:boom");
  });

  test("reads string-encoded tag-index members like other string-array fields", async () => {
    const state = newState();
    const node = mockNode(state);
    seed(state, cfg.schemaHashes[TAG_INDEX_SCHEMA_KEY]!, tagIndexSlug("hot"), {
      slug: tagIndexSlug("hot"),
      tag: "hot",
      members: "concept:c2, concept:c1, ,",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    });

    expect((await readTagIndex(node, cfg, "hot"))?.members).toEqual([
      "concept:c2",
      "concept:c1",
    ]);
  });

  test("filters stale index entries through live membership checks", async () => {
    const state = newState();
    const node = mockNode(state);

    await seedIndexed(state, node, "concept", "c1", ["hot"]);
    seed(state, conceptHash, "c1", recordFields("c1", ["cold"]));
    await indexRecordTags(node, cfg, "concept", "c2", ["hot"]);
    seed(state, conceptHash, "c2", recordFields("c2", [TOMBSTONE_TAG]));

    const out = await resolveRecordsByTag(node, cfg, "hot", {
      findBySlug: (type, hash, slug) => findBySlug(node, type, hash, slug),
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

  test("rebuild skips stale registered schema hashes", async () => {
    const state = newState();
    const node = mockNode(state);
    seed(state, conceptHash, "c1", recordFields("c1", ["a"]));
    const staleDecisionHash = "0".repeat(64);
    const activeCfg = buildTestCfg({
      userHash: "uh",
      schemaHashes: { ...TEST_HASHES, decision: staleDecisionHash },
    });
    const skipped: RecordType[] = [];

    const result = await rebuildTagIndex(node, activeCfg, {
      listRecords: async (type, hash) => {
        if (type === "decision" && hash === staleDecisionHash) {
          throw new FbrainError({
            code: "node_http_404",
            message: `Node /api/query returned HTTP 404: Schema not found: ${hash}.`,
          });
        }
        const rows = state.store.get(hash);
        if (!rows) return [];
        return [...rows.values()] as unknown as FbrainRecord[];
      },
      schemaHashFor: (type) => schemaHashFor(type, activeCfg),
      onSkipUnavailableType: (type) => skipped.push(type),
    });

    expect(result).toEqual({ tagsIndexed: 1, membersIndexed: 1 });
    expect(skipped).toEqual(["decision"]);
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
        findBySlug: (type, hash, slug) => findBySlug(node, type, hash, slug),
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
