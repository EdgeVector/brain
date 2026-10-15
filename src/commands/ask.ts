// `brain ask <query>` ranks with LastSeek. A miss reads keyword heads.

import type { Verbose } from "../client.ts";
import { newSearchClientFromCfg } from "../write-context.ts";
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
  missingSchemaHashReadNote,
  normalizeSlug,
  resolveTypeFilter,
} from "../record.ts";
import { BRAIN_EDGE_SET_SCHEMA_KEY, isRecordType, type RecordType } from "../schemas.ts";
import { tokenize } from "../retrieval/bm25.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import { normalizeGraphEdgeType } from "../graph-edge.ts";
import {
  SEARCH_DEFAULT_LIMIT,
  retrieveRankedPage,
  type SearchHitJson,
} from "./search.ts";
import {
  estimateCostUsd,
  expandQuery,
  ExpansionError,
  resolveAnthropicKey,
  type ExpansionResult,
} from "../retrieval/expand.ts";
import {
  resolveAdjacencyWeight,
  type AdjacencyAttribution,
  type AdjacencyBoost,
  type AdjacencyOptions,
} from "../retrieval/adjacency.ts";

export const DEFAULT_LIMIT = SEARCH_DEFAULT_LIMIT;

export type AskOptions = {
  cfg: Config;
  query: string;
  limit?: number;
  expand?: boolean;
  noLlm?: boolean;
  explain?: boolean;
  graphBoost?: boolean;
  graphBoostOptions?: AdjacencyOptions;
  types?: readonly RecordType[];
  fields?: readonly string[];
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  isTty?: () => boolean;
  agent?: boolean;
  onResult?: (payload: SearchHitJson[]) => void;
  onSkippedTypes?: (skipped: readonly RecordType[]) => void;
  fetchImpl?: typeof fetch;
};

export type AskHit = {
  type: RecordType;
  slug: string;
  fusedScore: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  expansionHits: Array<{ idx: number; ranker: "bm25" | "vector"; rank: number }>;
  record: {
    slug: string;
    title: string;
    body: string;
    status: string;
    tags: string[];
    created_at: string;
    updated_at: string;
  };
};

export type ExpansionStatus =
  | { kind: "ok" }
  | { kind: "disabled" }
  | { kind: "no-key" }
  | { kind: "failed"; reason: string };

export type AskResult = {
  query: string;
  expansions: string[];
  expansion: ExpansionResult | null;
  expansionStatus: ExpansionStatus;
  hits: AskHit[];
  bm25CorpusSize: number;
  bm25CacheHit: boolean;
  graphBoost: AdjacencyAttribution | null;
};

export async function askCmd(opts: AskOptions): Promise<AskResult> {
  const { print, printErr } = resolvePrintSinks(opts);
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const { typeFilter, activeTypes } = resolveTypeFilter(
    opts.types,
    opts.cfg,
    (skipped) => {
      opts.onSkippedTypes?.(skipped);
      printErr(missingSchemaHashReadNote(skipped, "answering from the rest"));
    },
  );

  // A LastSeek hit does not use the phrases, so the model stays idle.
  const expansionRun: {
    expansions: string[];
    expansion: ExpansionResult | null;
    status: ExpansionStatus;
  } = {
    expansions: [],
    expansion: null,
    status: opts.expand ? { kind: "ok" } : { kind: "disabled" },
  };

  const node = newSearchClientFromCfg(opts.cfg, opts.verbose).node;
  const ranked = await retrieveRankedPage({
    node,
    cfg: opts.cfg,
    query: opts.query,
    limit,
    typeFilter,
    activeTypes,
    caller: "brain/ask",
    verbose: opts.verbose,
    keywordText: opts.expand
      ? async () => {
          const key = resolveAnthropicKey();
          if (!key) {
            printErr("note: ANTHROPIC_API_KEY not set; running ask on the original query only.");
            expansionRun.status = { kind: "no-key" };
            return [];
          }
          try {
            const exp: Parameters<typeof expandQuery>[0] = {
              query: opts.query,
              apiKey: key,
            };
            if (opts.fetchImpl) exp.fetchImpl = opts.fetchImpl;
            expansionRun.expansion = await expandQuery(exp);
            expansionRun.expansions = expansionRun.expansion.expansions;
            expansionRun.status = { kind: "ok" };
            opts.verbose?.(
              `expansion: ${expansionRun.expansion.expansions.length} phrasings, ${expansionRun.expansion.latencyMs.toFixed(0)}ms, ` +
                `tokens in=${expansionRun.expansion.tokens.input} out=${expansionRun.expansion.tokens.output}, ` +
                formatCost(
                  estimateCostUsd(expansionRun.expansion.tokens, expansionRun.expansion.model),
                  expansionRun.expansion.model,
                ),
            );
            return expansionRun.expansions;
          } catch (err) {
            const msg = err instanceof ExpansionError ? err.message : String(err);
            printErr(`note: query expansion failed (${msg}); continuing without expansion.`);
            expansionRun.status = { kind: "failed", reason: msg };
            return [];
          }
        }
      : undefined,
  });
  const expansions = expansionRun.expansions;
  const expansion = expansionRun.expansion;
  const expansionStatus = expansionRun.status;
  if (ranked.sample) printErr("sample");
  if (ranked.hits.length === 0 && tokenize(opts.query).length === 0) {
    printErr("note: query tokenized to zero terms (all stopwords or too short); try more specific words.");
  }

  let pageHits = ranked.hits;
  let graphBoost: AdjacencyAttribution | null = null;
  if (opts.graphBoost) {
    const seed = pageHits[0];
    if (!seed) {
      graphBoost = { seeds: [], boosts: [], reads: 0, skipped: "no-seeds" };
    } else {
      const schemaHash = opts.cfg.schemaHashes[BRAIN_EDGE_SET_SCHEMA_KEY];
      if (!schemaHash) {
        graphBoost = {
          seeds: [{ slug: seed.slug, rank: 1 }],
          boosts: [],
          reads: 0,
          skipped: "edges-unavailable",
        };
        opts.verbose?.("graph boost: BrainEdgeSet schema absent");
      } else {
        const hash = `es#${seed.type}#${normalizeSlug(seed.slug).toLowerCase()}`;
        const res = await node.queryAll({
          schemaHash,
          fields: ["bes_ids"],
          filter: { HashRangeKey: { hash, range: "__head__" } },
        });
        const raw = (res.results[0]?.fields as Record<string, unknown> | undefined)?.bes_ids;
        let ids: string[] = [];
        if (typeof raw === "string" && raw.length > 0) {
          try {
            const value = JSON.parse(raw) as unknown;
            if (Array.isArray(value)) {
              ids = value.filter((item): item is string => typeof item === "string");
            }
          } catch {
            ids = [];
          }
        }
        const weight = resolveAdjacencyWeight(opts.graphBoostOptions?.weight);
        const neighborSlugs = new Set<string>();
        const edgeBySlug = new Map<string, ReturnType<typeof normalizeGraphEdgeType>>();
        for (const id of ids) {
          const cut = id.indexOf("#");
          if (cut <= 0) continue;
          const dst = normalizeSlug(id.slice(cut + 1)).toLowerCase();
          if (dst.length === 0) continue;
          neighborSlugs.add(dst);
          if (!edgeBySlug.has(dst)) edgeBySlug.set(dst, normalizeGraphEdgeType(id.slice(0, cut)));
        }
        opts.verbose?.(`HashRangeKey BrainEdgeSet ${hash} ids=${ids.length}`);
        if (weight > 0 && neighborSlugs.size > 0) {
          const near: typeof pageHits = [];
          const far: typeof pageHits = [];
          for (const hit of pageHits.slice(1)) {
            if (neighborSlugs.has(normalizeSlug(hit.slug).toLowerCase())) near.push(hit);
            else far.push(hit);
          }
          pageHits = [pageHits[0]!, ...near, ...far];
        }
        const boosts: AdjacencyBoost[] = [];
        if (weight > 0) {
          for (const hit of pageHits.slice(1)) {
            const edgeType = edgeBySlug.get(normalizeSlug(hit.slug).toLowerCase());
            if (!edgeType) continue;
            boosts.push({
              id: `${hit.type}::${hit.slug}`,
              slug: hit.slug,
              total: weight,
              rawTotal: weight,
              clampedBy: null,
              reasons: [
                {
                  seedSlug: seed.slug,
                  seedRank: 1,
                  edgeType,
                  direction: "out",
                  contribution: weight,
                },
              ],
            });
          }
        }
        graphBoost = {
          seeds: [{ slug: seed.slug, rank: 1 }],
          boosts,
          reads: 1,
          skipped: null,
        };
      }
    }
  }

  const boostBySlug = new Map(graphBoost?.boosts.map((item) => [item.slug, item.total]) ?? []);
  const resolved: AskHit[] = pageHits.map((hit, index) => ({
    type: hit.type,
    slug: hit.slug,
    fusedScore: (hit.score ?? 0) + (boostBySlug.get(hit.slug) ?? 0),
    bm25Rank: null,
    vectorRank: hit.score === null ? null : index + 1,
    vectorScore: hit.score,
    expansionHits: [],
    record: {
      slug: hit.slug,
      title: hit.title,
      body: hit.body,
      status: "",
      tags: [],
      created_at: "",
      updated_at: "",
    },
  }));

  const explainSink = opts.json ? printErr : print;
  if (opts.explain) {
    if (expansionStatus.kind === "failed") {
      explainSink(`expansion failed: ${expansionStatus.reason}`);
      explainSink("");
    } else if (expansionStatus.kind === "disabled") {
      explainSink("(no expansions — LLM expansion not enabled; pass --expand)");
      explainSink("");
    } else if (expansionStatus.kind === "no-key") {
      explainSink("(no expansions — ANTHROPIC_API_KEY not set; running the original query only)");
      explainSink("");
    } else if (expansions.length > 0) {
      explainSink(`expansions:`);
      for (const line of expansions) explainSink(`  - ${line}`);
      explainSink("");
    }
    if (graphBoost) {
      if (graphBoost.skipped === "edges-unavailable") {
        explainSink("graph boost: skipped — the edge set schema is not configured on this node.");
      } else if (graphBoost.skipped === "no-seeds") {
        explainSink("graph boost: skipped — no hits to seed a neighbor read from.");
      } else if (graphBoost.boosts.length === 0) {
        explainSink(
          `graph boost: one BrainEdgeSet read for ${graphBoost.seeds.map((seed) => seed.slug).join(", ") || "no seed"}.`,
        );
      }
      explainSink("");
    }
  }

  const weakMatch = pageHits.some((hit) => hit.confidence === "weak");
  const weakMatchNote = `note:  no strong matches for "${opts.query}" — showing closest by similarity. Try different terms.`;
  const payload: SearchHitJson[] = pageHits.map((hit) => ({
    slug: hit.slug,
    score: hit.score == null ? null : Math.round(hit.score * 1e6) / 1e6,
    type: hit.type,
    title: hit.title,
    snippet: buildSnippet(hit.body, opts.query),
    confidence: hit.confidence,
  }));
  opts.onResult?.(payload);

  const result = (): AskResult => ({
    query: opts.query,
    expansions,
    expansion,
    expansionStatus,
    hits: resolved,
    bm25CorpusSize: 0,
    bm25CacheHit: false,
    graphBoost,
  });

  if (opts.fields !== undefined && opts.fields.length > 0) {
    printFieldProjection(payload, opts.fields, print);
    if (weakMatch) printErr(weakMatchNote);
    return result();
  }

  if (resolved.length === 0) {
    const hint = opts.agent
      ? "hint:  nothing matched — try fewer or different terms, or create a record with `fbrain_put`"
      : "hint:  nothing matched — try fewer or different terms";
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
  } else if (opts.verbose) {
    if (weakMatch) printErr(weakMatchNote);
    if (resolveStdoutIsTty(opts)) {
      printColumnLegend(print, "rank · slug · score · type · title");
    }
    const lines = formatTable(
      resolved.map((hit, index) => [
        `${index + 1}.`,
        hit.slug,
        hit.vectorScore === null ? "—" : hit.vectorScore.toFixed(4),
        capitalize(hit.type),
        hit.record.title,
      ]),
      { align: ["right", "left", "right", "left", "left"] },
    );
    for (let i = 0; i < lines.length; i++) {
      print(lines[i]!);
      const snippet = payload[i]?.snippet;
      if (snippet) print(`    ${snippet}`);
    }
  } else {
    if (weakMatch) printErr(weakMatchNote);
    if (resolveStdoutIsTty(opts)) {
      printColumnLegend(print, "rank · slug · type · title (best match first)");
    }
    const lines = formatTable(
      resolved.map((hit, index) => [
        `${index + 1}.`,
        hit.slug,
        capitalize(hit.type),
        hit.record.title,
      ]),
      { align: ["right", "left", "left", "left"] },
    );
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

  return result();
}

export function formatCost(usd: number | null, model: string): string {
  return usd === null
    ? `cost≈unknown (${model} not in price table)`
    : `cost≈$${usd.toFixed(6)}`;
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
