// `brain graph neighbors|path|query` — bounded traversal over the persisted
// typed-edge substrate.
//
// Every command here is a read. None of them writes, and none of them can
// escalate into a corpus walk: see the access-pattern contract at the top of
// `src/graph-traverse.ts`.
//
// A note on the unconfigured case. When the graph-edge schemas are missing
// from config, the traversal helpers return `null` rather than an empty
// result, and these commands surface that as an explicit "graph edges are not
// configured" line with the remedy. Rendering it as "no neighbors" would be a
// confident wrong answer about the record, when the truth is that nothing was
// asked of the graph at all.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import { normalizeSlug } from "../record.ts";
import type { GraphEdgeType } from "../graph-edge.ts";
import {
  findGraphPath,
  graphQuery,
  readNeighbors,
  type GraphDirection,
  type GraphNeighbor,
  type GraphPathResult,
  type GraphQueryResult,
} from "../graph-traverse.ts";

export const GRAPH_EDGES_UNCONFIGURED_HINT =
  "graph edges are not configured — run `brain init` to register the edge schemas, " +
  "then `brain reindex --graph-edges` to populate them";

export type GraphNeighborsJson = {
  slug: string;
  direction: GraphDirection;
  edge_types: GraphEdgeType[] | null;
  configured: boolean;
  neighbors: GraphNeighbor[];
};

export type GraphCommonOptions = {
  cfg: Config;
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type GraphNeighborsOptions = GraphCommonOptions & {
  slug: string;
  direction?: GraphDirection;
  edgeTypes?: readonly GraphEdgeType[];
  onResult?: (payload: GraphNeighborsJson) => void;
};

export async function graphNeighborsCmd(opts: GraphNeighborsOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug).toLowerCase();
  const direction = opts.direction ?? "both";
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const neighbors = await readNeighbors(node, opts.cfg, slug, {
    direction,
    ...(opts.edgeTypes ? { edgeTypes: opts.edgeTypes } : {}),
  });
  const json: GraphNeighborsJson = {
    slug,
    direction,
    edge_types: opts.edgeTypes && opts.edgeTypes.length > 0 ? [...opts.edgeTypes] : null,
    configured: neighbors !== null,
    neighbors: neighbors ?? [],
  };
  opts.onResult?.(json);
  if (opts.json) {
    print(JSON.stringify(json));
    return;
  }
  print(formatNeighbors(json));
}

export function formatNeighbors(json: GraphNeighborsJson): string {
  if (!json.configured) return `graph neighbors for ${json.slug}: ${GRAPH_EDGES_UNCONFIGURED_HINT}`;
  const scope = json.edge_types ? ` [${json.edge_types.join(", ")}]` : "";
  if (json.neighbors.length === 0) {
    return `graph neighbors for ${json.slug} (${json.direction})${scope}: (none)`;
  }
  const lines = [`graph neighbors for ${json.slug} (${json.direction})${scope}:`];
  for (const neighbor of json.neighbors) {
    const arrow = neighbor.direction === "out" ? "->" : "<-";
    lines.push(`  ${arrow} ${neighbor.type} ${neighbor.slug} (${neighbor.provenance})`);
  }
  return lines.join("\n");
}

export type GraphPathJson = GraphPathResult & { configured: boolean };

export type GraphPathOptions = GraphCommonOptions & {
  src: string;
  dst: string;
  maxHops?: number;
  direction?: GraphDirection;
  edgeTypes?: readonly GraphEdgeType[];
  onResult?: (payload: GraphPathJson) => void;
};

export async function graphPathCmd(opts: GraphPathOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const result = await findGraphPath(node, opts.cfg, opts.src, opts.dst, {
    ...(opts.maxHops === undefined ? {} : { maxHops: opts.maxHops }),
    direction: opts.direction ?? "out",
    ...(opts.edgeTypes ? { edgeTypes: opts.edgeTypes } : {}),
  });
  const json: GraphPathJson = result
    ? { ...result, configured: true }
    : {
        configured: false,
        src: normalizeSlug(opts.src).toLowerCase(),
        dst: normalizeSlug(opts.dst).toLowerCase(),
        max_hops: opts.maxHops ?? 0,
        found: false,
        hops: null,
        nodes: [],
        edges: [],
        visited: 0,
        truncated: false,
      };
  opts.onResult?.(json);
  if (opts.json) {
    print(JSON.stringify(json));
    return;
  }
  print(formatPath(json));
}

export function formatPath(json: GraphPathJson): string {
  if (!json.configured) return `graph path ${json.src} -> ${json.dst}: ${GRAPH_EDGES_UNCONFIGURED_HINT}`;
  if (!json.found) {
    // Distinguish the two very different negatives. "Nothing within 3 hops" is
    // a statement about the budget; only an exhausted search is a statement
    // about the graph.
    const reason = json.truncated
      ? `search stopped at the node budget after visiting ${json.visited}`
      : `no path within ${json.max_hops} hop(s) (visited ${json.visited})`;
    return `graph path ${json.src} -> ${json.dst}: not found — ${reason}`;
  }
  const lines = [
    `graph path ${json.src} -> ${json.dst}: ${json.hops} hop(s), visited ${json.visited}`,
  ];
  for (const edge of json.edges) {
    const arrow = edge.direction === "out" ? "->" : "<-";
    lines.push(`  ${edge.from} ${arrow}[${edge.type}] ${edge.to}`);
  }
  return lines.join("\n");
}

export type GraphQueryJson = GraphQueryResult & { configured: boolean };

export type GraphQueryOptions = GraphCommonOptions & {
  slug: string;
  maxHops?: number;
  direction?: GraphDirection;
  edgeTypes?: readonly GraphEdgeType[];
  maxNodes?: number;
  onResult?: (payload: GraphQueryJson) => void;
};

export async function graphQueryCmd(opts: GraphQueryOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const result = await graphQuery(node, opts.cfg, opts.slug, {
    ...(opts.maxHops === undefined ? {} : { maxHops: opts.maxHops }),
    direction: opts.direction ?? "out",
    ...(opts.edgeTypes ? { edgeTypes: opts.edgeTypes } : {}),
    ...(opts.maxNodes === undefined ? {} : { maxNodes: opts.maxNodes }),
  });
  const json: GraphQueryJson = result
    ? { ...result, configured: true }
    : {
        configured: false,
        root: normalizeSlug(opts.slug).toLowerCase(),
        max_hops: opts.maxHops ?? 0,
        direction: opts.direction ?? "out",
        edge_types: null,
        hits: [],
        visited: 0,
        truncated: false,
      };
  opts.onResult?.(json);
  if (opts.json) {
    print(JSON.stringify(json));
    return;
  }
  print(formatQuery(json));
}

export function formatQuery(json: GraphQueryJson): string {
  if (!json.configured) return `graph query ${json.root}: ${GRAPH_EDGES_UNCONFIGURED_HINT}`;
  const scope = json.edge_types ? ` [${json.edge_types.join(", ")}]` : "";
  const header =
    `graph query ${json.root} (${json.direction}, max-hops ${json.max_hops})${scope}: ` +
    `${json.hits.length} reachable, visited ${json.visited}`;
  if (json.hits.length === 0) return `${header}\n  (none)`;
  const lines = [header];
  for (const hit of json.hits) {
    const via = hit.via ? ` via ${hit.via.type} from ${hit.via.from}` : "";
    lines.push(`  ${hit.depth}  ${hit.slug}${via}`);
  }
  if (json.truncated) {
    // Never let a capped sweep read as a complete one.
    lines.push("  TRUNCATED: node budget reached — widen --max-nodes for a complete answer");
  }
  return lines.join("\n");
}
