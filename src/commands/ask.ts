// `fbrain ask <query>` — hybrid retrieval.
//
// Pipeline:
//   1. (opt-in, --expand) LLM expands the query into 3 alternative phrasings
//      via Anthropic.  Original + 3 = 4 query strings.
//   2. For each query string, run BM25 (client-side index over all live
//      records) AND vector (node native-index, schema-scoped per G3d).
//      That's 2 ranked lists by default, 8 when --expand is on.
//   3. RRF fuses all lists. The fused top-K is the answer.
//   4. The chosen records get resolved to full FbrainRecord rows.
//
// Why hybrid: vector handles paraphrase ("backpressure" / "producer
// outpacing"); BM25 handles rare-token / acronym matches the embedding
// model never trained on.  RRF needs no score calibration between rankers.
//
// Default = no LLM. The 2026-05-25 labeled eval (docs/g0-replacement-
// readiness-gate.md §8) showed LLM query expansion REDUCED relevance vs.
// the plain hybrid path (P@5 0.59 vs 0.73, MRR 0.46 vs 0.60). So expansion
// is OFF by default — `ask` runs BM25 + vector + RRF on the original query,
// which is the eval winner and needs no API key. Expansion is opt-in via
// `--expand` (alias `--llm`) for callers who want the wider paraphrase recall.
//
// Cost guardrail: 1 LLM call per invocation ONLY when --expand is set. The
// expansion is logged to --verbose with token + USD estimate. Missing API
// key under --expand -> falls back to BM25 + vector + RRF only (one-line
// notice).

import {
  newReadClientFromCfg,
  recordTypeForHash,
  type NodeClient,
  type SearchOptions as ClientSearchOptions,
  type Verbose,
} from "../client.ts";
import type { Config } from "../config.ts";
import {
  capitalize,
  formatTable,
  printColumnLegend,
  resolvePrintSinks,
  resolveStdoutIsTty,
} from "../format.ts";
import {
  hasAnyLiveRecord,
  isTombstoned,
  listRecords,
  resolveTypeFilter,
  schemaHashFor,
  uniqueSchemaHashes,
  type FbrainRecord,
} from "../record.ts";
import { isRecordType, type RecordType } from "../schemas.ts";
import {
  BM25Index,
  computeFingerprint,
  loadCachedIndex,
  saveCachedIndex,
  tokenize,
  type BM25Document,
} from "../retrieval/bm25.ts";
import { dedupeHits } from "../retrieval/dedupe.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import { isWeakMatch, type SearchHitJson } from "./search.ts";
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
  // Opt-in LLM query expansion (Stage 0). Default OFF — the 2026-05-25
  // labeled eval showed expansion REDUCES relevance vs. the plain hybrid
  // path (see §8 of the gate doc), so the eval-winning, key-free path is
  // the default and expansion is explicit.
  expand?: boolean;
  // Back-compat no-op. `--no-llm` used to disable an on-by-default expansion;
  // expansion is now off by default, so passing this changes nothing. Kept
  // so existing scripts/agents don't break. Ignored when `expand` is set.
  noLlm?: boolean;
  explain?: boolean;
  // Restrict results to these record types. Undefined / empty = all 8 types.
  // Repeatable on the CLI via `--type T` (e.g. `--type design --type task`).
  // BM25 corpus is built only over the requested types and the vector call
  // is server-side schema-scoped, so both rankers see the narrowed slice.
  types?: readonly RecordType[];
  // Machine-readable mode. Emits a single JSON array document via `print`
  // (one call); empty-result sentinel becomes `[]`, the `--explain`
  // expansions block and every advisory `note:` line route to `printErr`
  // so stdout stays pure JSON — matches `fbrain search --json` discipline.
  json?: boolean;
  verbose?: Verbose;
  // Result rows sink (stdout). Default: console.log.
  print?: (line: string) => void;
  // Advisory `note:` lines sink (stderr). Kept separate from `print` so
  // `fbrain ask q 2>/dev/null` yields only the parseable result rows.
  // Default: console.error.
  printErr?: (line: string) => void;
  // Treat stdout as an interactive TTY (default: process.stdout.isTTY).
  // Gates the human-only column legend — overridable so tests can drive both
  // the TTY (legend present) and piped (legend absent) paths deterministically.
  isTty?: () => boolean;
  // Agent-channel signal. Set by the MCP `fbrain_ask` wrapper (NOT the human
  // CLI). When true, the empty-brain recovery hint is rendered in MCP-tool
  // terms (`fbrain_put`) instead of the `fbrain <type> new` CLI verb the agent
  // has no tool for. Mirrors `FbrainError.agentHint` for the ERROR path.
  // Default (undefined) keeps the human CLI output byte-identical.
  agent?: boolean;
  // Structured-result sink. When set, receives the SAME array of
  // `{slug,score,type,title}` objects that `--json` mode serializes to
  // stdout — one source of truth for both the JSON CLI surface and the
  // MCP `structuredContent`. Fires once per call (with `[]` on no
  // matches) regardless of the `json` flag, so the MCP handler can run
  // the command in human mode for `content` text AND capture the typed
  // payload without re-parsing the printed line. Same shape as
  // `fbrain search --json` (every `ask` hit carries a non-null score).
  onResult?: (payload: SearchHitJson[]) => void;
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
  | { kind: "disabled" } // expansion not requested (default; or --no-llm no-op)
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
  const { print, printErr } = resolvePrintSinks(opts);
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const { activeTypes } = resolveTypeFilter(opts.types);

  // ── Stage 0: query expansion ─────────────────────────────────────────
  let expansions: string[] = [];
  let expansion: ExpansionResult | null = null;
  let expansionStatus: ExpansionStatus;
  if (!opts.expand) {
    // Default path: no LLM. (Also covers the back-compat --no-llm no-op.)
    expansionStatus = { kind: "disabled" };
  } else {
    const key = resolveAnthropicKey();
    if (!key) {
      // Auto-fallback: behave as --no-llm with a single notice line.
      // Advisory → stderr so `fbrain ask q 2>/dev/null` stays parseable.
      printErr(
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
        // with just the original query. Advisory → stderr.
        printErr(`note: query expansion failed (${msg}); continuing without expansion.`);
        expansionStatus = { kind: "failed", reason: msg };
      }
    }
  }

  const queries = [opts.query, ...expansions];

  // ── Stage 1: BM25 corpus build (cached) ──────────────────────────────
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

  const { docs, liveById } = await loadBm25Documents(node, opts.cfg, activeTypes);
  let index = loadCachedIndex(opts.cfg.userHash);
  // computeFingerprint is the same hash BM25Index.build assigns, so we use it
  // standalone here to decide cache hit vs miss — building the full index
  // just to read its fingerprint would discard a full postings build on every
  // cache hit.
  const fingerprint = computeFingerprint(docs);
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
  const fbrainSchemas = uniqueSchemaHashes(opts.cfg, activeTypes);
  const rankers: RankerInput[] = [];
  const vectorScoreById = new Map<string, number>();
  const perQueryVectorTopId = new Map<number, Map<string, number>>();
  const perQueryBm25TopId = new Map<number, Map<string, number>>();

  // Dedupe queries by exact string. When the LLM emits an expansion identical
  // to the original (or to another expansion — the system prompt asks for
  // "exactly 3 alternative phrasings" but models occasionally repeat
  // themselves, especially under tight max_tokens or when they ran out of
  // genuine variations), the pre-fix loop ran each duplicate through BM25 +
  // vector and pushed IDENTICAL ranked lists into RRF. Each ranker input
  // then summed the same `1/(k+rank)` contribution, inflating any hit's
  // fused score by the count of duplicate phrasings and biasing the top-K
  // toward whichever string the LLM happened to repeat. Preserve the FIRST
  // occurrence so the original query's "orig" label survives any expansion
  // that echoes it; later duplicates are skipped wholesale (no per-query
  // ranker input, no extra HTTP, and no entry in `perQuery*TopId` so the
  // `expansionHits` collection correctly attributes contributions only to
  // the unique queries that actually ran).
  const seenQueries = new Set<string>();

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi]!;
    if (seenQueries.has(q)) continue;
    seenQueries.add(q);
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
    perQueryBm25TopId.set(qi, rankMap(bm25Ranked));
    opts.verbose?.(`bm25:${tag} → ${bm25Hits.length} hit(s)`);

    // Vector over this query.
    const clientOpts: ClientSearchOptions = {};
    if (fbrainSchemas.length > 0) clientOpts.schemas = fbrainSchemas;
    const raw = await node.search(q, clientOpts);
    const collapsed = dedupeHits(raw);
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
    // Sort by score DESC, ties broken by id ASC (code-unit order). Without
    // the id key, equal-score vector hits keep `dedupeHits` insertion
    // order — which depends on the order the daemon returned the underlying
    // fragments. That order then flowed into RRF as the per-doc vector rank,
    // and a tied doc that landed at rank 1 in one response ordering and
    // rank 2 in another came out with different fused scores (1/61 vs 1/62)
    // — flipping the top result for the same query + corpus + hit set just
    // because the server happened to return tied fragments in the opposite
    // order. Same shape as the rrf.ts (PR #79) and bm25.ts (PR #101)
    // tie-breaks, applied one layer up — vector rank assignment is the
    // third score-ordered layer on the ask pipeline and must be invariant
    // too. Especially load-bearing on the score-missing path, where the
    // default-to-0 maps every score-less hit into a wholesale tie.
    vectorHits.sort(
      (a, b) =>
        b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const vectorRanked = vectorHits.slice(0, RANKER_LIMIT).map((h, i) => ({
      id: h.id,
      rank: i + 1,
    }));
    rankers.push({ label: `vector:${tag}`, hits: vectorRanked });
    perQueryVectorTopId.set(qi, rankMap(vectorRanked));
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
      // Advisory → stderr so `fbrain ask q 2>/dev/null` stays parseable.
      printErr(
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
  // In --json mode, stdout MUST be pure JSON: the --explain expansions
  // block routes to stderr (matches the #200/#209 stdout-discipline
  // already applied to ask/search `note:` lines). --json + --explain
  // still works — explanations just land on stderr where jq can't see
  // them but a human reading stderr can.
  const explainSink = opts.json ? printErr : print;
  if (opts.explain) {
    // --explain must say something in every expansion path, otherwise an
    // operator running it on the offline path sees output identical to a
    // plain --no-llm run and concludes --explain is broken.
    if (expansionStatus.kind === "failed") {
      explainSink(`expansion failed: ${expansionStatus.reason}`);
      explainSink("");
    } else if (expansionStatus.kind === "disabled") {
      explainSink("(no expansions — LLM expansion not enabled; pass --expand)");
      explainSink("");
    } else if (expansionStatus.kind === "no-key") {
      explainSink(
        "(no expansions — ANTHROPIC_API_KEY not set; running BM25 + vector on original query only)",
      );
      explainSink("");
    } else if (expansions.length > 0) {
      explainSink(`expansions:`);
      for (const e of expansions) explainSink(`  - ${e}`);
      explainSink("");
    }
  }
  // {slug, score, type, title} per hit — type is the canonical lowercase
  // RecordType (not the capitalized human display name) so consumers can
  // match against `--type` values verbatim. Same shape as
  // `fbrain search --json`. Empty result is `[]` rather than the human
  // "no matches" sentinel.
  //
  // Score rounded to 6 decimals to match search --json's discipline and
  // strip RRF's float noise — output-only; sort/rank ran on full precision.
  //
  // Built unconditionally (not just under --json) so the `onResult`
  // structured sink and the `--json` stdout document are the SAME value
  // — the MCP `structuredContent` can't drift from the CLI JSON shape.
  const payload: SearchHitJson[] = resolved.map((h) => ({
    slug: h.slug,
    score: Math.round(h.fusedScore * 1e6) / 1e6,
    type: h.type,
    title: h.record.title,
    // Deterministic body extract from the already-hydrated record — no extra
    // fetch. Centered on the first matching query term (or the body head when
    // a hit came purely from the vector ranker with no literal overlap) so the
    // answer shows inline. Built unconditionally so `--json` and the MCP
    // `structuredContent` carry the same snippet the human render shows.
    snippet: buildSnippet(h.record.body, opts.query),
  }));
  opts.onResult?.(payload);

  // Weak-match advisory. `ask` is the RECOMMENDED retrieval primitive, yet
  // until now it was the one that silently handed a no-match query five
  // confident-looking rows with no signal they're junk — while the secondary
  // `search` path warns (#253/#308/#321). Close that inconsistency: when the
  // result set is a flat floor band of noise, flag it. STRICTLY ADDITIVE — we
  // never drop a row; the note just lets the user tell "showing the closest we
  // found" apart from "this nailed it".
  //
  // The signal is the per-hit `vectorScore` (the cosine the vector ranker
  // returned), NOT the fused RRF score. RRF scores are rank-based (~0.016 even
  // for great hits) and carry no absolute-relevance meaning, so they can't be
  // thresholded. `vectorScore` is the SAME cosine scale `search` thresholds on,
  // so we reuse search's distribution-shape classifier (`isWeakMatch`) and its
  // STRONG_SCORE 0.5 / FLATNESS_GAP 0.025 — those are the same cosine scale.
  //
  // NOISE_CEILING differs from search's 0.3, and on purpose. `search`
  // classifies over its full top-50 cosine list, so the flat-floor band is
  // densely sampled and FLATNESS_GAP reliably catches noise — 0.3 only needs to
  // backstop the sparse-brain edge. `ask` resolves only the top-`limit` (≈5)
  // RRF-FUSED hits, a tiny sample where one moderately-higher cosine breaks
  // flatness even on pure noise: a real no-match query measured top 0.419 with
  // median−min 0.037 on the live :9001 brain (run 2026-06-21) and slipped past
  // the flatness test. So `ask` leans harder on the absolute floor. Calibrated
  // on the live brain: noise tops landed 0.41–0.44, genuine sub-STRONG real
  // hits 0.45–0.49 (search.ts's own measured boundary), so 0.45 splits them —
  // it flags both gibberish probes (tops 0.419 / 0.409) via the floor while a
  // real query's strong top (≥0.66 here) clears STRONG_SCORE outright. A real
  // query whose own top is sub-strong-and-flat (e.g. 0.459, median−min 0.020)
  // still flags, exactly as `search` would — that IS a weak match, not a false
  // positive.
  //
  // If every resolved hit has `vectorScore === null` (e.g. a pure-BM25 rescue
  // where the vector ranker contributed nothing) the distribution is
  // unmeasurable → do not annotate (same as search's null handling). The
  // all-stopwords notice in Stage 2 (qi === 0, zero tokens) is a different,
  // complementary case and stays as-is.
  const STRONG_SCORE = 0.5;
  const FLATNESS_GAP = 0.025;
  const NOISE_CEILING = 0.45;
  const topVectorScore = resolved.reduce<number | null>((max, h) => {
    if (h.vectorScore === null) return max;
    return max === null || h.vectorScore > max ? h.vectorScore : max;
  }, null);
  const weakMatch =
    resolved.length > 0 &&
    topVectorScore !== null &&
    isWeakMatch(
      topVectorScore,
      resolved.map((h) => ({ score: h.vectorScore })),
      STRONG_SCORE,
      FLATNESS_GAP,
      NOISE_CEILING,
    );
  // Same copy as search's `weakMatchNote`, minus the "Try `fbrain ask`" tail
  // (the user is already in ask — pointing them back at it is a dead end).
  const weakMatchNote = `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms.`;

  if (resolved.length === 0) {
    // Context-aware no-match hint, mirroring `fbrain search` (#276). `ask` is a
    // BM25 + vector hybrid, so on a POPULATED brain it almost never returns
    // zero — this branch is reached almost exclusively on a brand-new EMPTY
    // brain (a new dev following the init next-steps, which point them at both
    // `search` AND `ask` before they've created anything). Probe whether the
    // brain holds any live record (a cheap extra round-trip, paid only on the
    // no-match path) and, when it's empty, point them at creating their first
    // record — the same calm guidance `search` now gives. A populated brain
    // that simply matched nothing gets a terse retry nudge.
    //
    // Fast-path: the BM25 corpus we already built walked the active types, so a
    // non-empty corpus PROVES the brain holds a live record — skip the extra
    // probe round-trip entirely. We only pay the `hasAnyLiveRecord` walk when
    // the corpus came back empty (the new-dev empty-brain case, or a `--type`
    // filter whose type has no records — the probe checks ALL types).
    const empty = docs.length === 0 && !(await hasAnyLiveRecord(node, opts.cfg));
    // On the MCP agent channel the empty-brain hint must name the agent's
    // create TOOL (`fbrain_put`), not the `fbrain <type> new` CLI verb it can't
    // call. The populated-brain "nothing matched" nudge is already
    // channel-neutral (no CLI verb / reindex / doc path), so it's shared.
    const hint = empty
      ? opts.agent
        ? "hint:  no records yet — create your first with the `fbrain_put` tool, then try again"
        : "hint:  no records yet — create your first with `fbrain <type> new <slug>` (design/concept/project/…), then ask again"
      : "hint:  nothing matched — try fewer or different terms";
    if (opts.json) {
      // Stdout stays the parseable empty array `[]` (== JSON.stringify(payload)
      // when nothing resolved); the hint goes to stderr so jq pipelines see a
      // clean empty array, never the hint text.
      print(JSON.stringify(payload));
      printErr(hint);
    } else {
      print("no matches");
      print(hint);
    }
  } else if (opts.json) {
    print(JSON.stringify(payload));
    // Advisory → stderr only; stdout stays pure JSON (mirrors search.ts).
    if (weakMatch) printErr(weakMatchNote);
  } else if (opts.verbose) {
    // Advisory → stderr so `fbrain ask q 2>/dev/null` stays parseable.
    if (weakMatch) printErr(weakMatchNote);
    // Human-only column legend (TTY, non-JSON; `resolved` is non-empty here).
    // Verbose keeps the raw fused-RRF score as a labeled debug column for
    // operators; the leading column is still the 1-based rank so the primary
    // read stays "best-first" rather than the tiny RRF magnitude.
    if (resolveStdoutIsTty(opts)) {
      printColumnLegend(
        print,
        "rank · slug · rrf(raw fused, not comparable to search) · type · bm25 · vec · title",
      );
    }
    // Verbose: per-ranker debug columns (bm25=, vec=, +exp[...]) plus the raw
    // fused-RRF score for diagnostics. The leading rank column matches the
    // default human render. Expansion column collapses when every row has no
    // expansion hits; formatTable computes a 0-width column for an all-empty
    // column, and adjacent gaps merge into the same 2-space separator.
    const lines = formatTable(
      resolved.map((h, i) => {
        const score = h.fusedScore.toFixed(4);
        const bm = h.bm25Rank === null ? "—" : String(h.bm25Rank);
        const vr = h.vectorRank === null ? "—" : String(h.vectorRank);
        const exp =
          h.expansionHits.length === 0
            ? ""
            : `+exp[${formatExpansionHits(h.expansionHits)}]`;
        return [
          `${i + 1}.`,
          h.slug,
          score,
          capitalize(h.type),
          `bm25=${bm}`,
          `vec=${vr}`,
          exp,
          h.record.title,
        ];
      }),
      { align: ["right", "left", "right", "left", "left", "left", "left", "left"] },
    );
    // Row, then the matching body snippet as an indented second line.
    // `payload` is index-aligned with `resolved`/`lines` (same map source).
    for (let i = 0; i < lines.length; i++) {
      print(lines[i]!);
      const snippet = payload[i]?.snippet;
      if (snippet) print(`    ${snippet}`);
    }
  } else {
    // Advisory → stderr so `fbrain ask q 2>/dev/null` stays parseable.
    if (weakMatch) printErr(weakMatchNote);
    // Human-only column legend (TTY, non-JSON; `resolved` is non-empty here).
    // Rows are printed best-first; the leading column is the 1-based rank,
    // NOT a score (the raw fused-RRF value is exposed via --json/--verbose).
    if (resolveStdoutIsTty(opts)) {
      printColumnLegend(print, "rank · slug · type · title (best match first)");
    }
    // Default: clean `rank · slug · type · title` — best-first ranked list.
    // The leading column is the hit's 1-based rank position (rows are already
    // emitted in RRF rank order, so rank is monotonic by construction). We
    // intentionally do NOT show the raw fused-RRF score here: a tiny value
    // like `0.0328` on a perfect top match reads as "3% confidence" and
    // undermines trust in retrieval. Machine consumers get the raw `score`
    // via --json; operators get it via --verbose. Per-ranker debug is
    // operator-only and lives behind --verbose.
    const lines = formatTable(
      resolved.map((h, i) => [
        `${i + 1}.`,
        h.slug,
        capitalize(h.type),
        h.record.title,
      ]),
      { align: ["right", "left", "left", "left"] },
    );
    // Row, then the matching body snippet as an indented second line so the
    // answer is visible without a follow-up `fbrain get`. The table row is
    // unchanged — same `slug · score · type · title` shape parsers expect.
    // `payload` is index-aligned with `resolved`/`lines` (same map source).
    for (let i = 0; i < lines.length; i++) {
      print(lines[i]!);
      const snippet = payload[i]?.snippet;
      if (snippet) print(`    ${snippet}`);
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

// Single source of truth for cost rendering in --verbose lines. When the
// pricing table doesn't know the model, surface that explicitly rather
// than letting a default fill in a wrong number.
export function formatCost(usd: number | null, model: string): string {
  return usd === null
    ? `cost≈unknown (${model} not in price table)`
    : `cost≈$${usd.toFixed(6)}`;
}

async function loadBm25Documents(
  node: NodeClient,
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
  // others entirely — smaller index, fewer HTTP calls. listRecords returns
  // live + tombstoned; we drop tombstones for the index.
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

function rankMap(ranked: Array<{ id: string; rank: number }>): Map<string, number> {
  return new Map(ranked.map((r) => [r.id, r.rank]));
}

function collectExpansionHits(
  f: FusedHit,
  bm25: Map<number, Map<string, number>>,
  vector: Map<number, Map<string, number>>,
): Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }> {
  const out: Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }> = [];
  // Expansion queries are at indices 1, 2, 3, ... — anything > 0.
  const collect = (
    src: Map<number, Map<string, number>>,
    ranker: "bm25" | "vector",
  ): void => {
    for (const [qi, byId] of src) {
      if (qi === 0) continue;
      const r = byId.get(f.id);
      if (r !== undefined) out.push({ idx: qi - 1, ranker, rank: r });
    }
  };
  collect(bm25, "bm25");
  collect(vector, "vector");
  return out;
}

function formatExpansionHits(
  hits: Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }>,
): string {
  return hits
    .map((h) => `${h.ranker[0]}${h.idx}=${h.rank}`)
    .join(",");
}
