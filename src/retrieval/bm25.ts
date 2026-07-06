// Client-side BM25 over fbrain records.
//
// fold_db doesn't expose a BM25 layer, so we build a tiny inverted index in
// the CLI process. Documents are `title + "\n" + body` for every live
// (non-tombstoned) record across all record types. The vector layer already
// dedupes per (schema, slug); BM25 here mirrors that — one document per
// (type, slug).
//
// Cache: the index is keyed by a fingerprint of (slug, updated_at) for
// every live record. The fingerprint is stable iff nothing was added,
// updated, or soft-deleted since the last build. We persist the index to
// `~/.fbrain/cache/bm25-<userHash>-<typeSetHash>.json` so back-to-back
// retrieval calls on the same corpus/type shape skip the rebuild — important
// because `listRecords` across schemas is the dominant cost.
//
// Tokenization is intentionally simple: lowercase, split on
// non-alphanumerics, length >= 2, English stopwords stripped. No
// stemming. This is a CLI retrieval baseline, not Elastic.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { NodeClient, Verbose } from "../client.ts";
import { fbrainHomeBase } from "../config.ts";
import type { Config } from "../config.ts";
import {
  isTombstoned,
  listRecordKeys,
  listRecords,
  schemaHashFor,
  type FbrainRecord,
  type RecordKey,
} from "../record.ts";
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

export type Bm25IndexLoad = {
  index: BM25Index;
  liveById: Map<string, FbrainRecord>;
  corpusSize: number;
  cacheHit: boolean;
  fingerprint: string;
};

type Posting = {
  // doc id is "type::slug"
  d: number; // doc index into `documents`
  f: number; // term frequency in that doc
};

// The per-doc text Stage 4/5 of `ask` needs to RENDER a chosen hit — its
// title (table column) and body (snippet). Persisted alongside the postings so
// a warm `ask` can resolve its (≤ limit) hits straight from the cache, with NO
// network body refetch. fold_db's `/api/query` has no per-key filter, so the
// only alternative to caching this is re-scanning a whole schema page per hit
// — which would defeat the cache. Caching it turns a warm resolve into a local
// disk read.
type DocText = { title: string; body: string };

type SerializedIndex = {
  version: 2;
  fingerprint: string;
  generatedAt: string;
  documents: Array<{ type: RecordType; slug: string }>;
  docLengths: number[];
  avgDocLength: number;
  // term -> postings list (sorted by doc id for compact serialization)
  postings: Record<string, Posting[]>;
  // Per-doc render text, index-aligned with `documents`. Lets a warm cache hit
  // resolve hits without refetching bodies over the network.
  docText: DocText[];
};

export class BM25Index {
  private documents: Array<{ type: RecordType; slug: string }>;
  private docLengths: number[];
  private avgDocLength: number;
  private postings: Map<string, Posting[]>;
  private docText: DocText[];
  // id ("type::slug") -> index into `documents`/`docText`. Built lazily on the
  // first `recordText` lookup so a warm `ask` can resolve a chosen hit's render
  // text in O(1) without a network fetch.
  private idIndex: Map<string, number> | null = null;
  readonly fingerprint: string;

  private constructor(serialized: SerializedIndex) {
    this.documents = serialized.documents;
    this.docLengths = serialized.docLengths;
    this.avgDocLength = serialized.avgDocLength;
    this.postings = new Map(Object.entries(serialized.postings));
    this.docText = serialized.docText;
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
    const docText: DocText[] = docs.map((d) => ({ title: d.title, body: d.body }));
    return new BM25Index({
      version: 2,
      fingerprint,
      generatedAt: new Date().toISOString(),
      documents,
      docLengths,
      avgDocLength,
      postings,
      docText,
    });
  }

  // Render text (title + body) for a doc id ("type::slug"), or null if the id
  // isn't in this index. Lets a warm cache hit resolve its chosen hits without
  // a network body fetch — the cached index already carries every doc's text.
  recordText(id: string): DocText | null {
    if (!this.idIndex) {
      this.idIndex = new Map();
      for (let i = 0; i < this.documents.length; i++) {
        const d = this.documents[i]!;
        this.idIndex.set(`${d.type}::${d.slug}`, i);
      }
    }
    const i = this.idIndex.get(id);
    if (i === undefined) return null;
    return this.docText[i] ?? null;
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
      version: 2,
      fingerprint: this.fingerprint,
      generatedAt: new Date().toISOString(),
      documents: this.documents,
      docLengths: this.docLengths,
      avgDocLength: this.avgDocLength,
      postings,
      docText: this.docText,
    };
  }

  static fromJSON(raw: unknown): BM25Index | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Partial<SerializedIndex>;
    // v2 added `docText` (the cached render text that lets a warm `ask` resolve
    // hits without a network body fetch). A v1 file lacks it, so reject it —
    // loadCachedIndex returns null and `ask` rebuilds (one extra cold call),
    // which is the same safe fall-through as any other corrupt/stale cache.
    if (obj.version !== 2) return null;
    if (typeof obj.fingerprint !== "string") return null;
    if (!Array.isArray(obj.documents)) return null;
    if (!Array.isArray(obj.docLengths)) return null;
    if (typeof obj.avgDocLength !== "number") return null;
    if (!obj.postings || typeof obj.postings !== "object") return null;
    if (!Array.isArray(obj.docText)) return null;
    // Cross-array structural checks: the cache file is written
    // non-atomically, so a truncated write or stale-schema file can pass
    // the field-type guards above and still produce an index whose
    // postings point at doc indices that don't exist. search() then
    // crashes on `documents[d].type` instead of the corrupt-cache path
    // (loadCachedIndex → null → rebuild) the file's contract promises.
    const N = obj.documents.length;
    if (obj.docLengths.length !== N) return null;
    // docText is index-aligned with documents; a length mismatch means a
    // truncated/stale write — reject so a warm resolve can't read past the
    // array or render a hit with the wrong record's text.
    if (obj.docText.length !== N) return null;
    for (const t of obj.docText) {
      if (!t || typeof t !== "object") return null;
      const tt = (t as { title?: unknown }).title;
      const bb = (t as { body?: unknown }).body;
      if (typeof tt !== "string" || typeof bb !== "string") return null;
    }
    for (const list of Object.values(obj.postings)) {
      if (!Array.isArray(list)) return null;
      for (const p of list) {
        if (!p || typeof p !== "object") return null;
        const d = (p as { d?: unknown }).d;
        const f = (p as { f?: unknown }).f;
        if (typeof d !== "number" || !Number.isInteger(d)) return null;
        if (typeof f !== "number" || !Number.isFinite(f) || f <= 0) return null;
        if (d < 0 || d >= N) return null;
      }
    }
    return new BM25Index({
      version: 2,
      fingerprint: obj.fingerprint,
      generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
      documents: obj.documents as Array<{ type: RecordType; slug: string }>,
      docLengths: obj.docLengths as number[],
      avgDocLength: obj.avgDocLength,
      postings: obj.postings as Record<string, Posting[]>,
      docText: obj.docText as DocText[],
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

// The minimal per-record identity the fingerprint is computed over. A
// BM25Document is a superset of this (it also carries title + body), so
// `computeFingerprint` delegates here — the two MUST agree bit-for-bit, or a
// cheap-listing fingerprint would never match the index a full-corpus build
// stamped, defeating the cache. Keeping one hash function over this shape is
// what lets `ask` decide cache-hit-vs-miss from a body-less listing.
export type FingerprintKey = {
  type: RecordType;
  slug: string;
  updatedAt: string;
};

export function computeFingerprint(docs: readonly FingerprintKey[]): string {
  // Stable hash of the (slug, updated_at) pairs sorted by slug. This is what
  // tells us "did the corpus change since the last build?". Including type
  // means a slug moving between types invalidates too.
  const pairs = docs
    .map((d) => `${d.type}::${d.slug}@${d.updatedAt}`)
    .sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

// Cache layout: `~/.fbrain/cache/bm25-<userHash>-<typeSetHash>.json` — keyed
// by user and active type set so two fbrain configs on the same machine cannot
// collide, and `ask`/`search` calls with different `--type` shapes do not
// overwrite each other. The cache survives a corpus change (we just rebuild on
// fingerprint mismatch). FBRAIN_CACHE_DIR override is for tests.
export function defaultCacheDir(): string {
  const override = process.env.FBRAIN_CACHE_DIR;
  if (override && override.length > 0) return override;
  return join(fbrainHomeBase(), ".fbrain", "cache");
}

function typeSetCacheKey(types: readonly RecordType[]): string {
  return createHash("sha256")
    .update([...types].sort().join("\0"))
    .digest("hex")
    .slice(0, 16);
}

export function bm25CachePath(
  userHash: string,
  typesOrDir?: readonly RecordType[] | string,
  dir?: string,
): string {
  // userHash is hex; safe as a filename. Still, sanitize to alnum + dash just
  // in case a test stubs a weird value.
  const safe = userHash.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const types = Array.isArray(typesOrDir) ? typesOrDir : undefined;
  const cacheDir =
    typeof typesOrDir === "string" ? typesOrDir : dir ?? defaultCacheDir();
  const typeSuffix = types ? `-${typeSetCacheKey(types)}` : "";
  return join(cacheDir, `bm25-${safe || "anon"}${typeSuffix}.json`);
}

export function loadCachedIndex(
  userHash: string,
  typesOrDir?: readonly RecordType[] | string,
  cacheDir?: string,
): BM25Index | null {
  const path = bm25CachePath(userHash, typesOrDir, cacheDir);
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
  typesOrDir?: readonly RecordType[] | string,
  cacheDir?: string,
): void {
  const path = bm25CachePath(userHash, typesOrDir, cacheDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(index.toJSON()) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup only; preserve the original write/rename failure.
    }
    throw err;
  }
}

export async function loadOrBuildBm25Index(
  node: NodeClient,
  cfg: Config,
  types: readonly RecordType[],
  opts: { verbose?: Verbose } = {},
): Promise<Bm25IndexLoad> {
  const keys = await loadBm25Keys(node, cfg, types);
  const fingerprint = computeFingerprint(keys);
  const cached = loadCachedIndex(cfg.userHash, types);
  if (cached && cached.fingerprint === fingerprint) {
    opts.verbose?.(
      `bm25: cache hit (fingerprint ${fingerprint.slice(0, 12)}...) - skipping corpus body fetch`,
    );
    return {
      index: cached,
      liveById: new Map(),
      corpusSize: keys.length,
      cacheHit: true,
      fingerprint,
    };
  }

  const built = await loadBm25Documents(node, cfg, types);
  const index = BM25Index.build(built.docs);
  saveCachedIndex(cfg.userHash, index, types);
  opts.verbose?.(
    `bm25: rebuilt index (${built.docs.length} docs, fingerprint ${index.fingerprint.slice(0, 12)}...)`,
  );
  return {
    index,
    liveById: built.liveById,
    corpusSize: built.docs.length,
    cacheHit: false,
    fingerprint: index.fingerprint,
  };
}

async function loadBm25Keys(
  node: NodeClient,
  cfg: Config,
  types: readonly RecordType[],
): Promise<RecordKey[]> {
  const keys: RecordKey[] = [];
  for (const t of types) {
    const typeKeys = await listRecordKeys(node, t, schemaHashFor(t, cfg));
    for (const k of typeKeys) keys.push(k);
  }
  return keys;
}

async function loadBm25Documents(
  node: NodeClient,
  cfg: Config,
  types: readonly RecordType[],
): Promise<{ docs: BM25Document[]; liveById: Map<string, FbrainRecord> }> {
  const docs: BM25Document[] = [];
  const liveById = new Map<string, FbrainRecord>();
  for (const t of types) {
    const records = await listRecords(node, t, schemaHashFor(t, cfg));
    for (const r of records) {
      if (isTombstoned(r)) continue;
      docs.push({
        type: t,
        slug: r.slug,
        title: r.title,
        body: r.body,
        updatedAt: r.updated_at,
      });
      liveById.set(`${t}::${r.slug}`, r);
    }
  }
  return { docs, liveById };
}
