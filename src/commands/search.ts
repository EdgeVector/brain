// `brain search <query>` — LastSeek rank, then a keyword-head sample on a miss.

import {
  recordTypeForHash,
  type NodeClient,
  type Verbose,
} from "../client.ts";
import { newSearchClientFromCfg } from "../write-context.ts";
import { queryLastSeek } from "../lastseek-plane.ts";
import type { Config } from "../config.ts";
import { parseSpillMarker } from "../body-spill.ts";
import {
  capitalize,
  formatTable,
  printColumnLegend,
  resolvePrintSinks,
  resolveStdoutIsTty,
} from "../format.ts";
import {
  missingSchemaHashReadNote,
  resolveTypeFilter,
  uniqueSchemaHashes,
} from "../record.ts";
import { RANKER_PAGE, rankKeywordQuery } from "../list-page.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import { isRecordType, type RecordType } from "../schemas.ts";

export const SEARCH_DEFAULT_LIMIT = 5;

const FALLBACK_CONFIDENCE = "fallback" as const;

export type SearchOptions = {
  cfg: Config;
  query: string;
  limit?: number;
  exact?: boolean;
  minScore?: number;
  types?: readonly RecordType[];
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  isTty?: () => boolean;
  agent?: boolean;
  onResult?: (payload: SearchHitJson[]) => void;
  onSkippedTypes?: (skipped: readonly RecordType[]) => void;
};

export type SearchHitJson = {
  slug: string;
  score: number | null;
  type: RecordType;
  title: string;
  snippet: string;
  confidence: "strong" | "weak" | "fallback";
};

const STRONG_SCORE = 0.5;
const FLATNESS_GAP = 0.025;
const NOISE_CEILING = 0.3;

export function isWeakMatch(
  topScore: number,
  hits: readonly { score: number | null }[],
  strongScore: number,
  flatnessGap: number,
  noiseCeiling: number,
): boolean {
  if (topScore >= strongScore) return false;
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

export type RetrievedHit = {
  type: RecordType;
  slug: string;
  score: number | null;
  confidence: SearchHitJson["confidence"];
  title: string;
  body: string;
};

function pageLimit(limit: number | undefined): number {
  const requested = limit && limit > 0 ? limit : SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_DEFAULT_LIMIT, Math.max(1, requested));
}

function snippetSource(raw: string): string {
  const marker = parseSpillMarker(raw);
  return marker ? marker.head : raw;
}

async function readBodyHeads(
  node: NodeClient,
  cfg: Config,
  hits: ReadonlyArray<{ type: RecordType; slug: string }>,
  verbose?: Verbose,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!node.queryByKeys || hits.length === 0) return out;
  const byType = new Map<RecordType, string[]>();
  for (const hit of hits) {
    const group = byType.get(hit.type) ?? [];
    group.push(hit.slug);
    byType.set(hit.type, group);
  }
  await Promise.all(
    [...byType].map(async ([type, slugs]) => {
      const schemaHash = cfg.schemaHashes[type];
      if (!schemaHash) return;
      verbose?.(`HashRangeKeys body keys=${slugs.length} field=body`);
      const rows = await node.queryByKeys!({
        schemaHash,
        fields: ["body"],
        keys: slugs.map((slug) => ({ hash: slug })),
      });
      for (const row of rows) {
        const slug = row.key?.hash ?? "";
        const body = (row.fields as Record<string, unknown> | undefined)?.body;
        if (slug.length === 0 || typeof body !== "string") continue;
        out.set(`${type}::${slug}`, snippetSource(body));
      }
    }),
  );
  return out;
}

function keepLive(
  picked: ReadonlyArray<{ type: RecordType; slug: string; score: number | null }>,
  bodies: Map<string, string>,
  confidence: SearchHitJson["confidence"],
): RetrievedHit[] {
  const hits: RetrievedHit[] = [];
  for (const hit of picked) {
    const body = bodies.get(`${hit.type}::${hit.slug}`);
    if (body === undefined) continue;
    hits.push({
      type: hit.type,
      slug: hit.slug,
      score: hit.score,
      confidence,
      title: "",
      body,
    });
  }
  return hits;
}

export async function retrieveRankedPage(opts: {
  node: NodeClient;
  cfg: Config;
  query: string;
  limit?: number;
  typeFilter: Set<RecordType> | null;
  activeTypes: readonly RecordType[];
  exact?: boolean;
  minScore?: number;
  caller?: string;
  verbose?: Verbose;
}): Promise<{ hits: RetrievedHit[]; sample: boolean }> {
  const page = pageLimit(opts.limit);
  const active = new Set(opts.activeTypes);
  const schemas = uniqueSchemaHashes(opts.cfg, opts.activeTypes);
  const seek = queryLastSeek({
    query: opts.query,
    k: RANKER_PAGE,
    caller: opts.caller ?? "brain/search",
    schemas: schemas.length > 0 ? schemas : undefined,
    exact: opts.exact,
    min_score: opts.minScore,
    verbose: opts.verbose,
  });
  if (seek === null) {
    if (opts.minScore !== undefined) return { hits: [], sample: false };
    const ranked = await rankKeywordQuery({
      node: opts.node,
      cfg: opts.cfg,
      query: opts.query,
      verbose: opts.verbose,
    });
    const picked: Array<{ type: RecordType; slug: string; score: number | null }> = [];
    for (const hit of ranked) {
      if (picked.length >= page) break;
      if (!isRecordType(hit.type) || !active.has(hit.type)) continue;
      if (opts.typeFilter && !opts.typeFilter.has(hit.type)) continue;
      picked.push({ type: hit.type, slug: hit.slug, score: null });
    }
    const bodies = await readBodyHeads(opts.node, opts.cfg, picked, opts.verbose);
    return { hits: keepLive(picked, bodies, FALLBACK_CONFIDENCE), sample: true };
  }

  const matched: Array<{ type: RecordType; slug: string; score: number }> = [];
  for (const hit of seek) {
    const slug = hit.key_hash;
    if (!slug) continue;
    const type = recordTypeForHash(hit.schema_identity, opts.cfg.schemaHashes);
    if (!type || !active.has(type)) continue;
    if (opts.typeFilter && !opts.typeFilter.has(type)) continue;
    matched.push({ type, slug, score: hit.score });
  }
  const top = matched.reduce<number | null>((max, hit) => {
    return max === null || hit.score > max ? hit.score : max;
  }, null);
  const confidence: SearchHitJson["confidence"] =
    top !== null &&
    isWeakMatch(
      top,
      matched.map((hit) => ({ score: hit.score })),
      STRONG_SCORE,
      FLATNESS_GAP,
      NOISE_CEILING,
    )
      ? "weak"
      : "strong";
  const picked = matched.slice(0, page);
  const bodies = await readBodyHeads(opts.node, opts.cfg, picked, opts.verbose);
  return { hits: keepLive(picked, bodies, confidence), sample: false };
}

export async function searchCmd(opts: SearchOptions): Promise<void> {
  const { print, printErr } = resolvePrintSinks(opts);
  const node = newSearchClientFromCfg(opts.cfg, opts.verbose).node;
  const { typeFilter, activeTypes } = resolveTypeFilter(
    opts.types,
    opts.cfg,
    (skipped) => {
      opts.onSkippedTypes?.(skipped);
      printErr(missingSchemaHashReadNote(skipped, "searching the rest"));
    },
  );
  const ranked = await retrieveRankedPage({
    node,
    cfg: opts.cfg,
    query: opts.query,
    limit: opts.limit,
    typeFilter,
    activeTypes,
    exact: opts.exact,
    minScore: opts.minScore,
    caller: "brain/search",
    verbose: opts.verbose,
  });
  if (ranked.sample) printErr("sample");
  const trimmed = ranked.hits;
  const showWeakNote = trimmed.some((hit) => hit.confidence === "weak");
  const weakMatchNote = opts.agent
    ? `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms or use the \`fbrain_ask\` tool.`
    : `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms or \`brain ask ${opts.query}\`.`;

  if (trimmed.length === 0) {
    opts.onResult?.([]);
    const hint = "hint:  nothing matched — try fewer or different terms";
    if (opts.json) {
      print("[]");
      printErr(hint);
      return;
    }
    print("no matches");
    print(hint);
    return;
  }

  const payload: SearchHitJson[] = trimmed.map((hit) => ({
    slug: hit.slug,
    score: hit.score == null ? null : Math.round(hit.score * 1e6) / 1e6,
    type: hit.type,
    title: hit.title,
    snippet: buildSnippet(hit.body, opts.query),
    confidence: hit.confidence,
  }));
  opts.onResult?.(payload);

  if (opts.json) {
    print(JSON.stringify(payload));
    if (showWeakNote) printErr(weakMatchNote);
    return;
  }

  if (showWeakNote) printErr(weakMatchNote);
  if (resolveStdoutIsTty(opts)) {
    printColumnLegend(print, "slug · relevance(0–1, cosine) · type · title");
  }
  const lines = formatTable(
    trimmed.map((hit) => [
      hit.slug,
      hit.score === null ? "—" : hit.score.toFixed(3),
      capitalize(hit.type),
      hit.title,
    ]),
    { align: ["left", "right", "left", "left"] },
  );
  for (let i = 0; i < lines.length; i++) {
    print(lines[i]!);
    const snippet = payload[i]?.snippet;
    if (snippet) print(`    ${snippet}`);
  }
}
