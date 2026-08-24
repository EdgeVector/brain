// Unit tests for the phase-3 graph adjacency boost (`src/retrieval/adjacency.ts`).
//
// The properties that matter here are the ones a ranking change can quietly
// break: the boost must be inert when off, bounded in cost, unable to invent
// candidates, and honest about doing nothing.

import { describe, expect, test } from "bun:test";

import {
  ADJACENCY_DEFAULT_SEEDS,
  ADJACENCY_DEFAULT_WEIGHT,
  ADJACENCY_MAX_SEEDS,
  applyAdjacencyBoost,
  graphBoostEnabledByEnv,
  resolveAdjacencySeeds,
  resolveAdjacencyWeight,
} from "../../src/retrieval/adjacency.ts";
import { RRF_DEFAULT_K } from "../../src/retrieval/rrf.ts";
import {
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
} from "../../src/schemas.ts";

const OUT = "edge-out";
const IN = "edge-in";
const cfg = {
  schemaHashes: {
    [GRAPH_EDGE_OUT_SCHEMA_KEY]: OUT,
    [GRAPH_EDGE_IN_SCHEMA_KEY]: IN,
  },
} as any;
const cfgWithoutEdges = { schemaHashes: {} } as any;

type EdgeSpec = { src: string; dst: string; type?: string };

/** In-memory stand-in for the two keyed edge planes, plus a read counter. */
function graphNode(edges: readonly EdgeSpec[]) {
  const rows = edges.map((e) => ({
    bge_src: e.src,
    bge_dst: e.dst,
    bge_type: e.type ?? "references",
    bge_provenance: "wikilink",
    bge_created_at: "2026-01-01T00:00:00.000Z",
    bge_out_r: `${e.type ?? "references"}#${e.dst}`,
    bge_in_r: `${e.type ?? "references"}#${e.src}`,
  }));
  let reads = 0;
  const node = {
    async queryAll({ schemaHash, filter }: any) {
      reads += 1;
      const key = filter?.HashKey;
      return {
        results: rows
          .filter((f) => (schemaHash === OUT ? f.bge_src === key : f.bge_dst === key))
          .map((fields) => ({ fields })),
      };
    },
  } as any;
  return { node, reads: () => reads };
}

/** Fused list shaped like RRF output: score descending. */
function fusedList(...slugs: string[]) {
  return slugs.map((slug, i) => ({
    id: `design::${slug}`,
    fusedScore: 1 / (RRF_DEFAULT_K + i + 1),
  }));
}

describe("adjacency boost — knob validation", () => {
  test("seed count defaults, accepts the ceiling, and rejects past it", () => {
    expect(resolveAdjacencySeeds(undefined)).toBe(ADJACENCY_DEFAULT_SEEDS);
    expect(resolveAdjacencySeeds(ADJACENCY_MAX_SEEDS)).toBe(ADJACENCY_MAX_SEEDS);
    expect(() => resolveAdjacencySeeds(ADJACENCY_MAX_SEEDS + 1)).toThrow(/hard limit/);
    expect(() => resolveAdjacencySeeds(0)).toThrow(/positive integer/);
    expect(() => resolveAdjacencySeeds(2.5)).toThrow(/positive integer/);
  });

  test("weight defaults, accepts zero, and rejects negative or non-finite", () => {
    expect(resolveAdjacencyWeight(undefined)).toBe(ADJACENCY_DEFAULT_WEIGHT);
    expect(resolveAdjacencyWeight(0)).toBe(0);
    expect(() => resolveAdjacencyWeight(-1)).toThrow(/>= 0/);
    expect(() => resolveAdjacencyWeight(Number.NaN)).toThrow(/finite/);
  });
});

describe("adjacency boost — env switch", () => {
  test("unset is OFF; only affirmative spellings turn it on", () => {
    expect(graphBoostEnabledByEnv({})).toBe(false);
    expect(graphBoostEnabledByEnv({ BRAIN_GRAPH_BOOST: "0" })).toBe(false);
    expect(graphBoostEnabledByEnv({ BRAIN_GRAPH_BOOST: "" })).toBe(false);
    expect(graphBoostEnabledByEnv({ BRAIN_GRAPH_BOOST: "off" })).toBe(false);
    expect(graphBoostEnabledByEnv({ BRAIN_GRAPH_BOOST: "1" })).toBe(true);
    expect(graphBoostEnabledByEnv({ BRAIN_GRAPH_BOOST: "TRUE" })).toBe(true);
    expect(graphBoostEnabledByEnv({ FBRAIN_GRAPH_BOOST: "yes" })).toBe(true);
  });
});

describe("adjacency boost — ranking behaviour", () => {
  test("a record adjacent to the top hit moves up", async () => {
    // `beta` is last on text alone but is what the top hit implements.
    const { node } = graphNode([{ src: "alpha", dst: "beta", type: "implements" }]);
    const baseline = fusedList("alpha", "gamma", "delta", "beta");
    // One seed: `beta` must be a boost TARGET, and a seed can never be one.
    const { fused, attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: baseline,
      options: { seedCount: 1 },
    });

    expect(fused[0]!.id).toBe("design::alpha");
    // beta jumped the two records it was previously behind.
    expect(fused.map((f) => f.id)).toEqual([
      "design::alpha",
      "design::beta",
      "design::gamma",
      "design::delta",
    ]);
    expect(attribution.skipped).toBeNull();
    expect(attribution.boosts).toHaveLength(1);
    const boost = attribution.boosts[0]!;
    expect(boost.slug).toBe("beta");
    expect(boost.reasons[0]!.seedSlug).toBe("alpha");
    expect(boost.reasons[0]!.seedRank).toBe(1);
    expect(boost.reasons[0]!.edgeType).toBe("implements");
    // out = the SEED points at this document.
    expect(boost.reasons[0]!.direction).toBe("out");
    // The raw contribution is the on-scale RRF term; the applied total is
    // clamped so `beta` sits just under `alpha` rather than above it.
    expect(boost.rawTotal).toBeCloseTo(ADJACENCY_DEFAULT_WEIGHT / (RRF_DEFAULT_K + 1), 12);
    expect(boost.clampedBy).toEqual({ seedSlug: "alpha", seedRank: 1, score: 1 / (RRF_DEFAULT_K + 1) });
    expect(boost.total).toBeLessThan(boost.rawTotal);
  });

  test("a boosted document never overtakes the seed that vouched for it", async () => {
    // Weight far past anything sane: the ceiling, not the weight, is what
    // keeps the seed on top.
    const { node } = graphNode([{ src: "alpha", dst: "beta", type: "implements" }]);
    const baseline = fusedList("alpha", "gamma", "delta", "beta");
    const { fused, attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: baseline,
      options: { seedCount: 1, weight: 1000 },
    });
    expect(fused[0]!.id).toBe("design::alpha");
    expect(fused[1]!.id).toBe("design::beta");
    // Clamped exactly to the seed's score — equal, and the baseline-position
    // tiebreak keeps the seed first.
    expect(fused[1]!.fusedScore).toBeCloseTo(fused[0]!.fusedScore, 12);
    expect(attribution.boosts[0]!.clampedBy!.seedSlug).toBe("alpha");
  });

  test("inbound edges count too — being cited by a top hit is adjacency", async () => {
    const { node } = graphNode([{ src: "beta", dst: "alpha", type: "proves" }]);
    const { attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "gamma", "beta"),
      options: { seedCount: 1 },
    });
    expect(attribution.boosts).toHaveLength(1);
    expect(attribution.boosts[0]!.slug).toBe("beta");
    expect(attribution.boosts[0]!.reasons[0]!.direction).toBe("in");
  });

  test("adjacency to a weaker seed is worth less than adjacency to the top hit", async () => {
    const { node } = graphNode([
      { src: "alpha", dst: "near" },
      { src: "gamma", dst: "far" },
    ]);
    const { attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "gamma", "near", "far"),
      options: { seedCount: 2 },
    });
    const near = attribution.boosts.find((b) => b.slug === "near")!;
    const far = attribution.boosts.find((b) => b.slug === "far")!;
    expect(near.rawTotal).toBeGreaterThan(far.rawTotal);
    expect(near.rawTotal).toBeCloseTo(ADJACENCY_DEFAULT_WEIGHT / (RRF_DEFAULT_K + 1), 12);
    expect(far.rawTotal).toBeCloseTo(ADJACENCY_DEFAULT_WEIGHT / (RRF_DEFAULT_K + 2), 12);
  });

  test("adjacency to several seeds accumulates, once per seed", async () => {
    const { node } = graphNode([
      { src: "alpha", dst: "hub", type: "implements" },
      // Same (seed, document) pair over a second typed edge: one relationship
      // recorded twice is not twice the evidence.
      { src: "alpha", dst: "hub", type: "references" },
      { src: "gamma", dst: "hub", type: "owns" },
    ]);
    const { attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "gamma", "hub"),
      options: { seedCount: 2 },
    });
    const hub = attribution.boosts.find((b) => b.slug === "hub")!;
    expect(hub.reasons.map((r) => r.seedSlug)).toEqual(["alpha", "gamma"]);
    expect(hub.rawTotal).toBeCloseTo(
      ADJACENCY_DEFAULT_WEIGHT * (1 / (RRF_DEFAULT_K + 1) + 1 / (RRF_DEFAULT_K + 2)),
      12,
    );
  });

  test("a seed never boosts another seed", async () => {
    const { node } = graphNode([{ src: "alpha", dst: "gamma", type: "implements" }]);
    const { fused, attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "gamma", "delta"),
      options: { seedCount: 2 },
    });
    expect(attribution.boosts).toHaveLength(0);
    expect(fused).toEqual(fusedList("alpha", "gamma", "delta"));
  });

  test("a neighbour no ranker retrieved is NOT injected", async () => {
    // `ghost` is adjacent to the top hit but was not in the fused list. The
    // boost is a ranking change, not a recall change.
    const { node } = graphNode([{ src: "alpha", dst: "ghost", type: "implements" }]);
    const { fused, attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "gamma"),
      options: { seedCount: 1 },
    });
    expect(fused.map((f) => f.id)).toEqual(["design::alpha", "design::gamma"]);
    expect(attribution.boosts).toHaveLength(0);
  });

  test("weight 0 leaves the baseline ordering and scores untouched", async () => {
    const { node } = graphNode([{ src: "alpha", dst: "beta", type: "implements" }]);
    const baseline = fusedList("alpha", "gamma", "beta");
    const { fused, attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: baseline,
      options: { weight: 0, seedCount: 1 },
    });
    expect(fused).toEqual(baseline);
    expect(attribution.boosts).toHaveLength(0);
  });

  test("the input list is not mutated", async () => {
    const { node } = graphNode([{ src: "alpha", dst: "beta", type: "implements" }]);
    const baseline = fusedList("alpha", "gamma", "beta");
    const snapshot = baseline.map((f) => ({ ...f }));
    await applyAdjacencyBoost({ node, cfg, fused: baseline, options: { seedCount: 1 } });
    expect(baseline).toEqual(snapshot);
  });
});

describe("adjacency boost — cost and honesty", () => {
  test("read count is exactly two per seed, independent of graph size", async () => {
    const many: EdgeSpec[] = [];
    for (let i = 0; i < 500; i++) many.push({ src: "alpha", dst: `n${i}` });
    const { node, reads } = graphNode(many);
    const { attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "n1", "n2", "n3", "n4"),
      options: { seedCount: 3 },
    });
    expect(reads()).toBe(6);
    expect(attribution.reads).toBe(6);
    expect(attribution.seeds).toHaveLength(3);
  });

  test("an unconfigured edge substrate is reported, not silently ignored", async () => {
    const { node, reads } = graphNode([{ src: "alpha", dst: "beta" }]);
    const baseline = fusedList("alpha", "beta");
    const { fused, attribution } = await applyAdjacencyBoost({
      node,
      cfg: cfgWithoutEdges,
      fused: baseline,
    });
    expect(attribution.skipped).toBe("edges-unavailable");
    expect(reads()).toBe(0);
    expect(fused).toEqual(baseline);
  });

  test("an empty fused list is reported as no-seeds", async () => {
    const { node } = graphNode([]);
    const { fused, attribution } = await applyAdjacencyBoost({ node, cfg, fused: [] });
    expect(attribution.skipped).toBe("no-seeds");
    expect(fused).toEqual([]);
  });

  test("a run that finds no adjacency still reports its seeds", async () => {
    const { node } = graphNode([{ src: "unrelated", dst: "other" }]);
    const { attribution } = await applyAdjacencyBoost({
      node,
      cfg,
      fused: fusedList("alpha", "gamma"),
    });
    expect(attribution.skipped).toBeNull();
    expect(attribution.boosts).toHaveLength(0);
    expect(attribution.seeds.map((s) => s.slug)).toEqual(["alpha", "gamma"]);
  });
});
