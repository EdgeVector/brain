import { describe, expect, test } from "bun:test";
import {
  GRAPH_DEFAULT_MAX_HOPS,
  GRAPH_MAX_HOPS_LIMIT,
  findGraphPath,
  graphQuery,
  lintGraphEdges,
  readNeighbors,
  resolveMaxHops,
} from "../../src/graph-traverse.ts";
import {
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
} from "../../src/schemas.ts";

const OUT = "edge-out";
const IN = "edge-in";
const cfg = {
  schemaHashes: {
    [GRAPH_EDGE_OUT_SCHEMA_KEY]: OUT,
    [GRAPH_EDGE_IN_SCHEMA_KEY]: IN,
  },
} as any;

type EdgeSpec = { src: string; dst: string; type?: string };

/**
 * In-memory stand-in for the two keyed edge planes.
 *
 * Mirrors the real substrate's shape: the out-plane is keyed by source and the
 * in-plane by destination, so a test can drop a row from ONE plane and
 * reproduce the exact drift the doctor lint exists to catch.
 */
function graphNode(edges: readonly EdgeSpec[], opts: { dropFromIn?: EdgeSpec[] } = {}) {
  const rows: Array<Record<string, string>> = [];
  for (const edge of edges) {
    rows.push({
      bge_src: edge.src,
      bge_dst: edge.dst,
      bge_type: edge.type ?? "references",
      bge_provenance: "wikilink",
      bge_created_at: "2026-01-01T00:00:00.000Z",
      bge_out_r: `${edge.type ?? "references"}#${edge.dst}`,
      bge_in_r: `${edge.type ?? "references"}#${edge.src}`,
    });
  }
  const dropped = new Set(
    (opts.dropFromIn ?? []).map((e) => `${e.src}|${e.dst}|${e.type ?? "references"}`),
  );
  let reads = 0;
  const node = {
    async queryAll({ schemaHash, filter }: any) {
      reads += 1;
      const key = filter?.HashKey;
      const results = rows
        .filter((f) => (schemaHash === OUT ? f.bge_src === key : f.bge_dst === key))
        .filter((f) =>
          schemaHash === IN ? !dropped.has(`${f.bge_src}|${f.bge_dst}|${f.bge_type}`) : true,
        )
        .map((fields) => ({ fields }));
      return { results };
    },
  };
  return { node: node as any, reads: () => reads };
}

describe("graph neighbors", () => {
  test("returns both directions, labelled, for the same record", async () => {
    const { node } = graphNode([
      { src: "design-a", dst: "task-b", type: "implements" },
      { src: "sop-c", dst: "design-a", type: "references" },
    ]);

    const both = await readNeighbors(node, cfg, "design-a");
    expect(both).not.toBeNull();
    expect(both).toEqual([
      { slug: "sop-c", type: "references", direction: "in", provenance: "wikilink" },
      { slug: "task-b", type: "implements", direction: "out", provenance: "wikilink" },
    ]);
  });

  test("direction narrows the walk to one plane", async () => {
    const { node } = graphNode([
      { src: "design-a", dst: "task-b", type: "implements" },
      { src: "sop-c", dst: "design-a", type: "references" },
    ]);

    const out = await readNeighbors(node, cfg, "design-a", { direction: "out" });
    expect(out?.map((n) => n.slug)).toEqual(["task-b"]);

    const inbound = await readNeighbors(node, cfg, "design-a", { direction: "in" });
    expect(inbound?.map((n) => n.slug)).toEqual(["sop-c"]);
  });

  test("edge-type filter drops non-matching types in both directions", async () => {
    const { node } = graphNode([
      { src: "design-a", dst: "task-b", type: "implements" },
      { src: "design-a", dst: "note-d", type: "mentions" },
      { src: "sop-c", dst: "design-a", type: "mentions" },
    ]);

    const only = await readNeighbors(node, cfg, "design-a", { edgeTypes: ["implements"] });
    expect(only).toEqual([
      { slug: "task-b", type: "implements", direction: "out", provenance: "wikilink" },
    ]);
  });

  test("an unconfigured substrate is null, NOT an empty neighbor list", async () => {
    const { node } = graphNode([{ src: "design-a", dst: "task-b" }]);
    // An isolated record and a graph that was never built are different
    // answers; collapsing them would let the CLI claim "no neighbors" about a
    // record whose edges were never asked for.
    expect(await readNeighbors(node, cfg, "design-a")).not.toBeNull();
    expect(await readNeighbors(node, { schemaHashes: {} } as any, "design-a")).toBeNull();
  });
});

describe("graph path", () => {
  const chain = [
    { src: "a", dst: "b", type: "implements" },
    { src: "b", dst: "c", type: "references" },
    { src: "c", dst: "d", type: "proves" },
  ];

  test("finds a real multi-hop path within the budget", async () => {
    const { node } = graphNode(chain);
    const result = await findGraphPath(node, cfg, "a", "d", { maxHops: 3 });
    expect(result?.found).toBe(true);
    expect(result?.hops).toBe(3);
    expect(result?.nodes).toEqual(["a", "b", "c", "d"]);
    expect(result?.edges.map((e) => e.type)).toEqual(["implements", "references", "proves"]);
  });

  test("hop limit bounds the search and reports not-found instead of walking on", async () => {
    const { node } = graphNode(chain);
    const result = await findGraphPath(node, cfg, "a", "d", { maxHops: 2 });
    expect(result?.found).toBe(false);
    expect(result?.hops).toBeNull();
    expect(result?.nodes).toEqual([]);
    // Not a budget truncation — the hop cap is what the caller asked for.
    expect(result?.truncated).toBe(false);
  });

  test("returns the SHORTEST path when a longer one also exists", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b" },
      { src: "b", dst: "z" },
      { src: "a", dst: "m" },
      { src: "m", dst: "n" },
      { src: "n", dst: "z" },
    ]);
    const result = await findGraphPath(node, cfg, "a", "z", { maxHops: 4 });
    expect(result?.found).toBe(true);
    expect(result?.hops).toBe(2);
    expect(result?.nodes).toEqual(["a", "b", "z"]);
  });

  test("a cycle terminates instead of looping forever", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b" },
      { src: "b", dst: "a" },
    ]);
    const result = await findGraphPath(node, cfg, "a", "missing", { maxHops: GRAPH_MAX_HOPS_LIMIT });
    expect(result?.found).toBe(false);
  });

  test("src === dst is a zero-hop hit, not a search", async () => {
    const { node, reads } = graphNode(chain);
    const result = await findGraphPath(node, cfg, "a", "a");
    expect(result?.found).toBe(true);
    expect(result?.hops).toBe(0);
    expect(result?.nodes).toEqual(["a"]);
    expect(reads()).toBe(0);
  });

  test("direction both walks an edge backwards", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b" },
      { src: "c", dst: "b" },
    ]);
    // a -> b <- c is reachable only if the walk may traverse `b -> c` inbound.
    expect((await findGraphPath(node, cfg, "a", "c", { maxHops: 3 }))?.found).toBe(false);
    expect(
      (await findGraphPath(node, cfg, "a", "c", { maxHops: 3, direction: "both" }))?.found,
    ).toBe(true);
  });
});

describe("hop-limit enforcement", () => {
  test("defaults, and rejects a request above the hard ceiling", () => {
    expect(resolveMaxHops()).toBe(GRAPH_DEFAULT_MAX_HOPS);
    expect(resolveMaxHops(1)).toBe(1);
    expect(resolveMaxHops(GRAPH_MAX_HOPS_LIMIT)).toBe(GRAPH_MAX_HOPS_LIMIT);
    expect(() => resolveMaxHops(GRAPH_MAX_HOPS_LIMIT + 1)).toThrow(/hard limit/);
    expect(() => resolveMaxHops(0)).toThrow(/positive integer/);
    expect(() => resolveMaxHops(2.5)).toThrow(/positive integer/);
  });

  test("query rejects an over-limit hop count rather than silently clamping", async () => {
    const { node } = graphNode([{ src: "a", dst: "b" }]);
    await expect(graphQuery(node, cfg, "a", { maxHops: 99 })).rejects.toThrow(/hard limit/);
  });
});

describe("graph query", () => {
  test("reports depth and the edge that first reached each hit", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b", type: "implements" },
      { src: "b", dst: "c", type: "proves" },
    ]);
    const result = await graphQuery(node, cfg, "a", { maxHops: 2 });
    expect(result?.hits).toEqual([
      { slug: "b", depth: 1, via: { from: "a", to: "b", type: "implements", direction: "out" } },
      { slug: "c", depth: 2, via: { from: "b", to: "c", type: "proves", direction: "out" } },
    ]);
    expect(result?.truncated).toBe(false);
  });

  test("stops at the hop budget", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b" },
      { src: "b", dst: "c" },
      { src: "c", dst: "d" },
    ]);
    const result = await graphQuery(node, cfg, "a", { maxHops: 1 });
    expect(result?.hits.map((h) => h.slug)).toEqual(["b"]);
  });

  test("a capped sweep is marked truncated, never presented as complete", async () => {
    const { node } = graphNode([
      { src: "hub", dst: "n1" },
      { src: "hub", dst: "n2" },
      { src: "hub", dst: "n3" },
      { src: "hub", dst: "n4" },
    ]);
    const result = await graphQuery(node, cfg, "hub", { maxHops: 2, maxNodes: 3 });
    expect(result?.truncated).toBe(true);
    // The budget counts the root, so fewer hits than the four that exist.
    expect(result?.hits.length).toBeLessThan(4);
  });

  test("never revisits a node in a cycle", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b" },
      { src: "b", dst: "c" },
      { src: "c", dst: "a" },
    ]);
    const result = await graphQuery(node, cfg, "a", { maxHops: GRAPH_MAX_HOPS_LIMIT });
    expect(result?.hits.map((h) => h.slug).sort()).toEqual(["b", "c"]);
  });
});

describe("graph edge lint", () => {
  const allLive = async () => true;

  test("clean graph reports no findings and counts what it sampled", async () => {
    const { node } = graphNode([
      { src: "a", dst: "b" },
      { src: "b", dst: "c" },
    ]);
    const result = await lintGraphEdges(node, cfg, {
      slugs: ["a", "b"],
      recordExists: allLive,
    });
    expect(result?.findings).toEqual([]);
    expect(result?.checked).toBe(2);
    expect(result?.edges).toBe(2);
    expect(result?.truncated).toBe(false);
  });

  test("dangling target is reported when the destination has no record", async () => {
    const { node } = graphNode([{ src: "a", dst: "ghost", type: "references" }]);
    const result = await lintGraphEdges(node, cfg, {
      slugs: ["a"],
      recordExists: async (slug) => slug !== "ghost",
    });
    expect(result?.findings).toEqual([
      {
        code: "dangling-target",
        src: "a",
        dst: "ghost",
        type: "references",
        detail: "no live record with this slug",
      },
    ]);
  });

  test("an out-edge missing from the in-plane is caught as mirror drift", async () => {
    // The exact substrate defect the doctor check exists for: the row is
    // readable walking forward and invisible walking backward.
    const drift = { src: "a", dst: "b", type: "implements" };
    const { node } = graphNode([drift], { dropFromIn: [drift] });
    const result = await lintGraphEdges(node, cfg, {
      slugs: ["a"],
      recordExists: allLive,
    });
    const codes = result?.findings.map((f) => f.code);
    expect(codes).toContain("mirror-missing");
  });

  test("a self-edge is reported and does not also count as dangling", async () => {
    const { node } = graphNode([{ src: "a", dst: "a", type: "mentions" }]);
    const result = await lintGraphEdges(node, cfg, {
      slugs: ["a"],
      recordExists: allLive,
    });
    expect(result?.findings.map((f) => f.code)).toEqual(["self-edge"]);
  });

  test("over-budget seed lists report the remainder instead of dropping it", async () => {
    const { node } = graphNode([{ src: "a", dst: "b" }]);
    const result = await lintGraphEdges(node, cfg, {
      slugs: ["a", "b", "c", "d"],
      maxSlugs: 2,
      recordExists: allLive,
    });
    expect(result?.checked).toBe(2);
    expect(result?.truncated).toBe(true);
    expect(result?.skipped).toBe(2);
  });

  test("a read failure in the existence oracle does not become a dangling claim", async () => {
    const { node } = graphNode([{ src: "a", dst: "b" }]);
    const result = await lintGraphEdges(node, cfg, {
      slugs: ["a"],
      recordExists: async () => {
        throw new Error("node blip");
      },
    });
    // The oracle threw; the lint must not report "no live record" on the
    // strength of a transport error.
    expect(result?.findings.filter((f) => f.code === "dangling-target")).toEqual([]);
  });

  test("returns null when the edge schemas are not configured", async () => {
    const { node } = graphNode([{ src: "a", dst: "b" }]);
    expect(
      await lintGraphEdges(node, { schemaHashes: {} } as any, { slugs: ["a"] }),
    ).toBeNull();
  });
});
