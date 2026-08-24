import { describe, expect, test } from "bun:test";
import {
  DOCTOR_GRAPH_LINT_MAX_SLUGS,
  collectGraphLintSeeds,
  runGraphEdgeLintProbe,
} from "../../src/commands/doctor/graph-lint.ts";
import {
  GRAPH_EDGE_IN_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
} from "../../src/schemas.ts";

const OUT = "edge-out";
const IN = "edge-in";

function cfgWithEdges(extra: Record<string, string> = {}) {
  return {
    schemaHashes: {
      [GRAPH_EDGE_OUT_SCHEMA_KEY]: OUT,
      [GRAPH_EDGE_IN_SCHEMA_KEY]: IN,
      ...extra,
    },
  } as any;
}

type EdgeSpec = { src: string; dst: string; type?: string };

function graphNode(edges: readonly EdgeSpec[], opts: { dropFromIn?: EdgeSpec[] } = {}) {
  const rows = edges.map((edge) => ({
    bge_src: edge.src,
    bge_dst: edge.dst,
    bge_type: edge.type ?? "references",
    bge_provenance: "wikilink",
    bge_created_at: "2026-01-01T00:00:00.000Z",
    bge_out_r: `${edge.type ?? "references"}#${edge.dst}`,
    bge_in_r: `${edge.type ?? "references"}#${edge.src}`,
  }));
  const dropped = new Set(
    (opts.dropFromIn ?? []).map((e) => `${e.src}|${e.dst}|${e.type ?? "references"}`),
  );
  return {
    async queryAll({ schemaHash, filter }: any) {
      const key = filter?.HashKey;
      return {
        results: rows
          .filter((f) => (schemaHash === OUT ? f.bge_src === key : f.bge_dst === key))
          .filter((f) =>
            schemaHash === IN ? !dropped.has(`${f.bge_src}|${f.bge_dst}|${f.bge_type}`) : true,
          )
          .map((fields) => ({ fields })),
      };
    },
    // Every seed's destination resolves, so `dangling` never fires unless a
    // test says so. Keyed point read, mirroring findBySlugRaw's shape.
    async queryByKey() {
      return { fields: { slug: "present", tags: "" } };
    },
  } as any;
}

describe("doctor graph-edge-lint probe", () => {
  // Reversed 2026-08-24. The old contract was "a SKIP must stay neutral: an
  // unbuilt graph is not an unhealthy one". On the primary brain that neutral
  // SKIP hid a live defect for a whole phase — the schemas were missing from
  // config, so every `put` parsed its links and wrote no edge, and doctor
  // still printed OK. The schemas ship in the standard init set; absent, they
  // are a fault, not an opt-out.
  test("FAILs, never SKIPs, when the edge schemas are not configured", async () => {
    const check = await runGraphEdgeLintProbe(graphNode([]), { schemaHashes: {} } as any);
    expect(check.name).toBe("graph-edge-lint");
    expect(check.tag).toBe("FAIL");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not in config");
    expect(check.fix).toContain("fbrain init");
  });

  test("PASSes on a consistent graph AND states what it sampled", async () => {
    const check = await runGraphEdgeLintProbe(
      graphNode([{ src: "a", dst: "b" }]),
      cfgWithEdges(),
      undefined,
      { seeds: ["a"] },
    );
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined();
    // The detail must carry the sample size. A bare "0 issues" would read as a
    // corpus-wide guarantee this probe cannot make.
    expect(check.detail).toContain("sampled 1 source(s)");
    expect(check.detail).toContain("both edge planes agree");
  });

  test("FAILs on mirror drift, because traversal answers then depend on direction", async () => {
    const drift = { src: "a", dst: "b", type: "implements" };
    const check = await runGraphEdgeLintProbe(
      graphNode([drift], { dropFromIn: [drift] }),
      cfgWithEdges(),
      undefined,
      { seeds: ["a"] },
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("only one plane");
    expect(check.fix).toContain("reindex --graph-edges");
  });

  test("dangling targets WARN but do not fail the doctor", async () => {
    const node = graphNode([{ src: "a", dst: "ghost" }]);
    // No record resolves, so every destination reads as dangling.
    node.queryByKey = async () => null;
    const check = await runGraphEdgeLintProbe(node, cfgWithEdges({ design: "d-hash" }), undefined, {
      seeds: ["a"],
    });
    expect(check.tag).toBe("WARN");
    // WARN keeps ok:true — dangling wiki-links are intentional in fbrain bodies.
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("dangling target(s)");
  });

  test("PASSes trivially when there is nothing to lint", async () => {
    const check = await runGraphEdgeLintProbe(graphNode([]), cfgWithEdges(), undefined, {
      seeds: [],
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("no records to lint");
  });

  test("SKIPs when no type partition is trustworthy, rather than reporting fake coverage", async () => {
    // readTypeListIndex returns null for an unmarked partition; with no marked
    // partition anywhere there is no honest seed set.
    const node = graphNode([]);
    node.queryAll = async () => ({ results: [] });
    const check = await runGraphEdgeLintProbe(node, cfgWithEdges({ design: "d-hash" }));
    expect(check.tag).toBe("SKIP");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("completeness marker");
  });

  test("the probe's seed cap is small enough to keep doctor interactive", () => {
    expect(DOCTOR_GRAPH_LINT_MAX_SLUGS).toBeLessThanOrEqual(50);
    expect(DOCTOR_GRAPH_LINT_MAX_SLUGS).toBeGreaterThan(0);
  });
});

describe("graph lint seed collection", () => {
  test("returns null when no partition carries the completeness marker", async () => {
    const node = graphNode([]);
    node.queryAll = async () => ({ results: [] });
    expect(await collectGraphLintSeeds(node, cfgWithEdges({ design: "d" }), 10)).toBeNull();
  });
});
