// `fbrain ask <query>` — hybrid retrieval.
//
// Pipeline:
//   1. (optional) LLM expands the query into 3 alternative phrasings via
//      Anthropic.  Original + 3 = 4 query strings.
//   2. For each query string, run BM25 (client-side index over all live
//      records) AND vector (node native-index, schema-scoped per G3d).
//      That's 8 ranked lists when expansion is on, 2 when --no-llm.
//   3. RRF fuses all lists. The fused top-K is the answer.
//   4. The chosen records get resolved to full FbrainRecord rows.
//
// Why hybrid: vector handles paraphrase ("backpressure" / "producer
// outpacing"); BM25 handles rare-token / acronym matches the embedding
// model never trained on.  RRF needs no score calibration between rankers.
//
// Cost guardrail: 1 LLM call per invocation when expansion is on. The
// expansion is logged to --verbose with token + USD estimate. Missing
// API key -> auto-fallback to BM25 + vector + RRF only (one-line notice).

import {
  newNodeClient,
  recordTypeForHash,
  type NativeIndexHit,
  type SearchOptions as ClientSearchOptions,
  type Verbose,
} from "../client.ts";
import type { Config } from "../config.ts";
import {
  isTombstoned,
  listRecords,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";
import {
  BM25Index,
  loadCachedIndex,
  saveCachedIndex,
  tokenize,
  type BM25Document,
} from "../retrieval/bm25.ts";
import {
  reciprocalRankFusion,
  RRF_DEFAULT_K,
  type FusedHit,
  type RankerInput,
} from "../retrieval/rrf.ts";
import {
  estimateCostUsd,
  expandQuery,
  ExpansionError,
  resolveAnthropicKey,
  type ExpansionResult,
} from "../retrieval/expand.ts";

export const DEFAULT_LIMIT = 5;
// Per-ranker breadth fed into RRF. Wider here gives RRF more material; the
// final --limit slices the fused top.
export const RANKER_LIMIT = 25;

export type AskOptions = {
  cfg: Config;
  query: string;
  limit?: number;
  noLlm?: boolean;
  explain?: boolean;
  // Restrict results to these record types. Undefined / empty = all 8 types.
  // Repeatable on the CLI via `--type T` (e.g. `--type design --type task`).
  // BM25 corpus is built only over the requested types and the vector call
  // is server-side schema-scoped, so both rankers see the narrowed slice.
  types?: readonly RecordType[];
  verbose?: Verbose;
  print?: (line: string) => void;
  // For tests: stub the expansion HTTP call.
  fetchImpl?: typeof fetch;
};

export type AskHit = {
  type: RecordType;
  slug: string;
  fusedScore: number;
  // Per-ranker debug. Bm25Rank / vectorRank refer to the ORIGINAL query
  // when expansion is on; expansionHits enumerates which expansion indices
  // (0-based) ranked the doc.
  bm25Rank: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  expansionHits: Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }>;
  record: FbrainRecord;
};

// Distinguishes the three "no expansion" stories so --explain can show
// whether the LLM was skipped intentionally vs. tried-and-failed. Kept
// alongside `expansion` (which is null whenever kind !== 'ok') rather
// than collapsing the two — `expansion` still carries the cost telemetry
// callers use on the success path.
export type ExpansionStatus =
  | { kind: "ok" }
  | { kind: "disabled" } // --no-llm
  | { kind: "no-key" } // ANTHROPIC_API_KEY not resolvable
  | { kind: "failed"; reason: string };

export type AskResult = {
  query: string;
  expansions: string[];
  // null = no LLM call made (--no-llm or missing key) OR the call failed.
  // Cross-reference `expansionStatus` to tell those apart.
  expansion: ExpansionResult | null;
  expansionStatus: ExpansionStatus;
  hits: AskHit[];
  bm25CorpusSize: number;
  bm25CacheHit: boolean;
};

export async function askCmd(opts: AskOptions): Promise<AskResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const typeFilter =
    opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const activeTypes: readonly RecordType[] = typeFilter
    ? RECORD_TYPES.filter((t) => typeFilter.has(t))
    : RECORD_TYPES;

  // ── Stage 0: query expansion ─────────────────────────────────────────
  let expansions: string[] = [];
  let expansion: ExpansionResult | null = null;
  let expansionStatus: ExpansionStatus;
  if (opts.noLlm) {
    expansionStatus = { kind: "disabled" };
  } else {
    const key = resolveAnthropicKey();
    if (!key) {
      // Auto-fallback: behave as --no-llm with a single notice line.
      print(
        "note: ANTHROPIC_API_KEY not set; running ask without query expansion (BM25+vector+RRF only).",
      );
      expansionStatus = { kind: "no-key" };
    } else {
      try {
        const exp: Parameters<typeof expandQuery>[0] = {
          query: opts.query,
          apiKey: key,
        };
        if (opts.fetchImpl) exp.fetchImpl = opts.fetchImpl;
        expansion = await expandQuery(exp);
        expansions = expansion.expansions;
        expansionStatus = { kind: "ok" };
        opts.verbose?.(
          `expansion: ${expansion.expansions.length} phrasings, ${expansion.latencyMs.toFixed(0)}ms, ` +
            `tokens in=${expansion.tokens.input} out=${expansion.tokens.output}, ` +
            formatCost(estimateCostUsd(expansion.tokens, expansion.model), expansion.model),
        );
      } catch (err) {
        const msg = err instanceof ExpansionError ? err.message : String(err);
        // Soft-fail: a flaky expansion shouldn't break ask. Print and continue
        // with just the original query.
        print(`note: query expansion failed (${msg}); continuing without expansion.`);
        expansionStatus = { kind: "failed", reason: msg };
      }
    }
  }

  const queries = [opts.query, ...expansions];

  // ── Stage 1: BM25 corpus build (cached) ──────────────────────────────
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const { docs, liveById } = await loadBm25Documents(node, opts.cfg, activeTypes);
  let index = loadCachedIndex(opts.cfg.userHash);
  const fingerprint = BM25Index.build(docs).fingerprint;
  let bm25CacheHit = false;
  if (index && index.fingerprint === fingerprint) {
    bm25CacheHit = true;
    opts.verbose?.(`bm25: cache hit (fingerprint ${fingerprint.slice(0, 12)}…)`);
  } else {
    index = BM25Index.build(docs);
    saveCachedIndex(opts.cfg.userHash, index);
    opts.verbose?.(
      `bm25: rebuilt index (${docs.length} docs, fingerprint ${index.fingerprint.slice(0, 12)}…)`,
    );
  }

  // ── Stage 2: per-query BM25 + vector ─────────────────────────────────
  const fbrainSchemas = uniqueFbrainSchemas(opts.cfg, activeTypes);
  const rankers: RankerInput[] = [];
  const vectorScoreById = new Map<string, number>();
  const perQueryVectorTopId = new Map<number, Map<string, number>>();
  const perQueryBm25TopId = new Map<number, Map<string, number>>();

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi]!;
    const tag = qi === 0 ? "orig" : `exp${qi - 1}`;

    // BM25 over this query. We re-tokenize here (cheap) to distinguish
    // "no surviving terms" (every token was a stopword or sub-2-char)
    // from "tokenized fine but nothing matched" — search() returns []
    // in both cases, which makes the all-stopword query indistinguishable
    // downstream without this peek.
    const bm25Tokens = tokenize(q);
    const bm25Hits = index.search(q, RANKER_LIMIT);
    const bm25Ranked = bm25Hits.map((h) => ({
      id: docId(h.type, h.slug),
      rank: h.rank,
    }));
    rankers.push({ label: `bm25:${tag}`, hits: bm25Ranked });
    const bm25Map = new Map<string, number>();
    for (const r of bm25Ranked) bm25Map.set(r.id, r.rank);
    perQueryBm25TopId.set(qi, bm25Map);
    opts.verbose?.(`bm25:${tag} → ${bm25Hits.length} hit(s)`);

    // Vector over this query.
    const clientOpts: ClientSearchOptions = {};
    if (fbrainSchemas.length > 0) clientOpts.schemas = fbrainSchemas;
    const raw = await node.search(q, clientOpts);
    const collapsed = collapseFragments(raw);
    const vectorHits = collapsed
      .map((h) => {
        const slug = h.key_value.hash;
        if (!slug) return null;
        const type = recordTypeForHash(h.schema_name, opts.cfg.schemaHashes);
        if (!type) return null;
        const id = docId(type, slug);
        const score = typeof h.metadata?.score === "number" ? h.metadata.score : 0;
        return { id, score };
      })
      .filter((x): x is { id: string; score: number } => x !== null);
    vectorHits.sort((a, b) => b.score - a.score);
    const vectorRanked = vectorHits.slice(0, RANKER_LIMIT).map((h, i) => ({
      id: h.id,
      rank: i + 1,
    }));
    rankers.push({ label: `vector:${tag}`, hits: vectorRanked });
    const vMap = new Map<string, number>();
    for (const r of vectorRanked) vMap.set(r.id, r.rank);
    perQueryVectorTopId.set(qi, vMap);
    // Record per-doc top vector score for display.
    for (const v of vectorHits) {
      const prior = vectorScoreById.get(v.id);
      if (prior === undefined || v.score > prior) vectorScoreById.set(v.id, v.score);
    }
    opts.verbose?.(
      `vector:${tag} → ${vectorRanked.length} unique hit(s) (raw fragments=${raw.length})`,
    );

    // User-facing "why am I getting nothing" surface for the original
    // query. Only fires for qi === 0 (the user's literal words) when
    // both rankers contributed zero AND the BM25 tokenizer dropped every
    // token — i.e. the query was all-stopwords or all-sub-2-char. We
    // intentionally keep the pipeline alive so expansions (when LLM is
    // on) can still rescue the query; the notice just explains why the
    // original phrasing alone produced nothing. Always shown, including
    // in --verbose mode — see the task's OUT OF SCOPE note.
    if (qi === 0 && bm25Tokens.length === 0 && vectorRanked.length === 0) {
      print(
        "note: query tokenized to zero terms (all stopwords or too short); try more specific words.",
      );
    }
  }

  // ── Stage 3: RRF fusion ──────────────────────────────────────────────
  const fused = reciprocalRankFusion(rankers, { k: RRF_DEFAULT_K });

  // ── Stage 4: resolve + filter ────────────────────────────────────────
  // Every live record was already loaded during the corpus build (Stage 1)
  // and indexed in `liveById`. Resolve is a Map lookup — no additional
  // HTTP round-trips. A miss means the doc is stale (vector index ahead
  // of the kind-filtered live snapshot, or soft-deleted between the
  // corpus walk and the vector call); silently skip.
  const resolved: AskHit[] = [];
  for (let i = 0; i < fused.length && resolved.length < limit; i++) {
    const f = fused[i]!;
    const parsed = parseDocId(f.id);
    if (!parsed) continue;
    const rec = liveById.get(f.id);
    if (!rec) {
      opts.verbose?.(`skip stale: ${parsed.type}/${parsed.slug}`);
      continue;
    }
    resolved.push({
      type: parsed.type,
      slug: parsed.slug,
      fusedScore: f.fusedScore,
      bm25Rank: perQueryBm25TopId.get(0)?.get(f.id) ?? null,
      vectorRank: perQueryVectorTopId.get(0)?.get(f.id) ?? null,
      vectorScore: vectorScoreById.get(f.id) ?? null,
      expansionHits: collectExpansionHits(f, perQueryBm25TopId, perQueryVectorTopId),
      record: rec,
    });
  }

  // ── Stage 5: print ───────────────────────────────────────────────────
  if (opts.explain) {
    // --explain must say something in every expansion path, otherwise an
    // operator running it on the offline path sees output identical to a
    // plain --no-llm run and concludes --explain is broken.
    if (expansionStatus.kind === "failed") {
      print(`expansion failed: ${expansionStatus.reason}`);
      print("");
    } else if (expansionStatus.kind === "disabled") {
      print("(no expansions — LLM disabled via --no-llm)");
      print("");
    } else if (expansionStatus.kind === "no-key") {
      print(
        "(no expansions — ANTHROPIC_API_KEY not set; running BM25 + vector on original query only)",
      );
      print("");
    } else if (expansions.length > 0) {
      print(`expansions:`);
      for (const e of expansions) print(`  - ${e}`);
      print("");
    }
  }
  if (resolved.length === 0) {
    print("no matches");
  } else {
    for (const h of resolved) {
      const score = h.fusedScore.toFixed(4);
      const bm = h.bm25Rank === null ? "—" : String(h.bm25Rank);
      const vr = h.vectorRank === null ? "—" : String(h.vectorRank);
      const exp =
        h.expansionHits.length === 0 ? "" : `  +exp[${formatExpansionHits(h.expansionHits)}]`;
      print(
        `${h.slug.padEnd(28)}  ${score.padStart(7)}  ${capitalize(h.type).padEnd(10)}  bm25=${bm.padStart(3)}  vec=${vr.padStart(3)}${exp}  ${h.record.title}`,
      );
    }
  }

  if (expansion && opts.verbose) {
    const usd = estimateCostUsd(expansion.tokens, expansion.model);
    opts.verbose(
      `ask: expansion ${formatCost(usd, expansion.model)} (${expansion.tokens.input}in / ${expansion.tokens.output}out, ${expansion.model})`,
    );
  }

  return {
    query: opts.query,
    expansions,
    expansion,
    expansionStatus,
    hits: resolved,
    bm25CorpusSize: docs.length,
    bm25CacheHit,
  };
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Single source of truth for cost rendering in --verbose lines. When the
// pricing table doesn't know the model, surface that explicitly rather
// than letting a default fill in a wrong number.
export function formatCost(usd: number | null, model: string): string {
  return usd === null
    ? `cost≈unknown (${model} not in price table)`
    : `cost≈$${usd.toFixed(6)}`;
}

function uniqueFbrainSchemas(
  cfg: Config,
  types: readonly RecordType[],
): string[] {
  return Array.from(
    new Set(
      types
        .map((t) => cfg.schemaHashes[t])
        .filter((h): h is string => typeof h === "string" && h.length > 0),
    ),
  );
}

async function loadBm25Documents(
  node: ReturnType<typeof newNodeClient>,
  cfg: Config,
  types: readonly RecordType[],
): Promise<{ docs: BM25Document[]; liveById: Map<string, FbrainRecord> }> {
  const docs: BM25Document[] = [];
  // `liveById` doubles as the Stage-4 resolve lookup: we keep the full
  // FbrainRecord here so Stage 4 can hand it back without a second
  // listRecords call. Tombstones are excluded — they're not in the index
  // either, so anything fused back to a tombstone is a stale ranker hit
  // and Stage 4 will skip on a miss.
  const liveById = new Map<string, FbrainRecord>();
  // Walk the active record types. When --type narrows the set we skip the
  // others entirely — smaller index, fewer HTTP calls. listRecords already
  // kind-filters and returns live + tombstoned; we drop tombstones for the
  // index. Phase 6 types share noteSchema so they're effectively listed via
  // separate kind-filtered queries — same network cost, just split logically.
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
      liveById.set(docId(t, r.slug), r);
    }
  }
  return { docs, liveById };
}

export function docId(type: RecordType, slug: string): string {
  return `${type}::${slug}`;
}

export function parseDocId(id: string): { type: RecordType; slug: string } | null {
  const idx = id.indexOf("::");
  if (idx <= 0) return null;
  const type = id.slice(0, idx);
  const slug = id.slice(idx + 2);
  if (!isRecordType(type) || slug.length === 0) return null;
  return { type, slug };
}

function isRecordType(s: string): s is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(s);
}

// Collapse multi-fragment vector hits to one per (schema, slug), keeping
// the highest score. Same shape as search.ts's dedupeHits but returns the
// raw NativeIndexHit kept per (schema, slug) — caller resolves to record.
export function collapseFragments(hits: NativeIndexHit[]): NativeIndexHit[] {
  const best = new Map<string, NativeIndexHit>();
  for (const h of hits) {
    const slug = h.key_value.hash;
    if (!slug) continue;
    const key = `${h.schema_name}::${slug}`;
    const score = typeof h.metadata?.score === "number" ? h.metadata.score : -1;
    const prior = best.get(key);
    const priorScore = typeof prior?.metadata?.score === "number" ? prior.metadata.score : -1;
    if (!prior || score > priorScore) best.set(key, h);
  }
  return Array.from(best.values());
}

function collectExpansionHits(
  f: FusedHit,
  bm25: Map<number, Map<string, number>>,
  vector: Map<number, Map<string, number>>,
): Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }> {
  const out: Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }> = [];
  // Expansion queries are at indices 1, 2, 3, ... — anything > 0.
  for (const [qi, m] of bm25) {
    if (qi === 0) continue;
    const r = m.get(f.id);
    if (r !== undefined) out.push({ idx: qi - 1, ranker: "bm25", rank: r });
  }
  for (const [qi, m] of vector) {
    if (qi === 0) continue;
    const r = m.get(f.id);
    if (r !== undefined) out.push({ idx: qi - 1, ranker: "vector", rank: r });
  }
  return out;
}

function formatExpansionHits(
  hits: Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }>,
): string {
  return hits
    .map((h) => `${h.ranker[0]}${h.idx}=${h.rank}`)
    .join(",");
}
