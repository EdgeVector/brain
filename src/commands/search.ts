// `fbrain search <query> [-n N | --limit N] [--exact] [--min-score F]` — semantic search
// over the native index, with fragment→record resolution.
//
// The node's /api/native-index/search returns one row per indexed fragment
// (e.g. a long body splits into multiple hits). We dedupe by
// (schema_display_name, key_value.hash), keep the highest-score fragment
// per record, resolve each unique hit to its full record via findBySlug,
// and silently skip stale hits (record deleted since indexing).

import {
  newReadClientFromCfg,
  type NativeIndexHit,
  type NodeClient,
  type SearchOptions as ClientSearchOptions,
  type Verbose,
  recordTypeForHash,
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
  hydrateSchemaBySlug,
  missingSchemaHashReadNote,
  resolveTypeFilter,
  schemaHashFor,
  uniqueSchemaHashes,
  type FbrainRecord,
} from "../record.ts";
import { loadOrBuildBm25Index } from "../retrieval/bm25.ts";
import { dedupeHits } from "../retrieval/dedupe.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import { type RecordType } from "../schemas.ts";

export { dedupeHits };

// Default result cap when the caller passes no `--limit`. Before this, `search`
// had NO default limit: a query that fell through to the BM25 keyword-rescue
// path printed the ENTIRE corpus (bm25FallbackFromCorpus defaults its own limit
// to `docs.length`), and the native path printed the server's full top-50. An
// explicit `--limit N` overrides this.
//
// This is the canonical page-size constant for both retrieval surfaces:
// `ask`'s DEFAULT_LIMIT is derived from it (ask.ts imports it), so `search`
// and `ask` stay consistent by construction. It is defined HERE (not in
// ask.ts) because ask.ts already imports from search.ts — keeping the
// dependency edge one-way avoids a module-init cycle where a re-export could
// read `undefined`.
export const SEARCH_DEFAULT_LIMIT = 5;

// Confidence label for a BM25 keyword-rescue row. Isolated as a constant so
// the "fallback rows are NOT strong" contract has one source of truth.
const FALLBACK_CONFIDENCE = "fallback" as const;

export type SearchOptions = {
  cfg: Config;
  query: string;
  limit?: number;
  exact?: boolean;
  minScore?: number;
  // Restrict results to these record types. Undefined / empty = all record types.
  // Repeatable on the CLI via `--type T` (e.g. `--type design --type task`).
  types?: readonly RecordType[];
  // Machine-readable mode. Emits a single JSON array document via
  // `print` (one call); empty-result hint and weak-match advisory
  // are routed to `printErr` so stdout stays pure JSON.
  json?: boolean;
  verbose?: Verbose;
  // Result rows sink (stdout). Default: console.log.
  print?: (line: string) => void;
  // Advisory `note:` lines sink (stderr). Kept separate from `print` so
  // `fbrain search q 2>/dev/null` yields only the parseable result rows.
  // Default: console.error.
  printErr?: (line: string) => void;
  // Treat stdout as an interactive TTY (default: process.stdout.isTTY).
  // Gates the human-only column legend — overridable so tests can drive both
  // the TTY (legend present) and piped (legend absent) paths deterministically.
  isTty?: () => boolean;
  // Agent-channel signal. Set by the MCP `fbrain_search` wrapper (NOT the
  // human CLI). When true, the empty/no-match recovery hint is rendered in
  // MCP-tool terms (`fbrain_put` / `fbrain_ask`) instead of CLI verbs the
  // agent has no tools for (`fbrain <type> new`, `fbrain ask`, `fbrain
  // reindex`, a repo doc path). Mirrors `FbrainError.agentHint` for the
  // ERROR path. Default (undefined) keeps the human CLI output byte-identical.
  agent?: boolean;
  // Structured-result sink. When set, receives the SAME array of
  // `{slug,score,type,title,snippet,confidence}` objects that `--json` mode serializes to
  // stdout — one source of truth for both the JSON CLI surface and the
  // MCP `structuredContent`. Fires once per call (with `[]` on no
  // matches) regardless of the `json` flag, so the MCP handler can run
  // the command in human mode for `content` text AND capture the typed
  // payload without re-parsing the printed line.
  onResult?: (payload: SearchHitJson[]) => void;
  // Structured advisory sink for read-degraded configs. The human/CLI surface
  // still receives the existing note via printErr; MCP uses this to expose
  // skipped record types in structuredContent.
  onSkippedTypes?: (skipped: readonly RecordType[]) => void;
};

// One match in the machine-readable search/ask result. `type` is the
// canonical lowercase RecordType (matches `--type` values verbatim);
// `score` is rounded to 6 decimals (see the rationale at the emit site)
// and is `null` only for search hits the node reported no score for.
export type SearchHitJson = {
  slug: string;
  score: number | null;
  type: RecordType;
  title: string;
  // A short deterministic body extract — a ~120-char window around the first
  // matching query term (or the body head for a pure-vector hit) — so the
  // answer is visible inline under each result without a follow-up
  // `fbrain get`. `""` only when the record body is empty. Built from the
  // already-hydrated record (no extra fetch).
  snippet: string;
  // Retrieval confidence for this row. `strong` = a real vector match.
  // `weak` = the native vector result set looks like a noise-floor band, so
  // the row is a closest-known candidate, not a trusted answer. `fallback` =
  // the native vector search found nothing usable and this row came from the
  // BM25 keyword-rescue path — a literal keyword match with no semantic
  // confidence signal (score is always `null`). Both `weak` and `fallback`
  // are "do not trust as a confident answer" for the MCP `confident` flag.
  confidence: "strong" | "weak" | "fallback";
};

export type ResolvedHit = {
  slug: string;
  schemaDisplayName: string;
  schemaHash: string;
  type: RecordType;
  score: number | null;
  matchType: string | null;
  record: FbrainRecord;
};

// Top score at/above this is a real hit regardless of distribution shape
// (real-match band ~0.45-0.8 on the live brain; a dense strong band lands here).
const STRONG_SCORE = 0.5;
// Below STRONG_SCORE, a result set whose median is within this of its
// minimum is a flat floor band -> weak. Noise measured at median-min <=0.014,
// genuine sub-0.5 hits at >=0.035; 0.025 splits them with margin.
const FLATNESS_GAP = 0.025;
// Absolute low-top-score floor for sparse new-dev brains.
const NOISE_CEILING = 0.3;

// Weak-match classifier (separation-based; see the rationale block in
// `searchCmd` below). A hit list is weak when its top score neither clears
// `strongScore` on its own NOR rises out of a flat floor band: when the bulk
// of the distribution piles on its minimum (`median − min < flatnessGap`),
// the results are indistinguishable noise even if the top fragment edges a
// little higher. Robust to brain size by construction — more noise records
// just lengthen the floor pile; a real query grades upward off the floor.
//
// One extra guard handles the SPARSE NEW-DEV brain. The flat-floor shape test
// was calibrated on Tom's populated live brain, where dozens of noise records
// pile on a flat floor so `median ≈ min`. A brand-new dev's brain has too few
// records to form that pile — a handful of scattered low noise scores keeps
// `median − min` above `flatnessGap`, so the shape test alone misses the noise
// and the headline search feature looks broken for the exact "minimal effort"
// persona fbrain targets. `noiseCeiling` adds an ABSOLUTE low-top-score floor:
// an obviously-low top score is weak regardless of distribution shape. Genuine
// sub-`strongScore` hits land ~0.45–0.49 and noise tops ~0.39–0.44, so a top
// below ~0.30 is unambiguous noise.
//
// `null` scores are dropped first (they're "unmeasurable", not part of the
// distribution). Exported for tests.
export function isWeakMatch(
  topScore: number,
  hits: readonly { score: number | null }[],
  strongScore: number,
  flatnessGap: number,
  noiseCeiling: number,
): boolean {
  if (topScore >= strongScore) return false;
  // Absolute floor: a top below the noise ceiling is weak no matter the shape
  // (covers the sparse new-dev brain whose few records can't form a flat pile).
  if (topScore < noiseCeiling) return true;
  const scores = hits
    .map((h) => h.score)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (scores.length === 0) return false;
  const min = scores[0]!;
  const mid = Math.floor(scores.length / 2);
  const median =
    scores.length % 2 === 0 ? (scores[mid - 1]! + scores[mid]!) / 2 : scores[mid]!;
  return median - min < flatnessGap;
}

async function resolveNativeHits(
  node: NodeClient,
  opts: SearchOptions,
  hits: NativeIndexHit[],
  typeFilter: Set<RecordType> | null,
): Promise<ResolvedHit[]> {
  const unique = dedupeHits(hits, opts.verbose);
  opts.verbose?.(`dedupe collapsed to ${unique.length} unique record(s)`);

  // Resolve every deduped hit to its full record. Two passes so the whole
  // hydration cost is ONE /api/query per DISTINCT schema, not one per hit.
  //
  // Pre-fix this loop point-read each hit, and that fetches the WHOLE schema
  // page (`queryAll`) and client-filters for one slug — so a
  // 50-hit search that all landed on one schema issued ~50 identical
  // full-schema fetches (each ~0.5–2 s) and threw away every row but one. That
  // N+1 read amplification was the entire ~25–29 s `search` latency on the live
  // brain (dogfood run 115). fbrain's hits collapse onto ≤3 distinct schema
  // hashes (Design, Task, unified MEMO) regardless of hit count, so batching
  // per-schema drops a 50-hit search from ~50 fetches to ~1–3. See PR #98
  // (link), PRs #154/#156, and docs/phase-7-search-latency-spike.md.
  //
  // Pass 1 (no node round-trips): classify each hit — resolve its type, apply
  // the `--type` filter, and record the distinct schema hashes to hydrate.
  type Candidate = { hit: NativeIndexHit; slug: string; type: RecordType; schemaHash: string };
  const candidates: Candidate[] = [];
  const schemaHashByType = new Map<RecordType, string>();
  for (const hit of unique) {
    const slug = hit.key_value.hash;
    if (!slug) {
      opts.verbose?.(`skip: hit has no key_value.hash`);
      continue;
    }
    const type = recordTypeForHash(hit.schema_name, opts.cfg.schemaHashes);
    if (!type) {
      // schema_name didn't match any registered type — likely a superseded
      // schema hash that hasn't been pruned, or a system schema. Skip silently.
      opts.verbose?.(
        `skip: schema_name "${hit.schema_name}" matches no registered fbrain type`,
      );
      continue;
    }
    // Filter by --type. For Design/Task this is purely belt-and-braces (the
    // schemas filter on the wire already excluded them); for the shared
    // MEMO schema it's load-bearing — the server filter keeps every Phase 6
    // record and only the resolved type tells concept apart from preference.
    if (typeFilter && !typeFilter.has(type)) {
      opts.verbose?.(`skip: ${type}/${slug} not in --type filter`);
      continue;
    }
    const schemaHash = schemaHashFor(type, opts.cfg);
    schemaHashByType.set(type, schemaHash);
    candidates.push({ hit, slug, type, schemaHash });
  }

  // Hydrate each DISTINCT schema exactly once into a `Map<slug, record>`. The
  // batch helper preserves the per-hit empty-page flake tolerance, just hoisted
  // to the schema level: /api/query returns a non-deterministic top-100 slice,
  // so an empty page on a saturated daemon is retried (capped) before the
  // schema is declared empty, while a NON-empty page is authoritative — a slug
  // present in the search hits but absent from a non-empty hydrated page is a
  // genuine stale hit (record deleted since indexing). Same observable behavior
  // as the old per-hit point-read, one fetch per schema instead of one
  // per hit on it. Key the cache by schema HASH (not type) so the unified-MEMO
  // types — concept/preference/reference/agent/project/spike all on one hash —
  // share a single hydration.
  const hydrated = new Map<string, Map<string, FbrainRecord>>();
  for (const [type, schemaHash] of schemaHashByType) {
    if (hydrated.has(schemaHash)) continue;
    hydrated.set(schemaHash, await hydrateSchemaBySlug(node, type, schemaHash));
  }

  // Pass 2: resolve every candidate by map lookup (no further round-trips).
  const resolved: ResolvedHit[] = [];
  for (const { hit, slug, type, schemaHash } of candidates) {
    const record = hydrated.get(schemaHash)?.get(slug);
    if (!record) {
      // Stale hit — record deleted (or never present) in the current store.
      opts.verbose?.(`skip stale: ${type}/${slug} not found in current store`);
      continue;
    }
    // Display the user-facing record type, capitalized.
    const displayName = capitalize(type);
    const score = typeof hit.metadata?.score === "number" ? hit.metadata.score : null;
    const matchType = typeof hit.metadata?.match_type === "string" ? hit.metadata.match_type : null;
    opts.verbose?.(
      `kept: ${type}/${slug} score=${score ?? "—"} schema=${hit.schema_display_name ?? hit.schema_name}`,
    );
    resolved.push({
      slug,
      schemaDisplayName: displayName,
      schemaHash: hit.schema_name,
      type,
      score,
      matchType,
      record,
    });
  }
  return resolved;
}

async function bm25FallbackResults(
  node: NodeClient,
  cfg: Config,
  types: readonly RecordType[],
  query: string,
  limit: number | undefined,
  verbose: Verbose | undefined,
): Promise<ResolvedHit[]> {
  const loaded = await loadOrBuildBm25Index(node, cfg, types, { verbose });
  const effectiveLimit = limit && limit > 0 ? limit : loaded.corpusSize;
  return loaded.index.search(query, effectiveLimit).flatMap((hit) => {
    const id = `${hit.type}::${hit.slug}`;
    const record = loaded.liveById.get(id) ?? minimalRecord(hit.slug, loaded.index.recordText(id));
    if (!record) return [];
    return [{
      slug: hit.slug,
      schemaDisplayName: capitalize(hit.type),
      schemaHash: schemaHashFor(hit.type, cfg),
      type: hit.type,
      score: null,
      matchType: "bm25-fallback",
      record,
    }];
  });
}

function minimalRecord(
  slug: string,
  text: { title: string; body: string } | null,
): FbrainRecord | null {
  if (!text) return null;
  return {
    slug,
    title: text.title,
    body: text.body,
    status: "",
    tags: [],
    created_at: "",
    updated_at: "",
  };
}

export async function searchCmd(opts: SearchOptions): Promise<void> {
  const { print, printErr } = resolvePrintSinks(opts);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

  const clientOpts: ClientSearchOptions = {};
  if (opts.exact) clientOpts.exact = true;
  if (typeof opts.minScore === "number") clientOpts.minScore = opts.minScore;
  // Scope the server-side search to fbrain's registered schemas so the
  // top-50 cosine cut isn't burned on unrelated schemas hosted by the
  // same daemon (Persona / User Accounts / Contacts / CalendarEvent / …).
  // See docs/phase-7-search-latency-spike.md (H2b). Requires fold_db
  // PR #264; older daemons ignore the param so this is safe unconditionally.
  //
  // Dedupe: several record types share the unified MEMO hash (concept,
  // preference, reference, agent, project, spike all map to the same
  // schema), so Object.values() returns repeats. The server collapses
  // duplicates too, but deduping here keeps the URL compact and the
  // verbose count meaningful ("N unique schemas" vs N record types).
  //
  // When `--type T` is set, restrict to the hashes for those types only.
  // For Phase 6 types (concept | preference | reference | agent | project |
  // spike) that share the unified MEMO hash, the server filter alone can't
  // tell e.g. concept from preference — it'll return any record on that
  // hash. The post-filter on resolved hits (below) finishes the job.
  const { typeFilter, activeTypes } = resolveTypeFilter(
    opts.types,
    opts.cfg,
    (skipped) => {
      opts.onSkippedTypes?.(skipped);
      printErr(missingSchemaHashReadNote(skipped, "searching the rest"));
    },
  );
  const fbrainSchemas = uniqueSchemaHashes(opts.cfg, activeTypes);
  if (fbrainSchemas.length > 0) {
    clientOpts.schemas = fbrainSchemas;
    opts.verbose?.(
      `scope: native-index search restricted to ${fbrainSchemas.length} fbrain schema hash(es)` +
        (typeFilter ? ` (types: ${[...typeFilter].join(",")})` : ""),
    );
  }

  const hits = await node.search(opts.query, clientOpts);
  opts.verbose?.(`search returned ${hits.length} fragment hit(s)`);
  let resolved = await resolveNativeHits(node, opts, hits, typeFilter);

  // Sort by score DESC, ties broken by (type::slug) ASC (code-unit order). Without
  // the id key, equal-score hits keep `dedupeHits`'s Map insertion order — which
  // is the order each (schema_name, slug) first appeared in the server's fragment
  // response. With `--limit N` the slice would then keep the top N in server-
  // fragment order rather than a canonical lexicographic order, so the same
  // corpus + query could shift across re-indexes / daemon restarts. Especially
  // load-bearing on the score-missing path: the `?? -1` default maps every
  // score-less hit into a wholesale tie at -1, where `slice(0, limit)` would
  // otherwise pick whichever N the server happened to emit first. Same shape as
  // the rrf.ts (PR #79), bm25.ts (PR #101), and ask.ts vector-rank tie-break.
  resolved.sort((a, b) => {
    const scoreDelta = (b.score ?? -1) - (a.score ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    const aId = `${a.type}::${a.slug}`;
    const bId = `${b.type}::${b.slug}`;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  // Result cap. With no explicit `--limit`, fall back to SEARCH_DEFAULT_LIMIT
  // (== ask's DEFAULT_LIMIT) so a query that drops to the BM25 keyword-rescue
  // path can't print the whole corpus, and the default page size matches
  // `ask`. `--limit N` (N > 0) overrides.
  const effectiveLimit =
    opts.limit && opts.limit > 0 ? opts.limit : SEARCH_DEFAULT_LIMIT;

  const canUseBm25Fallback =
    !opts.exact && opts.minScore === undefined && fbrainSchemas.length > 0;

  // STEP 3: classify weak-match over the FULL resolved list, BEFORE slicing to
  // the limit. The classifier is a distribution-shape test — its flat-floor /
  // separation signal is only meaningful over the full sample the server
  // returned; classifying on a post-`--limit` slice (e.g. the top 5) throws
  // away the floor pile the test needs and mis-reads a truncated head as a
  // spike (the sparse-sample failure ask.ts:489-491 documents for its own
  // small resolved set).
  const topScoreBeforeFallback = resolved[0]?.score ?? null;
  let weakMatch =
    canUseBm25Fallback &&
    topScoreBeforeFallback !== null &&
    isWeakMatch(topScoreBeforeFallback, resolved, STRONG_SCORE, FLATNESS_GAP, NOISE_CEILING);

  // Track which resolved rows are BM25 keyword-rescue rows so per-row
  // confidence stays truthful: fallback rows are keyword matches with no
  // semantic score, NOT strong vector hits. Keyed on `type::slug` (identity
  // everywhere else in fbrain) so a Design and a Task that share a slug are
  // distinct entries — not collapsed by a bare-slug key.
  const fallbackIds = new Set<string>();
  if (canUseBm25Fallback && (resolved.length === 0 || weakMatch)) {
    // STEP 4: pass the same effective limit into the corpus scorer so the
    // rescue set is bounded too (it otherwise defaults to `docs.length`).
    const fallback = await bm25FallbackResults(
      node,
      opts.cfg,
      activeTypes,
      opts.query,
      effectiveLimit,
      opts.verbose,
    );
    // STEP 2: MERGE the rescue rows with the native rows keyed on `type::slug`,
    // rather than wholesale-replacing the native set (which discarded every
    // native vector hit even when only one rescue record was new). Append only
    // rescue rows not already present, and mark them `fallback` so they never
    // read as `strong`/confident.
    //
    // Ordering: rescue rows come FIRST, then the native rows. This branch only
    // runs when the native set was EMPTY or graded WEAK (noise-floor) — a
    // strong native set never reaches here — so the keyword-rescue rows are the
    // better answers for this query. Putting them ahead means a tight `--limit`
    // keeps the rescue matches instead of burying them under the weak native
    // noise. (`type::slug` keeps a Design and a Task that share a slug distinct
    // rather than collapsing on a bare-slug key.)
    const nativeIds = new Set(resolved.map((hit) => `${hit.type}::${hit.slug}`));
    const newFallback = fallback.filter(
      (hit) => !nativeIds.has(`${hit.type}::${hit.slug}`),
    );
    if (resolved.length === 0 || newFallback.length > 0) {
      opts.verbose?.(
        resolved.length === 0
          ? "bm25 fallback: native vector search returned no resolved matches"
          : "bm25 fallback: native vector search result set was weak/noise-floor — merging keyword rescue rows",
      );
      for (const hit of newFallback) fallbackIds.add(`${hit.type}::${hit.slug}`);
      resolved = [...newFallback, ...resolved];
    }
  }

  // Slice to the effective limit AFTER the merge/classification, so the
  // classifier saw the full sample and the limit bounds the final output.
  const trimmed = resolved.slice(0, effectiveLimit);
  // Per-row confidence: a rescue row is `fallback`; a native row is `weak` when
  // the whole native set graded as noise-floor, else `strong`. `confidenceFor`
  // is index-agnostic (keyed on the row's identity), so it's correct after the
  // slice too.
  const confidenceFor = (hit: ResolvedHit): SearchHitJson["confidence"] =>
    fallbackIds.has(`${hit.type}::${hit.slug}`)
      ? FALLBACK_CONFIDENCE
      : weakMatch
        ? "weak"
        : "strong";
  // The advisory note fires whenever the visible set is not all-strong — i.e.
  // the native set was weak OR any rescue row is shown.
  const showWeakNote =
    canUseBm25Fallback &&
    trimmed.some((hit) => confidenceFor(hit) !== "strong");

  if (trimmed.length === 0) {
    opts.onResult?.([]);
    // Context-aware no-match hint. On a brand-new EMPTY brain (a new dev
    // following the init next-steps, which tell them to run `fbrain search`
    // before they've created anything), the fresh-write-latency / `fbrain
    // reindex` advice is actively misleading — there is nothing indexed and
    // nothing to reindex. Probe whether the brain holds any live record (a
    // cheap extra round-trip, paid only on the no-match path) and, when it's
    // empty, point them at creating their first record — the calm
    // "create your first record" recovery every other CLI hint already gives.
    // A populated brain that simply matched nothing keeps the existing hint.
    const empty = !(await hasAnyLiveRecord(node, opts.cfg));
    // On the MCP agent channel the hint must name TOOLS the agent can call.
    // The CLI hint points at `fbrain <type> new`, `fbrain ask <query>`, and
    // `fbrain reindex` (plus a repo-local doc path) — none of which exist as
    // MCP tools — so an agent reading them dead-ends. Render the agent-voiced
    // variant only when `opts.agent` is set; the human CLI path is unchanged.
    const hint = opts.agent
      ? empty
        ? "hint:  no records yet — create your first with the `fbrain_put` tool, then try again"
        : "hint:  fresh writes can take a moment to land in the vector index — use the `fbrain_ask` tool (BM25 + vector hybrid) for immediate retrieval"
      : empty
        ? "hint:  no records yet — create your first with `fbrain <type> new <slug>` (design/concept/project/…), then search again"
        : "hint:  fresh writes may take a moment to land in the vector index — try `fbrain ask <query>` (BM25 + vector hybrid) or `fbrain reindex`";
    if (opts.json) {
      // Stdout is just `[]` so jq pipelines see a parseable empty
      // array rather than the "no matches" sentinel; the hint stays on stderr.
      print("[]");
      printErr(hint);
      return;
    }
    print("no matches");
    print(hint);
    return;
  }

  // Weak-match advisory. Without a confidence signal, a gibberish query that
  // matches NOTHING still returns the brain ranked by tiny cosine scores —
  // indistinguishable from a real hit list. This is STRICTLY ADDITIVE: we
  // never drop a row, so a real-but-distant match in a large brain is still
  // shown — we just flag the hit list as weak so the user can tell "showing
  // the closest we found" apart from "this nailed it".
  // Server-side `--min-score` (and explicit `--min-score 0`) are unchanged.
  // Score-null is treated as "unmeasurable", not "weak", so we don't annotate.
  //
  // ── Why a DISTRIBUTION-SHAPE signal, not a fixed cosine cut ───────────────
  // The original advisory (#185/#193) fired when `topScore < 0.35`, calibrated
  // on a clean-room 3-record brain (2026-06-06) where pure noise topped out
  // ~0.24 and real matches sat ~0.45–0.59. That absolute cut is brain-size
  // fragile: the more vectors indexed, the closer the nearest neighbour to
  // even gibberish, so on Tom's real :9001 brain (hundreds of records) pure
  // gibberish tops out ~0.39–0.44 — above 0.35 — and the advisory SILENTLY
  // NEVER FIRED. A no-match query was indistinguishable from a real hit
  // (dogfooded 2026-06-16, v0.11.0). `fbrain ask` (hybrid) degrades
  // gracefully on the same query; `search` (and the `fbrain_search` MCP tool,
  // fbrain's primary agent consumer) did not.
  //
  // The robust signal is the SHAPE of the score distribution, not its
  // magnitude. A no-match query produces a flat FLOOR BAND: the server returns
  // the top-N nearest vectors, and for noise they're all roughly equidistant,
  // so the bulk of scores pile right on the minimum. A real query grades
  // upward off that floor. Measured on :9001 (2026-06-16), `median − min`:
  //   gibberish "qwxz9931 blarghonk zztopflux"  top 0.443  median−min 0.000
  //   gibberish "florbnax wuggle …"             top 0.394  median−min 0.000
  //   gibberish "plorptang xrrn jibwoz"         top 0.392  median−min 0.014
  //   real      "weak match advisory threshold" top 0.475  median−min 0.035
  //   real      "at-rest encryption master key" top 0.478  median−min 0.065
  //   real      "fkanban board columns"         top 0.619  median−min 0.101
  // Noise sits at ≤0.014, real (even sub-0.5) at ≥0.035. We flag weak when
  // `median − min < FLATNESS_GAP` — robust to brain size by construction: more
  // noise records just lengthen the floor pile, they don't lift the median off
  // it. Two extra guards bracket the shape test:
  //   • A top score at/above `STRONG_SCORE` is always a real hit regardless of
  //     shape (covers a dense real-match band where every returned vector is
  //     genuinely relevant, so the floor itself is high).
  //   • A top score BELOW `NOISE_CEILING` is always weak regardless of shape.
  //     The shape test assumes a populated brain with enough records to form a
  //     flat floor pile; a brand-new dev's SPARSE brain has too few records, so
  //     a few scattered low noise scores keep median−min above FLATNESS_GAP and
  //     defeat the shape test (dogfooded 2026-06-19 on a fresh 3-record brain:
  //     top 0.236, median−min 0.039 → would NOT have been flagged). Since real
  //     sub-STRONG hits top ~0.45–0.49 and noise tops ~0.39–0.44, an absolute
  //     ceiling at 0.30 catches sparse-brain noise without touching real hits.
  // A lone hit below `STRONG_SCORE` has `median == min`, so `median − min == 0`
  // and it is conservatively flagged weak — the signal-preserving choice (we
  // still print the row; the note never drops it).
  //
  // `--exact` opts out: fold_db_node's `filter_by_exact_substring` keeps only
  // hits whose hydrated value contains the query as a case-insensitive
  // substring (handlers/query.rs), so every surviving hit is a literal text
  // match by construction. The cosine carried on the wire is the semantic
  // relatedness of the fragment to the query — a query word buried in a long
  // doc can sit at cosine 0.15 while still being a real, "this nailed it"
  // hit — so any confidence cut is meaningless in this mode. Worse, the note
  // points at `fbrain ask <query>`, which is the hybrid semantic + BM25 + RRF
  // retrieval — exactly the surface the user opted out of.
  //
  // On the MCP agent channel the advisory must name a TOOL the agent can call,
  // not a CLI command string. An MCP agent has no shell — telling it to run
  // `fbrain ask <query>` is a dead-end. Render the agent-voiced variant only
  // when `opts.agent` is set (mirroring the empty/no-match hint above); the
  // human CLI path is byte-identical to before. "(BM25 + vector hybrid)" also
  // labels `ask` accurately (it's hybrid/RRF, not keyword-only).
  const weakMatchNote = opts.agent
    ? `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms or use the \`fbrain_ask\` tool (BM25 + vector hybrid).`
    : `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms or \`fbrain ask <query>\` (BM25 + vector hybrid — fbrain's strongest retrieval).`;

  // {slug, score, type, title} per hit — type is the canonical
  // lowercase RecordType (not the capitalized human display name)
  // so consumers can match against `--type` values verbatim.
  //
  // Score is rounded to 6 decimals. The native index ships cosines as
  // f32 and the node promotes back to f64 on the wire, so a perfect
  // match arrives as 1.0000001192092896 (= f32(1.0)). Left raw, a
  // consumer filtering on the natural cosine contract `score <= 1.0`
  // silently drops the single best hit. Rounding is OUTPUT-ONLY — the
  // sort above ran on the full-precision value. Null stays null.
  //
  // Built unconditionally (not just under --json) so the `onResult`
  // structured sink and the `--json` stdout document are the SAME value
  // — the MCP `structuredContent` can't drift from the CLI JSON shape.
  const payload: SearchHitJson[] = trimmed.map((hit) => ({
    slug: hit.slug,
    score: hit.score == null ? null : Math.round(hit.score * 1e6) / 1e6,
    type: hit.type,
    title: hit.record.title,
    // Deterministic body extract from the already-hydrated record — no extra
    // fetch. Centered on the first matching query term (or the body head for a
    // pure-vector hit) so the answer shows inline. Built unconditionally so
    // the `--json` document and the MCP `structuredContent` carry it too.
    snippet: buildSnippet(hit.record.body, opts.query),
    confidence: confidenceFor(hit),
  }));
  opts.onResult?.(payload);

  if (opts.json) {
    print(JSON.stringify(payload));
    if (showWeakNote) printErr(weakMatchNote);
    return;
  }

  // Advisory → stderr so `fbrain search q 2>/dev/null` stays parseable.
  if (showWeakNote) printErr(weakMatchNote);

  // Human-only column legend (TTY, non-JSON). `trimmed` is non-empty here (the
  // empty-result path returned above), so this never sits above a no-match
  // hint. `search` scores a max-normalized cosine in 0–1 (top hit is `1.000`);
  // the note flags that this scale is NOT comparable to `ask`'s fused RRF.
  if (resolveStdoutIsTty(opts)) {
    printColumnLegend(print, "slug · relevance(0–1, cosine) · type · title");
  }

  const lines = formatTable(
    trimmed.map((hit) => [
      hit.slug,
      hit.score === null ? "—" : hit.score.toFixed(3),
      hit.schemaDisplayName,
      hit.record.title,
    ]),
    { align: ["left", "right", "left", "left"] },
  );
  // Print the table row, then the matching body snippet as an indented
  // second line under it (only when the body produced one). The table row
  // itself is UNCHANGED — existing first-line parsers (and `--json`
  // consumers) see the same `slug · score · type · title` shape; the snippet
  // is purely additive human context. `payload` is index-aligned with
  // `trimmed`/`lines` (same map source), so `payload[i].snippet` matches row i.
  for (let i = 0; i < lines.length; i++) {
    print(lines[i]!);
    const snippet = payload[i]?.snippet;
    if (snippet) print(`    ${snippet}`);
  }
}
