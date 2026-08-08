// `fbrain find` — retrieval by an explicit array of match probes.
//
// Unlike `search` (one query) or `ask` (one query, optionally LLM-expanded
// into a few alternate phrasings), `find` takes N caller-supplied probes —
// each MAY be huge (a paragraph, a whole record body, an error dump) — and
// treats every probe as an independent semantic query against the Search
// app's vector plane. The caller does the framing; brain never distills a
// probe to keywords and never embeds anything itself
// (design-brain-no-enumeration-match-array-retrieval).
//
// Pipeline:
//   1. For each probe, query the semantic plane (search-plane.ts) — one
//      ranked list per probe.
//   2. RRF-fuse the N lists, rankers labeled `match[i]` so --explain output
//      shows which probe(s) surfaced each hit (mirrors how `ask` labels its
//      expansion rankers).
//   3. Hydrate survivors by point read (`findBySlug` — keyed by slug, never a
//      partition/type scan).
//
// No BM25, no LLM query expansion: `find`'s recall lever is the CALLER
// supplying more/better probes, not brain rephrasing on its own.

import { recordTypeForHash, type SearchOptions as ClientSearchOptions, type Verbose } from "../client.ts";
import { newSearchClientFromCfg } from "../write-context.ts";
import { querySearchPlane } from "../search-plane.ts";
import type { Config } from "../config.ts";
import { printFieldProjection } from "../field-projection.ts";
import {
  capitalize,
  formatTable,
  printColumnLegend,
  resolvePrintSinks,
  resolveStdoutIsTty,
} from "../format.ts";
import {
  findBySlug,
  missingSchemaHashReadNote,
  resolveTypeFilter,
  schemaHashFor,
  uniqueSchemaHashes,
  type FbrainRecord,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";
import { dedupeHits } from "../retrieval/dedupe.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import { isWeakMatch, SEARCH_DEFAULT_LIMIT, type SearchHitJson } from "./search.ts";
import { reciprocalRankFusion, RRF_DEFAULT_K, type RankerInput } from "../retrieval/rrf.ts";
import { docId, parseDocId } from "./ask.ts";

export const DEFAULT_LIMIT = SEARCH_DEFAULT_LIMIT;
// Per-probe breadth fed into RRF. Wider here gives RRF more material; the
// final --limit slices the fused top. Same constant as ask.ts's RANKER_LIMIT.
export const RANKER_LIMIT = 25;

export type FindOptions = {
  cfg: Config;
  // Each entry is an independent semantic probe — may be a whole paragraph
  // or record body. At least one is required (enforced by the caller/CLI).
  matches: readonly string[];
  limit?: number;
  explain?: boolean;
  // Restrict results to these record types. Undefined / empty = all record types.
  types?: readonly RecordType[];
  fields?: readonly string[];
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  isTty?: () => boolean;
  // Structured-result sink — same shape `--json` serializes to stdout, one
  // source of truth for the CLI JSON surface and the MCP `structuredContent`.
  onResult?: (payload: SearchHitJson[]) => void;
  onSkippedTypes?: (skipped: readonly RecordType[]) => void;
};

export type FindHit = {
  type: RecordType;
  slug: string;
  fusedScore: number;
  // Highest raw cosine returned for this record across the caller's probes.
  // RRF is the ordering score; callers that need an absolute similarity
  // floor (for example papercut dedupe) must use this value instead.
  maxSimilarity: number;
  // Which probe indices ranked this hit, and at what rank — mirrors ask.ts's
  // expansionHits, labeled by probe index instead of expansion index.
  matchHits: Array<{ idx: number; rank: number }>;
  record: FbrainRecord;
};

export type FindResult = {
  matches: readonly string[];
  hits: FindHit[];
};

export async function findCmd(opts: FindOptions): Promise<FindResult> {
  const { print, printErr } = resolvePrintSinks(opts);
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const { activeTypes } = resolveTypeFilter(opts.types, opts.cfg, (skipped) => {
    opts.onSkippedTypes?.(skipped);
    printErr(missingSchemaHashReadNote(skipped, "finding from the rest"));
  });

  const node = newSearchClientFromCfg(opts.cfg, opts.verbose).node;
  const fbrainSchemas = uniqueSchemaHashes(opts.cfg, activeTypes);

  const rankers: RankerInput[] = [];
  const perMatchTopId = new Map<number, Map<string, number>>();
  const vectorScoreById = new Map<string, number>();

  for (let mi = 0; mi < opts.matches.length; mi++) {
    const probe = opts.matches[mi]!;
    const label = `match[${mi}]`;

    const clientOpts: ClientSearchOptions = {};
    if (fbrainSchemas.length > 0) clientOpts.schemas = fbrainSchemas;
    const plane = await querySearchPlane({
      query: probe,
      k: RANKER_LIMIT,
      schemas: fbrainSchemas.length > 0 ? fbrainSchemas : undefined,
      verbose: opts.verbose,
    });
    let raw: Awaited<ReturnType<typeof node.search>> = [];
    if (plane !== null && plane.length > 0) {
      raw = plane.map((h) => ({
        schema_name: h.schema_name,
        field: "body",
        key_value: { hash: h.key_hash, range: h.key_range },
        value: h.text,
        metadata: { score: h.score, match_type: "search-plane" },
      }));
      opts.verbose?.(`${label} → ${raw.length} hit(s) via search-plane`);
    } else {
      opts.verbose?.(
        plane !== null
          ? `${label}: search-plane empty; node /api/app/search fallback`
          : `${label}: search-plane unavailable; node /api/app/search fallback`,
      );
      raw = await node.search(probe, clientOpts);
    }

    const collapsed = dedupeHits(raw);
    const hits = collapsed
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
    // Sort DESC by score, ties broken by id ASC — same determinism rationale
    // as ask.ts's vector ranker (a tied fragment order must not flip rank).
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ranked = hits.slice(0, RANKER_LIMIT).map((h, i) => ({ id: h.id, rank: i + 1 }));
    rankers.push({ label, hits: ranked });
    perMatchTopId.set(mi, new Map(ranked.map((r) => [r.id, r.rank])));
    for (const h of hits) {
      const prior = vectorScoreById.get(h.id);
      if (prior === undefined || h.score > prior) vectorScoreById.set(h.id, h.score);
    }
    opts.verbose?.(`${label} → ${ranked.length} unique hit(s) (raw fragments=${raw.length})`);
  }

  const fused = reciprocalRankFusion(rankers, { k: RRF_DEFAULT_K });

  const resolved: FindHit[] = [];
  for (let i = 0; i < fused.length && resolved.length < limit; i++) {
    const f = fused[i]!;
    const parsed = parseDocId(f.id);
    if (!parsed) continue;
    let rec: FbrainRecord | null;
    try {
      rec = await findBySlug(node, parsed.type, schemaHashFor(parsed.type, opts.cfg), parsed.slug);
    } catch {
      rec = null;
    }
    if (!rec) {
      opts.verbose?.(`skip stale: ${parsed.type}/${parsed.slug}`);
      continue;
    }
    const matchHits: Array<{ idx: number; rank: number }> = [];
    for (const [mi, byId] of perMatchTopId) {
      const r = byId.get(f.id);
      if (r !== undefined) matchHits.push({ idx: mi, rank: r });
    }
    resolved.push({
      type: parsed.type,
      slug: parsed.slug,
      fusedScore: f.fusedScore,
      maxSimilarity: vectorScoreById.get(f.id) ?? 0,
      matchHits,
      record: rec,
    });
  }

  const explainSink = opts.json ? printErr : print;
  if (opts.explain) {
    explainSink(`probes:`);
    for (let i = 0; i < opts.matches.length; i++) {
      const probe = opts.matches[i]!;
      const oneLine = probe.length > 80 ? `${probe.slice(0, 80)}…` : probe;
      explainSink(`  match[${i}]: ${oneLine}`);
    }
    explainSink("");
  }

  // Same weak-match classifier ask.ts uses (isWeakMatch from search.ts) —
  // vectorScore is the raw cosine the plane returned, comparable across
  // probes on the same 0–1 scale RRF's rank-based fused score is not.
  const STRONG_SCORE = 0.5;
  const FLATNESS_GAP = 0.025;
  const NOISE_CEILING = 0.45;
  const topVectorScore = resolved.reduce<number | null>((max, h) => {
    const score = vectorScoreById.get(docId(h.type, h.slug)) ?? null;
    if (score === null) return max;
    return max === null || score > max ? score : max;
  }, null);
  const weakMatch =
    resolved.length > 0 &&
    topVectorScore !== null &&
    isWeakMatch(
      topVectorScore,
      resolved.map((h) => ({ score: vectorScoreById.get(docId(h.type, h.slug)) ?? null })),
      STRONG_SCORE,
      FLATNESS_GAP,
      NOISE_CEILING,
    );
  const weakMatchNote = `note:  no strong matches for the given probes — showing closest by similarity.`;

  const payload: SearchHitJson[] = resolved.map((h) => ({
    slug: h.slug,
    score: Math.round(h.fusedScore * 1e6) / 1e6,
    type: h.type,
    title: h.record.title,
    snippet: buildSnippet(h.record.body, opts.matches[0] ?? ""),
    confidence: weakMatch ? "weak" : "strong",
  }));
  opts.onResult?.(payload);

  if (opts.fields !== undefined && opts.fields.length > 0) {
    printFieldProjection(payload, opts.fields, print);
    if (weakMatch) printErr(weakMatchNote);
    return { matches: opts.matches, hits: resolved };
  }

  if (resolved.length === 0) {
    const hint = "hint:  nothing matched — try more or different probes";
    if (opts.json) {
      print(JSON.stringify(payload));
      printErr(hint);
    } else {
      print("no matches");
      print(hint);
    }
  } else if (opts.json) {
    print(JSON.stringify(payload));
    if (weakMatch) printErr(weakMatchNote);
  } else {
    if (weakMatch) printErr(weakMatchNote);
    if (resolveStdoutIsTty(opts)) {
      printColumnLegend(print, "rank · slug · type · title (best match first)");
    }
    const lines = formatTable(
      resolved.map((h, i) => [`${i + 1}.`, h.slug, capitalize(h.type), h.record.title]),
      { align: ["right", "left", "left", "left"] },
    );
    for (let i = 0; i < lines.length; i++) {
      print(lines[i]!);
      const snippet = payload[i]?.snippet;
      if (snippet) print(`    ${snippet}`);
    }
  }

  return { matches: opts.matches, hits: resolved };
}
