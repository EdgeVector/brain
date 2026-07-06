// Regression: the BM25 keyword-rescue fallback must stay TRUTHFUL about
// confidence. Before this fix, when the native vector result set was weak (or
// empty) and the fallback fired, the swap set `weakMatch = false` — so every
// rescue row came out `confidence: "strong"` and the MCP `fbrain_search` tool
// derived `confident: true` from a noise-floor keyword rescue. A gibberish
// query looked exactly as trustworthy as a real hit.
//
// The honest contract (this card):
//   1. Rescue rows are labeled `fallback`, never `strong` — so any consumer
//      that computes `confident = matches.every(m => m.confidence === "strong")`
//      (the MCP server's `confidenceFromMatches`) reads them as NOT confident.
//   2. The fallback MERGES with native by `type::slug` (rescue rows first) —
//      it does not wholesale-replace, and cross-type slug collisions stay
//      distinct.
//   3. Weak-match is classified over the FULL resolved list, before the
//      `--limit` slice.
//   4. `search` has a default limit (== ask's DEFAULT_LIMIT) so a fallback
//      can't print the whole corpus.
//   5. A genuinely strong query is unchanged: all rows `strong`, no note.

import { afterEach, describe, expect, test } from "bun:test";

import {
  searchCmd,
  SEARCH_DEFAULT_LIMIT,
  type SearchHitJson,
} from "../../src/commands/search.ts";
import { DEFAULT_LIMIT } from "../../src/commands/ask.ts";
import type { NativeIndexHit } from "../../src/client.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;
const TASK_HASH = TEST_HASHES.task;
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

type Row = {
  slug: string;
  title: string;
  body: string;
  schemaHash: string;
};

// Mirrors the MCP server's confidence derivation (confidenceFromMatches):
// confident ⇔ non-empty AND every row is `strong`.
const confidentFromPayload = (matches: readonly SearchHitJson[]): boolean =>
  matches.length > 0 && matches.every((m) => m.confidence === "strong");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Install a mock where the native vector search returns `nativeHits` and each
// /api/query returns the corpus rows whose schemaHash matches the requested
// schema_name (so the BM25 corpus is loaded per-type, realistically scoped).
function installMock(nativeHits: NativeIndexHit[], corpus: Row[]): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    let body: unknown = {};
    if (url.includes("/api/native-index/search")) {
      body = { ok: true, results: nativeHits, user_hash: cfg.userHash };
    } else if (url.includes("/api/query")) {
      const req = JSON.parse(String(init?.body ?? "{}")) as { schema_name?: string };
      const results = corpus
        .filter((r) => r.schemaHash === req.schema_name)
        .map((r) => ({
          fields: {
            slug: r.slug,
            title: r.title,
            body: r.body,
            status: "active",
            tags: [],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
          key: { hash: r.slug, range: null },
        }));
      body = { ok: true, results, total_count: results.length, returned_count: results.length };
    } else {
      return new Response(JSON.stringify({ error: "unknown" }), { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

async function run(
  query: string,
  extra: Parameters<typeof searchCmd>[0] extends infer O ? Partial<O> : never = {},
): Promise<{ payload: SearchHitJson[]; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let payload: SearchHitJson[] = [];
  await searchCmd({
    cfg,
    query,
    print: (l) => stdout.push(l),
    printErr: (l) => stderr.push(l),
    onResult: (p) => {
      payload = p;
    },
    ...extra,
  });
  return { payload, stdout, stderr };
}

describe("BM25 fallback confidence (honest labeling)", () => {
  test("SEARCH_DEFAULT_LIMIT is kept consistent with ask's DEFAULT_LIMIT", () => {
    expect(SEARCH_DEFAULT_LIMIT).toBe(DEFAULT_LIMIT);
  });

  test("gibberish query: native noise → rescue rows are `fallback`, never strong, and confident is false", async () => {
    // Native vector search returns a lone noise-floor hit (0.22 < NOISE_CEILING)
    // that does NOT contain the query term. BM25 finds a different record whose
    // body carries the rare token → it is surfaced as a `fallback` row.
    const nativeHits = [
      hit({ slug: "noise-note", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.22 } }),
    ];
    const corpus: Row[] = [
      { slug: "noise-note", title: "Noise", body: "totally unrelated prose", schemaHash: DESIGN_HASH },
      { slug: "rare-token-note", title: "Rare token", body: "the token zzqx913 lives here", schemaHash: DESIGN_HASH },
    ];
    installMock(nativeHits, corpus);
    const { payload, stderr } = await run("zzqx913");

    // The rescue match surfaces, honestly labeled `fallback` (NOT strong).
    const rescue = payload.find((m) => m.slug === "rare-token-note");
    expect(rescue).toBeDefined();
    expect(rescue!.confidence).toBe("fallback");
    // No row may claim `strong` for a rescue result set.
    expect(payload.every((m) => m.confidence !== "strong")).toBe(true);
    // MCP would derive confident:false.
    expect(confidentFromPayload(payload)).toBe(false);
    // The advisory fires.
    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(true);
  });

  test("native empty → pure fallback rows all labeled `fallback`, confident false", async () => {
    const corpus: Row[] = [
      { slug: "kw-a", title: "A", body: "findme keyword here", schemaHash: DESIGN_HASH },
      { slug: "kw-b", title: "B", body: "findme keyword also here", schemaHash: DESIGN_HASH },
    ];
    installMock([], corpus);
    const { payload } = await run("findme");
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.every((m) => m.confidence === "fallback")).toBe(true);
    expect(confidentFromPayload(payload)).toBe(false);
  });

  test("MERGES native + fallback by type::slug (does not wholesale-replace); rescue rows come first", async () => {
    // Native returns ONE weak vector hit (design::weak-native, 0.24). BM25
    // rescue finds a DIFFERENT new record (design::rescue-hit). The pre-fix
    // wholesale-replace would have dropped the native row entirely; the merge
    // keeps BOTH — rescue first (better answer for a weak native set), native
    // retained (not discarded), and no duplicate row.
    const nativeHits = [
      hit({ slug: "weak-native", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.24 } }),
    ];
    const corpus: Row[] = [
      { slug: "weak-native", title: "Weak native", body: "some body without the token", schemaHash: DESIGN_HASH },
      { slug: "rescue-hit", title: "Rescue", body: "contains splunkword clearly", schemaHash: DESIGN_HASH },
    ];
    installMock(nativeHits, corpus);
    const { payload } = await run("splunkword", { limit: 10 });

    const slugs = payload.map((m) => m.slug);
    // Native row NOT discarded, rescue row added → both present, no dup.
    expect(slugs).toContain("weak-native");
    expect(slugs).toContain("rescue-hit");
    expect(new Set(slugs).size).toBe(slugs.length);
    // Rescue row ranks ahead of the weak native noise.
    expect(slugs.indexOf("rescue-hit")).toBeLessThan(slugs.indexOf("weak-native"));
    // Confidence is per-row and truthful.
    expect(payload.find((m) => m.slug === "rescue-hit")!.confidence).toBe("fallback");
    expect(payload.find((m) => m.slug === "weak-native")!.confidence).toBe("weak");
  });

  test("a Design and a Task sharing a slug are NOT collapsed by the dedupe (type::slug identity)", async () => {
    // Native returns a weak design::shared hit. BM25 corpus also has a
    // task::shared record that matches the query. A bare-slug dedupe would drop
    // the task rescue as a "duplicate" of the design row; the type::slug key
    // keeps them distinct so the real task match still surfaces.
    const nativeHits = [
      hit({ slug: "shared", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.24 } }),
    ];
    const corpus: Row[] = [
      { slug: "shared", title: "Design shared", body: "no matching token here", schemaHash: DESIGN_HASH },
      { slug: "shared", title: "Task shared", body: "the crossslug token is in the task", schemaHash: TASK_HASH },
    ];
    installMock(nativeHits, corpus);
    const { payload } = await run("crossslug", { limit: 10 });

    const taskShared = payload.find((m) => m.slug === "shared" && m.type === "task");
    expect(taskShared).toBeDefined();
    expect(taskShared!.confidence).toBe("fallback");
    // The native design::shared row is retained, distinct from the task rescue.
    const designShared = payload.find((m) => m.slug === "shared" && m.type === "design");
    expect(designShared).toBeDefined();
  });

  test("weak-match is classified over the FULL list, not the post-limit slice", async () => {
    // A flat noise band of 6 hits with a small --limit 2. If the classifier ran
    // on the 2-row slice it could mis-read the truncated head as a spike and
    // call it strong. Classifying over the full 6-row floor band keeps it weak.
    const scores = [0.443, 0.44, 0.438, 0.435, 0.431, 0.43];
    const nativeHits = scores.map((score, i) =>
      hit({ slug: `noise-${i}`, schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score } }),
    );
    const corpus: Row[] = scores.map((_, i) => ({
      slug: `noise-${i}`,
      title: `Noise ${i}`,
      body: "flat noise band body",
      schemaHash: DESIGN_HASH,
    }));
    installMock(nativeHits, corpus);
    const { payload, stderr } = await run("qwxz9931 blarghonk", { limit: 2 });

    // Only 2 rows shown (limit), but both flagged weak from the full-list shape.
    expect(payload).toHaveLength(2);
    expect(payload.every((m) => m.confidence !== "strong")).toBe(true);
    expect(confidentFromPayload(payload)).toBe(false);
    expect(stderr.some((l) => l.includes("no strong matches"))).toBe(true);
  });

  test("default limit (no --limit) bounds a fallback so it can't print the whole corpus", async () => {
    // Native empty → pure BM25 rescue over a corpus far larger than the default
    // page. Without a default limit this printed every matching record.
    const bigCorpus: Row[] = Array.from({ length: 20 }, (_, i) => ({
      slug: `doc-${i}`,
      title: `Doc ${i}`,
      body: "commonword appears in every doc",
      schemaHash: DESIGN_HASH,
    }));
    installMock([], bigCorpus);
    const { payload } = await run("commonword");
    // Bounded to the default page size, not the whole 20-doc corpus.
    expect(payload.length).toBe(SEARCH_DEFAULT_LIMIT);
  });

  test("a strong query is unchanged: all rows strong, confident true, no note", async () => {
    // A top hit that clears STRONG_SCORE (0.5) on its own → no fallback, no
    // note, all rows strong.
    const nativeHits = [
      hit({ slug: "strong-hit", schemaName: DESIGN_HASH, schema_display_name: "Design", metadata: { score: 0.72 } }),
    ];
    const corpus: Row[] = [
      { slug: "strong-hit", title: "Strong", body: "the real answer body", schemaHash: DESIGN_HASH },
    ];
    installMock(nativeHits, corpus);
    const { payload, stderr } = await run("the real answer");
    expect(payload).toHaveLength(1);
    expect(payload[0]!.confidence).toBe("strong");
    expect(confidentFromPayload(payload)).toBe(true);
    expect(stderr.filter((l) => l.startsWith("note:"))).toHaveLength(0);
  });
});
