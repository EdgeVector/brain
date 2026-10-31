// `brain search <query>` — LastSeek rank, then a keyword-head sample on a miss.

import {
  recordTypeForHash,
  type NodeClient,
  type Verbose,
} from "../client.ts";
import { newSearchClientFromCfg } from "../write-context.ts";
import { queryLastSeek } from "../lastseek-plane.ts";
import type { Config } from "../config.ts";
import { hydrateRecord, parseSpillMarker } from "../body-spill.ts";
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
  TOMBSTONE_TAG,
} from "../record.ts";
import { lastSeekScope } from "../lastseek-scope.ts";
import { RANKER_PAGE, READ_KEY_CAP, rankKeywordQuery } from "../list-page.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import { isRecordType, type RecordType } from "../schemas.ts";

export const SEARCH_DEFAULT_LIMIT = 5;

const SAMPLE_CONFIDENCE = "sample" as const;

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
  confidence: "strong" | "weak" | "sample";
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

type BodyHead = { title: string; body: string };

function matchesExact(row: BodyHead, query: string): boolean {
  return `${row.title}\n${row.body}`.toLowerCase().includes(query.toLowerCase());
}

async function readBodyHeads(
  node: NodeClient,
  cfg: Config,
  hits: ReadonlyArray<{ type: RecordType; slug: string }>,
  verbose?: Verbose,
  exactQuery?: string,
): Promise<Map<string, BodyHead>> {
  const out = new Map<string, BodyHead>();
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
      verbose?.(`HashRangeKeys body keys=${slugs.length} field=body,title`);
      const chunks: string[][] = [];
      for (let i = 0; i < slugs.length; i += READ_KEY_CAP) {
        chunks.push(slugs.slice(i, i + READ_KEY_CAP));
      }
      const rows = (await Promise.all(chunks.map((chunk) => node.queryByKeys!({
        schemaHash,
        fields: ["body", "title", "tags"],
        keys: chunk.map((slug) => ({ hash: slug })),
      })))).flat();
      await Promise.all(rows.map(async (row) => {
        const slug = row.key?.hash ?? "";
        const fields = row.fields as Record<string, unknown> | undefined;
        const rawBody = fields?.body;
        if (slug.length === 0 || typeof rawBody !== "string") return;
        if (Array.isArray(fields?.tags) && fields.tags.includes(TOMBSTONE_TAG)) return;
        const marker = parseSpillMarker(rawBody);
        const head: BodyHead = {
          title: typeof fields?.title === "string" ? fields.title : "",
          body: marker ? marker.head : rawBody,
        };
        // A phrase absent from the head can still occur in the stored tail.
        if (exactQuery !== undefined && marker && !matchesExact(head, exactQuery)) {
          const full = await hydrateRecord(node, cfg, type, {
            slug,
            title: head.title,
            body: rawBody,
            status: "",
            tags: [],
            created_at: "",
            updated_at: "",
          }, { fields: ["body"] });
          head.body = full.body;
        }
        if (exactQuery === undefined || matchesExact(head, exactQuery)) {
          out.set(`${type}::${slug}`, head);
        }
      }));
    }),
  );
  return out;
}

function keepLive(
  picked: ReadonlyArray<{ type: RecordType; slug: string; score: number | null }>,
  bodies: Map<string, BodyHead>,
  confidence: SearchHitJson["confidence"],
): RetrievedHit[] {
  const hits: RetrievedHit[] = [];
  for (const hit of picked) {
    const row = bodies.get(`${hit.type}::${hit.slug}`);
    if (row === undefined) continue;
    hits.push({
      type: hit.type,
      slug: hit.slug,
      score: hit.score,
      confidence,
      title: row.title,
      body: row.body,
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
  /** Called only on a LastSeek miss that uses keyword heads. */
  keywordText?: () => Promise<readonly string[]>;
}): Promise<{ hits: RetrievedHit[]; sample: boolean }> {
  const page = pageLimit(opts.limit);
  const active = new Set(opts.activeTypes);
  const schemas = await lastSeekScope(opts.node, opts.cfg, opts.activeTypes, opts.verbose);
  // Every walked type is empty: nothing to find, and an unscoped query would
  // rank other apps' rows.
  if (opts.activeTypes.length > 0 && schemas.length === 0) return { hits: [], sample: false };
  const seek = queryLastSeek({
    query: opts.query,
    k: RANKER_PAGE,
    caller: opts.caller ?? "brain/search",
    schemas: schemas.length > 0 ? schemas : undefined,
    // LastSeek retains no text and refuses --exact. Verify the ranked keys below.
    min_score: opts.minScore,
    verbose: opts.verbose,
  });
  if (seek === null || opts.exact) {
    if (seek === null && opts.minScore !== undefined) return { hits: [], sample: false };
    const extraText = opts.minScore === undefined && opts.keywordText ? await opts.keywordText() : [];
    const ranked = opts.minScore !== undefined ? [] : await rankKeywordQuery({
      node: opts.node,
      cfg: opts.cfg,
      query: opts.query,
      extraText,
      verbose: opts.verbose,
    });
    const picked: Array<{ type: RecordType; slug: string; score: number | null }> = [];
    const seen = new Set<string>();
    if (opts.exact && seek !== null) {
      for (const hit of seek) {
        const slug = hit.key_hash;
        const type = recordTypeForHash(hit.schema_identity, opts.cfg.schemaHashes);
        if (!slug || !type || !active.has(type) || (opts.typeFilter && !opts.typeFilter.has(type))) continue;
        seen.add(`${type}::${slug}`);
        picked.push({ type, slug, score: hit.score });
      }
    }
    let keywordPicked = 0;
    for (const hit of ranked) {
      if (opts.exact ? keywordPicked >= RANKER_PAGE : picked.length >= page) break;
      if (!isRecordType(hit.type) || !active.has(hit.type)) continue;
      if (opts.typeFilter && !opts.typeFilter.has(hit.type)) continue;
      const id = `${hit.type}::${hit.slug}`;
      if (seen.has(id)) continue;
      seen.add(id);
      picked.push({ type: hit.type, slug: hit.slug, score: null });
      keywordPicked += 1;
    }
    const bodies = await readBodyHeads(
      opts.node, opts.cfg, picked, opts.verbose, opts.exact ? opts.query : undefined,
    );
    return { hits: keepLive(picked, bodies, SAMPLE_CONFIDENCE).slice(0, page), sample: true };
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
    ? `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms or use the \`brain_ask\` tool.`
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
