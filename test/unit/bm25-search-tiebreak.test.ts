// Regression: BM25Index.search tie-break must be deterministic by (type, slug)
// — not by Map-insertion order, which depends on which query term was
// processed first and thus on the order tokens appear in the query string.
//
// Pre-fix behavior: `search("foo bar", N)` and `search("bar foo", N)` returned
// the same set of (slug, score) pairs but with different orderings for tied
// scores. The set-semantics BM25 in this file already collapses duplicate
// query terms via `Array.from(new Set(terms))`, so the SCORES are
// order-invariant — the only thing that varied was the rank assignment for
// ties. That assignment then propagated into RRF (where it changed the
// fused score for tied BM25 hits by ~1/(60·61)·k) and could flip the final
// `fbrain ask` output for queries that differ only in word order.
//
// This is the same shape of fix as PR #79 (deterministic RRF tie-break by
// id) but one layer down — the ranker itself.

import { describe, expect, test } from "bun:test";

import { BM25Index, type BM25Document } from "../../src/retrieval/bm25.ts";

// Three docs constructed so two of them tie in score:
//   - "alpha" matches "foo" only
//   - "beta" matches "bar" only
//   - "gamma" matches both
// With df=2 for both terms and dl(alpha)=dl(beta)=1, dl(gamma)=2, alpha and
// beta land on the same per-term contribution → identical BM25 scores.
// Gamma wins outright (sums both terms). The interesting case is the tie
// between alpha and beta.
const TIE_DOCS: BM25Document[] = [
  { type: "design", slug: "alpha", title: "foo", body: "", updatedAt: "2026-01-01T00:00:00Z" },
  { type: "design", slug: "beta", title: "bar", body: "", updatedAt: "2026-01-01T00:00:00Z" },
  { type: "design", slug: "gamma", title: "foo bar", body: "", updatedAt: "2026-01-01T00:00:00Z" },
];

describe("BM25Index.search tie-break determinism", () => {
  test("queries with identical token sets produce identical orderings", () => {
    const idx = BM25Index.build(TIE_DOCS);
    const a = idx.search("foo bar", 10);
    const b = idx.search("bar foo", 10);

    // Sanity: same hits, same scores. The set-semantics tokenizer means
    // both queries reduce to the same {foo, bar} bag, so scores must match.
    expect(a.map((h) => h.slug).sort()).toEqual(b.map((h) => h.slug).sort());
    for (const slug of a.map((h) => h.slug)) {
      const sa = a.find((h) => h.slug === slug)!.score;
      const sb = b.find((h) => h.slug === slug)!.score;
      expect(sa).toBeCloseTo(sb, 12);
    }

    // Load-bearing: same ORDERING. Pre-fix this failed — alpha and beta
    // tied in score and their relative rank depended on which of "foo" or
    // "bar" was iterated first, which is the query's word order.
    expect(a.map((h) => h.slug)).toEqual(b.map((h) => h.slug));
  });

  test("ties between docs at the same score break by (type::slug) ascending", () => {
    // Direct contract: when scores tie, the lexicographically smaller
    // "type::slug" comes first. Mirrors src/retrieval/rrf.ts's sort, so
    // the BM25-output ranks fed into RRF are already in the same total
    // order RRF uses internally.
    const idx = BM25Index.build(TIE_DOCS);
    const hits = idx.search("foo bar", 10);

    // gamma wins on score (both terms). The remaining two tie.
    expect(hits[0]!.slug).toBe("gamma");
    expect(hits[1]!.score).toBeCloseTo(hits[2]!.score, 12);
    // "design::alpha" < "design::beta" → alpha must come before beta.
    expect(hits[1]!.slug).toBe("alpha");
    expect(hits[2]!.slug).toBe("beta");
  });

  test("tie-break is invariant when type differs but score is equal", () => {
    // Same-score docs of different types must also fall into a single
    // total order. "design::x" < "task::x" lexicographically; pin that.
    const idx = BM25Index.build([
      { type: "task", slug: "shared", title: "foo", body: "", updatedAt: "2026-01-01T00:00:00Z" },
      { type: "design", slug: "shared", title: "foo", body: "", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    const hits = idx.search("foo", 10);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 12);
    expect(hits[0]!.type).toBe("design");
    expect(hits[1]!.type).toBe("task");
  });
});
