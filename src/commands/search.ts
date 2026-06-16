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
  type SearchOptions as ClientSearchOptions,
  type Verbose,
  recordTypeForHash,
} from "../client.ts";
import type { Config } from "../config.ts";
import { capitalize, formatTable, resolvePrintSinks } from "../format.ts";
import {
  findBySlugFast,
  resolveTypeFilter,
  schemaHashFor,
  uniqueSchemaHashes,
  type FbrainRecord,
} from "../record.ts";
import { dedupeHits } from "../retrieval/dedupe.ts";
import { type RecordType } from "../schemas.ts";

export { dedupeHits };

export type SearchOptions = {
  cfg: Config;
  query: string;
  limit?: number;
  exact?: boolean;
  minScore?: number;
  // Restrict results to these record types. Undefined / empty = all 8 types.
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

// Weak-match classifier (separation-based; see the rationale block in
// `searchCmd` below). A hit list is weak when its top score neither clears
// `strongScore` on its own NOR rises out of a flat floor band: when the bulk
// of the distribution piles on its minimum (`median − min < flatnessGap`),
// the results are indistinguishable noise even if the top fragment edges a
// little higher. Robust to brain size by construction — more noise records
// just lengthen the floor pile; a real query grades upward off the floor.
// `null` scores are dropped first (they're "unmeasurable", not part of the
// distribution). Exported for tests.
export function isWeakMatch(
  topScore: number,
  hits: readonly { score: number | null }[],
  strongScore: number,
  flatnessGap: number,
): boolean {
  if (topScore >= strongScore) return false;
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
  const { typeFilter, activeTypes } = resolveTypeFilter(opts.types);
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

  const unique = dedupeHits(hits, opts.verbose);
  opts.verbose?.(`dedupe collapsed to ${unique.length} unique record(s)`);

  const resolved: ResolvedHit[] = [];
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
    // /api/query returns a non-deterministic top-100 slice per schema, so a
    // single findBySlug can miss a slug that genuinely exists (~1/5 of the
    // time on a saturated daemon). The fast-miss helper rides out that
    // empty-page flake (so a live record isn't silently dropped as "stale")
    // but short-circuits on a populated-but-missing page — so a genuinely
    // stale hit (record deleted since indexing) skips in ~one query instead
    // of burning the full 5×250 ms retry budget serially per stale result.
    // See PR #98 (link), PRs #154/#156, and docs/phase-7-search-latency-spike.md.
    const record = await findBySlugFast(node, type, schemaHash, slug);
    if (!record) {
      // Stale hit — record deleted since the index was written.
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

  const trimmed = opts.limit && opts.limit > 0 ? resolved.slice(0, opts.limit) : resolved;

  if (trimmed.length === 0) {
    if (opts.json) {
      // Stdout is just `[]` so jq pipelines see a parseable empty
      // array rather than the "no matches" sentinel.
      print("[]");
      printErr(
        "hint:  fresh writes may take a moment to land in the vector index — try `fbrain ask <query>` (BM25 + vector hybrid) or `fbrain reindex` (see docs/phase-7-search-latency-spike.md)",
      );
      return;
    }
    print("no matches");
    print(
      "hint:  fresh writes may take a moment to land in the vector index — try `fbrain ask <query>` (BM25 + vector hybrid) or `fbrain reindex` (see docs/phase-7-search-latency-spike.md)",
    );
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
  // it. One escape hatch keeps it from over-firing on a clear hit:
  //   • A top score at/above `STRONG_SCORE` is always a real hit regardless of
  //     shape (covers a dense real-match band where every returned vector is
  //     genuinely relevant, so the floor itself is high).
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
  // points at `fbrain ask <query>` for keyword search, which is hybrid
  // semantic + BM25 + RRF — exactly the surface the user opted out of.
  //
  // Top score at/above this is a real hit regardless of distribution shape
  // (real-match band ~0.45–0.8 on the live brain; a dense strong band lands here).
  const STRONG_SCORE = 0.5;
  // Below STRONG_SCORE, a result set whose median is within this of its
  // minimum is a flat floor band → weak. Noise measured at median−min ≤0.014,
  // genuine sub-0.5 hits at ≥0.035 (data above); 0.025 splits them with margin.
  const FLATNESS_GAP = 0.025;
  const topScore = trimmed[0]?.score ?? null;
  const weakMatch =
    !opts.exact && topScore !== null && isWeakMatch(topScore, trimmed, STRONG_SCORE, FLATNESS_GAP);
  const weakMatchNote = `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms or \`fbrain ask <query>\` for keyword search.`;

  if (opts.json) {
    // {slug, score, type, title} per hit — type is the canonical
    // lowercase RecordType (not the capitalized human display name)
    // so consumers can match against `--type` values verbatim.
    //
    // Score is rounded to 6 decimals before serializing. The native index
    // ships cosines as f32 and the node promotes back to f64 on the wire,
    // so a perfect match arrives as 1.0000001192092896 (= f32(1.0)). Left
    // raw, a consumer filtering on the natural cosine contract `score <=
    // 1.0` silently drops the single best hit. Rounding is OUTPUT-ONLY —
    // the sort above ran on the full-precision value. Null stays null.
    const payload = trimmed.map((hit) => ({
      slug: hit.slug,
      score: hit.score == null ? null : Math.round(hit.score * 1e6) / 1e6,
      type: hit.type,
      title: hit.record.title,
    }));
    print(JSON.stringify(payload));
    if (weakMatch) printErr(weakMatchNote);
    return;
  }

  // Advisory → stderr so `fbrain search q 2>/dev/null` stays parseable.
  if (weakMatch) printErr(weakMatchNote);

  const lines = formatTable(
    trimmed.map((hit) => [
      hit.slug,
      hit.score === null ? "—" : hit.score.toFixed(3),
      hit.schemaDisplayName,
      hit.record.title,
    ]),
    { align: ["left", "right", "left", "left"] },
  );
  for (const line of lines) print(line);
}
