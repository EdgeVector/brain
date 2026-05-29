// Reciprocal Rank Fusion — combine N ranked lists into one fused ranking.
//
//   score(d) = sum over each ranker i of  1 / (k + rank_i(d))
//
// where rank_i(d) is the 1-based position of d in ranker i's list (omit the
// term if d is not in that ranker's top-K). k=60 is the standard value from
// the original Cormack et al. paper — it dampens the contribution of any
// single ranker so a doc has to land in multiple lists to top the fused
// result. Documented at `docs/phase-7-search-latency-spike.md` G3 plan.

export const RRF_DEFAULT_K = 60;

export type RankedDoc = {
  id: string; // canonical doc id; we use "type::slug"
  rank: number; // 1-based rank in this list
};

export type RankerInput = {
  // Human-readable label — for the --explain output. e.g. "bm25",
  // "vector:expanded[0]", etc.
  label: string;
  hits: RankedDoc[];
};

export type FusedHit = {
  id: string;
  fusedScore: number;
  // Per-ranker contributions, keyed by label. Absent rankers (doc not in
  // that list) are omitted — caller treats missing as "did not rank".
  contributions: Record<string, { rank: number; contribution: number }>;
};

export type FuseOptions = {
  k?: number;
};

export function reciprocalRankFusion(
  inputs: RankerInput[],
  opts: FuseOptions = {},
): FusedHit[] {
  const k = opts.k ?? RRF_DEFAULT_K;
  const acc = new Map<string, FusedHit>();
  for (const input of inputs) {
    // Defensive de-dup: if a ranker passed us the same doc twice (e.g. two
    // fragments of one record snuck through), keep the better rank.
    const bestRankInList = new Map<string, number>();
    for (const h of input.hits) {
      const prior = bestRankInList.get(h.id);
      if (prior === undefined || h.rank < prior) bestRankInList.set(h.id, h.rank);
    }
    for (const [id, rank] of bestRankInList) {
      const contribution = 1 / (k + rank);
      const existing = acc.get(id);
      if (existing) {
        existing.fusedScore += contribution;
        existing.contributions[input.label] = { rank, contribution };
      } else {
        acc.set(id, {
          id,
          fusedScore: contribution,
          contributions: { [input.label]: { rank, contribution } },
        });
      }
    }
  }
  // Sort by fused score, descending. Ties broken by id (ascending, code-unit
  // order) so the output is invariant to the order of `inputs`. RRF sums are
  // commutative, but a bare score sort leaves equal-score docs in Map-insertion
  // order — which depends on which ranker first saw each doc. With identical
  // inputs in a different ranker order that flips the top-N (ask.ts truncates
  // the fused list), so the id key pins a single deterministic ordering.
  return Array.from(acc.values()).sort(
    (a, b) => b.fusedScore - a.fusedScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
