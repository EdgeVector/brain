// Unit tests for the tag secondary index (src/tag-index.ts) and the tag-filtered
// read paths that route through it (`list --tag`, `delete --tag`).
//
// The contract (per the fbrain-tag-secondary-index card):
//   1. Tag membership is backed by a per-tag TagIndex record; tag-filtered reads
//      resolve members through it (a point-read of the tag record + a point-read
//      per member) instead of scanning every record of the type(s).
//   2. Query cost scales with the tag's CARDINALITY, not the size of the type(s)
//      being scanned — proven by a perf test showing flat cost as the corpus
//      grows (the card's END STATE).
//   3. The scan path is retained as an index-miss fallback: no TagIndex schema
//      in config, or no index record for the tag, falls back to the full scan,
//      so correctness never depends on the index.
//   4. Writes maintain the index transactionally (create indexes, delete
//      unindexes, a re-put moves membership); a stale index entry is filtered
//      out by the read path's live-membership re-check.
//   5. `fbrain reindex --tags` rebuilds the whole index from a corpus scan.
//
// The mock node models fold_db's storage: a per-schema `slug → fields` store,
// with `queryAll` returning the whole schema (the O(rows) scan) and `queryByKey`
// returning just the keyed row (the flat O(1) point read, fold #905). Both are
// INSTRUMENTED with counters so the perf test can assert HOW MANY rows each tag
// query touched — that's the property the card is about.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryResponse, QueryRow } from "../../src/client.ts";
import type { Config } from "../../src/config.ts";
import {
  indexRecordTags,
  reconcileTagIndex,
  rebuildTagIndex,
  readTagIndex,
  resolveRecordsByTag,
  tagIndexSlug,
  unindexRecordTags,
} from "../../src/tag-index.ts";
import { findBySlugPointRead, schemaHashFor, TOMBSTONE_TAG, type FbrainRecord } from "../../src/record.ts";
import { TAG_INDEX_SCHEMA_KEY, type RecordType } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });

// Feature-OFF config: no TagIndex hash, so every index call is a no-op and every
// read path must fall back to the scan. buildTestCfg re-injects the tag-index
// hash for a non-empty schemaHashes override, so we delete it explicitly.
function cfgWithoutIndex(): Config {
  const c = buildTestCfg({ userHash: "uh" });
  const hashes = { ...c.schemaHashes };
  delete hashes[TAG_INDEX_SCHEMA_KEY];
  return { ...c, schemaHashes: hashes };
}

type RowFields = Record<string, unknown>;

type Counters = {
  queryAllCalls: number;
  queryAllRowsScanned: number; // total rows returned across all full scans
  queryByKeyCalls: number;
};

type MockState = {
  // schemaHash → slug → fields
  store: Map<string, Map<string, RowFields>>;
  counters: Counters;
};

function newState(): MockState {
  return {
    store: new Map(),
    counters: { queryAllCalls: 0, queryAllRowsScanned: 0, queryByKeyCalls: 0 },
  };
}

function seed(state: MockState, schemaHash: string, slug: string, fields: RowFields): void {
  if (!state.store.has(schemaHash)) state.store.set(schemaHash, new Map());
  state.store.get(schemaHash)!.set(slug, fields);
}

function mockNode(state: MockState): NodeClient {
  const node: NodeClient = {
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
    async listLoadedSchemas() {
      return [];
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      seed(state, schemaHash, keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      seed(state, schemaHash, keyHash, fields);
    },
    async deleteRecord() {
      // append-only no-op (the preceding update stamps the tombstone tag)
    },
    async queryAll({ schemaHash }): Promise<QueryResponse> {
      const rows = state.store.get(schemaHash);
      state.counters.queryAllCalls++;
      if (!rows) return { ok: true, results: [], total_count: 0, returned_count: 0 };
      state.counters.queryAllRowsScanned += rows.size;
      const results: QueryRow[] = [...rows.entries()].map(([hash, fields]) => ({
        fields,
        key: { hash, range: null },
      }));
      return { ok: true, results, total_count: results.length, returned_count: results.length };
    },
    async queryByKey({ schemaHash, keyHash }): Promise<QueryRow | null> {
      // The flat point read: touches exactly the keyed row, independent of how
      // many rows the schema holds (models fold #905 filter-aware reads).
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
  return node;
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

// Seed a concept record directly into the store AND index its tags — the state a
// real create leaves behind.
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

const conceptHash = TEST_HASHES.concept;

describe("tagIndexSlug", () => {
  test("is a reserved __tagidx__ hash key, distinct per tag, stable per tag", () => {
    const a = tagIndexSlug("papercut");
    const b = tagIndexSlug("incident");
    expect(a.startsWith("__tagidx__")).toBe(true);
    expect(a).not.toBe(b);
    expect(tagIndexSlug("papercut")).toBe(a); // deterministic
    // A user slug can never collide: validateSlug requires ^[a-z0-9], so a
    // leading underscore is impossible.
    expect(a).toMatch(/^__tagidx__[0-9a-f]{64}$/);
  });
});

describe("index maintenance (reconcileTagIndex / index / unindex)", () => {
  test("indexRecordTags then readTagIndex returns the member", async () => {
    const state = newState();
    const node = mockNode(state);
    await indexRecordTags(node, cfg, "concept", "c1", ["papercut", "friction"]);
    const idx = await readTagIndex(node, cfg, "papercut");
    expect(idx).not.toBeNull();
    expect(idx!.members).toEqual(["concept:c1"]);
    const idx2 = await readTagIndex(node, cfg, "friction");
    expect(idx2!.members).toEqual(["concept:c1"]);
    // A tag nobody carries is an index miss (null → caller scans).
    expect(await readTagIndex(node, cfg, "never-used")).toBeNull();
  });

  test("a re-put moves membership: added tag gains, dropped tag loses", async () => {
    const state = newState();
    const node = mockNode(state);
    await reconcileTagIndex(node, cfg, "concept", "c1", [], ["a", "b"]);
    // Now change tags a,b → b,c (drop a, keep b, add c).
    await reconcileTagIndex(node, cfg, "concept", "c1", ["a", "b"], ["b", "c"]);
    expect((await readTagIndex(node, cfg, "a"))!.members).toEqual([]); // dropped
    expect((await readTagIndex(node, cfg, "b"))!.members).toEqual(["concept:c1"]); // kept
    expect((await readTagIndex(node, cfg, "c"))!.members).toEqual(["concept:c1"]); // added
  });

  test("unindexRecordTags removes the record from every tag it carried", async () => {
    const state = newState();
    const node = mockNode(state);
    await indexRecordTags(node, cfg, "reference", "r1", ["x", "y"]);
    await unindexRecordTags(node, cfg, "reference", "r1", ["x", "y"]);
    expect((await readTagIndex(node, cfg, "x"))!.members).toEqual([]);
    expect((await readTagIndex(node, cfg, "y"))!.members).toEqual([]);
  });

  test("the tombstone tag is never indexed", async () => {
    const state = newState();
    const node = mockNode(state);
    await indexRecordTags(node, cfg, "concept", "c1", ["real", TOMBSTONE_TAG]);
    expect((await readTagIndex(node, cfg, "real"))!.members).toEqual(["concept:c1"]);
    expect(await readTagIndex(node, cfg, TOMBSTONE_TAG)).toBeNull();
  });

  test("feature OFF (no TagIndex hash): index maintenance is a silent no-op", async () => {
    const state = newState();
    const node = mockNode(state);
    const off = cfgWithoutIndex();
    await indexRecordTags(node, off, "concept", "c1", ["papercut"]);
    // Nothing was written to the (nonexistent) tag-index schema, and reads miss.
    expect(await readTagIndex(node, off, "papercut")).toBeNull();
  });
});

describe("resolveRecordsByTag (the read resolver)", () => {
  test("returns the live records carrying the tag", async () => {
    const state = newState();
    const node = mockNode(state);
    await seedIndexed(state, node, "concept", "c1", ["papercut"]);
    await seedIndexed(state, node, "reference", "r1", ["papercut"]);
    await seedIndexed(state, node, "concept", "c2", ["other"]);

    const out = await resolveRecordsByTag(node, cfg, "papercut", {
      findBySlug: (t, hash, slug) => findBySlugPointRead(node, t, hash, slug),
      schemaHashFor: (t) => schemaHashFor(t, cfg),
    });
    expect(out).not.toBeNull();
    const slugs = out!.map((r) => `${r.type}:${r.record.slug}`).sort();
    expect(slugs).toEqual(["concept:c1", "reference:r1"]);
  });

  test("index MISS (no record for the tag) returns null so the caller scans", async () => {
    const state = newState();
    const node = mockNode(state);
    const out = await resolveRecordsByTag(node, cfg, "unseen", {
      findBySlug: (t, hash, slug) => findBySlugPointRead(node, t, hash, slug),
      schemaHashFor: (t) => schemaHashFor(t, cfg),
    });
    expect(out).toBeNull();
  });

  test("a STALE index entry is filtered out (record deleted or tag removed)", async () => {
    const state = newState();
    const node = mockNode(state);
    // Index c1 under papercut, then simulate the record LOSING the tag WITHOUT
    // the index catching up (a dropped best-effort update): the store row no
    // longer carries `papercut`, but the index still lists it.
    await seedIndexed(state, node, "concept", "c1", ["papercut"]);
    seed(state, conceptHash, "c1", recordFields("c1", ["something-else"]));
    // And index c2 which was tombstoned in the store but still in the index.
    await indexRecordTags(node, cfg, "concept", "c2", ["papercut"]);
    seed(state, conceptHash, "c2", recordFields("c2", [TOMBSTONE_TAG]));

    const out = await resolveRecordsByTag(node, cfg, "papercut", {
      findBySlug: (t, hash, slug) => findBySlugPointRead(node, t, hash, slug),
      schemaHashFor: (t) => schemaHashFor(t, cfg),
    });
    // Neither stale entry surfaces — the live-membership re-check drops both.
    expect(out).toEqual([]);
  });
});

describe("rebuildTagIndex (fbrain reindex --tags)", () => {
  test("rebuilds the whole index from a corpus scan", async () => {
    const state = newState();
    const node = mockNode(state);
    // Seed records WITHOUT indexing (models a corpus written before the index).
    seed(state, conceptHash, "c1", recordFields("c1", ["a", "b"]));
    seed(state, conceptHash, "c2", recordFields("c2", ["a"]));
    seed(state, TEST_HASHES.reference, "r1", recordFields("r1", ["b"]));
    seed(state, conceptHash, "dead", recordFields("dead", [TOMBSTONE_TAG, "a"]));

    const res = await rebuildTagIndex(node, cfg, {
      listRecords: async (_type, hash) => {
        const rows = state.store.get(hash);
        if (!rows) return [];
        return [...rows.values()].map((f) => f as unknown as FbrainRecord);
      },
      schemaHashFor: (type) => schemaHashFor(type, cfg),
    });
    expect(res.tagsIndexed).toBe(2); // a, b (tombstoned "dead" excluded)
    expect((await readTagIndex(node, cfg, "a"))!.members.sort()).toEqual(["concept:c1", "concept:c2"]);
    expect((await readTagIndex(node, cfg, "b"))!.members.sort()).toEqual(["concept:c1", "reference:r1"]);
  });
});

// ── The END STATE: flat query cost as the corpus grows ──────────────────────
describe("PERF: tag query cost scales with tag cardinality, not corpus size", () => {
  // Build a corpus of `corpusSize` concept records of which exactly
  // `taggedCount` carry the target tag; measure how many record rows a
  // tag-filtered resolve TOUCHES. Via the index, cost is O(taggedCount) point
  // reads — flat as corpusSize grows. The scan path (feature OFF) is
  // O(corpusSize). We assert both to prove the index is what makes it flat.
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
      // Index membership when the feature is on (mirrors a real create).
      if (useIndex) await indexRecordTags(node, activeCfg, "concept", `c${i}`, tags);
    }
    // Reset the counters so we measure ONLY the query, not the setup writes.
    state.counters.queryAllCalls = 0;
    state.counters.queryAllRowsScanned = 0;
    state.counters.queryByKeyCalls = 0;

    let matched = 0;
    if (useIndex) {
      const out = await resolveRecordsByTag(node, activeCfg, "hot", {
        findBySlug: (t, hash, slug) => findBySlugPointRead(node, t, hash, slug),
        schemaHashFor: (t) => schemaHashFor(t, activeCfg),
      });
      matched = out!.length;
    } else {
      // Scan path: mirror what listCmd does on an index miss — sweep the type.
      const rows = state.store.get(conceptHash)!;
      let hits = 0;
      // A real scan reads every row via queryAll; model that read here.
      const res = await node.queryAll({ schemaHash: conceptHash, fields: [] });
      for (const r of res.results) {
        const tags = (r.fields as { tags?: string[] }).tags ?? [];
        if (tags.includes("hot")) hits++;
      }
      matched = hits;
      void rows;
    }
    return {
      rowsScanned: state.counters.queryAllRowsScanned,
      pointReads: state.counters.queryByKeyCalls,
      matched,
    };
  }

  test("INDEX path: same small cost at 10, 100, and 1000-record corpora", async () => {
    const TAGGED = 3; // fixed tag cardinality across all corpus sizes
    const small = await measure(10, TAGGED, true);
    const medium = await measure(100, TAGGED, true);
    const large = await measure(1000, TAGGED, true);

    // Correctness: every corpus size matches exactly the tagged records.
    expect(small.matched).toBe(TAGGED);
    expect(medium.matched).toBe(TAGGED);
    expect(large.matched).toBe(TAGGED);

    // FLAT COST: the index resolve never does a full-schema SCAN of the concept
    // records — zero rows scanned — regardless of corpus size.
    expect(small.rowsScanned).toBe(0);
    expect(medium.rowsScanned).toBe(0);
    expect(large.rowsScanned).toBe(0);

    // The point-read count is 1 (read the tag's index record) + one per member,
    // i.e. TAGGED + 1 — and is IDENTICAL across 10 / 100 / 1000 records. That
    // invariance (not the absolute number) is the defining flatness property:
    // cost tracks the tag's cardinality, never the corpus size.
    expect(small.pointReads).toBe(TAGGED + 1);
    expect(medium.pointReads).toBe(TAGGED + 1);
    expect(large.pointReads).toBe(TAGGED + 1);
    expect(small.pointReads).toBe(large.pointReads);
  });

  test("SCAN fallback: cost grows LINEARLY with corpus size (the thing the index fixes)", async () => {
    const TAGGED = 3;
    const small = await measure(10, TAGGED, false);
    const large = await measure(1000, TAGGED, false);
    // Same correct match count…
    expect(small.matched).toBe(TAGGED);
    expect(large.matched).toBe(TAGGED);
    // …but the scan touches EVERY record, so cost tracks corpus size, not the
    // 3 matches — 100× more rows at 1000 than at 10. This is the O(type size)
    // behavior the secondary index replaces.
    expect(small.rowsScanned).toBe(10);
    expect(large.rowsScanned).toBe(1000);
    expect(large.rowsScanned).toBeGreaterThan(small.rowsScanned * 50);
  });
});

// ── End-to-end through the real command paths (list --tag, delete --tag) ─────
// These drive `listCmd`/`deleteByFilter`, which build their OWN node client via
// `newReadClientFromCfg`/the write client, so we stub `globalThis.fetch` (the
// same pattern delete.test.ts / put.test.ts use) rather than injecting a mock
// node. The stub honors the `HashKey` filter — a point read returns only the
// keyed row — so it faithfully models the flat read the index relies on, and it
// tracks each `/api/query` request's filter so we can prove the tag path took
// point reads, not an unfiltered full scan.

type FetchStub = {
  restore: () => void;
  // Every /api/query request's `filter` field, in order.
  queryFilters: Array<unknown>;
  store: Map<string, Map<string, RowFields>>;
};

function stubFetchFrom(state: MockState): FetchStub {
  const original = globalThis.fetch;
  const queryFilters: Array<unknown> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/system/auto-identity")) {
      return json(200, { user_hash: "uh", provisioned: true });
    }
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      queryFilters.push(body.filter ?? null);
      const rows = state.store.get(body.schema_name as string);
      let entries = rows ? [...rows.entries()] : [];
      // Honor a HashKey filter → point read (only the keyed row).
      const filter = body.filter as { HashKey?: string } | null;
      if (filter && typeof filter.HashKey === "string") {
        entries = entries.filter(([hash]) => hash === filter.HashKey);
      }
      const results = entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
      return json(200, { ok: true, results, total_count: results.length, has_more: false });
    }
    if (url.endsWith("/api/mutation")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const schemaHash = body.schema as string;
      const keyHash = body.key_value?.hash as string;
      if (body.mutation_type === "create" || body.mutation_type === "update") {
        seed(state, schemaHash, keyHash, body.fields_and_values);
      }
      return json(200, { ok: true, success: true });
    }
    if (url.includes("/api/native-index/search")) {
      return json(200, { ok: true, results: [] });
    }
    return json(404, { error: "unexpected", url });
  }) as unknown as typeof globalThis.fetch;
  return { restore: () => { globalThis.fetch = original; }, queryFilters, store: state.store };
}

describe("end-to-end: list --tag / delete --tag route through the index", () => {
  // A cfg whose node URL is loopback so the read/write client uses the stubbed
  // fetch; enforcement off so writes don't need consent in the test.
  const e2eCfg = buildTestCfg({ userHash: "uh", nodeUrl: "http://127.0.0.1:9001" });
  const savedEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;

  async function seedCorpus(state: MockState): Promise<void> {
    // 5 concepts, 2 carry `hot`; index membership as a real create would.
    const node = mockNode(state); // reuse the counting mock only to seed+index
    for (let i = 0; i < 5; i++) {
      const tags = i < 2 ? ["hot"] : ["cold"];
      seed(state, conceptHash, `c${i}`, recordFields(`c${i}`, tags));
      await indexRecordTags(node, e2eCfg, "concept", `c${i}`, tags);
    }
  }

  test("list --tag returns exactly the tagged records and uses point reads (no unfiltered scan of the type)", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "off";
    const { listCmd } = await import("../../src/commands/list.ts");
    const state = newState();
    await seedCorpus(state);
    const stub = stubFetchFrom(state);
    try {
      let out = "";
      await listCmd({
        cfg: e2eCfg,
        tag: "hot",
        json: true,
        print: (l) => { out += l; },
        printErr: () => {},
      });
      const parsed = JSON.parse(out) as Array<{ slug: string; tags: string[] }>;
      expect(parsed.map((r) => r.slug).sort()).toEqual(["c0", "c1"]);
      // Every /api/query the tag path issued carried a HashKey filter (the index
      // record read + each member point read) — NOT one unfiltered full-schema
      // scan of the concept type. A `null` filter would be the legacy scan.
      expect(stub.queryFilters.length).toBeGreaterThan(0);
      for (const f of stub.queryFilters) {
        expect(f).toHaveProperty("HashKey");
      }
    } finally {
      stub.restore();
      if (savedEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
      else process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
    }
  });

  test("delete --tag (dry-run) previews exactly the tagged records via the index", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "off";
    const { deleteByFilter } = await import("../../src/commands/delete.ts");
    const state = newState();
    await seedCorpus(state);
    const stub = stubFetchFrom(state);
    try {
      let result: { deleted: Array<{ slug: string }>; dryRun: boolean } | null = null;
      await deleteByFilter({
        cfg: e2eCfg,
        tag: "hot",
        print: () => {},
        onResult: (p) => { result = p as typeof result; },
      });
      expect(result).not.toBeNull();
      expect(result!.dryRun).toBe(true);
      expect(result!.deleted.map((d) => d.slug).sort()).toEqual(["c0", "c1"]);
      // The resolve took the index (point reads), never an unfiltered scan.
      for (const f of stub.queryFilters) {
        expect(f).toHaveProperty("HashKey");
      }
    } finally {
      stub.restore();
      if (savedEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
      else process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
    }
  });

  test("index MISS falls back to the scan and still returns the right records", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "off";
    const { listCmd } = await import("../../src/commands/list.ts");
    // Feature ON in cfg, but seed the corpus WITHOUT indexing → no index record
    // for `hot` → the read path must fall back to the scan and still be correct.
    const state = newState();
    for (let i = 0; i < 4; i++) {
      seed(state, conceptHash, `c${i}`, recordFields(`c${i}`, i < 2 ? ["hot"] : ["cold"]));
    }
    const stub = stubFetchFrom(state);
    try {
      let out = "";
      await listCmd({
        cfg: e2eCfg,
        tag: "hot",
        json: true,
        print: (l) => { out += l; },
        printErr: () => {},
      });
      const parsed = JSON.parse(out) as Array<{ slug: string }>;
      expect(parsed.map((r) => r.slug).sort()).toEqual(["c0", "c1"]);
      // The fallback issued at least one UNFILTERED (null-filter) scan.
      expect(stub.queryFilters.some((f) => f === null)).toBe(true);
    } finally {
      stub.restore();
      if (savedEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
      else process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
    }
  });
});
