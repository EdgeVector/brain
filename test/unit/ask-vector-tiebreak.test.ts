// Regression: ask.ts assigns vector ranks via a score-only sort with no
// id tie-break, so two vector hits at the same cosine score keep server
// response order. That order propagates into RRF as the per-doc vector
// rank, and a tied doc that lands at vector-rank 1 in one response
// ordering and vector-rank 2 in another ends up with different fused
// scores — flipping the final `fbrain ask` output for the SAME query +
// corpus + hit set just because the server returned the tied fragments
// in a different order.
//
// Same shape as PR #79 (deterministic RRF tie-break by id) and PR #101
// (deterministic BM25 search tie-break by id), one layer up. Both
// existing layers now end with `... || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)`;
// the vector rank-assignment sort is the third layer of the same pattern.
//
// Realistic trigger: the embedding model returns continuous scores so
// genuine ties are rare, BUT the defensive code path treats a missing
// `metadata.score` as 0 — so a server response with multiple
// score-missing fragments yields a wholesale tie. Either way: the
// pipeline must be order-invariant under tied vector scores.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askCmd } from "../../src/commands/ask.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const realFetch = globalThis.fetch;
let cacheDir = "";
let savedCacheEnv: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "fbrain-ask-vec-tie-test-"));
  savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.FBRAIN_CACHE_DIR = cacheDir;
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

function designRow(slug: string, body: string): RowFields {
  return {
    slug,
    title: `T-${slug}`,
    body,
    status: "draft",
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function vectorHit(schemaName: string, slug: string, score: number): Record<string, unknown> {
  return {
    schema_name: schemaName,
    schema_display_name: null,
    field: "body",
    key_value: { hash: slug, range: null },
    value: "fragment",
    metadata: { score, match_type: "semantic" },
  };
}

function installStub(opts: {
  designRows: RowFields[];
  vectorHits: Record<string, unknown>[];
}): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/query")) {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const schema = (body as { schema_name: string }).schema_name;
      const rows = schema === TEST_HASHES.design ? opts.designRows : [];
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
      return new Response(
        JSON.stringify({ ok: true, results: opts.vectorHits }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("askCmd vector rank tie-break determinism", () => {
  test("tied vector scores produce the same fused ordering regardless of server response order", async () => {
    // Two designs whose bodies do NOT contain the query term, so BM25
    // contributes nothing — the final ordering is driven entirely by the
    // vector ranks. Both vector hits tie at score=0.5; pre-fix, their
    // assigned ranks (and therefore their RRF contributions, 1/61 vs
    // 1/62) swap when the server returns the fragments in the opposite
    // order. The TOP RESULT flips with server order.
    const cfg = buildTestCfg();
    const designRows = [designRow("alpha", "elephant"), designRow("zebra", "elephant")];

    installStub({
      designRows,
      vectorHits: [
        vectorHit(TEST_HASHES.design, "alpha", 0.5),
        vectorHit(TEST_HASHES.design, "zebra", 0.5),
      ],
    });
    const a = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
    });

    installStub({
      designRows,
      vectorHits: [
        vectorHit(TEST_HASHES.design, "zebra", 0.5),
        vectorHit(TEST_HASHES.design, "alpha", 0.5),
      ],
    });
    const b = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
    });

    // Sanity: both runs returned the same two docs at the same set of
    // fused scores. The bug is purely about ORDER — neither run should
    // drop a result.
    expect(a.hits.map((h) => h.slug).sort()).toEqual(["alpha", "zebra"]);
    expect(b.hits.map((h) => h.slug).sort()).toEqual(["alpha", "zebra"]);

    // Load-bearing: identical slug ORDER. Pre-fix this failed — alpha
    // landed at rank 1 in run A (server returned it first) and rank 2 in
    // run B (server returned zebra first), so the top result swapped.
    expect(a.hits.map((h) => h.slug)).toEqual(b.hits.map((h) => h.slug));

    // And specifically: the id tie-break must put the lexicographically
    // smaller slug first ("design::alpha" < "design::zebra"), matching
    // the BM25 (PR #101) and RRF (PR #79) tie-break ordering one layer
    // down. Anchoring the absolute order pins the whole-pipeline contract,
    // not just the equality.
    expect(a.hits.map((h) => h.slug)).toEqual(["alpha", "zebra"]);
  });

  test("score-missing vector hits (all default to 0) are also order-invariant", async () => {
    // Companion case: the defensive code path treats a missing
    // metadata.score as 0, so a server response with N score-missing
    // fragments produces a wholesale N-way tie. Same bug, more realistic
    // trigger than two embeddings that happen to land on identical
    // floats. Build the hits without a `score` field.
    const cfg = buildTestCfg();
    const designRows = [designRow("alpha", "elephant"), designRow("zebra", "elephant")];

    const scorelessHit = (slug: string): Record<string, unknown> => ({
      schema_name: TEST_HASHES.design,
      schema_display_name: null,
      field: "body",
      key_value: { hash: slug, range: null },
      value: "fragment",
      metadata: { match_type: "semantic" },
    });

    installStub({
      designRows,
      vectorHits: [scorelessHit("alpha"), scorelessHit("zebra")],
    });
    const a = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
    });

    installStub({
      designRows,
      vectorHits: [scorelessHit("zebra"), scorelessHit("alpha")],
    });
    const b = await askCmd({
      cfg,
      query: "octopus",
      noLlm: true,
      print: () => {},
    });

    expect(a.hits.map((h) => h.slug)).toEqual(b.hits.map((h) => h.slug));
    expect(a.hits.map((h) => h.slug)).toEqual(["alpha", "zebra"]);
  });
});
