// Unit tests for `fbrain ask` (G5 hybrid retrieval).
//
// The first test is the regression for the Stage-4 N+1: resolving fused
// hits used to call `listRecords` once per fused hit, even though each
// call returned every row at (type, schemaHash). On a real ask with
// top-5 across mixed types that meant 5 extra full-record-set HTTP
// round-trips after the corpus build had already loaded the same rows.
// Same shape as the PR #27 migrate fix.
//
// The fix reuses the live records produced by the corpus build, so
// resolve is in-memory and adds zero /api/query calls.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askCmd, docId, parseDocId } from "../../src/commands/ask.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const realFetch = globalThis.fetch;
let cacheDir = "";
let savedCacheEnv: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fbrain-ask-test-"));
  savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.FBRAIN_CACHE_DIR = cacheDir;
  // Belt + suspenders: even with noLlm:true the resolveAnthropicKey path
  // never runs, but clear the key so a developer with one set locally
  // can't accidentally turn this test into a live API call.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedCacheEnv === undefined) delete process.env.FBRAIN_CACHE_DIR;
  else process.env.FBRAIN_CACHE_DIR = savedCacheEnv;
  if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
  rmSync(cacheDir, { recursive: true, force: true });
});

type RowFields = Record<string, unknown>;

function designRow(slug: string, body: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `T-${slug}`,
    body,
    status: "draft",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function taskRow(slug: string, body: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `T-${slug}`,
    body,
    status: "open",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function noteRow(
  slug: string,
  kind: string,
  body: string,
  over: Partial<RowFields> = {},
): RowFields {
  return {
    slug,
    kind,
    title: `T-${slug}`,
    body,
    status: "active",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function vectorHit(opts: {
  schemaName: string;
  slug: string;
  score: number;
}): Record<string, unknown> {
  return {
    schema_name: opts.schemaName,
    schema_display_name: null,
    field: "body",
    key_value: { hash: opts.slug, range: null },
    value: "fragment",
    metadata: { score: opts.score, match_type: "semantic" },
  };
}

type Stub = {
  queryCountsBySchema: Map<string, number>;
  searchCalls: number;
};

function installFetchStub(opts: {
  // Records returned per /api/query, keyed by schema_name in the body.
  queries: Record<string, RowFields[]>;
  // Vector hits returned per /api/native-index/search call.
  vectorHits: Record<string, unknown>[];
}): Stub {
  const stub: Stub = {
    queryCountsBySchema: new Map(),
    searchCalls: 0,
  };
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.includes("/api/query")) {
      const schema = (body as { schema_name: string }).schema_name;
      stub.queryCountsBySchema.set(
        schema,
        (stub.queryCountsBySchema.get(schema) ?? 0) + 1,
      );
      const rows = opts.queries[schema] ?? [];
      return new Response(
        JSON.stringify({
          ok: true,
          results: rows.map((f) => ({ fields: f, key: { hash: f.slug, range: null } })),
          total_count: rows.length,
          returned_count: rows.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/native-index/search")) {
      stub.searchCalls++;
      return new Response(
        JSON.stringify({ ok: true, results: opts.vectorHits }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return stub;
}

describe("docId / parseDocId", () => {
  test("round-trips type and slug", () => {
    const id = docId("concept", "my-slug");
    expect(parseDocId(id)).toEqual({ type: "concept", slug: "my-slug" });
  });

  test("rejects malformed ids", () => {
    expect(parseDocId("noseparator")).toBeNull();
    expect(parseDocId("::orphan")).toBeNull();
    expect(parseDocId("bogus::slug")).toBeNull();
    expect(parseDocId("concept::")).toBeNull();
  });

  test("slugs with `::` inside survive the round-trip", () => {
    // parseDocId splits on the FIRST `::` so an embedded one in the slug
    // stays in the slug. Defensive: slugs are kebab-case per validateSlug
    // but the helper shouldn't silently mangle either way.
    const id = docId("concept", "weird::slug");
    expect(parseDocId(id)).toEqual({ type: "concept", slug: "weird::slug" });
  });
});

describe("askCmd resolve N+1 regression (Stage 4)", () => {
  test(
    "resolving 5 fused hits across 5 types makes ZERO extra /api/query calls beyond the corpus build",
    async () => {
      // Worst case for the old N+1: all six Phase 6 types share one
      // canonical hash, so the per-hit listRecords used to fetch the
      // same row set five times in a row (one per hit). Plus design and
      // task each have their own hash. With the fix, Stage 4 reuses the
      // FbrainRecord map built by the corpus pass — no extra round-trips.
      const sharedNoteHash = TEST_HASHES.concept;
      const cfg = buildTestCfg({
        schemaHashes: {
          ...TEST_HASHES,
          concept: sharedNoteHash,
          preference: sharedNoteHash,
          reference: sharedNoteHash,
          agent: sharedNoteHash,
          project: sharedNoteHash,
          spike: sharedNoteHash,
        },
      });

      // Five live records, one per type. All bodies share a common
      // token so a single BM25 query catches them all.
      const noteRows = [
        noteRow("c1", "concept", "octopus blueberry"),
        noteRow("p1", "preference", "octopus blueberry"),
        noteRow("r1", "reference", "octopus blueberry"),
        noteRow("a1", "agent", "octopus blueberry"),
        noteRow("pr1", "project", "octopus blueberry"),
      ];
      const designRows = [designRow("d1", "octopus blueberry")];
      const taskRows = [taskRow("t1", "octopus blueberry")];

      const stub = installFetchStub({
        queries: {
          [sharedNoteHash]: noteRows,
          [TEST_HASHES.design]: designRows,
          [TEST_HASHES.task]: taskRows,
        },
        vectorHits: [
          // Mirror BM25 hits so the vector ranker also contributes —
          // exercises the schema-hash → type → docId lookup path.
          vectorHit({ schemaName: sharedNoteHash, slug: "c1", score: 0.9 }),
          vectorHit({ schemaName: sharedNoteHash, slug: "p1", score: 0.8 }),
          vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.7 }),
          vectorHit({ schemaName: TEST_HASHES.task, slug: "t1", score: 0.6 }),
        ],
      });

      const result = await askCmd({
        cfg,
        query: "octopus",
        limit: 5,
        noLlm: true,
        print: () => {},
      });

      // Sanity: we resolved up to limit hits (no stale-skips on this corpus).
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.length).toBeLessThanOrEqual(5);

      // CRITICAL ASSERTION: total /api/query calls equal RECORD_TYPES.length.
      // The corpus build runs listRecords once per logical type. Stage 4
      // must add ZERO calls — anything more is the old N+1.
      //
      // Pre-fix behavior was 8 (corpus) + N (per fused hit) = 8 + min(limit,
      // fused.length). The regression assertion is the tight bound 8.
      const totalQueries = Array.from(stub.queryCountsBySchema.values()).reduce(
        (a, b) => a + b,
        0,
      );
      expect(totalQueries).toBe(RECORD_TYPES.length);

      // The shared note hash is the worst-case multiplier. Before the fix
      // it took the corpus calls (one per Phase 6 type = 6) PLUS one per
      // resolved Phase 6 hit. After the fix: exactly 6, no more.
      expect(stub.queryCountsBySchema.get(sharedNoteHash)).toBe(6);
      expect(stub.queryCountsBySchema.get(TEST_HASHES.design)).toBe(1);
      expect(stub.queryCountsBySchema.get(TEST_HASHES.task)).toBe(1);
    },
  );

  test("vector-only stale hit (slug absent from corpus) is skipped, no extra fetch", async () => {
    // The other Stage-4 responsibility is filtering stale hits — a slug
    // returned by the vector index that no longer exists as a live
    // record. With the in-memory map that's a simple map.get() miss; no
    // network call. Assert both: it's filtered out AND no extra query
    // fires.
    const cfg = buildTestCfg();
    const stub = installFetchStub({
      queries: {
        // No records anywhere — every type query returns [].
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "ghost", score: 0.9 }),
      ],
    });

    const result = await askCmd({
      cfg,
      query: "anything",
      noLlm: true,
      print: () => {},
    });

    expect(result.hits.length).toBe(0);
    // Eight corpus queries (one per RECORD_TYPE), nothing extra for the
    // ghost vector hit.
    const totalQueries = Array.from(stub.queryCountsBySchema.values()).reduce(
      (a, b) => a + b,
      0,
    );
    expect(totalQueries).toBe(RECORD_TYPES.length);
  });
});
