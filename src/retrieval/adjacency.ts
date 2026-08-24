// Graph-adjacency ranking boost for `brain ask` — phase 3 of the knowledge
// graph (design [[design-brain-knowledge-graph]], decision 4: "ranking is
// eval-gated").
//
// WHAT IT DOES
// The hybrid ranker (BM25 + vector, fused with RRF) scores each record on its
// OWN text. A record that answers the query through its neighbours — the
// decision that a design settled, the proof a card produced — carries little
// of the query's vocabulary itself and therefore ranks low. This module adds a
// second, small signal: a record adjacent in the typed edge graph to a record
// the rankers already put near the top gets a bounded score increment.
//
// WHY IT IS SHAPED LIKE RRF
// The boost is expressed on the SAME scale as an RRF contribution:
//
//   boost(d) = weight * sum over adjacent seeds s of  1 / (k + rank(s))
//
// where `rank(s)` is the seed's 1-based fused rank and `k` is the RRF constant.
// Adjacency to the #1 hit is therefore worth `weight` of what a third ranker
// placing `d` first would be worth, and adjacency to a weaker seed is worth
// proportionally less.
//
// THE CEILING (the invariant that makes this safe to turn on)
// A boosted document is clamped to the score of the best-ranked seed that
// vouched for it, so it can rise to just under that seed but never above it.
// Without the clamp, one edge from the top hit could carry a rank-4 document
// to rank 1 whenever the top hit sat in only one ranker's list — the graph
// would be overruling the text that found the seed in the first place. With
// it, the boost re-orders the middle of the list, which is where the graph
// knows something the text does not, and the document the rankers were most
// confident about keeps its place.
//
// NO-SCAN CONTRACT
// Seeds are capped (`seedCount`, default 3) and the walk is exactly ONE hop.
// Each seed costs at most two keyed range reads (`readNeighbors` with
// direction `both`), so a boosted ask issues at most `2 * seedCount` extra
// reads regardless of corpus size. There is no traversal, no frontier, and
// nothing whose cost grows with the graph. A deeper walk belongs in
// `graph query`, which reports its own truncation.
//
// DEFAULT OFF
// Nothing here runs unless the caller passes the flag. The design settled that
// the default may change only on measured P@5 lift from the graph eval fixture
// (`eval/graph/pairs.json`, harness `scripts/eval-graph-boost.ts`).

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { readNeighbors, graphEdgesUnavailable } from "../graph-traverse.ts";
import type { GraphEdgeType } from "../graph-edge.ts";
import { RRF_DEFAULT_K } from "./rrf.ts";

/** Default number of top fused hits used as adjacency seeds. */
export const ADJACENCY_DEFAULT_SEEDS = 3;
/** Hard ceiling on seeds, independent of the caller's request. */
export const ADJACENCY_MAX_SEEDS = 10;
/**
 * Default weight.
 *
 * 0.5 means "adjacency to the top hit is worth half of what a third ranker
 * ranking you first would be worth". Chosen to move the middle of the list
 * without letting one edge outrank two independent text signals.
 */
export const ADJACENCY_DEFAULT_WEIGHT = 0.5;

/** One reason a document was boosted — the unit `--explain` prints. */
export type AdjacencyReason = {
  /** Slug of the seed hit this document is adjacent to. */
  seedSlug: string;
  /** 1-based fused rank of that seed before the boost. */
  seedRank: number;
  /** Typed edge that connects them. */
  edgeType: GraphEdgeType;
  /** `out` = the seed points at this document; `in` = it points at the seed. */
  direction: "out" | "in";
  /** This reason's addition to the document's fused score. */
  contribution: number;
};

/** The seed a boosted document may not overtake, and that seed's score. */
export type AdjacencyCeiling = {
  seedSlug: string;
  seedRank: number;
  score: number;
};

export type AdjacencyBoost = {
  /** Canonical doc id (`type::slug`). */
  id: string;
  slug: string;
  /** Score actually added, after the ceiling. Never exceeds `rawTotal`. */
  total: number;
  /** Sum of every reason's contribution, before the ceiling. */
  rawTotal: number;
  /** Set when the ceiling bound this document; null when it did not. */
  clampedBy: AdjacencyCeiling | null;
  reasons: AdjacencyReason[];
};

export type AdjacencyAttribution = {
  /** Seeds actually used, in fused order. */
  seeds: Array<{ slug: string; rank: number }>;
  /** Documents whose score changed, strongest boost first. */
  boosts: AdjacencyBoost[];
  /** Keyed range reads this boost issued. Two per seed when the walk ran. */
  reads: number;
  /**
   * Why the boost produced nothing, when it produced nothing.
   *
   * `null` means it ran normally. A boost that silently does nothing is
   * indistinguishable from a broken flag, so every no-op path names itself.
   */
  skipped: "edges-unavailable" | "no-seeds" | null;
};

export type FusedForBoost = {
  id: string;
  fusedScore: number;
};

export type AdjacencyOptions = {
  /** Top-N fused hits used as seeds. Clamped to [1, ADJACENCY_MAX_SEEDS]. */
  seedCount?: number;
  /** Scale factor on every contribution. Must be finite and >= 0. */
  weight?: number;
  /** RRF constant; keep in step with the fusion that produced `fused`. */
  k?: number;
};

export function resolveAdjacencySeeds(requested?: number): number {
  if (requested === undefined) return ADJACENCY_DEFAULT_SEEDS;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(
      `graph-boost-seeds must be a positive integer, got ${JSON.stringify(requested)}.`,
    );
  }
  if (requested > ADJACENCY_MAX_SEEDS) {
    throw new Error(
      `graph-boost-seeds ${requested} exceeds the hard limit of ${ADJACENCY_MAX_SEEDS}. ` +
        "Each seed costs two keyed range reads; a wider seed set is a traversal, " +
        "which is what `brain graph query` is for.",
    );
  }
  return requested;
}

export function resolveAdjacencyWeight(requested?: number): number {
  if (requested === undefined) return ADJACENCY_DEFAULT_WEIGHT;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new Error(
      `graph-boost-weight must be a finite number >= 0, got ${JSON.stringify(requested)}.`,
    );
  }
  return requested;
}

/**
 * True when the flag is on for this process because of the environment.
 *
 * The CLI flag is the primary switch; the env var exists so the eval harness
 * and the MCP surface can turn the boost on for a whole run without every
 * call site growing an argument. Unset env => OFF, which is the default the
 * design requires.
 */
export function graphBoostEnabledByEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.BRAIN_GRAPH_BOOST ?? env.FBRAIN_GRAPH_BOOST;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function slugOf(id: string): string {
  const idx = id.indexOf("::");
  return idx <= 0 ? id : id.slice(idx + 2);
}

/**
 * Compute the adjacency boost for one fused list.
 *
 * Returns the boosted list (a new array, sorted) and the attribution. The
 * input array is not mutated: the caller keeps the unboosted ranking so
 * `--explain` can state what moved.
 *
 * The sort is score descending, ties broken by BASELINE POSITION ascending.
 * The baseline arrives already ordered by `reciprocalRankFusion`'s own total
 * order (score descending, id ascending), so an all-zero boost reproduces it
 * exactly — the property the "default off is inert" test pins. Position
 * rather than id is what makes the ceiling hold at an exact tie: seeds are
 * the head of the baseline, so a clamped document always sorts after the seed
 * that clamped it.
 */
export async function applyAdjacencyBoost(opts: {
  node: NodeClient;
  cfg: Pick<Config, "schemaHashes">;
  fused: readonly FusedForBoost[];
  options?: AdjacencyOptions;
}): Promise<{ fused: FusedForBoost[]; attribution: AdjacencyAttribution }> {
  const seedCount = resolveAdjacencySeeds(opts.options?.seedCount);
  const weight = resolveAdjacencyWeight(opts.options?.weight);
  const k = opts.options?.k ?? RRF_DEFAULT_K;
  const baseline = opts.fused.map((f) => ({ id: f.id, fusedScore: f.fusedScore }));

  if (graphEdgesUnavailable(opts.cfg)) {
    return {
      fused: baseline,
      attribution: { seeds: [], boosts: [], reads: 0, skipped: "edges-unavailable" },
    };
  }
  const seeds = baseline.slice(0, seedCount).map((f, i) => ({ slug: slugOf(f.id), rank: i + 1 }));
  if (seeds.length === 0) {
    return {
      fused: baseline,
      attribution: { seeds: [], boosts: [], reads: 0, skipped: "no-seeds" },
    };
  }

  // Every fused document, indexed by slug. A boost only ever moves a document
  // the rankers ALREADY retrieved — adjacency never injects a new candidate,
  // because a record no ranker matched has no measured relevance to trade off
  // against, and injecting it would make the boost a recall change disguised
  // as a ranking change.
  const byslug = new Map<string, string[]>();
  for (const f of baseline) {
    const slug = slugOf(f.id);
    const ids = byslug.get(slug);
    if (ids) ids.push(f.id);
    else byslug.set(slug, [f.id]);
  }

  const boostById = new Map<string, AdjacencyBoost>();
  const seedSlugs = new Set(seeds.map((s) => s.slug));
  let reads = 0;

  for (const seed of seeds) {
    const neighbors = await readNeighbors(opts.node, opts.cfg, seed.slug, { direction: "both" });
    // `readNeighbors` returns null only when the substrate is unconfigured,
    // which we already ruled out above; treat it as no neighbours anyway
    // rather than assuming.
    reads += 2;
    if (!neighbors) continue;
    const contribution = weight * (1 / (k + seed.rank));
    if (contribution === 0) continue;
    for (const neighbor of neighbors) {
      // A seed boosting another seed would let the top of the list inflate
      // itself, which is a feedback loop, not evidence.
      if (seedSlugs.has(neighbor.slug)) continue;
      const ids = byslug.get(neighbor.slug);
      if (!ids) continue;
      for (const id of ids) {
        const existing = boostById.get(id);
        const reason: AdjacencyReason = {
          seedSlug: seed.slug,
          seedRank: seed.rank,
          edgeType: neighbor.type,
          direction: neighbor.direction,
          contribution,
        };
        if (existing) {
          // One seed can reach the same document over several typed edges.
          // Count the strongest edge once per (seed, document) pair: two
          // parallel edges are one relationship recorded twice, not twice the
          // evidence.
          if (existing.reasons.some((r) => r.seedSlug === seed.slug)) continue;
          existing.reasons.push(reason);
          existing.rawTotal += contribution;
          existing.total = existing.rawTotal;
        } else {
          boostById.set(id, {
            id,
            slug: neighbor.slug,
            total: contribution,
            rawTotal: contribution,
            clampedBy: null,
            reasons: [reason],
          });
        }
      }
    }
  }

  // Apply the ceiling: a document may rise to its best supporting seed's
  // score, never past it. `seedScoreByRank` reads from the baseline because
  // seeds are never themselves boosted.
  const seedScoreByRank = new Map(seeds.map((s2) => [s2.rank, baseline[s2.rank - 1]!.fusedScore]));
  for (const boost of boostById.values()) {
    const best = boost.reasons.reduce((a, b) => (a.seedRank <= b.seedRank ? a : b));
    const ceiling = seedScoreByRank.get(best.seedRank)!;
    const base = baseline.find((f) => f.id === boost.id)!.fusedScore;
    const allowed = Math.max(0, ceiling - base);
    if (boost.rawTotal > allowed) {
      boost.total = allowed;
      boost.clampedBy = { seedSlug: best.seedSlug, seedRank: best.seedRank, score: ceiling };
    }
  }

  const positionById = new Map(baseline.map((f, i) => [f.id, i]));
  const boosted = baseline.map((f) => ({
    id: f.id,
    fusedScore: f.fusedScore + (boostById.get(f.id)?.total ?? 0),
  }));
  boosted.sort(
    (a, b) =>
      b.fusedScore - a.fusedScore || positionById.get(a.id)! - positionById.get(b.id)!,
  );

  const boosts = [...boostById.values()].sort(
    (a, b) => b.total - a.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const boost of boosts) {
    boost.reasons.sort((a, b) => a.seedRank - b.seedRank || a.edgeType.localeCompare(b.edgeType));
  }
  return { fused: boosted, attribution: { seeds, boosts, reads, skipped: null } };
}
