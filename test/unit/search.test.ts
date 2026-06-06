// Unit tests for the search command's fragment→record resolution +
// dedupe path. Uses a mocked fetch so we control the search and query
// responses without standing up a real node.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dedupeHits, searchCmd } from "../../src/commands/search.ts";
import type { NativeIndexHit } from "../../src/client.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;
const TASK_HASH = TEST_HASHES.task;
const OTHER_HASH = "1111111111111111111111111111111111111111111111111111111111111111";

const cfg = buildTestCfg({ userHash: "test-hash" });

function hit(opts: Partial<NativeIndexHit> & { slug: string; schemaName: string }): NativeIndexHit {
  return {
    schema_name: opts.schemaName,
    schema_display_name: opts.schema_display_name ?? null,
    field: opts.field ?? "body",
    key_value: { hash: opts.slug, range: null },
    value: opts.value ?? "fragment text",
    metadata: opts.metadata ?? { score: 0.5, match_type: "semantic" },
  };
}

describe("dedupeHits", () => {
  test("collapses multiple fragments of same record to highest-score", () => {
    const hits: NativeIndexHit[] = [
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.3 } }),
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.7 } }),
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.5 } }),
    ];
    const out = dedupeHits(hits);
    expect(out).toHaveLength(1);
    expect(out[0]!.metadata!.score).toBe(0.7);
  });

  test("keeps distinct records separate", () => {
    const hits: NativeIndexHit[] = [
      hit({ slug: "a", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
      hit({ slug: "b", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
    ];
    expect(dedupeHits(hits)).toHaveLength(2);
  });

  test("treats Design+slug and Task+slug as distinct keys", () => {
    const hits: NativeIndexHit[] = [
      hit({ slug: "x", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
      hit({ slug: "x", schemaName: TASK_HASH, schema_display_name: "Task" }),
    ];
    expect(dedupeHits(hits)).toHaveLength(2);
  });

  test("skips hits with no key_value.hash", () => {
    const hits: NativeIndexHit[] = [
      { ...hit({ slug: "ignored", schemaName: DESIGN_HASH, schema_display_name: "Design" }), key_value: { hash: null, range: null } },
      hit({ slug: "kept", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
    ];
    const out = dedupeHits(hits);
    expect(out).toHaveLength(1);
    expect(out[0]!.key_value.hash).toBe("kept");
  });

  test("collapses fragments where schema_display_name varies between null and a string", () => {
    // Regression: NativeIndexHit declares `schema_display_name?: string | null`,
    // so a single record's fragments can legitimately come back with the
    // display name present on one and null/missing on another. Pre-fix the
    // dedupe key was `displayName::slug` with displayName falling back to the
    // schema hash when missing — i.e. `"Concept::a"` vs `"<hash>::a"`, two
    // different keys for what is logically the SAME (schema, slug). Both
    // fragments survived dedupe and the search command resolved both via
    // findBySlug to the SAME underlying record, so the printed output carried
    // a duplicate row for that record. The fix keys by `schema_name` (the
    // canonical hash, always a string), making the dedupe robust against any
    // server-side inconsistency in `schema_display_name`.
    const hits: NativeIndexHit[] = [
      hit({
        slug: "a",
        schemaName: DESIGN_HASH,
        schema_display_name: "Design",
        metadata: { score: 0.4 },
      }),
      hit({
        slug: "a",
        schemaName: DESIGN_HASH,
        schema_display_name: null,
        metadata: { score: 0.6 },
      }),
    ];
    const out = dedupeHits(hits);
    expect(out).toHaveLength(1);
    // Highest-score fragment must win regardless of which one carried the
    // display name; pin the score so a future change to keep the
    // display-name-carrying fragment (a different policy) shows up here.
    expect(out[0]!.metadata!.score).toBe(0.6);
  });

  test("does not collapse two distinct schemas that share a display name", () => {
    // Defensive: if a shared daemon hosts a non-fbrain schema whose
    // descriptive_name happens to match one of fbrain's (e.g. another app's
    // "Design") and that schema sneaks past the `schemas=` filter, the
    // fragment dedupe must keep them apart by canonical hash so the wrong-
    // schema record doesn't silently displace fbrain's. Pre-fix dedupe by
    // displayName would have collapsed both onto `"Design::x"` and dropped
    // the lower-scoring one — which could be the genuine fbrain hit.
    const FOREIGN_HASH = "2".repeat(64);
    const hits: NativeIndexHit[] = [
      hit({
        slug: "x",
        schemaName: DESIGN_HASH,
        schema_display_name: "Design",
        metadata: { score: 0.5 },
      }),
      hit({
        slug: "x",
        schemaName: FOREIGN_HASH,
        schema_display_name: "Design",
        metadata: { score: 0.9 },
      }),
    ];
    const out = dedupeHits(hits);
    expect(out).toHaveLength(2);
    const hashes = out.map((h) => h.schema_name).sort();
    expect(hashes).toEqual([FOREIGN_HASH, DESIGN_HASH].sort());
  });
});

const realFetch = globalThis.fetch;

type MockResponse = { status: number; body?: unknown };

function installSequencedMock(handler: (url: string, init?: RequestInit) => MockResponse): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const next = handler(url, init);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("searchCmd", () => {
  test("resolves a single hit and prints slug+score+type+title", async () => {
    const recordRow = {
      fields: {
        slug: "alpha",
        title: "Alpha design",
        body: "blueberry octopus",
        status: "draft",
        tags: ["x"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "alpha", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "alpha", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.42 } }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow], total_count: 1, returned_count: 1 } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "blueberry", print: (l) => lines.push(l) });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("0.420");
    expect(lines[0]).toContain("Design");
    expect(lines[0]).toContain("Alpha design");
  });

  test("retries findBySlug past a transient empty /api/query slice and surfaces the hit", async () => {
    // /api/query's top-100 slice is non-deterministic on a saturated daemon
    // (docs/phase-7-search-latency-spike.md H2 + PR #98). A bare findBySlug
    // can return null for a real row, which the pre-fix search command
    // misclassified as "stale" and silently dropped from the printed
    // results. Pin the retry hedge so a flaked first /api/query lands the
    // row on retry and the user still sees their match.
    const recordRow = {
      fields: {
        slug: "flaky",
        title: "Flaky design",
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "flaky", range: null },
    };
    let queryCalls = 0;
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "flaky", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.42 } }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        queryCalls++;
        // First attempt models the top-100 slice flake — empty result for a
        // row that is genuinely in the schema. Subsequent attempts surface
        // it. Without the retry hedge in search.ts, the empty first slice
        // would drop the hit as "stale".
        if (queryCalls === 1) {
          return { status: 200, body: { ok: true, results: [], total_count: 0, returned_count: 0 } };
        }
        return { status: 200, body: { ok: true, results: [recordRow], total_count: 1, returned_count: 1 } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "anything", print: (l) => lines.push(l) });
    expect(queryCalls).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("flaky");
    expect(lines[0]).toContain("Flaky design");
  }, 10_000);

  test("silently skips stale hits where findBySlug returns nothing", async () => {
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "ghost", schemaName: DESIGN_HASH, schema_display_name: "Design" }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [], total_count: 0, returned_count: 0 } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "anything", print: (l) => lines.push(l) });
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toContain("fbrain ask <query> --no-llm");
    expect(lines).toHaveLength(2);
  });

  test("skips hits whose schema_name matches neither Design nor Task", async () => {
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "x", schemaName: OTHER_HASH, schema_display_name: "Other" }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", print: (l) => lines.push(l) });
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toContain("fbrain ask <query> --no-llm");
    expect(lines).toHaveLength(2);
  });

  test("empty result prints BM25-fallback hint pointing at `fbrain ask --no-llm`", async () => {
    // Vector index has freshness lag (G3a/G3b per phase-7-search-latency-spike.md).
    // Users who hit "no matches" interactively shouldn't be left thinking the record
    // isn't there — BM25 (via `fbrain ask --no-llm`) often catches it.
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "papercut", print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toMatch(/^hint:\s/);
    expect(lines[1]).toContain("fbrain ask <query> --no-llm");
    expect(lines[1]).toContain("BM25 fallback");
  });

  test("tolerates missing metadata.score → prints — in the score column", async () => {
    const recordRow = {
      fields: {
        slug: "x",
        title: "X",
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "x", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                schema_name: DESIGN_HASH,
                schema_display_name: "Design",
                field: "body",
                key_value: { hash: "x", range: null },
                value: "fragment",
                // no metadata
              } as NativeIndexHit,
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow] } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", print: (l) => lines.push(l) });
    expect(lines[0]).toContain("—");
  });

  test("ties in score break by (type::slug) ASC so the limit slice is canonical, not server-order-dependent", async () => {
    // Regression: resolved.sort was `(b.score ?? -1) - (a.score ?? -1)` with
    // NO tie-break. JS sort is stable, so equal-score hits kept the dedupe-Map
    // insertion order — which is the order each (schema_name, slug) FIRST
    // appeared in the server's fragment response. With --limit N the slice
    // then kept the top N in server-fragment order rather than a canonical
    // lexicographic order, so the SAME corpus + SAME query could yield
    // different displayed results across re-indexes / daemon restarts /
    // any change to the server's tied-fragment ordering. Especially load-
    // bearing on the score-missing path (`metadata.score === undefined`),
    // where the `?? -1` default maps every score-less hit into a wholesale
    // tie at -1 and `slice(0, limit)` picks whichever N the server happened
    // to emit first.
    //
    // Same shape as the rrf.ts (PR #79) and bm25.ts (PR #101) tie-break and
    // the ask.ts vector-rank tie-break — every score-ordered layer in the
    // retrieval pipeline must break ties deterministically; search.ts was
    // the lone holdout.
    const rows = ["zebra", "beta", "alpha"].map((slug) => ({
      fields: {
        slug,
        title: `T-${slug}`,
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: slug, range: null },
    }));
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            // Server returns in REVERSE-ID order with IDENTICAL scores. Without
            // the tie-break, slice(0, 2) keeps ["zebra", "beta"] (server's
            // first 2). With the tie-break, slice(0, 2) keeps ["alpha", "beta"]
            // — the two lexicographically smallest IDs.
            results: [
              hit({ slug: "zebra", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.5 } }),
              hit({ slug: "beta", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.5 } }),
              hit({ slug: "alpha", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.5 } }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: rows } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", limit: 2, print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    // Canonical order: lexicographically smallest "(type::slug)" IDs first.
    // alpha < beta < zebra under "design::<slug>".
    expect(lines[0]).toContain("alpha");
    expect(lines[1]).toContain("beta");
    // And the dropped hit ("zebra") must not have leaked into either line.
    expect(lines.join("\n")).not.toContain("zebra");
  });

  test("score-missing tie at -1 still produces a canonical (id ASC) ordering", async () => {
    // Companion to the score-tie case above. When the server omits
    // metadata.score on every hit, `resolved.sort` defaults each side to -1,
    // every comparison resolves to 0 (wholesale tie), and the pre-fix sort
    // is a stable no-op over server order. The tie-break must kick in here
    // exactly as it does for genuine equal scores.
    const rows = ["zebra", "alpha"].map((slug) => ({
      fields: {
        slug,
        title: `T-${slug}`,
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: slug, range: null },
    }));
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                schema_name: DESIGN_HASH,
                schema_display_name: "Design",
                field: "body",
                key_value: { hash: "zebra", range: null },
                value: "fragment",
                // no metadata.score on either hit
              },
              {
                schema_name: DESIGN_HASH,
                schema_display_name: "Design",
                field: "body",
                key_value: { hash: "alpha", range: null },
                value: "fragment",
              },
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: rows } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("alpha");
    expect(lines[1]).toContain("zebra");
  });

  test("applies -n limit", async () => {
    const rows = ["a", "b", "c", "d"].map((slug) => ({
      fields: {
        slug,
        title: `T-${slug}`,
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: slug, range: null },
    }));
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: rows.map((r, i) =>
              hit({
                slug: r.fields.slug,
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.9 - i * 0.1 },
              }),
            ),
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: rows } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "x", limit: 2, print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    // Highest-scoring first.
    expect(lines[0]).toContain("a");
    expect(lines[1]).toContain("b");
  });

  test("--exact passes ?exact=true on the wire", async () => {
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({ cfg, query: "blue", exact: true, print: () => {} });
    expect(capturedUrl).toContain("exact=true");
  });

  test("--min-score passes ?min_score on the wire", async () => {
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({ cfg, query: "blue", minScore: 0.6, print: () => {} });
    expect(capturedUrl).toContain("min_score=0.6");
  });

  test("scopes the search to fbrain's registered schema hashes (G3d)", async () => {
    // Regression guard for phase-7-search-latency-spike.md (H2b): the
    // search command must always send `schemas=...` so a shared homebrew
    // daemon's other schemas can't drown out fbrain hits in the top-50.
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({ cfg, query: "x", print: () => {} });
    const parsed = new URL(capturedUrl, "http://example/");
    const schemas = parsed.searchParams.get("schemas");
    expect(schemas).not.toBeNull();
    const sent = (schemas ?? "").split(",").filter((s) => s.length > 0);
    // Every test-config schema hash must be present on the wire.
    for (const h of Object.values(cfg.schemaHashes)) {
      expect(sent).toContain(h);
    }
  });

  test("--type design restricts the schemas filter to the design hash and drops non-design hits", async () => {
    // Mixed fixture: one design + one concept come back from the vector index.
    // With --type design, the schemas= param on the wire must contain ONLY the
    // design hash, and the concept hit must not appear in the printed output.
    const designRow = {
      fields: {
        slug: "the-readiness-gate",
        title: "Readiness Gate",
        body: "design body",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "the-readiness-gate", range: null },
    };
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "the-readiness-gate",
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.9 },
              }),
              // Same slug shape as agent-pr-events-* noise — concept on the
              // shared MEMO hash. Must NOT appear after --type design.
              hit({
                slug: "agent-pr-events-noise",
                schemaName: TEST_HASHES.concept,
                schema_display_name: "FbrainKindNote",
                metadata: { score: 0.95 },
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [designRow] } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({
      cfg,
      query: "readiness",
      types: ["design"],
      print: (l) => lines.push(l),
    });
    // The wire only carries the design hash — none of the other 7 type hashes.
    const parsed = new URL(capturedUrl, "http://example/");
    const sent = (parsed.searchParams.get("schemas") ?? "").split(",").filter(Boolean);
    expect(sent).toEqual([DESIGN_HASH]);
    // Output contains the design slug; the concept noise is filtered out.
    const joined = lines.join("\n");
    expect(joined).toContain("the-readiness-gate");
    expect(joined).not.toContain("agent-pr-events-noise");
  });

  test("--type design --type task sends both hashes on the wire (dedup'd)", async () => {
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({
      cfg,
      query: "x",
      types: ["design", "task", "design"],
      print: () => {},
    });
    const parsed = new URL(capturedUrl, "http://example/");
    const sent = (parsed.searchParams.get("schemas") ?? "").split(",").filter(Boolean);
    // Order follows the cfg.schemaHashes iteration; assert membership +
    // dedup rather than pinning order.
    expect(new Set(sent)).toEqual(new Set([DESIGN_HASH, TASK_HASH]));
    expect(sent.length).toBe(2);
  });

  test("--type filter drops a resolved hit whose type didn't match (Phase 6 MEMO case)", async () => {
    // Simulate a daemon where concept + preference both live on the same
    // canonical hash, and the user filters by --type preference. The shared
    // hash means the server returns BOTH on the wire, and only the
    // resolved-type post-filter can keep just preferences.
    const sharedHash = TEST_HASHES.concept; // any non-design/task hash
    const sharedCfg = buildTestCfg({
      schemaHashes: {
        ...TEST_HASHES,
        concept: sharedHash,
        preference: sharedHash,
      },
    });
    // findBySlug looks at listRecords' kind filter to distinguish concept
    // vs preference — but recordTypeForHash returns the FIRST type matching
    // the hash, which in iteration order is "concept". So the resolved
    // type is "concept" → the --type=preference filter drops it.
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "a-note",
                schemaName: sharedHash,
                schema_display_name: "FbrainKindNote",
                metadata: { score: 0.5 },
              }),
            ],
            user_hash: sharedCfg.userHash,
          },
        };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({
      cfg: sharedCfg,
      query: "x",
      types: ["preference"],
      print: (l) => lines.push(l),
    });
    expect(lines[0]).toBe("no matches");
  });

  test("does not duplicate a record when its fragments disagree on schema_display_name", async () => {
    // End-to-end version of the dedupeHits regression. The server returns
    // two fragments of the SAME design ("alpha"), one with
    // schema_display_name="Design" and one with schema_display_name=null
    // (legal per the wire type). Pre-fix the dedupe-key fallback put them
    // under distinct keys, both survived dedupe, both resolved via
    // findBySlug to the same record, and the printed output carried
    // "alpha" twice. The fix collapses them by schema hash.
    const recordRow = {
      fields: {
        slug: "alpha",
        title: "Alpha design",
        body: "blueberry octopus",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "alpha", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "alpha",
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.4 },
              }),
              hit({
                slug: "alpha",
                schemaName: DESIGN_HASH,
                schema_display_name: null,
                metadata: { score: 0.6 },
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow] } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "blueberry", print: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("alpha");
    // The kept fragment's score must be the higher of the two (0.6, not 0.4).
    expect(lines[0]).toContain("0.600");
  });

  test("annotates with a weak-match note when the top score is below the confidence line", async () => {
    // Without a confidence signal a gibberish query that matches NOTHING
    // still returns the user's brain ranked by tiny cosine scores —
    // indistinguishable from a real hit list. Clean-room dogfood (3 records,
    // 2026-06-06) showed pure noise tops out ~0.24 while real matches sit
    // ~0.45+, so when the TOP score is below 0.35 we prepend a note that
    // tells the user the rows are weak. We never drop rows (Option A), so a
    // real-but-distant match in a large brain is still surfaced; the note
    // just disambiguates "showing the closest we found" from "this nailed it".
    const recordRow = {
      fields: {
        slug: "ship-it",
        title: "Ship the thing",
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "ship-it", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "ship-it",
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.24 },
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow] } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "qwxz pqrlmn vbnghj", print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^note:\s/);
    expect(lines[0]).toContain("no strong matches");
    expect(lines[0]).toContain("qwxz pqrlmn vbnghj");
    expect(lines[0]).toContain("fbrain ask");
    // The row itself is still printed; the note is strictly additive.
    expect(lines[1]).toContain("ship-it");
    expect(lines[1]).toContain("0.240");
  });

  test("does NOT annotate when the top score is above the confidence line (no false positive on a real match)", async () => {
    // Companion: a genuinely good top match must NOT trigger the weak-match
    // note. Pin a real-match-band score (0.579 from the same dogfood — a
    // concept hit on "OAuth security tokens") and assert the note is absent
    // even if lower-ranked rows fall under the threshold. Threshold is
    // evaluated against the TOP score only.
    const rows = ["my-first-note", "auth-redesign", "ship-it"].map((slug) => ({
      fields: {
        slug,
        title: `T-${slug}`,
        body: "...",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: slug, range: null },
    }));
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "my-first-note", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.579 } }),
              hit({ slug: "auth-redesign", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.445 } }),
              hit({ slug: "ship-it", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.102 } }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: rows } };
      }
      return { status: 404 };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "OAuth security tokens", print: (l) => lines.push(l) });
    // Three rows, NO note.
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toMatch(/^note:\s/);
    }
    expect(lines[0]).toContain("my-first-note");
  });

  test("explicit --min-score still filters server-side and the empty-state path is unchanged", async () => {
    // Sanity check that the weak-note path doesn't displace the existing
    // explicit `--min-score` contract: the value still rides the wire on
    // `?min_score=...`, and when the server returns zero rows the existing
    // "no matches" + reindex hint is what the user sees.
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({
      cfg,
      query: "qwxz pqrlmn vbnghj",
      minScore: 0.4,
      print: (l) => lines.push(l),
    });
    expect(capturedUrl).toContain("min_score=0.4");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toMatch(/^hint:\s/);
    expect(lines[1]).toContain("fbrain ask <query> --no-llm");
  });

  test("omits ?schemas when the config carries no schema hashes", async () => {
    // A pathological empty-config case shouldn't send `schemas=` at all
    // (that would be a no-op on fold, but it pollutes the URL and obscures
    // the user-facing scope verbose message). The default mock cfg has
    // every hash populated, so build a stripped one.
    const emptyCfg = buildTestCfg({
      schemaHashes: {
        design: "",
        task: "",
        concept: "",
        preference: "",
        reference: "",
        agent: "",
        project: "",
        spike: "",
      },
    });
    let capturedUrl = "";
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [], user_hash: emptyCfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    await searchCmd({ cfg: emptyCfg, query: "x", print: () => {} });
    expect(capturedUrl).not.toContain("schemas=");
  });
});

beforeEach(() => {});
