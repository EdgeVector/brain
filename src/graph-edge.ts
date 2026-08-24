import type { NodeClient, QueryRow } from "./client.ts";
import type { Config } from "./config.ts";
import { normalizeSlug } from "./record.ts";
import {
  GRAPH_EDGE_FIELDS,
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
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

export function graphEdgeHashes(
  cfg: Pick<Config, "schemaHashes">,
): { out: string; in: string } | null {
  const out = cfg.schemaHashes[GRAPH_EDGE_OUT_SCHEMA_KEY];
  const inbound = cfg.schemaHashes[GRAPH_EDGE_IN_SCHEMA_KEY];
  return out && inbound ? { out, in: inbound } : null;
}

export async function readGraphEdges(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  slug: string,
  direction: "out" | "in",
): Promise<GraphEdge[] | null> {
  const hashes = graphEdgeHashes(cfg);
  if (!hashes) return null;
  const key = normalizeSlug(slug).toLowerCase();
  const res = await node.queryAll({
    schemaHash: hashes[direction],
    fields: [...GRAPH_EDGE_FIELDS],
    filter: { HashKey: key },
  });
  // Measured on the primary brain 2026-08-24: querying either plane's schema
  // hash with the same `HashKey` returns the IDENTICAL union of that slug's
  // inbound and outbound rows. The two planes are one product under two
  // indexes, and the node's HashKey filter does not pick the index the schema
  // hash names. Untrimmed, an `out` read hands back edges pointing AT the
  // slug, which `graph neighbors` then renders with the queried slug as its
  // own neighbour, and which the mirror lint compares against itself and
  // always calls agreement. Keep only the rows this direction actually owns.
  // Harmless once the node discriminates: the predicate is already true then.
  const owns = direction === "out"
    ? (edge: GraphEdge) => edge.src === key
    : (edge: GraphEdge) => edge.dst === key;
  return res.results
    .map(rowToEdge)
    .filter((edge): edge is GraphEdge => edge !== null)
    .filter(owns)
    .sort(compareEdges);
}

export async function reconcileGraphEdges(opts: {
  node: NodeClient;
  cfg: Pick<Config, "schemaHashes">;
  sourceSlug: string;
  body: string;
  frontmatterEdges?: readonly string[];
  preserveExistingFrontmatter?: boolean;
  now?: string;
}): Promise<number> {
  const hashes = graphEdgeHashes(opts.cfg);
  if (!hashes) return 0;
  const existing = (await readGraphEdges(opts.node, opts.cfg, opts.sourceSlug, "out")) ?? [];
  const desired = extractGraphEdges(opts);
  if (opts.preserveExistingFrontmatter) {
    for (const edge of existing) {
      if (edge.provenance === "frontmatter" && !desired.some((d) => edgeRange(d) === edgeRange(edge))) {
        desired.push(edge);
      }
    }
  }
  const current = new Map(existing.map((edge) => [edgeRange(edge), edge]));
  const wanted = new Map(desired.map((edge) => [edgeRange(edge), edge]));
  for (const [range] of current) {
    if (!wanted.has(range)) {
      await opts.node.deleteRecord({
        schemaHash: hashes.out,
        keyHash: normalizeSlug(opts.sourceSlug).toLowerCase(),
        keyRange: range,
      });
    }
  }
  for (const [range, edge] of wanted) {
    const old = current.get(range);
    const fields = edgeFields({ ...edge, created_at: old?.created_at || edge.created_at });
    const mutation = { schemaHash: hashes.out, fields, keyHash: edge.src, keyRange: range };
    if (old) await opts.node.updateRecord(mutation);
    else await opts.node.createRecord(mutation);
  }
  return wanted.size;
}

// An unregistered substrate is a config state, not a per-write event: every
// `put` on that brain drops its links the same way. Warn once per process so
// the first write says it plainly and a 200-record backfill does not print
// the same line 200 times.
let inertNoticeEmitted = false;

/** Test seam — forget that the once-per-process inert notice was printed. */
export function resetGraphEdgeInertNotice(): void {
  inertNoticeEmitted = false;
}

export type MaintainGraphEdgesResult = {
  graphEdgeIndexFailed: boolean;
  edges: number;
  // True when the graph-edge schemas are absent from config, so no edge row
  // can be written whatever the body says.
  substrateInert: boolean;
  // Links parsed out of this body that the inert substrate discarded. Zero
  // when the substrate is live, or when the body carries no links.
  droppedLinks: number;
};

export async function maintainGraphEdges(
  opts: Parameters<typeof reconcileGraphEdges>[0] & {
    verbose?: (message: string) => void;
    // Loud channel for the inert-substrate notice. Defaults to stderr — this
    // one must reach a non-verbose operator, unlike `verbose`.
    warn?: (message: string) => void;
  },
): Promise<MaintainGraphEdgesResult> {
  // Before phase 1 shipped, this path returned `edges: 0` here in silence, so
  // a brain whose config never got the two schema keys looked identical to a
  // brain whose records simply carry no links. It is not: the links parsed
  // fine and were thrown away. Say so.
  if (graphEdgeHashes(opts.cfg) === null) {
    const droppedLinks = extractGraphEdges(opts).length;
    if (droppedLinks > 0 && !inertNoticeEmitted) {
      inertNoticeEmitted = true;
      const warn = opts.warn ?? ((message: string) => console.error(message));
      warn(
        `graph-edge substrate is INERT: parsed ${droppedLinks} link(s) in ${opts.sourceSlug} ` +
          "and stored none, because the graph-edge schemas are not in this brain's config. " +
          "The record is saved; its links are not queryable. " +
          "Fix: run `fbrain init` to register them, then `fbrain reindex --graph-edges`. " +
          "(reported once per process)",
      );
    }
    return { graphEdgeIndexFailed: false, edges: 0, substrateInert: true, droppedLinks };
  }
  try {
    return {
      graphEdgeIndexFailed: false,
      edges: await reconcileGraphEdges(opts),
      substrateInert: false,
      droppedLinks: 0,
    };
  } catch (err) {
    opts.verbose?.(
      `graph-edge reconcile FAILED for ${opts.sourceSlug}: ${err instanceof Error ? err.message : String(err)}; ` +
        "record persisted — run `fbrain reindex --graph-edges` for bounded repair",
    );
    return { graphEdgeIndexFailed: true, edges: 0, substrateInert: false, droppedLinks: 0 };
  }
}

function edgeRange(edge: Pick<GraphEdge, "type" | "dst">): string {
  return `${edge.type}#${edge.dst}`;
}

function edgeFields(edge: GraphEdge): Record<string, string> {
  return {
    bge_src: edge.src,
    bge_dst: edge.dst,
    bge_type: edge.type,
    bge_provenance: edge.provenance,
    bge_created_at: edge.created_at,
    bge_out_r: `${edge.type}#${edge.dst}`,
    bge_in_r: `${edge.type}#${edge.src}`,
  };
}

function rowToEdge(row: QueryRow): GraphEdge | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const src = typeof fields.bge_src === "string" ? fields.bge_src : "";
  const dst = typeof fields.bge_dst === "string" ? fields.bge_dst : "";
  const provenance = fields.bge_provenance;
  if (
    !src ||
    !dst ||
    (provenance !== "explicit" && provenance !== "wikilink" && provenance !== "frontmatter")
  ) return null;
  return {
    src,
    dst,
    type: typeof fields.bge_type === "string" ? normalizeGraphEdgeType(fields.bge_type) : "mentions",
    provenance,
    created_at: typeof fields.bge_created_at === "string" ? fields.bge_created_at : "",
  };
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return a.type.localeCompare(b.type) || a.dst.localeCompare(b.dst) || a.src.localeCompare(b.src);
}
