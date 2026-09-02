import { describe, expect, test } from "bun:test";
import {
  extractGraphEdges,
  maintainGraphEdges,
  readGraphEdges,
  readGraphEdgesDetailed,
  reconcileGraphEdges,
  resetGraphEdgeInertNotice,
} from "../../src/graph-edge.ts";
import {
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_NEIGHBOR_FIELDS,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
  GRAPH_EDGE_RECONCILE_FIELDS,
  graphEdgeInSchema,
  graphEdgeOutSchema,
} from "../../src/schemas.ts";
import { GRAPH_EDGE_BACKFILL_CAVEAT } from "../../src/commands/reindex.ts";

const OUT = "edge-out";
const IN = "edge-in";
const cfg = {
  schemaHashes: {
    [GRAPH_EDGE_OUT_SCHEMA_KEY]: OUT,
    [GRAPH_EDGE_IN_SCHEMA_KEY]: IN,
  },
};

function foldedNode() {
  const rows = new Map<string, Record<string, unknown>>();
  const lastQueries: Array<{ schemaHash: string; fields: string[]; filter: unknown }> = [];
  const node = {
    lastQueries,
    async queryAll({ schemaHash, fields, filter }: any) {
      lastQueries.push({ schemaHash, fields: [...(fields ?? [])], filter });
      const hash = filter?.HashKey;
      const result = [...rows.values()].filter((f) =>
        schemaHash === OUT ? f.bge_src === hash : f.bge_dst === hash,
      );
      return { results: result.map((rowFields) => ({ fields: rowFields })) };
    },
    async createRecord({ fields }: any) {
      rows.set(`${fields.bge_src}|${fields.bge_out_r}`, fields);
    },
    async updateRecord({ fields }: any) {
      rows.set(`${fields.bge_src}|${fields.bge_out_r}`, fields);
    },
    async deleteRecord({ keyHash, keyRange }: any) {
      rows.delete(`${keyHash}|${keyRange}`);
    },
  };
  return { node: node as any, rows };
}

describe("graph edge extraction", () => {
  test("source and destination schemas are same-product protein siblings", () => {
    expect(graphEdgeOutSchema.schema.fields).toEqual(graphEdgeInSchema.schema.fields);
    expect(graphEdgeOutSchema.schema.key).toEqual({ hash_field: "bge_src", range_field: "bge_out_r" });
    expect(graphEdgeInSchema.schema.key).toEqual({ hash_field: "bge_dst", range_field: "bge_in_r" });
    expect(GRAPH_EDGE_BACKFILL_CAVEAT).toContain("known to under-report");
    expect(GRAPH_EDGE_BACKFILL_CAVEAT).toContain("not proof of complete corpus coverage");
  });
  test("parses typed, bare, frontmatter, and unknown fallback edges", () => {
    expect(
      extractGraphEdges({
        sourceSlug: "source",
        body: "[[implements::Design-A]] [[plain-note]] [[surprises::target-b]]",
        frontmatterEdges: ["blocks::task-c"],
        now: "2026-08-18T00:00:00Z",
      }).map(({ type, dst, provenance }) => ({ type, dst, provenance })),
    ).toEqual([
      { type: "blocks", dst: "task-c", provenance: "frontmatter" },
      { type: "implements", dst: "design-a", provenance: "explicit" },
      { type: "mentions", dst: "plain-note", provenance: "wikilink" },
      { type: "mentions", dst: "target-b", provenance: "explicit" },
    ]);
  });

  test("one source write is addressable from both protein-folded directions", async () => {
    const { node } = foldedNode();
    await reconcileGraphEdges({
      node,
      cfg: cfg as any,
      sourceSlug: "source",
      body: "[[implements::design-brain-knowledge-graph]] [[odd::fallback-target]]",
      now: "2026-08-18T00:00:00Z",
    });
    expect(
      (await readGraphEdges(node, cfg as any, "source", "out"))?.map(
        (edge) => `${edge.type}:${edge.dst}`,
      ),
    ).toEqual([
      "implements:design-brain-knowledge-graph",
      "mentions:fallback-target",
    ]);
    expect(
      (await readGraphEdges(node, cfg as any, "design-brain-knowledge-graph", "in"))?.map(
        (edge) => edge.src,
      ),
    ).toEqual(["source"]);
  });
});

describe("maintainGraphEdges on an unconfigured substrate", () => {
  const inertCfg = { schemaHashes: {} } as any;

  function collectWarnings() {
    const lines: string[] = [];
    return { lines, warn: (line: string) => lines.push(line) };
  }

  test("says the links were parsed and dropped, instead of returning 0 in silence", async () => {
    resetGraphEdgeInertNotice();
    const { lines, warn } = collectWarnings();
    const result = await maintainGraphEdges({
      node: foldedNode().node,
      cfg: inertCfg,
      sourceSlug: "source",
      body: "[[implements::design-brain-knowledge-graph]] and [[references::other]]",
      warn,
    });
    expect(result).toMatchObject({
      edges: 0,
      graphEdgeIndexFailed: false,
      substrateInert: true,
      droppedLinks: 2,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("INERT");
    expect(lines[0]).toContain("2 link(s)");
    expect(lines[0]).toContain("fbrain init");
  });

  test("warns once per process, so a backfill does not repeat it per record", async () => {
    resetGraphEdgeInertNotice();
    const { lines, warn } = collectWarnings();
    for (const slug of ["one", "two", "three"]) {
      await maintainGraphEdges({
        node: foldedNode().node,
        cfg: inertCfg,
        sourceSlug: slug,
        body: "[[references::target]]",
        warn,
      });
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("one");
  });

  test("stays quiet for a body with no links — nothing was dropped", async () => {
    resetGraphEdgeInertNotice();
    const { lines, warn } = collectWarnings();
    const result = await maintainGraphEdges({
      node: foldedNode().node,
      cfg: inertCfg,
      sourceSlug: "source",
      body: "a body that carries no wiki-links at all",
      warn,
    });
    expect(result).toMatchObject({ substrateInert: true, droppedLinks: 0 });
    expect(lines).toEqual([]);
  });

  test("reports a live substrate as not inert, and writes the edges", async () => {
    resetGraphEdgeInertNotice();
    const { lines, warn } = collectWarnings();
    const { node } = foldedNode();
    const result = await maintainGraphEdges({
      node,
      cfg: cfg as any,
      sourceSlug: "source",
      body: "[[implements::design-brain-knowledge-graph]]",
      warn,
    });
    expect(result).toMatchObject({ edges: 1, substrateInert: false, droppedLinks: 0 });
    expect(lines).toEqual([]);
  });
});

describe("readGraphEdges against a node whose HashKey filter does not pick the index", () => {
  // The real primary brain, measured 2026-08-24: both plane hashes answer the
  // same HashKey with the same union of rows, because the two planes are one
  // product under two indexes. This fixture reproduces that exactly — unlike
  // `foldedNode`, which is stricter than the node it stands in for.
  function unionNode(rows: readonly Record<string, unknown>[]) {
    return {
      async queryAll({ filter }: any) {
        const key = filter?.HashKey;
        return {
          results: rows
            .filter((f) => f.bge_src === key || f.bge_dst === key)
            .map((fields) => ({ fields })),
        };
      },
    } as any;
  }

  const row = (src: string, dst: string, type: string) => ({
    bge_src: src,
    bge_dst: dst,
    bge_type: type,
    bge_provenance: "explicit",
    bge_created_at: "2026-08-24T00:00:00.000Z",
    bge_out_r: `${type}#${dst}`,
    bge_in_r: `${type}#${src}`,
  });

  const rows = [
    row("octopus-design", "octopus-decision", "decided-in"),
    row("octopus-task", "octopus-design", "implements"),
    row("octopus-proof", "octopus-design", "proves"),
  ];

  test("an out read returns only edges leaving the slug", async () => {
    const edges = await readGraphEdges(unionNode(rows), cfg as any, "octopus-design", "out");
    expect(edges?.map((e) => `${e.type}:${e.dst}`)).toEqual(["decided-in:octopus-decision"]);
  });

  test("an in read returns only edges arriving at the slug", async () => {
    const edges = await readGraphEdges(unionNode(rows), cfg as any, "octopus-design", "in");
    expect(edges?.map((e) => `${e.type}:${e.src}`)).toEqual([
      "implements:octopus-task",
      "proves:octopus-proof",
    ]);
  });

  test("the slug never appears as its own neighbour", async () => {
    for (const direction of ["out", "in"] as const) {
      const edges = await readGraphEdges(unionNode(rows), cfg as any, "octopus-design", direction);
      const neighbours = edges?.map((e) => (direction === "out" ? e.dst : e.src)) ?? [];
      expect(neighbours).not.toContain("octopus-design");
    }
  });

  test("droppedOwns counts union rows the owns predicate drops", async () => {
    const detailed = await readGraphEdgesDetailed(
      unionNode(rows),
      cfg as any,
      "octopus-design",
      "out",
    );
    expect(detailed.edges).toHaveLength(1);
    expect(detailed.droppedOwns).toBe(2);
  });
});

describe("graph-edge neighbor vs reconcile field lists", () => {
  test("neighbor HashKey omits range keys and created_at", async () => {
    const { node } = foldedNode();
    await reconcileGraphEdges({
      node,
      cfg: cfg as any,
      sourceSlug: "source",
      body: "[[implements::design-a]]",
      now: "2026-08-18T00:00:00Z",
    });
    node.lastQueries.length = 0;
    await readGraphEdges(node, cfg as any, "source", "out");
    expect(node.lastQueries).toHaveLength(1);
    expect(node.lastQueries[0]!.filter).toEqual({ HashKey: "source" });
    expect(node.lastQueries[0]!.fields).toEqual([...GRAPH_EDGE_NEIGHBOR_FIELDS]);
    expect(node.lastQueries[0]!.fields).not.toContain("bge_out_r");
    expect(node.lastQueries[0]!.fields).not.toContain("bge_in_r");
    expect(node.lastQueries[0]!.fields).not.toContain("bge_created_at");
  });

  test("reconcile HashKey includes created_at so a second put keeps the timestamp", async () => {
    const { node } = foldedNode();
    await reconcileGraphEdges({
      node,
      cfg: cfg as any,
      sourceSlug: "source",
      body: "[[implements::design-a]]",
      now: "2026-08-18T00:00:00Z",
    });
    node.lastQueries.length = 0;
    await reconcileGraphEdges({
      node,
      cfg: cfg as any,
      sourceSlug: "source",
      body: "[[implements::design-a]]",
      now: "2026-09-02T00:00:00Z",
    });
    expect(node.lastQueries[0]!.fields).toEqual([...GRAPH_EDGE_RECONCILE_FIELDS]);
    expect(node.lastQueries[0]!.fields).toContain("bge_created_at");
    expect(node.lastQueries[0]!.filter).toEqual({ HashKey: "source" });
    const edges = await readGraphEdges(node, cfg as any, "source", "out", {
      fields: GRAPH_EDGE_RECONCILE_FIELDS,
    });
    expect(edges?.[0]?.created_at).toBe("2026-08-18T00:00:00Z");
  });
});
