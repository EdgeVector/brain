// Unit tests for src/retrieval/rrf.ts tie-break determinism.
//
// Regression: the final sort was `b.fusedScore - a.fusedScore` only. JS sort
// is stable, so equal-score docs kept Map-insertion order — and insertion
// order depends on which ranker first introduced each doc. Identical inputs
// fed in a different ranker order therefore produced a different top-N
// ordering. ask.ts truncates the fused list to `limit`, so that
// non-determinism could change *which* tied docs survive the cut. The contract
// is now: output is invariant to the order of `inputs`, ties broken by id.

import { describe, expect, test } from "bun:test";

import { reciprocalRankFusion, type RankerInput } from "../../src/retrieval/rrf.ts";

describe("reciprocalRankFusion tie-break determinism", () => {
  test("ties are broken by id, ascending (code-unit order)", () => {
    // Two docs at the same rank in a single ranker → identical fused score.
    // Without the id key the order would mirror insertion order; with it the
    // alphabetically smaller id comes first.
    const inputs: RankerInput[] = [
      { label: "bm25", hits: [{ id: "design::zebra", rank: 1 }, { id: "design::alpha", rank: 1 }] },
    ];
    const out = reciprocalRankFusion(inputs);
    expect(out[0]!.fusedScore).toBeCloseTo(out[1]!.fusedScore, 12);
    expect(out.map((h) => h.id)).toEqual(["design::alpha", "design::zebra"]);
  });

  test("output is invariant to the order of the input rankers", () => {
    // Two single-hit rankers, each contributing 1/(60+1) to a distinct doc.
    // Both docs tie. Feeding the rankers in either order must yield the same
    // fused ordering — RRF is a commutative sum, so its output should not
    // depend on which list we happened to process first.
    const bm25: RankerInput = { label: "bm25", hits: [{ id: "task::beta", rank: 1 }] };
    const vector: RankerInput = { label: "vector", hits: [{ id: "task::gamma", rank: 1 }] };

    const orderA = reciprocalRankFusion([bm25, vector]).map((h) => h.id);
    const orderB = reciprocalRankFusion([vector, bm25]).map((h) => h.id);

    expect(orderA).toEqual(orderB);
    // And specifically the deterministic id order, regardless of feed order.
    expect(orderA).toEqual(["task::beta", "task::gamma"]);
  });

  test("higher fused score still wins over the id tie-break", () => {
    // A doc that lands in two rankers must outrank a single-list doc whose id
    // sorts earlier — the id key only breaks genuine score ties.
    const inputs: RankerInput[] = [
      { label: "bm25", hits: [{ id: "doc::zzz", rank: 1 }] },
      { label: "vector", hits: [{ id: "doc::zzz", rank: 1 }, { id: "doc::aaa", rank: 2 }] },
    ];
    const out = reciprocalRankFusion(inputs);
    expect(out[0]!.id).toBe("doc::zzz");
    expect(out[1]!.id).toBe("doc::aaa");
    expect(out[0]!.fusedScore).toBeGreaterThan(out[1]!.fusedScore);
  });
});
