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

describe("askCmd expansion failure observability (--explain)", () => {
  test(
    "expansion fetch throws → AskResult carries failure reason and --explain prints it",
    async () => {
      // Pre-fix: a failed expansion was indistinguishable from --no-llm in
      // --explain output (expansion=null, no expansions list). This test
      // pins both halves of the fix: the structured status on AskResult,
      // and the new --explain line that surfaces the reason.
      const cfg = buildTestCfg();
      installFetchStub({
        queries: {
          // Empty corpus — we only care about the expansion path.
        },
        vectorHits: [],
      });
      // resolveAnthropicKey() must return truthy so askCmd actually
      // attempts the expansion (and hits our throwing fetchImpl). The
      // afterEach restores the developer's real key.
      process.env.ANTHROPIC_API_KEY = "test-key-not-real";

      const printed: string[] = [];
      const throwingFetch = (async () => {
        throw new Error("simulated network outage");
      }) as unknown as typeof fetch;

      const result = await askCmd({
        cfg,
        query: "anything",
        explain: true,
        print: (line) => printed.push(line),
        fetchImpl: throwingFetch,
      });

      // Structured status: caller can programmatically distinguish failure
      // from --no-llm / no-key.
      expect(result.expansionStatus.kind).toBe("failed");
      if (result.expansionStatus.kind === "failed") {
        // ExpansionError wraps the underlying error message — assert the
        // root cause survives so the operator can actually diagnose.
        expect(result.expansionStatus.reason).toContain("simulated network outage");
      }
      // Existing fields stay coherent: expansion stays null (no successful
      // result), expansions list stays empty.
      expect(result.expansion).toBeNull();
      expect(result.expansions).toEqual([]);

      // --explain branch surfaces the reason on its own line. Match a
      // literal prefix so this doesn't depend on the wrap format.
      const explainLine = printed.find((l) => l.startsWith("expansion failed:"));
      expect(explainLine).toBeDefined();
      expect(explainLine).toContain("simulated network outage");
    },
  );

  test("--no-llm path reports kind='disabled', not 'failed'", async () => {
    // Negative control: --no-llm must NOT look like a failure. Keeps the
    // discriminator honest if someone later collapses the branches.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const result = await askCmd({
      cfg,
      query: "anything",
      noLlm: true,
      explain: true,
      print: () => {},
    });

    expect(result.expansionStatus.kind).toBe("disabled");
    expect(result.expansion).toBeNull();
  });

  test("--no-llm + --explain prints a 'disabled' notice so --explain isn't a no-op", async () => {
    // Pre-fix bug: running `ask --no-llm --explain` printed exactly the
    // same lines as `ask --no-llm` (because the only --explain emit paths
    // were the failure-reason print and the expansions list, both of which
    // are quiet when --no-llm is on). An operator debugging with --explain
    // had no signal that expansions were intentionally off.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const printed: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      noLlm: true,
      explain: true,
      print: (line) => printed.push(line),
    });

    expect(printed.some((l) => l.includes("LLM disabled via --no-llm"))).toBe(true);
  });

  test("--no-llm WITHOUT --explain stays quiet about the disabled status", async () => {
    // Bookend the previous test: confirm we only emit the explanation
    // line when --explain is set, so users who don't ask for the debug
    // surface don't get a new line of chatter on every offline run.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const printed: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      noLlm: true,
      print: (line) => printed.push(line),
    });

    expect(printed.some((l) => l.includes("LLM disabled via --no-llm"))).toBe(false);
  });

  test("--explain with no ANTHROPIC_API_KEY prints a no-key notice", async () => {
    // Third branch of the fix: when the key is absent we already print a
    // top-of-run `note:` line, but --explain should ALSO drop its own
    // honest stub so the explain section is non-empty and self-consistent
    // across all four expansionStatus kinds.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });
    // beforeEach already deletes ANTHROPIC_API_KEY — assert we're really
    // in the no-key branch and not the disabled one.
    delete process.env.ANTHROPIC_API_KEY;

    const printed: string[] = [];
    const result = await askCmd({
      cfg,
      query: "anything",
      explain: true,
      print: (line) => printed.push(line),
    });

    expect(result.expansionStatus.kind).toBe("no-key");
    expect(printed.some((l) => l.includes("ANTHROPIC_API_KEY not set"))).toBe(true);
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

  test("all-stopword query emits a notice and returns zero hits when nothing else hits", async () => {
    // Regression for the silent-empty case: `fbrain ask 'the and or'`
    // used to return zero rows with no log, no notice, no --verbose
    // surface, because the BM25 tokenizer dropped every term and the
    // vector ranker had nothing to offer. The pipeline now emits a
    // one-line print() notice when the ORIGINAL query produced zero
    // BM25 tokens AND the vector ranker returned nothing — so the user
    // sees "why am I getting nothing" instead of an empty silence.
    const cfg = buildTestCfg();
    installFetchStub({
      // No live records anywhere; vector stub returns nothing either.
      queries: {},
      vectorHits: [],
    });

    const lines: string[] = [];
    const result = await askCmd({
      cfg,
      query: "the and or",
      noLlm: true,
      print: (line) => lines.push(line),
    });

    expect(result.hits.length).toBe(0);
    expect(
      lines.some((l) => l.includes("query tokenized to zero terms")),
    ).toBe(true);
  });

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
