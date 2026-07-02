// Unit tests for the search command's fragment→record resolution +
// dedupe path. Uses a mocked fetch so we control the search and query
// responses without standing up a real node.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dedupeHits, isWeakMatch, searchCmd } from "../../src/commands/search.ts";
import type { NativeIndexHit } from "../../src/client.ts";
import { RECORD_TYPES } from "../../src/schemas.ts";
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

describe("isWeakMatch (distribution-shape weak-match classifier)", () => {
  // Mirrors the constants in src/commands/search.ts. Weak ⇔ top < STRONG and
  // either top < NOISE_CEILING (absolute floor) OR the bulk piles on the floor
  // (median − min < FLATNESS_GAP).
  const STRONG = 0.5;
  const GAP = 0.025;
  const NOISE = 0.3;
  const s = (...scores: (number | null)[]) => scores.map((score) => ({ score }));

  test("a flat floor band whose top is well above the old 0.35 cut is weak", () => {
    // The real-brain regression (live :9001 numbers): top 0.443 but the bulk
    // is pinned to the score floor — median − min ≈ 0, far under FLATNESS_GAP.
    expect(isWeakMatch(0.443, s(0.443, 0.334, 0.334, 0.334, 0.334), STRONG, GAP, NOISE)).toBe(true);
  });

  test("a top score at/above STRONG_SCORE is never weak, even on a flat floor", () => {
    expect(isWeakMatch(0.619, s(0.619, 0.347, 0.347, 0.346), STRONG, GAP, NOISE)).toBe(false);
    expect(isWeakMatch(0.5, s(0.5, 0.5, 0.5), STRONG, GAP, NOISE)).toBe(false);
  });

  test("a sub-STRONG hit list that grades up off the floor is NOT weak", () => {
    // Live "at-rest encryption master key": top 0.478, median 0.320, min 0.255
    // → median − min = 0.065 ≥ 0.025.
    expect(isWeakMatch(0.478, s(0.478, 0.42, 0.32, 0.28, 0.255), STRONG, GAP, NOISE)).toBe(false);
  });

  test("a lone sub-STRONG hit has no distribution → median == min → weak", () => {
    expect(isWeakMatch(0.24, s(0.24), STRONG, GAP, NOISE)).toBe(true);
    expect(isWeakMatch(0.48, s(0.48), STRONG, GAP, NOISE)).toBe(true);
  });

  test("null scores are excluded from the distribution, not treated as 0", () => {
    // Without filtering, nulls would crater the min and falsely lift median−min
    // above the gap. With filtering, a flat measurable band stays weak.
    expect(isWeakMatch(0.4, s(0.4, 0.39, 0.39, null, null), STRONG, GAP, NOISE)).toBe(true);
  });

  test("an even-length score set uses the mean of the two middle values", () => {
    // sorted [0.1, 0.2, 0.42, 0.45] → median (0.2+0.42)/2 = 0.31, min 0.1 →
    // median − min = 0.21 ≥ 0.025 → graded by shape, not weak. Top 0.45 is also
    // above NOISE_CEILING, so the absolute floor does not fire either.
    expect(isWeakMatch(0.45, s(0.45, 0.42, 0.2, 0.1), STRONG, GAP, NOISE)).toBe(false);
  });

  // --- NOISE_CEILING (absolute low-top-score floor) — sparse new-dev brain ---

  test("sparse-brain noise: scattered low scores with top < NOISE_CEILING are weak even though the gap test fails", () => {
    // The regression this card fixes (dogfooded 2026-06-19, fresh 3-record
    // brain, query "zzqqxx nonexistent topic 99"): top 0.236, scores scattered
    // so median(0.223) − min(0.184) = 0.039 > FLATNESS_GAP → the shape test
    // alone would NOT flag it. The absolute floor (top < 0.30) catches it.
    expect(isWeakMatch(0.236, s(0.236, 0.223, 0.184), STRONG, GAP, NOISE)).toBe(true);
  });

  test("a genuine low-N real hit just above NOISE_CEILING is NOT over-fired", () => {
    // A real sub-STRONG hit lands ~0.45–0.49 (and even a borderline ~0.46 hit
    // is well above the 0.30 ceiling); with a graded distribution the shape
    // test also passes. NOISE_CEILING must not push these into weak.
    expect(isWeakMatch(0.46, s(0.46, 0.4, 0.34, 0.31), STRONG, GAP, NOISE)).toBe(false);
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

// Each result now prints as a table ROW followed by an indented body-snippet
// line (4-space prefix). Row-count / row-order assertions filter the snippet
// lines out with this helper; the snippet behavior is exercised by the
// dedicated "body snippet" describe block at the end of the file.
const rowsOf = (lines: string[]): string[] => lines.filter((l) => !l.startsWith("    "));

describe("searchCmd", () => {
  test("falls back to BM25 records when native vector results are weak", async () => {
    const rows = [
      {
        fields: {
          slug: "socket-note",
          title: "Socket transport note",
          body: "native vector search can be unavailable while query still works over the socket",
          status: "active",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        key: { hash: "socket-note", range: null },
      },
      {
        fields: {
          slug: "other-note",
          title: "Other note",
          body: "unrelated content",
          status: "active",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        key: { hash: "other-note", range: null },
      },
    ];
    installSequencedMock((url, init) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "other-note",
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.24, match_type: "semantic" },
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { schema_name?: string };
        return {
          status: 200,
          body: {
            ok: true,
            results: body.schema_name === DESIGN_HASH ? rows : [],
            total_count: body.schema_name === DESIGN_HASH ? rows.length : 0,
            returned_count: body.schema_name === DESIGN_HASH ? rows.length : 0,
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "vector socket",
      limit: 1,
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });

    expect(stderr).toEqual([]);
    const rowsOut = rowsOf(stdout);
    expect(rowsOut).toHaveLength(1);
    expect(rowsOut[0]).toContain("socket-note");
    expect(rowsOut[0]).toContain("—");
    expect(stdout.some((l) => l.includes("query still works over the socket"))).toBe(true);
  });

  test("falls back to BM25 records when native vector search returns no matches", async () => {
    const rows = [
      {
        fields: {
          slug: "rare-token-design",
          title: "Rare token design",
          body: "Exact fragment zzqx-913 should be findable by keyword fallback",
          status: "active",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        key: { hash: "rare-token-design", range: null },
      },
    ];
    installSequencedMock((url, init) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      if (url.includes("/api/query")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { schema_name?: string };
        return {
          status: 200,
          body: {
            ok: true,
            results: body.schema_name === DESIGN_HASH ? rows : [],
            total_count: body.schema_name === DESIGN_HASH ? rows.length : 0,
            returned_count: body.schema_name === DESIGN_HASH ? rows.length : 0,
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });

    const stdout: string[] = [];
    await searchCmd({
      cfg,
      query: "zzqx-913",
      limit: 1,
      print: (l) => stdout.push(l),
    });

    const rowsOut = rowsOf(stdout);
    expect(rowsOut).toHaveLength(1);
    expect(rowsOut[0]).toContain("rare-token-design");
    expect(rowsOut[0]).toContain("—");
    expect(stdout.join("\n")).not.toContain("no matches");
  });

  test("does not replace strong native vector results with BM25 keyword hits", async () => {
    const rows = [
      {
        fields: {
          slug: "semantic-winner",
          title: "Semantic winner",
          body: "This is the strong semantic result.",
          status: "active",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        key: { hash: "semantic-winner", range: null },
      },
      {
        fields: {
          slug: "keyword-only",
          title: "Keyword-only hit",
          body: "Contains zxq-strong-token but should not replace a confident vector result.",
          status: "active",
          tags: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        key: { hash: "keyword-only", range: null },
      },
    ];
    installSequencedMock((url, init) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "semantic-winner",
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                metadata: { score: 0.72, match_type: "semantic" },
              }),
            ],
            user_hash: cfg.userHash,
          },
        };
      }
      if (url.includes("/api/query")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { schema_name?: string };
        return {
          status: 200,
          body: {
            ok: true,
            results: body.schema_name === DESIGN_HASH ? rows : [],
            total_count: body.schema_name === DESIGN_HASH ? rows.length : 0,
            returned_count: body.schema_name === DESIGN_HASH ? rows.length : 0,
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });

    const stdout: string[] = [];
    await searchCmd({
      cfg,
      query: "zxq-strong-token",
      limit: 1,
      print: (l) => stdout.push(l),
    });

    const rowsOut = rowsOf(stdout);
    expect(rowsOut).toHaveLength(1);
    expect(rowsOut[0]).toContain("semantic-winner");
    expect(rowsOut[0]).toContain("0.720");
    expect(stdout.join("\n")).not.toContain("keyword-only");
  });

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
    const rows = rowsOf(lines);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("alpha");
    expect(rows[0]).toContain("0.420");
    expect(rows[0]).toContain("Design");
    expect(rows[0]).toContain("Alpha design");
    // The matching body snippet prints as an indented second line.
    expect(lines.some((l) => l.startsWith("    ") && l.includes("blueberry octopus"))).toBe(true);
  });

  test("falls back to local query search when native-index search is missing", async () => {
    const recordRow = {
      fields: {
        slug: "dogfood-native-index-404",
        title: "Dogfood native index fallback",
        body: "dogfood routines should still dedupe when native-index search returns 404",
        status: "active",
        tags: ["dogfood"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "dogfood-native-index-404", range: null },
    };
    installSequencedMock((url, init) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 404, body: "Not Found" };
      }
      if (url.includes("/api/query")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { schema_name?: string };
        const results = body.schema_name === DESIGN_HASH ? [recordRow] : [];
        return {
          status: 200,
          body: { ok: true, results, total_count: results.length, returned_count: results.length },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "dogfood native-index", print: (l) => lines.push(l) });
    const rows = rowsOf(lines);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("dogfood-native-index-404");
    expect(rows[0]).toContain("1.000");
    expect(rows[0]).toContain("Design");
    expect(rows[0]).toContain("Dogfood native index fallback");
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
    const rows = rowsOf(lines);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("flaky");
    expect(rows[0]).toContain("Flaky design");
  }, 10_000);

  test("hydrates ONCE per distinct schema, not once per hit (N+1 fix)", async () => {
    // The perf fix this card lands. Pre-fix, search hydrated each deduped hit
    // with its own `findBySlugFast` — and that helper fetches the WHOLE schema
    // page via /api/query and client-filters for one slug. So N hits on one
    // schema issued N identical full-schema fetches (the ~25–29 s live-brain
    // latency, dogfood run 115). The fix groups hits by schema hash and fetches
    // each DISTINCT schema exactly once. Here: 5 Design hits + 3 Task hits = 8
    // hits across 2 distinct schemas must issue exactly 2 /api/query POSTs, not
    // 8. We count POSTs PER schema_name so the assertion pins both the total
    // (K, not N) and the one-per-schema invariant.
    const mkRow = (slug: string, title: string) => ({
      fields: {
        slug,
        title,
        body: `body for ${slug}`,
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: slug, range: null },
    });
    const designRows = ["d1", "d2", "d3", "d4", "d5"].map((s) => mkRow(s, `Design ${s}`));
    const taskRows = ["t1", "t2", "t3"].map((s) => mkRow(s, `Task ${s}`));
    const searchHits = [
      ...designRows.map((r) =>
        hit({ slug: r.fields.slug, schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.6 } }),
      ),
      ...taskRows.map((r) =>
        hit({ slug: r.fields.slug, schemaName: TASK_HASH, schema_display_name: "Task", metadata: { score: 0.55 } }),
      ),
    ];
    // POST count keyed by the schema_name the /api/query body targets.
    const queryCallsBySchema = new Map<string, number>();
    installSequencedMock((url, init) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: searchHits, user_hash: cfg.userHash } };
      }
      if (url.includes("/api/query")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { schema_name?: string };
        const schema = body.schema_name ?? "";
        queryCallsBySchema.set(schema, (queryCallsBySchema.get(schema) ?? 0) + 1);
        const rows = schema === DESIGN_HASH ? designRows : schema === TASK_HASH ? taskRows : [];
        return { status: 200, body: { ok: true, results: rows, total_count: rows.length, returned_count: rows.length } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "anything", print: (l) => lines.push(l) });
    // Exactly ONE hydrate fetch per distinct schema — the whole point of the fix.
    expect(queryCallsBySchema.get(DESIGN_HASH)).toBe(1);
    expect(queryCallsBySchema.get(TASK_HASH)).toBe(1);
    // K=2 distinct schemas, not N=8 hits.
    const totalQueryCalls = [...queryCallsBySchema.values()].reduce((a, b) => a + b, 0);
    expect(totalQueryCalls).toBe(2);
    // …and all 8 hits still resolved + printed (no row lost to the batching).
    const rows = rowsOf(lines);
    expect(rows.length).toBe(8);
    for (const r of [...designRows, ...taskRows]) {
      expect(rows.some((row) => row.includes(r.fields.slug))).toBe(true);
    }
  });

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
    // The stale hit resolves to nothing AND the brain holds no live record
    // (every /api/query page is empty) → the empty-brain hint, not the
    // fresh-write-latency one.
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toContain("no records yet");
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
    // Unregistered-schema hit is dropped AND no live record exists → empty-brain hint.
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toContain("no records yet");
    expect(lines).toHaveLength(2);
  });

  test("empty result on a POPULATED brain prints the fresh-write-latency hint pointing at `fbrain ask`", async () => {
    // Vector index has freshness lag (G3a/G3b per phase-7-search-latency-spike.md).
    // On a brain that DOES hold records, a "no matches" interactively shouldn't
    // leave the user thinking the record isn't there — BM25 (via the default
    // `fbrain ask`) often catches it. The empty-brain probe must therefore see
    // a live row so this populated-but-no-match path keeps the latency hint.
    const liveRow = {
      fields: {
        slug: "an-existing-record",
        title: "Already here",
        body: "unrelated body",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "an-existing-record", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      if (url.includes("/api/query")) {
        // The empty-brain probe queries /api/query — return a live record so
        // the brain reads as NON-empty.
        return { status: 200, body: { ok: true, results: [liveRow] } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "papercut", print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toMatch(/^hint:\s/);
    expect(lines[1]).toContain("fbrain ask <query>");
    expect(lines[1]).toContain("BM25 + vector hybrid");
  });

  test("empty result on a brand-new EMPTY brain points the new dev at creating their first record", async () => {
    // The new-developer cut this card fixes: the init next-steps tell a fresh
    // dev to run `fbrain search "<term>"` (step 3) before they've created
    // anything. On a zero-record brain every /api/query page is empty, so the
    // hint must be the calm "create your first record" — NOT the misleading
    // fresh-write-latency / `fbrain reindex` advice (nothing is indexed and
    // nothing to reindex).
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      // Empty brain: every schema page comes back with no rows.
      return { status: 200, body: { ok: true, results: [] } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "anything", print: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("no matches");
    expect(lines[1]).toMatch(/^hint:\s/);
    expect(lines[1]).toContain("no records yet");
    expect(lines[1]).toContain("fbrain <type> new <slug>");
    // The misleading latency / reindex advice must be gone on an empty brain.
    expect(lines[1]).not.toContain("reindex");
    expect(lines[1]).not.toContain("fresh writes");
  });

  test("empty-state hint on an empty brain routes to stderr under --json so stdout stays `[]`", async () => {
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "anything",
      json: true,
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    // Stdout is a single parseable empty array — jq pipelines stay clean.
    expect(stdout).toEqual(["[]"]);
    // The empty-state hint lands on stderr.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("no records yet");
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
    const printedRows = rowsOf(lines);
    expect(printedRows).toHaveLength(2);
    // Canonical order: lexicographically smallest "(type::slug)" IDs first.
    // alpha < beta < zebra under "design::<slug>".
    expect(printedRows[0]).toContain("alpha");
    expect(printedRows[1]).toContain("beta");
    // And the dropped hit ("zebra") must not have leaked into any line.
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
    const printedRows = rowsOf(lines);
    expect(printedRows).toHaveLength(2);
    expect(printedRows[0]).toContain("alpha");
    expect(printedRows[1]).toContain("zebra");
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
    const printedRows = rowsOf(lines);
    expect(printedRows).toHaveLength(2);
    // Highest-scoring first.
    expect(printedRows[0]).toContain("a");
    expect(printedRows[1]).toContain("b");
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
    // Every user-facing record schema hash must be present on the wire; the
    // internal TagIndex schema is not semantically searched.
    for (const type of RECORD_TYPES) {
      expect(sent).toContain(cfg.schemaHashes[type]!);
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
    const rows = rowsOf(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("alpha");
    // The kept fragment's score must be the higher of the two (0.6, not 0.4).
    expect(rows[0]).toContain("0.600");
  });

  test("annotates with a weak-match note when the top score is below the confidence line", async () => {
    // Without a confidence signal a gibberish query that matches NOTHING
    // still returns the user's brain ranked by tiny cosine scores —
    // indistinguishable from a real hit list. A lone hit at 0.24 is below the
    // STRONG_SCORE ceiling (0.5) and has no pack to separate from (median ==
    // top, gap 0 < SEPARATION_GAP), so it is flagged weak: we prepend a note
    // telling the user the rows are weak. We never drop rows (Option A), so a
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "qwxz pqrlmn vbnghj",
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    // Stdout carries the parseable result row (+ its indented snippet line) —
    // the advisory `note:` line goes to stderr so `fbrain search q 2>/dev/null`
    // (or any line-oriented parse) never sees a note among the result rows.
    const rows = rowsOf(stdout);
    expect(rows).toHaveLength(1);
    for (const line of stdout) expect(line).not.toMatch(/^note:\s/);
    expect(rows[0]).toContain("ship-it");
    expect(rows[0]).toContain("0.240");
    // Note lands on stderr.
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^note:\s/);
    expect(stderr[0]).toContain("no strong matches");
    expect(stderr[0]).toContain("qwxz pqrlmn vbnghj");
    expect(stderr[0]).toContain("fbrain ask");
  });

  test("weak-match note names the `fbrain_ask` tool (not the CLI string) on the agent channel", async () => {
    // The MCP `fbrain_search` handler sets `agent: true` and routes printErr
    // into the agent content sink, so this advisory reaches an agent that has
    // no shell. Telling it to run `fbrain ask <query>` is a dead-end — the
    // agent-voiced variant must name the `fbrain_ask` TOOL instead, mirroring
    // the empty/no-match hint. The human (default) path is byte-identical and
    // still carries the CLI verb (covered by the test above).
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "qwxz pqrlmn vbnghj",
      agent: true,
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^note:\s/);
    expect(stderr[0]).toContain("no strong matches");
    // The agent path names the TOOL, never the CLI command string.
    expect(stderr[0]).toContain("`fbrain_ask` tool");
    expect(stderr[0]).toContain("(BM25 + vector hybrid)");
    expect(stderr[0]).not.toContain("fbrain ask <query>");
  });

  test("does NOT annotate when the top score is above the confidence line (no false positive on a real match)", async () => {
    // Companion: a genuinely good top match must NOT trigger the weak-match
    // note. Pin a real-match-band score (0.579 from the same dogfood — a
    // concept hit on "OAuth security tokens"), which clears the STRONG_SCORE
    // ceiling (0.5) on its own, and assert the note is absent even though the
    // lower-ranked rows trail far behind.
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "OAuth security tokens",
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    // Three result rows on stdout, NO note on either sink.
    const printedRows = rowsOf(stdout);
    expect(printedRows).toHaveLength(3);
    for (const line of stdout) {
      expect(line).not.toMatch(/^note:\s/);
    }
    expect(stderr).toHaveLength(0);
    expect(printedRows[0]).toContain("my-first-note");
  });

  test("fires the weak-match note on a realistic flat noise band whose top score is well above 0.35", async () => {
    // The brain-size regression this card fixes: on a real brain (hundreds of
    // records) the nearest neighbour to even pure gibberish lands at a cosine
    // ABOVE the old absolute 0.35 cut, so the advisory silently never fired and
    // a no-match query was indistinguishable from a real hit (dogfooded
    // 2026-06-16 on :9001: gibberish topped out 0.443). The separation signal
    // catches it: a flat band (top 0.443, the pack clustered just below at
    // 0.44/0.435/0.43) is NOT a spike — top − median ≈ 0.01 < SEPARATION_GAP —
    // so the note fires even though every score is comfortably above 0.35.
    const scores = [0.443, 0.44, 0.438, 0.435, 0.431];
    const slugs = scores.map((_, i) => `noise-${i}`);
    const rows = slugs.map((slug) => ({
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
            results: scores.map((score, i) =>
              hit({ slug: slugs[i]!, schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score } }),
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "qwxz9931 blarghonk zztopflux",
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    // All five result rows printed (we never drop rows), advisory on stderr.
    expect(rowsOf(stdout)).toHaveLength(5);
    for (const line of stdout) expect(line).not.toMatch(/^note:\s/);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("no strong matches");
    expect(stderr[0]).toContain("qwxz9931 blarghonk zztopflux");
  });

  test("does NOT fire when a sub-0.5 hit list grades up off the floor", async () => {
    // The mirror case: a genuine match in a large brain can land below the
    // STRONG_SCORE ceiling (0.5) yet still produce a graded distribution that
    // climbs off the score floor — the live "at-rest encryption master key"
    // shape (top 0.478, median ~0.32, min ~0.255 → median − min ≈ 0.065 ≥
    // FLATNESS_GAP). Reads as a real hit, so the note is suppressed.
    const scores = [0.478, 0.42, 0.32, 0.28, 0.255];
    const slugs = scores.map((_, i) => `spike-${i}`);
    const rows = slugs.map((slug) => ({
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
            results: scores.map((score, i) =>
              hit({ slug: slugs[i]!, schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score } }),
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "a real but distant memory",
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    expect(rowsOf(stdout)).toHaveLength(5);
    expect(stderr).toHaveLength(0);
    for (const line of stdout) expect(line).not.toMatch(/^note:\s/);
  });

  test("--exact suppresses the weak-match note even when cosine scores fall below the confidence line", async () => {
    // Regression: the weak-match note classifies a hit list "no strong matches"
    // by separation (top cosine not meaningfully above the median). That
    // heuristic is meaningful for semantic search — a gibberish query that hits
    // nothing semantically still gets ranked by a flat band of tiny cosines. It
    // is meaningless for
    // `--exact`: the daemon's exact filter (fold_db_node/handlers/query.rs
    // `filter_by_exact_substring`) is a strict case-insensitive substring keep
    // applied AFTER the semantic top-50 cut, so every surviving hit is by
    // definition a literal text match. The cosine carried on the wire is the
    // semantic relatedness of that fragment to the query, not a confidence
    // signal about the match — a query word buried in a long doc can land at
    // cosine 0.15 while still being a real, exact, "this nailed it" hit.
    //
    // Pre-fix the search command annotated such hits with
    //   note: no strong matches for "foo" — showing closest by similarity.
    //   Try different terms or `fbrain ask <query>` for keyword search.
    // — flatly contradicting the user (they DID find the literal term) and
    // recommending the hybrid-semantic `fbrain ask` (the WRONG tool when the
    // user already opted out of semantic recall via --exact).
    const recordRow = {
      fields: {
        slug: "long-design",
        title: "An essay on something else",
        body: "a long body that happens to mention blueberry once near the end",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "long-design", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({
                slug: "long-design",
                schemaName: DESIGN_HASH,
                schema_display_name: "Design",
                value: "a long body that happens to mention blueberry once near the end",
                // Semantic cosine is below the weak-match threshold even though
                // the daemon's `filter_by_exact_substring` already certified
                // the value contains "blueberry".
                metadata: { score: 0.15, match_type: "semantic" },
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
    const stdout: string[] = [];
    const stderr: string[] = [];
    await searchCmd({
      cfg,
      query: "blueberry",
      exact: true,
      print: (l) => stdout.push(l),
      printErr: (l) => stderr.push(l),
    });
    // The row is printed; the weak-match note is suppressed in --exact mode.
    const rows = rowsOf(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("long-design");
    expect(rows[0]).toContain("0.150");
    // No advisory note on either sink.
    expect(stderr).toHaveLength(0);
    for (const line of rows) {
      expect(line).not.toMatch(/^note:\s/);
      expect(line).not.toContain("no strong matches");
      expect(line).not.toContain("fbrain ask");
    }
  });

  test("explicit --min-score still filters server-side and the empty-state path is intact", async () => {
    // Sanity check that the weak-note path doesn't displace the existing
    // explicit `--min-score` contract: the value still rides the wire on
    // `?min_score=...`, and when the server returns zero rows the user still
    // sees "no matches" + a hint. The brain here is empty (every /api/query
    // page is empty), so the hint is the empty-brain "no records yet" form.
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
    expect(lines[1]).toContain("no records yet");
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

  test("prints a matching body snippet under each hit and carries it in --json/onResult", async () => {
    // The headline UX this card delivers: the answer is visible inline under
    // the result row (no follow-up `fbrain get`), and the SAME snippet rides
    // the structured `onResult` payload (so `--json` and MCP carry it too).
    const recordRow = {
      fields: {
        slug: "caching-decision",
        title: "Caching layer decision",
        body: "# Caching layer decision\n\nDecision: we picked a 5-minute TTL for the cache after the dogfood.",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "caching-decision", range: null },
    };
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              hit({ slug: "caching-decision", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.62 } }),
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
    let payload: import("../../src/commands/search.ts").SearchHitJson[] | undefined;
    await searchCmd({
      cfg,
      query: "TTL",
      print: (l) => lines.push(l),
      onResult: (p) => {
        payload = p;
      },
    });
    // Human render: row + an indented snippet line under it.
    const rows = rowsOf(lines);
    expect(rows).toHaveLength(1);
    const snippetLine = lines.find((l) => l.startsWith("    "));
    expect(snippetLine).toBeDefined();
    // The matched term shows inline; the H1 (== the title) is stripped so the
    // snippet isn't just the title echoed.
    expect(snippetLine!).toContain("5-minute TTL");
    expect(snippetLine!).not.toContain("Caching layer decision");
    // Structured payload carries the SAME snippet.
    expect(payload).toBeDefined();
    expect(payload![0]!.snippet).toContain("5-minute TTL");
    expect(payload![0]!.snippet).not.toContain("Caching layer decision");
  });

  // ── TTY column legend ──────────────────────────────────────────────────
  // A dim, one-line legend names the columns and flags that `search`'s 0–1
  // cosine is NOT comparable to `ask`'s fused RRF. It rides the STDOUT stream
  // (same as the rows) but is HUMAN-ONLY: present only on an interactive TTY,
  // absent under `--json` and when stdout is piped/redirected, so first-line
  // parsers and agent consumers see byte-identical rows.
  const installSingleHitMock = (): void => {
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
  };

  test("prints a TTY column legend above the rows, on the stdout stream", async () => {
    installSingleHitMock();
    const lines: string[] = [];
    await searchCmd({ cfg, query: "blueberry", print: (l) => lines.push(l), isTty: () => true });
    // The legend is the first stdout line, labels the columns, and names the
    // cosine scale — so a first-time human knows the leading 1.000 is a cosine.
    expect(lines[0]).toContain("columns:");
    expect(lines[0]).toContain("relevance");
    expect(lines[0]).toContain("cosine");
    // It is dim (ANSI 2m) and never reaches a pipe (off-TTY path drops it).
    expect(lines[0]).toContain("\x1b[2m");
    // The actual result row is unchanged and still present below it.
    const rows = rowsOf(lines).filter((l) => !l.includes("columns:"));
    expect(rows[0]).toContain("alpha");
    expect(rows[0]).toContain("0.420");
  });

  test("suppresses the legend when stdout is NOT a TTY (piped/redirected)", async () => {
    installSingleHitMock();
    const lines: string[] = [];
    await searchCmd({ cfg, query: "blueberry", print: (l) => lines.push(l), isTty: () => false });
    // No legend; first stdout line is the result row, byte-identical to the
    // pre-change output (so first-line parsers are unaffected).
    expect(lines.some((l) => l.includes("columns:"))).toBe(false);
    expect(lines.some((l) => l.includes("\x1b["))).toBe(false);
    expect(lines[0]).toContain("alpha");
    expect(lines[0]).toContain("0.420");
  });

  test("suppresses the legend under --json even on a TTY", async () => {
    installSingleHitMock();
    const lines: string[] = [];
    await searchCmd({ cfg, query: "blueberry", json: true, print: (l) => lines.push(l), isTty: () => true });
    // --json stdout is exactly one JSON array document — no legend line.
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.includes("columns:"))).toBe(false);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  test("no legend on an empty/no-match result, even on a TTY", async () => {
    installSequencedMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [], user_hash: cfg.userHash } };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [], total_count: 0, returned_count: 0 } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const lines: string[] = [];
    await searchCmd({ cfg, query: "nothingmatchesthis", print: (l) => lines.push(l), isTty: () => true });
    // The no-match hint path runs; no legend above it.
    expect(lines.some((l) => l.includes("columns:"))).toBe(false);
  });
});

beforeEach(() => {});
