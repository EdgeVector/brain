// Offline eval of the graph adjacency boost over the SHIPPED fixture
// (`eval/graph/pairs.json`).
//
// `scripts/eval-graph-boost.ts` measures the boost against a live node. That
// is the number a human reads, but it cannot run in CI — CI has no node — so
// nothing would stop a change that quietly makes the boost useless or
// harmful. This test closes that hole: it runs the SAME fixture through the
// real BM25 ranker and the real boost, entirely in memory, and asserts the
// two properties the design gates promotion on.
//
//   1. Adjacency pairs improve. These are the queries whose answer carries
//      almost none of the query's words and is reachable in one hop.
//   2. Control pairs do not regress. These win on their own text; a boost
//      that trades them away is not an improvement, it is a different set of
//      wrong answers.
//
// The retrieval here is BM25-only, not the full BM25+vector hybrid the live
// harness exercises, so the absolute numbers are NOT the reported baseline —
// they are a floor that moves in the same direction. The live harness owns
// the headline figure.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BM25Index, type BM25Document } from "../../src/retrieval/bm25.ts";
import { reciprocalRankFusion, RRF_DEFAULT_K } from "../../src/retrieval/rrf.ts";
import { applyAdjacencyBoost } from "../../src/retrieval/adjacency.ts";
import { extractGraphEdges, type GraphEdge } from "../../src/graph-edge.ts";
import {
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
  isRecordType,
  type RecordType,
} from "../../src/schemas.ts";

type FixtureRecord = { slug: string; type: string; title: string; body: string; tags?: string[] };
type Pair = {
  query: string;
  expected_slug: string;
  expected_type: string;
  kind: "adjacency" | "control";
};
type Fixture = { slug_prefix: string; records: FixtureRecord[]; pairs: Pair[] };

const FIXTURE_PATH = join(import.meta.dir, "..", "..", "eval", "graph", "pairs.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

const OUT = "edge-out";
const IN = "edge-in";
const cfg = {
  schemaHashes: {
    [GRAPH_EDGE_OUT_SCHEMA_KEY]: OUT,
    [GRAPH_EDGE_IN_SCHEMA_KEY]: IN,
  },
} as any;

/**
 * The two keyed edge planes, built from the fixture bodies by the REAL
 * extractor — so a change to link parsing shows up here as a metric change,
 * not as a test that keeps passing against a hand-written edge list.
 */
function edgePlanes() {
  const edges: GraphEdge[] = [];
  for (const rec of fixture.records) {
    edges.push(...extractGraphEdges({ sourceSlug: rec.slug, body: rec.body }));
  }
  const rows = edges.map((e) => ({
    bge_src: e.src,
    bge_dst: e.dst,
    bge_type: e.type,
    bge_provenance: e.provenance,
    bge_created_at: e.created_at,
    bge_out_r: `${e.type}#${e.dst}`,
    bge_in_r: `${e.type}#${e.src}`,
  }));
  const node = {
    async queryAll({ schemaHash, filter }: any) {
      const key = filter?.HashKey;
      return {
        results: rows
          .filter((f) => (schemaHash === OUT ? f.bge_src === key : f.bge_dst === key))
          .map((fields) => ({ fields })),
      };
    },
  } as any;
  return { node, edgeCount: edges.length };
}

function bm25Index(): BM25Index {
  const docs: BM25Document[] = fixture.records.map((r) => ({
    type: r.type as RecordType,
    slug: r.slug,
    title: r.title,
    body: r.body,
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  return BM25Index.build(docs);
}

const K = 10;

type Ranked = { rank: number | null };

function rankOf(ids: readonly string[], expectedSlug: string): number | null {
  const idx = ids.findIndex((id) => id.slice(id.indexOf("::") + 2) === expectedSlug);
  return idx < 0 ? null : idx + 1;
}

function metrics(ranks: readonly Ranked[]) {
  const n = ranks.length;
  if (n === 0) return { p1: 0, p3: 0, p5: 0, mrr: 0, n };
  let p1 = 0;
  let p3 = 0;
  let p5 = 0;
  let mrr = 0;
  for (const r of ranks) {
    if (r.rank === null) continue;
    if (r.rank <= 1) p1++;
    if (r.rank <= 3) p3++;
    if (r.rank <= 5) p5++;
    mrr += 1 / r.rank;
  }
  return { p1: p1 / n, p3: p3 / n, p5: p5 / n, mrr: mrr / n, n };
}

async function measure(): Promise<{
  adjacency: { before: ReturnType<typeof metrics>; after: ReturnType<typeof metrics> };
  control: { before: ReturnType<typeof metrics>; after: ReturnType<typeof metrics> };
  movedUp: string[];
  movedDown: string[];
}> {
  const index = bm25Index();
  const { node } = edgePlanes();
  const before: Record<string, Ranked[]> = { adjacency: [], control: [] };
  const after: Record<string, Ranked[]> = { adjacency: [], control: [] };
  const movedUp: string[] = [];
  const movedDown: string[] = [];

  for (const pair of fixture.pairs) {
    const hits = index.search(pair.query, 25);
    const fused = reciprocalRankFusion(
      [{ label: "bm25", hits: hits.map((h) => ({ id: `${h.type}::${h.slug}`, rank: h.rank })) }],
      { k: RRF_DEFAULT_K },
    );
    const baselineIds = fused.slice(0, K).map((f) => f.id);
    const boosted = await applyAdjacencyBoost({ node, cfg, fused });
    const boostedIds = boosted.fused.slice(0, K).map((f) => f.id);

    const b = rankOf(baselineIds, pair.expected_slug);
    const a = rankOf(boostedIds, pair.expected_slug);
    before[pair.kind]!.push({ rank: b });
    after[pair.kind]!.push({ rank: a });
    const bScore = b ?? Number.POSITIVE_INFINITY;
    const aScore = a ?? Number.POSITIVE_INFINITY;
    if (aScore < bScore) movedUp.push(pair.expected_slug);
    if (aScore > bScore) movedDown.push(pair.expected_slug);
  }
  return {
    adjacency: { before: metrics(before.adjacency!), after: metrics(after.adjacency!) },
    control: { before: metrics(before.control!), after: metrics(after.control!) },
    movedUp,
    movedDown,
  };
}

describe("graph eval fixture", () => {
  test("is well-formed and large enough to report a rate on", () => {
    expect(fixture.pairs.length).toBeGreaterThanOrEqual(30);
    expect(fixture.pairs.length).toBeLessThanOrEqual(50);
    const slugs = new Set(fixture.records.map((r) => r.slug));
    for (const r of fixture.records) {
      expect(r.slug.startsWith(fixture.slug_prefix)).toBe(true);
      expect(isRecordType(r.type)).toBe(true);
    }
    for (const p of fixture.pairs) {
      expect(slugs.has(p.expected_slug)).toBe(true);
      expect(isRecordType(p.expected_type)).toBe(true);
      expect(["adjacency", "control"]).toContain(p.kind);
    }
    // Both classes must be substantial: a fixture that is almost all controls
    // cannot show a lift, and one with no controls cannot show a regression.
    const adjacency = fixture.pairs.filter((p) => p.kind === "adjacency").length;
    expect(adjacency).toBeGreaterThanOrEqual(10);
    expect(fixture.pairs.length - adjacency).toBeGreaterThanOrEqual(10);
  });

  test("every link in a fixture body points at a fixture record", () => {
    const slugs = new Set(fixture.records.map((r) => r.slug));
    let edges = 0;
    for (const rec of fixture.records) {
      for (const edge of extractGraphEdges({ sourceSlug: rec.slug, body: rec.body })) {
        expect(slugs.has(edge.dst)).toBe(true);
        edges++;
      }
    }
    // A fixture whose links stopped parsing would silently become a
    // no-adjacency corpus and every boost assertion below would still pass by
    // measuring nothing.
    expect(edges).toBeGreaterThanOrEqual(fixture.records.length);
  });
});

describe("graph adjacency boost — measured over the fixture", () => {
  test("adjacency pairs improve and control pairs do not regress", async () => {
    const m = await measure();

    // 1. The pairs the boost exists for get better.
    expect(m.adjacency.after.p5).toBeGreaterThan(m.adjacency.before.p5);
    expect(m.adjacency.after.mrr).toBeGreaterThan(m.adjacency.before.mrr);

    // 2. The pairs that already worked keep working. This is the assertion
    //    that would fail first if someone raised the default weight past the
    //    point where the graph starts overruling the text.
    expect(m.control.after.p1).toBeGreaterThanOrEqual(m.control.before.p1);
    expect(m.control.after.p5).toBeGreaterThanOrEqual(m.control.before.p5);
    expect(m.control.after.mrr).toBeGreaterThanOrEqual(m.control.before.mrr);

    // 3. Something actually moved — a boost that changes nothing would pass
    //    every inequality above.
    expect(m.movedUp.length).toBeGreaterThan(0);
  });
});
