// Bounded traversal and integrity linting over the persisted typed-edge
// substrate written by `src/graph-edge.ts`.
//
// ACCESS-PATTERN CONTRACT (the reason this file exists at all): LastDB is
// Dynamo-style — point get is O(1), a range under one hash is O(log M), and a
// scan does not exist. Phase 1 dual-writes every edge into two schemas keyed
// the two ways a traversal needs to walk it:
//
//   __graphedgeout__   hash = bge_src   range = "<type>#<dst>"
//   __graphedgein__    hash = bge_dst   range = "<type>#<src>"
//
// So "who does X point at" and "who points at X" are BOTH one keyed range read.
// Every traversal below is therefore a breadth-first walk where each frontier
// node costs exactly one keyed read per direction — never a scan, and never a
// read whose cost depends on the size of the corpus.
//
// The cost that IS unbounded is the walk itself: a graph with a hub node fans
// out without limit, and an unbounded walk over a keyed substrate is still a
// de-facto scan. Every entry point here takes a hard hop cap AND a node
// budget, and reports when either one truncated the answer. A capped traversal
// that reports a partial answer as complete is the failure this file is most
// careful to avoid.

import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import {
  GRAPH_EDGE_TYPES,
  readGraphEdges,
  graphEdgeHashes,
  type GraphEdge,
  type GraphEdgeType,
} from "./graph-edge.ts";
import { findBySlug, normalizeSlug } from "./record.ts";
import { RECORD_TYPES, type RecordType } from "./schemas.ts";

/** Which way to walk an edge. `both` treats the graph as undirected. */
export type GraphDirection = "out" | "in" | "both";

/**
 * Hard ceiling on `--max-hops`, independent of the caller's request.
 *
 * Each extra hop multiplies the frontier, so the read count grows with the
 * graph's branching factor raised to the hop count. Six is already generous
 * for a knowledge graph whose longest meaningful chain (design → decision →
 * card → proof) is about four; past that a caller wants `query`, which
 * reports its own truncation, rather than a silently enormous `path`.
 */
export const GRAPH_MAX_HOPS_LIMIT = 6;
/** Default hops when the caller does not say. */
export const GRAPH_DEFAULT_MAX_HOPS = 3;
/**
 * Default ceiling on distinct nodes visited in one traversal.
 *
 * This bounds the number of keyed reads a single command can issue. When it
 * binds, the result carries `truncated: true` and the caller MUST surface
 * that — see the no-silent-caps rule in the module header.
 */
export const GRAPH_DEFAULT_MAX_NODES = 500;

export type GraphNeighbor = {
  slug: string;
  type: GraphEdgeType;
  /** `out` = this record points at `slug`; `in` = `slug` points at this record. */
  direction: "out" | "in";
  provenance: GraphEdge["provenance"];
};

export type GraphPathEdge = {
  from: string;
  to: string;
  type: GraphEdgeType;
  direction: "out" | "in";
};

export type GraphPathResult = {
  src: string;
  dst: string;
  max_hops: number;
  found: boolean;
  hops: number | null;
  /** Slugs from `src` to `dst` inclusive; empty when not found. */
  nodes: string[];
  edges: GraphPathEdge[];
  /** Distinct nodes dequeued during the search. */
  visited: number;
  /** True when the node budget stopped the search before it was exhaustive. */
  truncated: boolean;
};

export type GraphQueryHit = {
  slug: string;
  depth: number;
  /** The edge that first reached this slug. Null for the root. */
  via: GraphPathEdge | null;
};

export type GraphQueryResult = {
  root: string;
  max_hops: number;
  direction: GraphDirection;
  edge_types: GraphEdgeType[] | null;
  hits: GraphQueryHit[];
  visited: number;
  truncated: boolean;
};

export type GraphTraverseOptions = {
  direction?: GraphDirection;
  /** Restrict the walk to these edge types. Undefined/empty means all types. */
  edgeTypes?: readonly GraphEdgeType[];
  maxHops?: number;
  maxNodes?: number;
};

/**
 * Validate a caller-supplied hop count against the hard ceiling.
 *
 * Returns the effective hop count. Throws a plain `Error` with a message the
 * CLI layer wraps in an `FbrainError`; this module stays free of CLI types so
 * the MCP surface can reuse it.
 */
export function resolveMaxHops(requested?: number): number {
  if (requested === undefined) return GRAPH_DEFAULT_MAX_HOPS;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`max-hops must be a positive integer, got ${JSON.stringify(requested)}.`);
  }
  if (requested > GRAPH_MAX_HOPS_LIMIT) {
    throw new Error(
      `max-hops ${requested} exceeds the hard limit of ${GRAPH_MAX_HOPS_LIMIT}. ` +
        "Each hop multiplies the keyed-read fan-out; use `brain graph query` for a " +
        "breadth-first sweep that reports its own truncation.",
    );
  }
  return requested;
}

/** True when the graph-edge schemas are absent from config (phase 1 not run). */
export function graphEdgesUnavailable(cfg: Pick<Config, "schemaHashes">): boolean {
  return graphEdgeHashes(cfg) === null;
}

function edgeTypeFilter(
  edgeTypes: readonly GraphEdgeType[] | undefined,
): ((type: GraphEdgeType) => boolean) | null {
  if (!edgeTypes || edgeTypes.length === 0) return null;
  const set = new Set<string>(edgeTypes);
  return (type) => set.has(type);
}

/**
 * One hop from `slug`, in one or both directions.
 *
 * Returns null when the edge schemas are not configured, matching
 * `readGraphEdges`. Callers render that as a SKIP, not as "no neighbors" — an
 * unconfigured substrate and an isolated record are very different answers.
 */
export async function readNeighbors(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  slug: string,
  opts: Pick<GraphTraverseOptions, "direction" | "edgeTypes"> = {},
): Promise<GraphNeighbor[] | null> {
  if (graphEdgesUnavailable(cfg)) return null;
  const from = normalizeSlug(slug).toLowerCase();
  const direction = opts.direction ?? "both";
  const keep = edgeTypeFilter(opts.edgeTypes);
  const out: GraphNeighbor[] = [];

  if (direction === "out" || direction === "both") {
    for (const edge of (await readGraphEdges(node, cfg, from, "out")) ?? []) {
      if (keep && !keep(edge.type)) continue;
      out.push({ slug: edge.dst, type: edge.type, direction: "out", provenance: edge.provenance });
    }
  }
  if (direction === "in" || direction === "both") {
    for (const edge of (await readGraphEdges(node, cfg, from, "in")) ?? []) {
      if (keep && !keep(edge.type)) continue;
      out.push({ slug: edge.src, type: edge.type, direction: "in", provenance: edge.provenance });
    }
  }
  return out.sort(compareNeighbors);
}

function compareNeighbors(a: GraphNeighbor, b: GraphNeighbor): number {
  return (
    a.direction.localeCompare(b.direction) ||
    a.type.localeCompare(b.type) ||
    a.slug.localeCompare(b.slug)
  );
}

/**
 * Breadth-first walk from `root`, bounded by hops AND by node budget.
 *
 * BFS (not DFS) because the useful answer is "what is near this record", and
 * the hop cap only means depth when the frontier is expanded in depth order.
 * `hits` excludes the root and is ordered by depth, then slug.
 */
export async function graphQuery(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  root: string,
  opts: GraphTraverseOptions = {},
): Promise<GraphQueryResult | null> {
  if (graphEdgesUnavailable(cfg)) return null;
  const start = normalizeSlug(root).toLowerCase();
  const maxHops = resolveMaxHops(opts.maxHops);
  const maxNodes = opts.maxNodes ?? GRAPH_DEFAULT_MAX_NODES;
  const direction = opts.direction ?? "out";
  const edgeTypes = opts.edgeTypes && opts.edgeTypes.length > 0 ? [...opts.edgeTypes] : null;

  const seen = new Set<string>([start]);
  const hits: GraphQueryHit[] = [];
  let frontier: string[] = [start];
  let visited = 0;
  let truncated = false;

  for (let depth = 1; depth <= maxHops && frontier.length > 0 && !truncated; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      visited += 1;
      const neighbors = (await readNeighbors(node, cfg, current, {
        direction,
        ...(edgeTypes ? { edgeTypes } : {}),
      })) ?? [];
      for (const neighbor of neighbors) {
        if (seen.has(neighbor.slug)) continue;
        if (seen.size >= maxNodes) {
          // Budget reached mid-expansion. Stop taking new nodes and mark the
          // result partial rather than returning a prefix that reads complete.
          truncated = true;
          break;
        }
        seen.add(neighbor.slug);
        hits.push({
          slug: neighbor.slug,
          depth,
          via: {
            from: current,
            to: neighbor.slug,
            type: neighbor.type,
            direction: neighbor.direction,
          },
        });
        next.push(neighbor.slug);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  // The walk stopped at the hop cap with more graph beyond it. That is a
  // requested bound, not a budget failure, so it is not `truncated` — but the
  // caller still sees `max_hops` and can widen deliberately.
  hits.sort((a, b) => a.depth - b.depth || a.slug.localeCompare(b.slug));
  return {
    root: start,
    max_hops: maxHops,
    direction,
    edge_types: edgeTypes,
    hits,
    visited,
    truncated,
  };
}

/**
 * Shortest path from `src` to `dst` within `maxHops`, or a not-found result.
 *
 * Shortest because BFS reaches every node at its minimum depth, so the first
 * time `dst` is dequeued the parent chain is already optimal. `found:false`
 * with `truncated:true` means "no path within the budget", which is NOT the
 * same claim as "no path exists" — the CLI renders those differently.
 */
export async function findGraphPath(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  src: string,
  dst: string,
  opts: GraphTraverseOptions = {},
): Promise<GraphPathResult | null> {
  if (graphEdgesUnavailable(cfg)) return null;
  const from = normalizeSlug(src).toLowerCase();
  const to = normalizeSlug(dst).toLowerCase();
  const maxHops = resolveMaxHops(opts.maxHops);
  const maxNodes = opts.maxNodes ?? GRAPH_DEFAULT_MAX_NODES;
  const direction = opts.direction ?? "out";
  const edgeTypes = opts.edgeTypes && opts.edgeTypes.length > 0 ? [...opts.edgeTypes] : undefined;

  const base: GraphPathResult = {
    src: from,
    dst: to,
    max_hops: maxHops,
    found: false,
    hops: null,
    nodes: [],
    edges: [],
    visited: 0,
    truncated: false,
  };
  if (from === to) {
    return { ...base, found: true, hops: 0, nodes: [from] };
  }

  const parent = new Map<string, GraphPathEdge>();
  const seen = new Set<string>([from]);
  let frontier: string[] = [from];
  let visited = 0;
  let truncated = false;

  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      visited += 1;
      const neighbors = (await readNeighbors(node, cfg, current, {
        direction,
        ...(edgeTypes ? { edgeTypes } : {}),
      })) ?? [];
      for (const neighbor of neighbors) {
        if (seen.has(neighbor.slug)) continue;
        const edge: GraphPathEdge = {
          from: current,
          to: neighbor.slug,
          type: neighbor.type,
          direction: neighbor.direction,
        };
        parent.set(neighbor.slug, edge);
        if (neighbor.slug === to) {
          const edges = reconstruct(parent, from, to);
          return {
            ...base,
            found: true,
            hops: edges.length,
            nodes: [from, ...edges.map((e) => e.to)],
            edges,
            visited,
            truncated,
          };
        }
        if (seen.size >= maxNodes) {
          truncated = true;
          break;
        }
        seen.add(neighbor.slug);
        next.push(neighbor.slug);
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }
  return { ...base, visited, truncated };
}

function reconstruct(
  parent: ReadonlyMap<string, GraphPathEdge>,
  from: string,
  to: string,
): GraphPathEdge[] {
  const edges: GraphPathEdge[] = [];
  let cursor = to;
  // Bounded by the parent map: every step consumes one entry and the map is
  // acyclic by construction (a node is assigned a parent exactly once).
  while (cursor !== from) {
    const edge = parent.get(cursor);
    if (!edge) break;
    edges.push(edge);
    cursor = edge.from;
  }
  return edges.reverse();
}

// ---------------------------------------------------------------------------
// Integrity lint
// ---------------------------------------------------------------------------

export type GraphLintCode =
  /** An edge points at a slug with no live record of any configured type. */
  | "dangling-target"
  /** An out-edge has no mirrored in-edge row — the phase-1 dual write drifted. */
  | "mirror-missing"
  /** An in-edge row has no mirrored out-edge row. */
  | "mirror-orphan"
  /** src === dst. Always a parse bug or a self-referential body link. */
  | "self-edge";

export type GraphLintFinding = {
  code: GraphLintCode;
  src: string;
  dst: string;
  type: GraphEdgeType;
  detail: string;
};

export type GraphLintResult = {
  /** Source slugs whose edges were actually read. */
  checked: number;
  /** Edges examined across those sources. */
  edges: number;
  findings: GraphLintFinding[];
  /** True when `slugs` was longer than the budget and the tail went unread. */
  truncated: boolean;
  /** Slugs requested but not examined because the budget bound first. */
  skipped: number;
};

export type GraphLintOptions = {
  /** Source slugs to lint. The caller owns how this bounded set was chosen. */
  slugs: readonly string[];
  /** Cap on source slugs examined. Excess is reported, never silently dropped. */
  maxSlugs?: number;
  /**
   * Resolve whether a slug has a live record. Injected so the doctor probe and
   * tests can supply a cheaper or mocked existence oracle. Defaults to a
   * per-type keyed point read across every configured record type.
   */
  recordExists?: (slug: string) => Promise<boolean>;
};

export const GRAPH_LINT_DEFAULT_MAX_SLUGS = 100;

/**
 * Structural lint over a BOUNDED set of source slugs.
 *
 * This deliberately takes its source set from the caller rather than
 * discovering one: there is no scan to enumerate "every record with edges",
 * and inventing one here would smuggle a corpus walk into a health check. The
 * doctor probe seeds it from the keyed type-list index; `reindex` seeds it
 * from the slice it just rebuilt.
 */
export async function lintGraphEdges(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
  opts: GraphLintOptions,
): Promise<GraphLintResult | null> {
  if (graphEdgesUnavailable(cfg)) return null;
  const maxSlugs = opts.maxSlugs ?? GRAPH_LINT_DEFAULT_MAX_SLUGS;
  const requested = [...new Set(opts.slugs.map((s) => normalizeSlug(s).toLowerCase()))].filter(
    (s) => s.length > 0,
  );
  const examined = requested.slice(0, maxSlugs);
  const exists = opts.recordExists ?? defaultRecordExists(node, cfg);

  const findings: GraphLintFinding[] = [];
  const existsCache = new Map<string, boolean>();
  let edges = 0;

  for (const src of examined) {
    const outEdges = (await readGraphEdges(node, cfg, src, "out")) ?? [];
    // The mirror plane is keyed by dst, so verifying "every out-edge has its
    // in-edge twin" needs one keyed read per distinct destination — still no
    // scan, and the cache keeps a hub destination to one read.
    const inboundByDst = new Map<string, GraphEdge[]>();
    for (const edge of outEdges) {
      edges += 1;
      if (edge.src === edge.dst) {
        findings.push({
          code: "self-edge",
          src: edge.src,
          dst: edge.dst,
          type: edge.type,
          detail: "edge points at its own source",
        });
        continue;
      }
      let live = existsCache.get(edge.dst);
      if (live === undefined) {
        // Absence must be PROVEN, never inferred from a failed read. A throwing
        // oracle (node blip, injected stub) resolves to "live" so a transport
        // error can never be rendered as a dangling edge.
        live = await exists(edge.dst).catch(() => true);
        existsCache.set(edge.dst, live);
      }
      if (!live) {
        findings.push({
          code: "dangling-target",
          src: edge.src,
          dst: edge.dst,
          type: edge.type,
          detail: "no live record with this slug",
        });
      }
      let inbound = inboundByDst.get(edge.dst);
      if (inbound === undefined) {
        inbound = (await readGraphEdges(node, cfg, edge.dst, "in")) ?? [];
        inboundByDst.set(edge.dst, inbound);
      }
      const mirrored = inbound.some((m) => m.src === edge.src && m.type === edge.type);
      if (!mirrored) {
        findings.push({
          code: "mirror-missing",
          src: edge.src,
          dst: edge.dst,
          type: edge.type,
          detail: "out-edge has no matching in-edge row",
        });
      }
    }

    // The reverse direction: an in-edge row naming a source that no longer
    // carries the out-edge. Left behind when a delete lands on one plane only.
    const inEdges = (await readGraphEdges(node, cfg, src, "in")) ?? [];
    for (const edge of inEdges) {
      if (edge.src === edge.dst) continue;
      const siblings = (await readGraphEdges(node, cfg, edge.src, "out")) ?? [];
      const mirrored = siblings.some((m) => m.dst === src && m.type === edge.type);
      if (!mirrored) {
        findings.push({
          code: "mirror-orphan",
          src: edge.src,
          dst: src,
          type: edge.type,
          detail: "in-edge row has no matching out-edge row",
        });
      }
    }
  }

  findings.sort(
    (a, b) =>
      a.code.localeCompare(b.code) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
  );
  return {
    checked: examined.length,
    edges,
    findings,
    truncated: requested.length > examined.length,
    skipped: requested.length - examined.length,
  };
}

/**
 * Existence oracle: one keyed point read per configured record type.
 *
 * `resolveBySlug` does the same fan-out for the user-facing commands, but it
 * throws on not-found and on ambiguity. The lint wants a boolean, and an
 * ambiguous slug is emphatically NOT dangling, so this asks the simpler
 * question directly.
 */
function defaultRecordExists(
  node: NodeClient,
  cfg: Pick<Config, "schemaHashes">,
): (slug: string) => Promise<boolean> {
  const types: RecordType[] = RECORD_TYPES.filter(
    (t) => (cfg.schemaHashes as Record<string, string | undefined>)[t] !== undefined,
  );
  // With no record schema configured there is nothing to ask, so the oracle
  // has no opinion. Returning false here would report EVERY edge as dangling
  // on a half-initialised config — a confident wrong answer, and the loudest
  // possible one. Unknown is not absent.
  if (types.length === 0) return async () => true;
  return async (slug: string) => {
    const hits = await Promise.all(
      types.map(async (type) => {
        const hash = (cfg.schemaHashes as Record<string, string | undefined>)[type];
        if (!hash) return false;
        try {
          return (await findBySlug(node, type, hash, slug)) !== null;
        } catch {
          // A read failure is not evidence of absence. Treating it as such
          // would report a live record as dangling on a transient node blip,
          // which is exactly the false alarm a health check must not raise.
          return true;
        }
      }),
    );
    return hits.some(Boolean);
  };
}

/** All edge types, for CLI help and flag validation. */
export const GRAPH_EDGE_TYPE_VALUES: readonly GraphEdgeType[] = GRAPH_EDGE_TYPES;
