import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { normalizeSlug } from "./record.ts";
import {
  BRAIN_EDGE_SET_SCHEMA_KEY,
  BRAIN_LIST_PAGE_SCHEMA_KEY,
  RECORD_TYPES,
} from "./schemas.ts";

export const GRAPH_EDGE_TYPES = [
  "implements",
  "supersedes",
  "blocks",
  "part-of",
  "references",
  "decided-in",
  "proves",
  "owns",
  "mentions",
] as const;
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];
export type GraphEdgeProvenance = "explicit" | "wikilink" | "frontmatter";
export type GraphEdge = {
  src: string;
  dst: string;
  type: GraphEdgeType;
  provenance: GraphEdgeProvenance;
  created_at: string;
};

const TYPE_SET = new Set<string>(GRAPH_EDGE_TYPES);
const LINK_RE = /\[\[([^\[\]\n]+)\]\]/g;

export function normalizeGraphEdgeType(raw: string): GraphEdgeType {
  const normalized = raw.trim().toLowerCase();
  return TYPE_SET.has(normalized) ? (normalized as GraphEdgeType) : "mentions";
}

export function extractGraphEdges(opts: {
  sourceSlug: string;
  body: string;
  frontmatterEdges?: readonly string[];
  now?: string;
}): GraphEdge[] {
  const src = normalizeSlug(opts.sourceSlug).toLowerCase();
  const created_at = opts.now ?? new Date().toISOString();
  const byKey = new Map<string, GraphEdge>();
  const add = (raw: string, provenance: GraphEdgeProvenance) => {
    const spec = raw.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
    const split = spec.indexOf("::");
    const typed = split >= 0;
    const rawType = typed ? spec.slice(0, split) : "mentions";
    const dst = normalizeSlug(typed ? spec.slice(split + 2) : spec).toLowerCase();
    if (!src || !dst) return;
    const type = normalizeGraphEdgeType(rawType);
    const edge: GraphEdge = { src, dst, type, provenance, created_at };
    const key = `${type}#${dst}`;
    const prior = byKey.get(key);
    const weight = { wikilink: 0, frontmatter: 1, explicit: 2 } as const;
    if (!prior || weight[provenance] > weight[prior.provenance]) byKey.set(key, edge);
  };

  for (const match of opts.body.matchAll(LINK_RE)) {
    const raw = match[1] ?? "";
    add(raw, raw.includes("::") ? "explicit" : "wikilink");
  }
  for (const raw of opts.frontmatterEdges ?? []) add(raw, "frontmatter");
  return [...byKey.values()].sort(compareEdges);
}

const EDGE_HEAD = "__head__";
const EDGE_FRONTMATTER = "__frontmatter__";

/** Out is the edge-set schema. In is the list-page schema (`link#slug`). */
export function graphEdgeHashes(
  cfg: Pick<Config, "schemaHashes">,
): { out: string; in: string } | null {
  const out = cfg.schemaHashes[BRAIN_EDGE_SET_SCHEMA_KEY];
  const inbound = cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY];
  return out && inbound ? { out, in: inbound } : null;
}

export type ReadGraphEdgesOpts = {
  fields?: readonly string[];
  verbose?: (message: string) => void;
};

export type ReadGraphEdgesDetailed = {
  edges: GraphEdge[] | null;
  droppedOwns: number;
};

function parseIdList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function edgeFromId(src: string, id: string, provenance: GraphEdgeProvenance): GraphEdge | null {
  const cut = id.indexOf("#");
  if (cut <= 0) return null;
  const dst = id.slice(cut + 1);
  if (dst.length === 0) return null;
  return {
    src,
    dst,
    type: normalizeGraphEdgeType(id.slice(0, cut)),
    provenance,
    created_at: "",
  };
}

export async function readGraphEdgesDetailed(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  slug: string,
  direction: "out" | "in",
  opts?: ReadGraphEdgesOpts,
): Promise<ReadGraphEdgesDetailed> {
  void opts;
  const hashes = graphEdgeHashes(cfg);
  if (!hashes) return { edges: null, droppedOwns: 0 };
  const key = normalizeSlug(slug).toLowerCase();
  if (direction === "in") {
    const res = await node.queryAll({
      schemaHash: hashes.in,
      fields: ["blp_page"],
      filter: { HashRangeKey: { hash: `link#${key}`, range: EDGE_HEAD } },
    });
    const raw = res.results[0]?.fields?.blp_page;
    const ids = typeof raw === "string" ? linkCardSlugs(raw) : [];
    const edges = ids.map((src) => edgeFromId(src, `mentions#${key}`, "explicit"))
      .filter((edge): edge is GraphEdge => edge !== null);
    return { edges: edges.sort(compareEdges), droppedOwns: 0 };
  }
  const types = RECORD_TYPES.filter((type) => {
    const hash = cfg.schemaHashes[type];
    return typeof hash === "string" && hash.length > 0;
  });
  const keys = types.flatMap((type) => [
    { hash: `es#${type}#${key}`, range: EDGE_HEAD },
    { hash: `es#${type}#${key}`, range: EDGE_FRONTMATTER },
  ]);
  if (keys.length === 0) return { edges: [], droppedOwns: 0 };
  const rows = node.queryByKeys
    ? await node.queryByKeys({
      schemaHash: hashes.out,
      fields: ["bes_r", "bes_ids"],
      keys,
    })
    : (await node.queryAll({
      schemaHash: hashes.out,
      fields: ["bes_r", "bes_ids"],
      filter: { HashRangeKeys: keys.map((item) => [item.hash, item.range]) },
    })).results;
  const frontmatter = new Set<string>();
  const headIds: string[] = [];
  for (const row of rows) {
    const range = row.key?.range ?? "";
    const ids = parseIdList(row.fields?.bes_ids);
    if (range === EDGE_FRONTMATTER) {
      for (const id of ids) frontmatter.add(id);
    } else {
      headIds.push(...ids);
    }
  }
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const id of headIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const edge = edgeFromId(key, id, frontmatter.has(id) ? "frontmatter" : "explicit");
    if (edge) edges.push(edge);
  }
  return { edges: edges.sort(compareEdges), droppedOwns: 0 };
}

function linkCardSlugs(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as { cards?: unknown };
    if (!Array.isArray(value.cards)) return [];
    const seen = new Set<string>();
    const slugs: string[] = [];
    for (const item of value.cards) {
      if (!item || typeof item !== "object") continue;
      const slug = (item as { slug?: unknown }).slug;
      // A papercut and its reference twin share one slug. One slug is one inbound edge.
      if (typeof slug !== "string" || slug.length === 0 || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
    return slugs;
  } catch {
    return [];
  }
}

export async function readGraphEdges(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  slug: string,
  direction: "out" | "in",
  opts?: ReadGraphEdgesOpts,
): Promise<GraphEdge[] | null> {
  const detailed = await readGraphEdgesDetailed(node, cfg, slug, direction, opts);
  if (detailed.edges !== null) {
    opts?.verbose?.(
      `graph-edges ${direction} kept=${detailed.edges.length} droppedOwns=${detailed.droppedOwns}`,
    );
  }
  return detailed.edges;
}

export function edgeRange(edge: Pick<GraphEdge, "type" | "dst">): string {
  return `${edge.type}#${edge.dst}`;
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return a.type.localeCompare(b.type) || a.dst.localeCompare(b.dst) || a.src.localeCompare(b.src);
}
