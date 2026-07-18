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
import {
  appSearchAsLegacyNativeIndex,
  legacySearchResponseBody,
  buildTestCfg,
  TEST_HASHES,
} from "../util.ts";

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
  // Subset of the above counting only BODY-BEARING queries (the `fields`
  // projection includes "body"). The cache-aware corpus load issues a cheap
  // body-LESS listing on every call and a full body fetch only on a cache
  // miss, so this is the meter the perf cut moves: a warm `ask` over an
  // unchanged corpus must add ZERO to it.
  bodyQueryCountsBySchema: Map<string, number>;
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
    bodyQueryCountsBySchema: new Map(),
    searchCalls: 0,
  };
  const persistedRows = new Map<string, Map<string, Record<string, unknown>>>();
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : String(input);
    const appSearch = appSearchAsLegacyNativeIndex(rawUrl, init);
    const url = appSearch?.url ?? rawUrl;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.includes("/api/query")) {
      const schema = (body as { schema_name: string }).schema_name;
      stub.queryCountsBySchema.set(
        schema,
        (stub.queryCountsBySchema.get(schema) ?? 0) + 1,
      );
      const fields = (body as { fields?: unknown }).fields;
      if (Array.isArray(fields) && fields.includes("body")) {
        stub.bodyQueryCountsBySchema.set(
          schema,
          (stub.bodyQueryCountsBySchema.get(schema) ?? 0) + 1,
        );
      }
      const filter = (body as { filter?: { HashKey?: unknown } }).filter;
      const keyHash = typeof filter?.HashKey === "string" ? filter.HashKey : "";
      const persisted = keyHash ? persistedRows.get(schema)?.get(keyHash) : undefined;
      const rows = persisted ? [persisted] : (opts.queries[schema] ?? []);
      return new Response(
        JSON.stringify({
          ok: true,
          results: rows.map((f) => ({
            fields: f,
            key: { hash: f.slug ?? f.key, range: null },
          })),
          total_count: rows.length,
          returned_count: rows.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/api/mutation")) {
      const mutation = body as {
        schema?: string;
        fields_and_values?: Record<string, unknown>;
        key_value?: { hash?: unknown };
      };
      const schema = typeof mutation.schema === "string" ? mutation.schema : "";
      const keyHash = typeof mutation.key_value?.hash === "string" ? mutation.key_value.hash : "";
      if (schema && keyHash && mutation.fields_and_values) {
        const byKey = persistedRows.get(schema) ?? new Map<string, Record<string, unknown>>();
        byKey.set(keyHash, mutation.fields_and_values);
        persistedRows.set(schema, byKey);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/native-index/search")) {
      stub.searchCalls++;
      return new Response(
        JSON.stringify(legacySearchResponseBody({ ok: true, results: opts.vectorHits }, appSearch)),
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
      const stderr: string[] = [];
      const throwingFetch = (async () => {
        throw new Error("simulated network outage");
      }) as unknown as typeof fetch;

      const result = await askCmd({
        cfg,
        query: "anything",
        expand: true,
        explain: true,
        print: (line) => printed.push(line),
        printErr: (line) => stderr.push(line),
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

      // --explain branch surfaces the reason on its own line (stdout). Match
      // a literal prefix so this doesn't depend on the wrap format.
      const explainLine = printed.find((l) => l.startsWith("expansion failed:"));
      expect(explainLine).toBeDefined();
      expect(explainLine).toContain("simulated network outage");
      // The transient `note: query expansion failed (...)` advisory rides
      // stderr so a script doing `fbrain ask q 2>/dev/null` doesn't see it
      // interleaved with the result rows.
      const noteLine = stderr.find((l) => l.startsWith("note: query expansion failed"));
      expect(noteLine).toBeDefined();
      expect(noteLine).toContain("simulated network outage");
    },
  );

  test("default (no --expand) path reports kind='disabled', not 'failed'", async () => {
    // Negative control: the default no-expansion path must NOT look like a
    // failure. Keeps the discriminator honest if someone later collapses the
    // branches. (Post-flip: expansion is off unless --expand is passed.)
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const result = await askCmd({
      cfg,
      query: "anything",
      explain: true,
      print: () => {},
    });

    expect(result.expansionStatus.kind).toBe("disabled");
    expect(result.expansion).toBeNull();
  });

  test("disabled + --explain prints a notice so --explain isn't a no-op", async () => {
    // --explain must say something on the disabled path, otherwise it prints
    // exactly the same lines as a plain run. The notice now points at
    // --expand (expansion is off by default after the eval-driven flip).
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const printed: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      explain: true,
      print: (line) => printed.push(line),
    });

    expect(printed.some((l) => l.includes("LLM expansion not enabled; pass --expand"))).toBe(
      true,
    );
  });

  test("default WITHOUT --explain stays quiet about the disabled status", async () => {
    // Bookend the previous test: confirm we only emit the explanation
    // line when --explain is set, so users who don't ask for the debug
    // surface don't get a new line of chatter on every default run.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const printed: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      print: (line) => printed.push(line),
    });

    expect(printed.some((l) => l.includes("LLM expansion not enabled"))).toBe(false);
  });

  test("--no-llm is a back-compat no-op — default already disables expansion", async () => {
    // Existing scripts/agents that pass --no-llm must keep working. It now
    // changes nothing (expansion is off by default) and must NOT surface as
    // a failure.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const result = await askCmd({
      cfg,
      query: "anything",
      noLlm: true,
      print: () => {},
    });

    expect(result.expansionStatus.kind).toBe("disabled");
    expect(result.expansion).toBeNull();
  });

  test("--explain with --expand and no ANTHROPIC_API_KEY prints a no-key notice", async () => {
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
    const stderr: string[] = [];
    const result = await askCmd({
      cfg,
      query: "anything",
      expand: true,
      explain: true,
      print: (line) => printed.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(result.expansionStatus.kind).toBe("no-key");
    // Top-of-run `note:` line is an advisory → stderr.
    expect(
      stderr.some(
        (l) =>
          l.startsWith("note:") && l.includes("ANTHROPIC_API_KEY not set"),
      ),
    ).toBe(true);
    // --explain summary stays on stdout so `--explain` debug output is
    // self-contained on its own stream.
    expect(
      printed.some(
        (l) =>
          l.startsWith("(no expansions") &&
          l.includes("ANTHROPIC_API_KEY not set"),
      ),
    ).toBe(true);
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

      // CRITICAL ASSERTION: the BODY corpus fetch runs once per logical type,
      // never per fused hit. Stage 4 must add ZERO body fetches — anything
      // more is the old N+1. (Pre-fix the per-hit listRecords re-fetched the
      // full body; the in-memory map collapsed that, and the cache-aware load
      // keeps the cold-path body fetch at exactly one per type.)
      const totalBodyQueries = Array.from(
        stub.bodyQueryCountsBySchema.values(),
      ).reduce((a, b) => a + b, 0);
      expect(totalBodyQueries).toBe(RECORD_TYPES.length);

      // The shared note hash is the worst-case multiplier. Before the N+1 fix
      // it took the corpus body calls (one per Phase 6 type = 6) PLUS one per
      // resolved Phase 6 hit. After: exactly 6 body fetches, no more.
      expect(stub.bodyQueryCountsBySchema.get(sharedNoteHash)).toBe(6);
      expect(stub.bodyQueryCountsBySchema.get(TEST_HASHES.design)).toBe(1);
      expect(stub.bodyQueryCountsBySchema.get(TEST_HASHES.task)).toBe(1);

      // Cold RecordListIndex seed cost is bounded per type: read index miss,
      // body-bearing seed scan, write-existence point read, then read index hit
      // for the rebuild. The critical invariant is still above: only one of
      // those carries `body`, and Stage 4 adds no per-hit body fetches.
      const totalQueries = Array.from(stub.queryCountsBySchema.values()).reduce(
        (a, b) => a + b,
        0,
      );
      expect(totalQueries).toBe(4 * RECORD_TYPES.length);
    },
  );

  test(
    "a WARM ask over an UNCHANGED corpus issues only the cheap listing — ZERO body fetches",
    async () => {
      // The headline of the cache-aware corpus load: pre-fix `ask` re-fetched
      // every record's full body on EVERY call (one full-body limit:1000 scan
      // per type) just to recompute the fingerprint. Now the fingerprint is
      // computed from a body-less listing, so when nothing changed since the
      // last `ask` the second call does the cheap listing ONLY — no body
      // fetch, no rebuild — and still returns the right hits from the cached
      // index. The shared FBRAIN_CACHE_DIR (beforeEach) lets the first call's
      // saved index carry into the second.
      const cfg = buildTestCfg();
      const stub = installFetchStub({
        queries: {
          [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")],
          [TEST_HASHES.task]: [],
        },
        vectorHits: [
          vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 }),
        ],
      });

      // COLD call: warms the cache (does the full body fetch + rebuild).
      const cold = await askCmd({
        cfg,
        query: "octopus",
        noLlm: true,
        print: () => {},
      });
      expect(cold.bm25CacheHit).toBe(false);
      const coldBody = Array.from(stub.bodyQueryCountsBySchema.values()).reduce(
        (a, b) => a + b,
        0,
      );
      expect(coldBody).toBe(RECORD_TYPES.length);

      // Reset the counters; the index file persists in FBRAIN_CACHE_DIR.
      stub.queryCountsBySchema.clear();
      stub.bodyQueryCountsBySchema.clear();

      // WARM call: same corpus → cache hit → no body fetch at all.
      const warm = await askCmd({
        cfg,
        query: "octopus",
        noLlm: true,
        print: () => {},
      });
      expect(warm.bm25CacheHit).toBe(true);

      // ZERO body-bearing /api/query calls on the warm path — the whole point.
      const warmBody = Array.from(stub.bodyQueryCountsBySchema.values()).reduce(
        (a, b) => a + b,
        0,
      );
      expect(warmBody).toBe(0);

      // The cheap listing still runs (it's how we detect "unchanged"), one per
      // active type — but it carries no `body`, so it's the small query.
      const warmTotal = Array.from(stub.queryCountsBySchema.values()).reduce(
        (a, b) => a + b,
        0,
      );
      expect(warmTotal).toBe(RECORD_TYPES.length);

      // Correctness preserved: the warm path still resolves the same hit, with
      // its full record (title/body) hydrated on demand for the chosen hit.
      expect(warm.hits.map((h) => h.slug)).toEqual(["d1"]);
      expect(warm.hits[0]!.record.title).toBe("T-d1");
      expect(warm.hits[0]!.record.body).toContain("octopus");
    },
  );

  test("cold cache surfaces the rebuild note; a subsequent warm cache does not", async () => {
    // kill-scan-brain follow-up (option b, design-lastdb-scan-deprecation-
    // path): a live `ask` that pays for the full-corpus rebuild must say so
    // — explicitly, unconditionally, not gated behind --verbose — so the
    // cost is never a silent request-path drain. A warm cache hit does no
    // rebuild at all, so it must stay quiet.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: {
        [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")],
        [TEST_HASHES.task]: [],
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 }),
      ],
    });

    const coldStderr: string[] = [];
    const cold = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
      printErr: (l) => coldStderr.push(l),
    });
    expect(cold.bm25CacheHit).toBe(false);
    expect(
      coldStderr.some((l) => l.includes("search index cache was cold/stale")),
    ).toBe(true);
    expect(coldStderr.some((l) => l.includes("fbrain reindex --bm25"))).toBe(true);

    const warmStderr: string[] = [];
    const warm = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
      printErr: (l) => warmStderr.push(l),
    });
    expect(warm.bm25CacheHit).toBe(true);
    expect(
      warmStderr.some((l) => l.includes("search index cache was cold/stale")),
    ).toBe(false);
  });

  test("alternating untyped and --type asks keep separate warm BM25 caches", async () => {
    // Regression for type-filter cache thrash: the index fingerprint already
    // includes the active type set, but the old filename was keyed only by
    // userHash. Alternating plain ask and --type design overwrote the same file
    // in both directions, so the second occurrence of either shape was a cache
    // miss and paid the full body fetch again.
    const cfg = buildTestCfg();
    const stub = installFetchStub({
      queries: {
        [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")],
        [TEST_HASHES.concept]: [noteRow("c1", "concept", "octopus concept")],
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 }),
      ],
    });

    const plainCold = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
    });
    expect(plainCold.bm25CacheHit).toBe(false);

    const designCold = await askCmd({
      cfg,
      query: "octopus",
      types: ["design"],
      noLlm: true,
      print: () => {},
    });
    expect(designCold.bm25CacheHit).toBe(false);

    stub.queryCountsBySchema.clear();
    stub.bodyQueryCountsBySchema.clear();

    const plainWarm = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
    });
    const designWarm = await askCmd({
      cfg,
      query: "octopus",
      types: ["design"],
      noLlm: true,
      print: () => {},
    });

    expect(plainWarm.bm25CacheHit).toBe(true);
    expect(designWarm.bm25CacheHit).toBe(true);
    const bodyFetches = Array.from(stub.bodyQueryCountsBySchema.values()).reduce(
      (a, b) => a + b,
      0,
    );
    expect(bodyFetches).toBe(0);
  });

  test(
    "editing a record between asks busts the cache and rebuilds — the change is findable",
    async () => {
      // Correctness half of the cache: a changed corpus (new updated_at) must
      // change the fingerprint so the warm path falls back to a full rebuild
      // and the edited content is searchable. We flip the live row's body +
      // updated_at between the two calls and assert the second call rebuilds
      // (cache MISS) and finds the new token.
      const cfg = buildTestCfg();
      let designBody = "octopus blueberry";
      let designUpdatedAt = "2026-01-01T00:00:00Z";
      const queryCounts = new Map<string, number>();
      const bodyQueryCounts = new Map<string, number>();
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const rawUrl = typeof input === "string" ? input : String(input);
        const appSearch = appSearchAsLegacyNativeIndex(rawUrl, init);
        const url = appSearch?.url ?? rawUrl;
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (url.includes("/api/query")) {
          const schema = (body as { schema_name: string }).schema_name;
          queryCounts.set(schema, (queryCounts.get(schema) ?? 0) + 1);
          const fields = (body as { fields?: unknown }).fields;
          if (Array.isArray(fields) && fields.includes("body")) {
            bodyQueryCounts.set(schema, (bodyQueryCounts.get(schema) ?? 0) + 1);
          }
          const rows =
            schema === TEST_HASHES.design
              ? [designRow("d1", designBody, { updated_at: designUpdatedAt })]
              : [];
          return new Response(
            JSON.stringify({
              ok: true,
              results: rows.map((f) => ({ fields: f, key: { hash: f.slug as string, range: null } })),
              total_count: rows.length,
              returned_count: rows.length,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/api/native-index/search")) {
          return new Response(
            JSON.stringify(legacySearchResponseBody({
              ok: true,
              results: [vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 })],
            }, appSearch)),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      // COLD: builds the index over the original body.
      const cold = await askCmd({ cfg, query: "octopus", noLlm: true, print: () => {} });
      expect(cold.bm25CacheHit).toBe(false);
      expect(cold.hits.map((h) => h.slug)).toEqual(["d1"]);

      // Edit the record: new body token + bumped updated_at.
      designBody = "octopus zucchini";
      designUpdatedAt = "2026-02-02T00:00:00Z";
      bodyQueryCounts.clear();
      queryCounts.clear();

      // The edited corpus must bust the cache (fingerprint changed) and rebuild.
      const rebuilt = await askCmd({ cfg, query: "zucchini", noLlm: true, print: () => {} });
      expect(rebuilt.bm25CacheHit).toBe(false);
      // Rebuild means a full body fetch happened (so the new token is indexed).
      expect((bodyQueryCounts.get(TEST_HASHES.design) ?? 0)).toBeGreaterThan(0);
      // And the new content is findable by its new token.
      expect(rebuilt.hits.map((h) => h.slug)).toEqual(["d1"]);
      expect(rebuilt.hits[0]!.record.body).toContain("zucchini");
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

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await askCmd({
      cfg,
      query: "the and or",
      noLlm: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(result.hits.length).toBe(0);
    // The notice is advisory → stderr, not stdout, so a script doing
    // `fbrain ask q 2>/dev/null` parses cleanly.
    expect(
      stderr.some((l) => l.includes("query tokenized to zero terms")),
    ).toBe(true);
    expect(
      stdout.some((l) => l.includes("query tokenized to zero terms")),
    ).toBe(false);
  });

  test("--type design narrows BM25 corpus + vector schemas filter, dropping concept noise", async () => {
    // End-to-end --type sanity for ask. Corpus mixes designs with concepts
    // (the agent-pr-events-* shape). With --type design:
    //   - loadBm25Documents only walks the design type → no /api/query call
    //     for the concept hash.
    //   - The vector schemas= param carries only the design hash.
    //   - Only design hits are returned.
    const cfg = buildTestCfg();
    const designRows = [
      designRow("the-readiness-gate", "concurrent backpressure"),
      designRow("another-design", "concurrent backpressure"),
    ];
    const conceptRows = [
      noteRow("agent-pr-events-pr-created", "concept", "concurrent backpressure"),
      noteRow("agent-pr-events-pr-merged", "concept", "concurrent backpressure"),
    ];

    let lastSearchUrl = "";
    const queryCounts = new Map<string, number>();
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const rawUrl = typeof input === "string" ? input : String(input);
      const appSearch = appSearchAsLegacyNativeIndex(rawUrl, init);
      const url = appSearch?.url ?? rawUrl;
      if (url.includes("/api/query")) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const schema = (body as { schema_name: string }).schema_name;
        queryCounts.set(schema, (queryCounts.get(schema) ?? 0) + 1);
        const rows =
          schema === TEST_HASHES.design
            ? designRows
            : schema === TEST_HASHES.concept
              ? conceptRows
              : [];
        return new Response(
          JSON.stringify({
            ok: true,
            results: rows.map((f) => ({ fields: f, key: { hash: f.slug as string, range: null } })),
            total_count: rows.length,
            returned_count: rows.length,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/native-index/search")) {
        lastSearchUrl = url;
        return new Response(
          JSON.stringify(legacySearchResponseBody({
            ok: true,
            results: [
              vectorHit({ schemaName: TEST_HASHES.design, slug: "the-readiness-gate", score: 0.9 }),
              vectorHit({ schemaName: TEST_HASHES.design, slug: "another-design", score: 0.8 }),
              vectorHit({
                schemaName: TEST_HASHES.concept,
                slug: "agent-pr-events-pr-created",
                score: 0.95,
              }),
            ],
          }, appSearch)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await askCmd({
      cfg,
      query: "backpressure",
      types: ["design"],
      limit: 5,
      noLlm: true,
      print: () => {},
    });

    // Vector wire only carries the design hash.
    const parsed = new URL(lastSearchUrl, "http://example/");
    const sent = (parsed.searchParams.get("schemas") ?? "").split(",").filter(Boolean);
    expect(sent).toEqual([TEST_HASHES.design]);

    // BM25 corpus load only touched the design type — no concept walk. On a
    // cold call that's the cheap listing + the full body fetch (2), both scoped
    // to design; concept is never queried in either pass.
    expect(queryCounts.get(TEST_HASHES.design)).toBe(2);
    expect(queryCounts.get(TEST_HASHES.concept) ?? 0).toBe(0);

    // Results are design only — no agent-pr-events-* noise.
    expect(result.hits.length).toBeGreaterThan(0);
    for (const h of result.hits) {
      expect(h.type).toBe("design");
    }
    const slugs = result.hits.map((h) => h.slug);
    expect(slugs).not.toContain("agent-pr-events-pr-created");
    expect(slugs).not.toContain("agent-pr-events-pr-merged");
  });

  test("--type design --type task narrows corpus to both types", async () => {
    // Multi-type form: the BM25 walk and the vector wire both carry exactly
    // the requested types.
    const cfg = buildTestCfg();
    const searchUrls: string[] = [];
    const queryCounts = new Map<string, number>();
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const rawUrl = typeof input === "string" ? input : String(input);
      const appSearch = appSearchAsLegacyNativeIndex(rawUrl, init);
      const url = appSearch?.url ?? rawUrl;
      if (url.includes("/api/query")) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const schema = (body as { schema_name: string }).schema_name;
        queryCounts.set(schema, (queryCounts.get(schema) ?? 0) + 1);
        // Seed one live (non-matching) design row so the BM25 corpus is
        // non-empty: that lets askCmd's no-match empty-brain fast-path
        // short-circuit (corpus proves the brain holds a record) WITHOUT a
        // second `hasAnyLiveRecord` walk that would query concept/preference
        // and break the strict per-type counts this test asserts.
        const rows =
          schema === TEST_HASHES.design
            ? [
                {
                  fields: designRow("seed", "octopus blueberry zucchini"),
                  key: { hash: "seed", range: null },
                },
              ]
            : [];
        return new Response(
          JSON.stringify({
            ok: true,
            results: rows,
            total_count: rows.length,
            returned_count: rows.length,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/native-index/search")) {
        searchUrls.push(url);
        return new Response(
          JSON.stringify(legacySearchResponseBody({ ok: true, results: [] }, appSearch)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await askCmd({
      cfg,
      query: "anything",
      types: ["design", "task"],
      noLlm: true,
      print: () => {},
    });

    const sent = searchUrls
      .map((url) => new URL(url, "http://example/").searchParams.get("schemas"))
      .filter((s): s is string => Boolean(s));
    expect(new Set(sent)).toEqual(new Set([TEST_HASHES.design, TEST_HASHES.task]));

    // Cold call: cheap listing + full body fetch (2) per requested type.
    expect(queryCounts.get(TEST_HASHES.design)).toBe(2);
    expect(queryCounts.get(TEST_HASHES.task)).toBe(2);
    // No walks of the six Phase 6 types — narrowing skips them in both passes.
    expect(queryCounts.get(TEST_HASHES.concept) ?? 0).toBe(0);
    expect(queryCounts.get(TEST_HASHES.preference) ?? 0).toBe(0);
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
        // One live (non-matching) design row so the BM25 corpus is non-empty:
        // the query "anything" shares no tokens with it, so nothing resolves,
        // but askCmd's no-match fast-path can short-circuit on a non-empty
        // corpus WITHOUT a second `hasAnyLiveRecord` walk (which would add
        // queries and break the exact RECORD_TYPES.length count below).
        [TEST_HASHES.design]: [designRow("seed", "octopus blueberry zucchini")],
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
    // The ghost vector hit triggers NO extra fetch: on the cold path it's a
    // `liveById` Map miss (the in-memory corpus map), silently skipped. So the
    // only /api/query traffic is the corpus load itself: bounded cold
    // RecordListIndex seed/read traffic per type, and zero body fetches for
    // the ghost beyond the single per-type body-bearing seed scan.
    const totalQueries = Array.from(stub.queryCountsBySchema.values()).reduce(
      (a, b) => a + b,
      0,
    );
    expect(totalQueries).toBe(4 * RECORD_TYPES.length);
    const totalBodyQueries = Array.from(
      stub.bodyQueryCountsBySchema.values(),
    ).reduce((a, b) => a + b, 0);
    expect(totalBodyQueries).toBe(RECORD_TYPES.length);
  });
});

describe("askCmd output column gating (default vs --verbose)", () => {
  test("default output is `slug · score · type · title` — no bm25=/vec=/+exp[] columns", async () => {
    // Regression: per-ranker debug columns leaked into the default `ask`
    // output even though `fbrain help ask` documents them as --verbose-
    // only ("Run with the global --verbose to see ... per-ranker debug").
    // Clean by default; debug behind --verbose.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")] },
      vectorHits: [vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 })],
    });

    const lines: string[] = [];
    const result = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: (line) => lines.push(line),
    });

    expect(result.hits.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).not.toContain("bm25=");
    expect(joined).not.toContain("vec=");
    expect(joined).not.toContain("+exp[");
    // Sanity: the row still carries the rank + remaining columns.
    const row = lines.find((l) => l.includes("d1"));
    expect(row).toBeDefined();
    expect(row).toContain("Design");
    expect(row).toContain("T-d1");
    // Leads with the 1-based rank (`1.`), NOT a tiny RRF confidence decimal.
    expect(row).toMatch(/^\s*1\.\s/);
    expect(row).not.toMatch(/0\.0\d{3}/);
  });

  test("--verbose output retains the bm25=/vec= debug columns", async () => {
    // Bookend: when the global --verbose is set (modelled as a verbose
    // callback per Verbose's runtime shape, matching how cli.ts wires it),
    // the operator-debug columns come back so power users can still
    // diagnose ranker behaviour.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")] },
      vectorHits: [vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 })],
    });

    const lines: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      verbose: () => {},
      print: (line) => lines.push(line),
    });

    const row = lines.find((l) => l.includes("d1") && l.includes("bm25="));
    expect(row).toBeDefined();
    expect(row).toContain("vec=");
  });
});

describe("askCmd TTY column legend", () => {
  // The default human legend now describes a best-first RANKED list (no score
  // column) — the tiny raw-RRF decimal that read like "3% confidence" is gone.
  // Human-only: present on a TTY, absent under --json / when piped, so
  // first-line parsers and agents see byte-identical rows. The raw fused-RRF
  // score stays a labeled debug column under --verbose.
  const stubSingleHit = (): void => {
    installFetchStub({
      queries: { [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")] },
      vectorHits: [vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 })],
    });
  };

  test("prints a dim TTY legend describing a best-first ranked list", async () => {
    const cfg = buildTestCfg();
    stubSingleHit();
    const lines: string[] = [];
    await askCmd({ cfg, query: "octopus", noLlm: true, print: (l) => lines.push(l), isTty: () => true });
    expect(lines[0]).toContain("columns:");
    expect(lines[0]).toContain("rank");
    expect(lines[0]).toContain("best match first");
    // No misleading score/relevance language in the default legend.
    expect(lines[0]).not.toContain("RRF");
    expect(lines[0]).not.toContain("relevance");
    expect(lines[0]).toContain("\x1b[2m");
    // Result row present below, leading with the 1-based rank.
    const row = lines.find((l) => l.includes("d1"));
    expect(row).toBeDefined();
    expect(row).toContain("Design");
    expect(row).toMatch(/^\s*1\.\s/);
  });

  test("--verbose path carries a legend that still documents the raw RRF debug column", async () => {
    const cfg = buildTestCfg();
    stubSingleHit();
    const lines: string[] = [];
    await askCmd({ cfg, query: "octopus", noLlm: true, verbose: () => {}, print: (l) => lines.push(l), isTty: () => true });
    expect(lines[0]).toContain("columns:");
    expect(lines[0]).toContain("rank");
    expect(lines[0]).toContain("rrf");
    expect(lines[0]).toContain("not comparable to search");
  });

  test("suppresses the legend when stdout is NOT a TTY (piped/redirected)", async () => {
    const cfg = buildTestCfg();
    stubSingleHit();
    const lines: string[] = [];
    await askCmd({ cfg, query: "octopus", noLlm: true, print: (l) => lines.push(l), isTty: () => false });
    expect(lines.some((l) => l.includes("columns:"))).toBe(false);
    expect(lines.some((l) => l.includes("\x1b["))).toBe(false);
    expect(lines.find((l) => l.includes("d1"))).toBeDefined();
  });

  test("suppresses the legend under --json even on a TTY", async () => {
    const cfg = buildTestCfg();
    stubSingleHit();
    const lines: string[] = [];
    await askCmd({ cfg, query: "octopus", noLlm: true, json: true, print: (l) => lines.push(l), isTty: () => true });
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.includes("columns:"))).toBe(false);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});

describe("askCmd stdout/stderr discipline (advisory notes → stderr)", () => {
  test("no-key path: stdout has ONLY parseable result rows; the `note:` advisory rides stderr", async () => {
    // Regression for the bug the brief calls out: a script doing
    //   env -u ANTHROPIC_API_KEY fbrain ask 'merges' | head -1
    // used to grab `note: ANTHROPIC_API_KEY not set; ...` as the first
    // "result" because the advisory was emitted on the same sink as the
    // result rows. The fix routes notes through printErr (default
    // console.error) so stdout stays clean and line-oriented parsers
    // see only the result table.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")] },
      vectorHits: [vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 })],
    });
    // beforeEach already deletes ANTHROPIC_API_KEY — re-assert here so this
    // test stays meaningful if the suite-level setup ever changes.
    delete process.env.ANTHROPIC_API_KEY;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await askCmd({
      cfg,
      query: "octopus",
      expand: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(result.expansionStatus.kind).toBe("no-key");

    // Stdout: exactly one result row (+ its indented snippet line), no
    // `note:` line interleaved among them.
    const rows = stdout.filter((l) => !l.startsWith("    "));
    expect(rows).toHaveLength(1);
    for (const line of stdout) expect(line).not.toMatch(/^note:\s/);
    expect(rows[0]).toContain("d1");

    // Stderr: the no-key advisory, plus the (kill-scan-brain follow-up)
    // cold-cache BM25 rebuild note — this test's cache dir is always fresh,
    // so every call rebuilds. Both are advisories, and both stay off stdout.
    expect(stderr).toHaveLength(2);
    for (const line of stderr) expect(line).toMatch(/^note:\s/);
    expect(stderr.some((l) => l.includes("ANTHROPIC_API_KEY not set"))).toBe(true);
    expect(stderr.some((l) => l.includes("search index cache was cold/stale"))).toBe(true);
  });
});

describe("askCmd --json", () => {
  test("--field projects ask hits as TSV without JSON or human rows", async () => {
    const cfg = buildTestCfg();
    installFetchStub({
      queries: {
        [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")],
        [TEST_HASHES.task]: [],
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 }),
      ],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      fields: ["slug", "type", "title"],
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(stdout).toEqual(["d1\tdesign\tT-d1"]);
    expect(stdout[0]).not.toContain("{");
    // The (kill-scan-brain follow-up) cold-cache BM25 rebuild note is an
    // advisory on stderr, not stdout — this test's cache dir is always
    // fresh, so the call rebuilds.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("search index cache was cold/stale");
  });

  test("emits a single JSON array of {slug, score, type, title, snippet} on stdout", async () => {
    // Mirrors the `searchCmd --json` regression in cli-json-read.test.ts —
    // ask is the retrieval sibling of search with the same default column
    // shape, so its JSON payload must match search's verbatim. Pins:
    //   - stdout is exactly one parseable JSON document
    //   - each entry has {slug, score, type, title}; type is canonical
    //     lowercase RecordType (not the capitalized human display name)
    //   - no human table padding / `note:` lines leak onto stdout
    const cfg = buildTestCfg();
    installFetchStub({
      queries: {
        [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")],
        [TEST_HASHES.task]: [],
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 }),
      ],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(Object.keys(entry).sort()).toEqual(
        ["confidence", "score", "slug", "snippet", "title", "type"],
      );
      expect(entry.confidence).toBe("strong");
      expect(typeof entry.slug).toBe("string");
      expect(typeof entry.score).toBe("number");
      expect(typeof entry.title).toBe("string");
      expect(typeof entry.snippet).toBe("string");
      // Canonical lowercase RecordType, never the capitalized display.
      expect(entry.type).toBe(entry.type.toLowerCase());
    }
    const d1 = parsed.find((e: { slug: string }) => e.slug === "d1");
    expect(d1).toBeDefined();
    expect(d1.type).toBe("design");
    expect(d1.title).toBe("T-d1");
    // Snippet carries the matching body inline — query "octopus" against
    // body "octopus blueberry".
    expect(d1.snippet).toContain("octopus");
    // No human table padding on stdout (fusedScore.toFixed(4) → "0.0328")
    // — only the raw number lands in JSON.
    expect(stdout[0]).not.toMatch(/\bDesign\b/);
  });

  test("empty result emits `[]` on stdout — not the 'no matches' human sentinel", async () => {
    // Matches search's empty-result discipline (search.ts:183-192). A jq
    // pipeline must see a parseable empty array, not the string "no matches".
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "ghost",
      noLlm: true,
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(stdout).toEqual(["[]"]);
    expect(JSON.parse(stdout[0]!)).toEqual([]);
    // No stdout contamination from human sentinels.
    expect(stdout.some((l) => l.includes("no matches"))).toBe(false);
  });

  test("advisory notes route to stderr — stdout stays pure JSON under --json", async () => {
    // Cross-stream discipline (PRs #200/#209): every `note:` line on
    // stderr, so `fbrain ask q --json | jq ...` sees only the array.
    // The all-stopword path is the easiest advisory to provoke deterministically.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "the and or",
      noLlm: true,
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    // Stdout: pure JSON, no `note:` lines.
    expect(stdout).toEqual(["[]"]);
    expect(stdout.some((l) => l.startsWith("note:"))).toBe(false);
    // Stderr: the tokenized-to-zero-terms advisory.
    expect(
      stderr.some((l) => l.includes("query tokenized to zero terms")),
    ).toBe(true);
  });

  test("rounds the score to ≤6 decimals — matches search --json's discipline", async () => {
    // RRF's fusedScore is bounded < 1 (no >1.0 footgun), but the raw
    // value carries f64 float noise that pollutes a jq pipeline if left
    // unrounded. Same 6-decimal rounding as `search --json` for
    // sibling-command consistency.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: {
        [TEST_HASHES.design]: [designRow("d1", "octopus blueberry")],
        [TEST_HASHES.task]: [],
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.9 }),
      ],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    const parsed = JSON.parse(stdout[0]!) as Array<{
      slug: string;
      score: number;
    }>;
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      // After rounding to 1e6, the scaled value must be an integer.
      // (Float exactness: integers up to 2^53 round-trip cleanly.)
      const scaled = entry.score * 1e6;
      expect(Number.isFinite(scaled)).toBe(true);
      expect(scaled).toBeCloseTo(Math.round(scaled), 9);
      // And no 17-digit float-noise leaks into the serialized document.
      expect(String(entry.score).length).toBeLessThanOrEqual(10);
    }
  });

  test("--json + --explain routes the expansions block to stderr", async () => {
    // --json + --explain still works — explanations just land on stderr
    // so stdout stays parseable. Without this routing, `fbrain ask q
    // --json --explain | jq ...` would dead-end on a leading
    // "(no expansions — ...)" line. (Post-flip: the disabled notice now
    // points at --expand; askCmd accepts explain+disabled, the CLI guard
    // is what rejects `--explain` without `--expand`.)
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      explain: true,
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    // Stdout: only the JSON document.
    expect(stdout).toEqual(["[]"]);
    // Stderr: the --explain `(no expansions ...)` notice.
    expect(
      stderr.some((l) => l.includes("LLM expansion not enabled; pass --expand")),
    ).toBe(true);
  });

  test("carries a matching body snippet in --json and prints it under the human row", async () => {
    // The card's headline path on the `ask` side: the answer is visible
    // inline (no follow-up `fbrain get`), in both the human render and the
    // `--json` document (which is the SAME value MCP `structuredContent`
    // surfaces).
    const cfg = buildTestCfg();
    installFetchStub({
      queries: {
        [TEST_HASHES.design]: [
          designRow(
            "caching-decision",
            "# Caching layer decision\n\nDecision: we picked a 5-minute TTL for the cache.",
          ),
        ],
      },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "caching-decision", score: 0.9 }),
      ],
    });

    // Human render.
    const human: string[] = [];
    await askCmd({ cfg, query: "TTL", noLlm: true, print: (l) => human.push(l) });
    const snippetLine = human.find((l) => l.startsWith("    "));
    expect(snippetLine).toBeDefined();
    expect(snippetLine!).toContain("5-minute TTL");
    expect(snippetLine!).not.toContain("Caching layer decision");

    // --json carries the same snippet.
    const stdout: string[] = [];
    await askCmd({
      cfg,
      query: "TTL",
      noLlm: true,
      json: true,
      print: (l) => stdout.push(l),
    });
    const parsed = JSON.parse(stdout[0]!) as Array<{ slug: string; snippet: string }>;
    const hit = parsed.find((e) => e.slug === "caching-decision");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("5-minute TTL");
    expect(hit!.snippet).not.toContain("Caching layer decision");
  });
});

describe("askCmd query deduplication", () => {
  test("an expansion identical to the original query is not double-counted in RRF fusion", async () => {
    // Regression: when the LLM emits an expansion identical to the original
    // query (or to another expansion — e.g. the model repeats itself when
    // asked for "exactly 3 phrasings"), the pre-fix per-query loop ran BOTH
    // through BM25 + vector and pushed IDENTICAL ranked lists into RRF
    // twice. RRF then summed the same (id, rank=1) contribution twice and
    // any hit's fused score was inflated by the count of duplicate
    // phrasings — biasing the top-K toward whichever phrasing the LLM
    // happened to repeat.
    //
    // The fix dedupes queries by exact string before invoking the per-query
    // rankers, preserving the FIRST occurrence so the original query's
    // "orig" label survives any expansion that happens to echo it.
    const cfg = buildTestCfg();

    // One live record on the concept schema; BM25 + vector both put it at
    // rank 1 for query "foo".
    const stub = installFetchStub({
      queries: { [TEST_HASHES.concept]: [noteRow("r1", "concept", "foo bar")] },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.concept, slug: "r1", score: 0.9 }),
      ],
    });

    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    // Stub LLM to return one expansion equal to the original query.
    const llmFetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "foo" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await askCmd({
      cfg,
      query: "foo",
      expand: true,
      print: () => {},
      fetchImpl: llmFetch,
    });

    // Sanity: the LLM returned exactly the duplicate phrasing.
    expect(result.expansions).toEqual(["foo"]);
    expect(result.hits.length).toBe(1);

    // Both BM25 and vector return r1 at rank 1 for "foo". With one
    // duplicate phrasing the queries list is ["foo", "foo"]. Pre-fix each
    // query contributed 1/(60+1) from BM25 AND 1/(60+1) from vector, and
    // RRF summed all four contributions → 4/61 ≈ 0.0656. Post-fix the
    // duplicate is skipped and only the original's two rankers contribute
    // → 2/61 ≈ 0.0328.
    expect(result.hits[0]!.fusedScore).toBeCloseTo(2 / 61, 5);
    // And no wasted HTTP: the duplicate expansion does NOT trigger a
    // second vector-search fanout. Under SDK app-search, one logical vector
    // search fans out to one call per target schema; pre-fix the duplicate
    // expansion would double this count.
    const targetFanout = new Set(
      RECORD_TYPES.map((type) => cfg.schemaHashes[type]).filter(Boolean),
    ).size;
    expect(stub.searchCalls).toBe(targetFanout);
  });
});

describe("askCmd no-match hint (mirrors search #276)", () => {
  test("empty brain → calm create-first hint, not a bare `no matches`", async () => {
    // The brand-new-dev cut: `fbrain init`'s next-steps point a fresh dev at
    // BOTH `fbrain search` and `fbrain ask` before they've created anything.
    // On a zero-record brain ask resolves nothing AND the empty-brain probe
    // finds no live record, so the hint must be the same calm "create your
    // first record" guidance `search` now gives — never a dead-end `no
    // matches` with no recovery.
    const cfg = buildTestCfg();
    // Empty corpus, no vector hits → nothing resolves, and every /api/query
    // page comes back empty so hasAnyLiveRecord() reads the brain as empty.
    installFetchStub({ queries: {}, vectorHits: [] });

    const printed: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      print: (line) => printed.push(line),
    });

    expect(printed).toContain("no matches");
    const hint = printed.find((l) => l.startsWith("hint:"));
    expect(hint).toBeDefined();
    expect(hint).toContain("no records yet");
    expect(hint).toContain("fbrain <type> new <slug>");
    expect(hint).toContain("then ask again");
  });

  test("populated brain, nothing matched → terse retry nudge, not the create-first hint", async () => {
    // ask is a BM25 + vector hybrid, so a populated brain almost never returns
    // zero — but when it does, the new-dev create-first guidance would be
    // wrong (there ARE records). The probe must distinguish the two: a live
    // record exists, so the hint is the terse "try fewer/different terms".
    const cfg = buildTestCfg();
    // One live design record (so hasAnyLiveRecord → true) whose body shares no
    // tokens with the query, and no vector hits → nothing resolves.
    installFetchStub({
      queries: { [TEST_HASHES.design]: [designRow("alpha", "alpha beta gamma")] },
      vectorHits: [],
    });

    const printed: string[] = [];
    await askCmd({
      cfg,
      query: "zzzqqqxxnomatch99",
      print: (line) => printed.push(line),
    });

    expect(printed).toContain("no matches");
    const hint = printed.find((l) => l.startsWith("hint:"));
    expect(hint).toBeDefined();
    expect(hint).toContain("nothing matched");
    // Must NOT show the empty-brain create-first guidance on a populated brain.
    expect(hint).not.toContain("no records yet");
  });

  test("empty-state hint routes to stderr under --json so stdout stays `[]`", async () => {
    // The --json contract: stdout is a single parseable empty array (jq
    // pipelines stay clean) and the hint lands on stderr only.
    const cfg = buildTestCfg();
    installFetchStub({ queries: {}, vectorHits: [] });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "anything",
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    // Stdout is exactly the empty array — no hint, no `no matches` sentinel.
    expect(stdout).toEqual(["[]"]);
    expect(JSON.parse(stdout[0]!)).toEqual([]);
    // The hint lands on stderr.
    expect(stderr.some((l) => l.startsWith("hint:") && l.includes("no records yet"))).toBe(true);
  });
});

describe("askCmd weak-match advisory (#253 parity on the recommended path)", () => {
  // `ask` thresholds the per-hit vectorScore (the cosine the vector ranker
  // returned), NOT the fused RRF score — RRF scores are rank-based and carry no
  // absolute-relevance meaning. Reuses search's distribution-shape classifier +
  // constants (STRONG_SCORE 0.5 / FLATNESS_GAP 0.025 / NOISE_CEILING 0.3), and
  // routes the `note:` to stderr in both text and --json modes. The note copy
  // drops search's "Try `fbrain ask`" tail (already in ask).

  // All rows share the token "octopus" so BM25 resolves the whole list; the
  // weak/strong distinction comes purely from the vectorScores below.
  const noiseRows = [
    designRow("d1", "octopus alpha"),
    designRow("d2", "octopus beta"),
    designRow("d3", "octopus gamma"),
    designRow("d4", "octopus delta"),
  ];

  // A flat floor band of vector cosines: top below STRONG_SCORE (0.5) and the
  // bulk pinned to the floor (median − min < FLATNESS_GAP 0.025) — the no-match
  // shape. Top 0.443 is also above NOISE_CEILING (0.3) so the flatness test,
  // not the absolute floor, is what fires here.
  const noiseVectorHits = [
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.443 }),
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d2", score: 0.334 }),
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d3", score: 0.334 }),
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d4", score: 0.334 }),
  ];

  // A strong distribution: top at/above STRONG_SCORE → never weak.
  const strongVectorHits = [
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.62 }),
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d2", score: 0.34 }),
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d3", score: 0.34 }),
    vectorHit({ schemaName: TEST_HASHES.design, slug: "d4", score: 0.33 }),
  ];

  test("a noise hit list fires the advisory on stderr (text mode); stdout has the rows", async () => {
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: noiseRows, [TEST_HASHES.task]: [] },
      vectorHits: noiseVectorHits,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    // Advisory on stderr, with the ask-flavored copy (no "Try `fbrain ask`").
    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(true);
    expect(stderr.some((l) => l.includes("Try different terms."))).toBe(true);
    expect(stderr.some((l) => l.includes("`fbrain ask"))).toBe(false);
    // Result rows still land on stdout (strictly additive — never drops a row).
    expect(stdout.some((l) => l.includes("d1"))).toBe(true);
    expect(stdout.some((l) => l.startsWith("note:"))).toBe(false);
  });

  test("a strong hit list does NOT fire the advisory", async () => {
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: noiseRows, [TEST_HASHES.task]: [] },
      vectorHits: strongVectorHits,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(false);
    expect(stdout.some((l) => l.includes("d1"))).toBe(true);
  });

  test("--json: advisory rides stderr, stdout stays pure JSON", async () => {
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: noiseRows, [TEST_HASHES.task]: [] },
      vectorHits: noiseVectorHits,
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      json: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    // Stdout: exactly one parseable JSON document, no `note:` contamination.
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(stdout.some((l) => l.startsWith("note:"))).toBe(false);
    // Stderr carries the advisory.
    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(true);
  });

  test("small-sample noise whose floor breaks flatness is still caught by NOISE_CEILING", async () => {
    // The live-brain calibration case (run 2026-06-21): a true no-match query
    // resolved only ~5 RRF-fused hits whose vectorScores were
    // [0.419, 0.330, null, 0.385, 0.321] — top 0.419, median−min ≈ 0.037, so
    // the flatness test alone (median−min < 0.025) did NOT fire. ask's tiny
    // sample doesn't form the dense flat floor search's top-50 does, so the
    // absolute NOISE_CEILING (0.45 on ask, above search's 0.3) is what catches
    // it: top 0.419 < 0.45 → weak. This pins that calibration.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: noiseRows, [TEST_HASHES.task]: [] },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.419 }),
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d2", score: 0.385 }),
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d3", score: 0.33 }),
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d4", score: 0.321 }),
      ],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(true);
  });

  test("a sub-STRONG top whose own band is flat is weak (parity with search)", async () => {
    // A real-but-loosely-matching query can have a top cosine between
    // NOISE_CEILING and STRONG_SCORE with a flat band (live: 0.459, median−min
    // 0.020). That IS a weak match by search's own definition (top < 0.5 +
    // flat), so ask flags it too — not a false positive. The flatness test, not
    // the floor, is what fires here.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: noiseRows, [TEST_HASHES.task]: [] },
      vectorHits: [
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d1", score: 0.459 }),
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d2", score: 0.452 }),
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d3", score: 0.449 }),
        vectorHit({ schemaName: TEST_HASHES.design, slug: "d4", score: 0.448 }),
      ],
    });

    const stderr: string[] = [];
    await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
      printErr: (line) => stderr.push(line),
    });

    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(true);
  });

  test("all-null vectorScores (pure-BM25 rescue) are unmeasurable → no advisory", async () => {
    // No vector hits at all: every resolved hit has vectorScore === null, so
    // the distribution is unmeasurable. Matches search's null handling — we do
    // not annotate. BM25 still resolves the rows via the shared "octopus" token.
    const cfg = buildTestCfg();
    installFetchStub({
      queries: { [TEST_HASHES.design]: noiseRows, [TEST_HASHES.task]: [] },
      vectorHits: [],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    // Sanity: BM25 rescued rows, but none carry a vectorScore.
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((h) => h.vectorScore === null)).toBe(true);
    // Unmeasurable → no advisory.
    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(false);
  });
});
