import { describe, expect, test } from "bun:test";
import {
  extractGraphEdges,
  readGraphEdges,
  reconcileGraphEdges,
} from "../../src/graph-edge.ts";
import {
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
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
  const node = {
    async queryAll({ schemaHash, filter }: any) {
      const hash = filter?.HashKey;
      const result = [...rows.values()].filter((f) =>
        schemaHash === OUT ? f.bge_src === hash : f.bge_dst === hash,
      );
      return { results: result.map((fields) => ({ fields })) };
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
