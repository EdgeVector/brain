// Client-side BM25 over fbrain records.
//
// fold_db doesn't expose a BM25 layer, so we build a tiny inverted index in
// the CLI process. Documents are `title + "\n" + body` for every live
// (non-tombstoned) record across all 8 types. The vector layer already
// dedupes per (schema, slug); BM25 here mirrors that — one document per
// (type, slug).
//
// Cache: the index is keyed by a fingerprint of (slug, updated_at) for
// every live record. The fingerprint is stable iff nothing was added,
// updated, or soft-deleted since the last build. We persist the index to
// `~/.fbrain/cache/bm25-<userHash>.json` so back-to-back `fbrain ask`
// invocations on the same corpus skip the rebuild — important because
// `listRecords` across 3 schemas is the dominant cost.
//
// Tokenization is intentionally simple: lowercase, split on
// non-alphanumerics, length >= 2, English stopwords stripped. No
// stemming. This is a CLI retrieval baseline, not Elastic.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RecordType } from "../schemas.ts";

const STOPWORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "in", "on",
  "at", "to", "from", "for", "with", "by", "is", "are", "was", "were", "be",
  "been", "being", "do", "does", "did", "have", "has", "had", "as", "it",
  "its", "this", "that", "these", "those", "i", "you", "he", "she", "we",
  "they", "what", "which", "who", "whom", "how", "when", "where", "why",
  "not", "no", "so", "than", "into", "about", "over", "under", "between",
  "across", "through", "during", "before", "after", "above", "below", "out",
  "up", "down", "off", "on", "again", "here", "there", "all", "any", "each",
  "more", "most", "some", "such", "only", "own", "same", "very", "can", "will",
  "just", "should", "could", "would", "may", "might", "must", "shall",
]);

const K1 = 1.2;
const B = 0.75;

export type BM25Document = {
  type: RecordType;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
};

export type BM25Hit = {
  type: RecordType;
  slug: string;
  score: number;
  rank: number; // 1-based
};

type Posting = {
  // doc id is "type::slug"
  d: number; // doc index into `documents`
  f: number; // term frequency in that doc
};

type SerializedIndex = {
  version: 1;
  fingerprint: string;
  generatedAt: string;
  documents: Array<{ type: RecordType; slug: string }>;
  docLengths: number[];
  avgDocLength: number;
  // term -> postings list (sorted by doc id for compact serialization)
  postings: Record<string, Posting[]>;
};

export class BM25Index {
  private documents: Array<{ type: RecordType; slug: string }>;
  private docLengths: number[];
  private avgDocLength: number;
  private postings: Map<string, Posting[]>;
  readonly fingerprint: string;

  private constructor(serialized: SerializedIndex) {
    this.documents = serialized.documents;
    this.docLengths = serialized.docLengths;
    this.avgDocLength = serialized.avgDocLength;
    this.postings = new Map(Object.entries(serialized.postings));
    this.fingerprint = serialized.fingerprint;
  }

  static build(docs: BM25Document[]): BM25Index {
    const documents = docs.map((d) => ({ type: d.type, slug: d.slug }));
    const docLengths: number[] = [];
    const postingMap = new Map<string, Map<number, number>>();
    for (let i = 0; i < docs.length; i++) {
      const tokens = tokenize(`${docs[i]!.title}\n${docs[i]!.body}`);
      docLengths.push(tokens.length);
      for (const t of tokens) {
        let row = postingMap.get(t);
        if (!row) {
          row = new Map();
          postingMap.set(t, row);
        }
        row.set(i, (row.get(i) ?? 0) + 1);
      }
    }
    const totalLen = docLengths.reduce((a, b) => a + b, 0);
    const avgDocLength = docLengths.length > 0 ? totalLen / docLengths.length : 0;
    const postings: Record<string, Posting[]> = {};
    for (const [term, row] of postingMap) {
      const list: Posting[] = [];
      for (const [d, f] of row) list.push({ d, f });
      list.sort((a, b) => a.d - b.d);
      postings[term] = list;
    }
    const fingerprint = computeFingerprint(docs);
    return new BM25Index({
      version: 1,
      fingerprint,
      generatedAt: new Date().toISOString(),
      documents,
      docLengths,
      avgDocLength,
      postings,
    });
  }

  search(query: string, limit: number): BM25Hit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.documents.length === 0) return [];
    const N = this.documents.length;
    const scores = new Map<number, number>();
    // Score each doc that contains at least one query term. Same term in the
    // query twice still uses one idf (set semantics — standard BM25 over a
    // bag-of-query-terms).
    const uniqueTerms = Array.from(new Set(terms));
    for (const t of uniqueTerms) {
      const list = this.postings.get(t);
      if (!list || list.length === 0) continue;
      const df = list.length;
      // Okapi BM25 idf with the +0.5/+0.5 smoothing. Floor at 0 — common term
      // (df > N/2) would otherwise contribute a small negative.
      const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1));
      for (const { d, f } of list) {
        const dl = this.docLengths[d] ?? 0;
        const denom = f + K1 * (1 - B + (B * dl) / (this.avgDocLength || 1));
        const contrib = idf * ((f * (K1 + 1)) / (denom || 1));
        scores.set(d, (scores.get(d) ?? 0) + contrib);
      }
    }
    // Sort by score DESC, ties broken by (type::slug) ASC. The id key pins a
    // single deterministic ordering: without it, equal-score docs land in
    // Map-insertion order, which depends on which query term's posting list
    // was scanned first — i.e. on the order tokens appear in the query
    // string. That non-determinism flowed into RRF (changing the fused
    // contribution for tied BM25 hits) and could shift the final `fbrain
    // ask` output for queries that differ only in word order. Same shape
    // as the rrf.ts tie-break, applied one layer down.
    const ranked = Array.from(scores.entries())
      .map(([d, score]) => {
        const doc = this.documents[d]!;
        return { d, score, id: `${doc.type}::${doc.slug}` };
      })
      .sort(
        (a, b) =>
          b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, Math.max(limit, 1));
    return ranked.map(({ d, score }, i) => {
      const doc = this.documents[d]!;
      return { type: doc.type, slug: doc.slug, score, rank: i + 1 };
    });
  }

  toJSON(): SerializedIndex {
    const postings: Record<string, Posting[]> = {};
    for (const [k, v] of this.postings) postings[k] = v;
    return {
      version: 1,
      fingerprint: this.fingerprint,
      generatedAt: new Date().toISOString(),
      documents: this.documents,
      docLengths: this.docLengths,
      avgDocLength: this.avgDocLength,
      postings,
    };
  }

  static fromJSON(raw: unknown): BM25Index | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Partial<SerializedIndex>;
    if (obj.version !== 1) return null;
    if (typeof obj.fingerprint !== "string") return null;
    if (!Array.isArray(obj.documents)) return null;
    if (!Array.isArray(obj.docLengths)) return null;
    if (typeof obj.avgDocLength !== "number") return null;
    if (!obj.postings || typeof obj.postings !== "object") return null;
    return new BM25Index({
      version: 1,
      fingerprint: obj.fingerprint,
      generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
      documents: obj.documents as Array<{ type: RecordType; slug: string }>,
      docLengths: obj.docLengths as number[],
      avgDocLength: obj.avgDocLength,
      postings: obj.postings as Record<string, Posting[]>,
    });
  }
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  // Split on any non-alphanumeric run. Keep alphanumeric tokens of length >= 2
  // that are not in the stoplist.
  for (const raw of lower.split(/[^a-z0-9]+/g)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export function computeFingerprint(docs: BM25Document[]): string {
  // Stable hash of the (slug, updated_at) pairs sorted by slug. This is what
  // tells us "did the corpus change since the last build?". Including type
  // means a slug moving between types invalidates too.
  const pairs = docs
    .map((d) => `${d.type}::${d.slug}@${d.updatedAt}`)
    .sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

// Cache layout: `~/.fbrain/cache/bm25-<userHash>.json` — keyed by user so
// two fbrain configs on the same machine can't collide. The cache survives
// a corpus change (we just rebuild on fingerprint mismatch). FBRAIN_CACHE_DIR
// override is for tests.
export function defaultCacheDir(): string {
  const override = process.env.FBRAIN_CACHE_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".fbrain", "cache");
}

export function bm25CachePath(userHash: string, dir: string = defaultCacheDir()): string {
  // userHash is hex; safe as a filename. Still, sanitize to alnum + dash just
  // in case a test stubs a weird value.
  const safe = userHash.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return join(dir, `bm25-${safe || "anon"}.json`);
}

export function loadCachedIndex(userHash: string, cacheDir?: string): BM25Index | null {
  const path = bm25CachePath(userHash, cacheDir ?? defaultCacheDir());
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return BM25Index.fromJSON(raw);
  } catch {
    return null;
  }
}

export function saveCachedIndex(
  userHash: string,
  index: BM25Index,
  cacheDir?: string,
): void {
  const path = bm25CachePath(userHash, cacheDir ?? defaultCacheDir());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index.toJSON()) + "\n", "utf8");
}
