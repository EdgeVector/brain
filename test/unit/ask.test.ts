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
      const stderr: string[] = [];
      const throwingFetch = (async () => {
        throw new Error("simulated network outage");
      }) as unknown as typeof fetch;

      const result = await askCmd({
        cfg,
        query: "anything",
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
    const stderr: string[] = [];
    const result = await askCmd({
      cfg,
      query: "anything",
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
      const url = typeof input === "string" ? input : String(input);
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
          JSON.stringify({
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
          }),
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

    // BM25 corpus build only queried the design type — no concept walk.
    expect(queryCounts.get(TEST_HASHES.design)).toBe(1);
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
    let lastSearchUrl = "";
    const queryCounts = new Map<string, number>();
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/query")) {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const schema = (body as { schema_name: string }).schema_name;
        queryCounts.set(schema, (queryCounts.get(schema) ?? 0) + 1);
        return new Response(
          JSON.stringify({ ok: true, results: [], total_count: 0, returned_count: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/native-index/search")) {
        lastSearchUrl = url;
        return new Response(
          JSON.stringify({ ok: true, results: [] }),
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

    const parsed = new URL(lastSearchUrl, "http://example/");
    const sent = (parsed.searchParams.get("schemas") ?? "").split(",").filter(Boolean);
    expect(new Set(sent)).toEqual(new Set([TEST_HASHES.design, TEST_HASHES.task]));

    expect(queryCounts.get(TEST_HASHES.design)).toBe(1);
    expect(queryCounts.get(TEST_HASHES.task)).toBe(1);
    // No walks of the six Phase 6 types.
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
    // Sanity: the row still carries the four expected columns.
    const row = lines.find((l) => l.includes("d1"));
    expect(row).toBeDefined();
    expect(row).toContain("Design");
    expect(row).toContain("T-d1");
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
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
    });

    expect(result.expansionStatus.kind).toBe("no-key");

    // Stdout: exactly one result row, no `note:` line interleaved.
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).not.toMatch(/^note:\s/);
    expect(stdout[0]).toContain("d1");

    // Stderr: the no-key advisory.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^note:\s/);
    expect(stderr[0]).toContain("ANTHROPIC_API_KEY not set");
  });
});
