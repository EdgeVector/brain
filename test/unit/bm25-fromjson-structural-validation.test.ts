// Regression: BM25Index.fromJSON must treat a structurally-inconsistent
// payload as corrupt and return null, the same way loadCachedIndex's
// JSON.parse error path already does. The cache file at
// ~/.fbrain/cache/bm25-<userHash>.json is written non-atomically, so a
// truncated write (interrupted `fbrain ask`, ENOSPC, or a stale-schema
// file from an older fbrain version) can land on disk with the field
// types intact but the cross-array invariants broken.
//
// Pre-fix: fromJSON only validated field TYPES (version === 1, fingerprint
// is a string, documents/docLengths are arrays, postings is an object). It
// never checked docLengths.length === documents.length, nor that every
// posting's `d` is an in-bounds doc index. A payload with `documents`
// length 1 but a posting at `d: 5` passed validation and produced a live
// index whose `search()` then crashed with `TypeError: undefined is not
// an object (evaluating 'doc.type')` at the documents[d] dereference —
// breaking `fbrain ask` / `fbrain search` instead of triggering the
// rebuild path that loadCachedIndex already provides for JSON parse
// errors.

import { describe, expect, test } from "bun:test";

import { BM25Index } from "../../src/retrieval/bm25.ts";

describe("BM25Index.fromJSON structural validation", () => {
  test("posting with out-of-range doc index → returns null", () => {
    // documents has length 1, but a posting references d=5 — impossible.
    // Pre-fix this returned a non-null index whose search() crashed.
    const malformed = {
      version: 1,
      fingerprint: "abc",
      generatedAt: "2026-01-01T00:00:00Z",
      documents: [{ type: "design", slug: "alpha" }],
      docLengths: [3],
      avgDocLength: 3,
      postings: { foo: [{ d: 5, f: 1 }] },
    };
    expect(BM25Index.fromJSON(malformed)).toBeNull();
  });

  test("docLengths length != documents length → returns null", () => {
    // The two arrays must move together — every doc has exactly one
    // length. A mismatch means the file is truncated or schema-skewed,
    // and silently proceeding would feed `docLengths[d] ?? 0` zeros for
    // valid d's, quietly corrupting every score.
    const malformed = {
      version: 1,
      fingerprint: "abc",
      generatedAt: "2026-01-01T00:00:00Z",
      documents: [
        { type: "design", slug: "alpha" },
        { type: "design", slug: "beta" },
      ],
      docLengths: [3], // missing entry for "beta"
      avgDocLength: 3,
      postings: { foo: [{ d: 0, f: 1 }] },
    };
    expect(BM25Index.fromJSON(malformed)).toBeNull();
  });

  test("negative posting doc index → returns null", () => {
    // Same crash class — documents[-1] is undefined in JS, search()
    // would TypeError on doc.type. Pin the lower bound too.
    const malformed = {
      version: 1,
      fingerprint: "abc",
      generatedAt: "2026-01-01T00:00:00Z",
      documents: [{ type: "design", slug: "alpha" }],
      docLengths: [3],
      avgDocLength: 3,
      postings: { foo: [{ d: -1, f: 1 }] },
    };
    expect(BM25Index.fromJSON(malformed)).toBeNull();
  });

  test("posting list is not an array → returns null", () => {
    // search() does `for (const { d, f } of list)` — a non-array list
    // throws on destructuring. Catch it at validation, not at query time.
    const malformed = {
      version: 1,
      fingerprint: "abc",
      generatedAt: "2026-01-01T00:00:00Z",
      documents: [{ type: "design", slug: "alpha" }],
      docLengths: [3],
      avgDocLength: 3,
      postings: { foo: "not-an-array" },
    };
    expect(BM25Index.fromJSON(malformed)).toBeNull();
  });

  test("valid round-trip still survives the tighter validation", () => {
    // Belt-and-suspenders: the stricter fromJSON must not reject a
    // well-formed payload produced by toJSON(). If it does, every cached
    // index becomes a forced rebuild and `fbrain ask` regresses to the
    // pre-cache cost on every invocation.
    const built = BM25Index.build([
      {
        type: "design",
        slug: "alpha",
        title: "alpha doc",
        body: "the body",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      {
        type: "task",
        slug: "beta",
        title: "beta thing",
        body: "another body",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);
    const round = BM25Index.fromJSON(JSON.parse(JSON.stringify(built.toJSON())));
    expect(round).not.toBeNull();
    // And search still works on the round-tripped index.
    const hits = round!.search("alpha", 10);
    expect(hits.length).toBeGreaterThan(0);
  });
});
