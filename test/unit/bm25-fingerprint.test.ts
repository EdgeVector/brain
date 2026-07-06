// Pins the load-bearing invariant that makes ask.ts's BM25 cache check
// cheap: `computeFingerprint(docs)` must equal the `.fingerprint` field of
// an index built from the same docs.
//
// ask.ts calls `computeFingerprint(docs)` standalone to decide cache hit
// vs miss without building a full postings index just to read its hash.
// If `BM25Index.build` ever started hashing post-build state (e.g. the
// stemmed token stream, or the doc-length vector) instead of routing
// through `computeFingerprint`, the standalone hash would silently
// disagree with the cached one — every ask would look like a cache miss
// and rebuild the index even when the corpus hadn't changed. This test
// catches that drift the moment it lands rather than as a "ask got slow"
// report weeks later.

import { describe, expect, test } from "bun:test";

import {
  BM25Index,
  bm25CachePath,
  computeFingerprint,
  type BM25Document,
} from "../../src/retrieval/bm25.ts";

const docs: BM25Document[] = [
  {
    type: "design",
    slug: "alpha",
    title: "Alpha design",
    body: "the alpha design body",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    type: "task",
    slug: "beta",
    title: "Beta task",
    body: "do the beta thing",
    updatedAt: "2026-01-02T00:00:00Z",
  },
  {
    type: "concept",
    slug: "gamma",
    title: "Gamma concept",
    body: "core idea text",
    updatedAt: "2026-01-03T00:00:00Z",
  },
];

describe("computeFingerprint vs BM25Index.build().fingerprint", () => {
  test("standalone fingerprint equals the built index's fingerprint", () => {
    const standalone = computeFingerprint(docs);
    const built = BM25Index.build(docs).fingerprint;
    expect(standalone).toBe(built);
  });

  test("input order does not change the fingerprint (sort is canonicalized)", () => {
    const a = computeFingerprint(docs);
    const reversed = [...docs].reverse();
    const b = computeFingerprint(reversed);
    expect(a).toBe(b);
  });

  test("changing an updated_at flips the fingerprint", () => {
    const baseline = computeFingerprint(docs);
    const bumped = docs.map((d, i) =>
      i === 0 ? { ...d, updatedAt: "2026-06-01T00:00:00Z" } : d,
    );
    expect(computeFingerprint(bumped)).not.toBe(baseline);
  });

  test("empty doc list yields a stable fingerprint that still matches the built index", () => {
    // Edge case ask.ts hits on a fresh brain with zero live records: the
    // cache key must still be deterministic and identical between the two
    // computation paths, otherwise the empty-corpus state would always
    // look like a miss and burn an index build on every invocation.
    expect(computeFingerprint([])).toBe(BM25Index.build([]).fingerprint);
  });

  test("cache path is keyed by the active type set", () => {
    const all = bm25CachePath("user-hash", ["design", "task"], "/tmp/cache");
    const reversed = bm25CachePath("user-hash", ["task", "design"], "/tmp/cache");
    const designOnly = bm25CachePath("user-hash", ["design"], "/tmp/cache");

    expect(all).toBe(reversed);
    expect(all).not.toBe(designOnly);
  });
});
