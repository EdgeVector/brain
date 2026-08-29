import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../../src/client.ts";
import { GRAPH_EDGE_OUT_SCHEMA_KEY } from "../../src/schemas.ts";
import {
  buildResidentWritePlan,
  recordFromPrimaryFields,
} from "../../src/resident-write-plan.ts";
import { TEST_HASHES, TEST_GRAPH_EDGE_OUT_HASH, buildTestCfg } from "../util.ts";

function mockNode(): NodeClient {
  return {
    baseUrl: "http://10.0.0.1:9001",
    userHash: "uh",
    queryAll: async () => ({ ok: true, results: [] }),
    queryByKey: async () => null,
  } as unknown as NodeClient;
}

describe("buildResidentWritePlan", () => {
  test("one create plan holds primary, list, tag, and graph ops", async () => {
    const cfg = buildTestCfg();
    const fields = {
      slug: "resident-plan",
      title: "Plan",
      body: "See [[other-note]].",
      status: "active",
      tags: ["alpha"],
      created_at: "2026-08-29T00:00:00.000Z",
      updated_at: "2026-08-29T00:00:00.000Z",
    };
    const next = recordFromPrimaryFields(fields);
    const plan = await buildResidentWritePlan({
      node: mockNode(),
      cfg,
      type: "concept",
      schemaHash: TEST_HASHES.concept,
      previous: null,
      next,
      primaryFields: fields,
    });
    expect(plan.action).toBe("created");
    const primary = plan.ops.find((op) => op.projection === "primary");
    expect(primary?.mutationType).toBe("create");
    expect(primary?.schemaHash).toBe(TEST_HASHES.concept);
    expect(plan.ops.some((op) => op.projection === "list")).toBe(true);
    expect(plan.ops.some((op) => op.projection === "tag")).toBe(true);
    const graph = plan.ops.filter((op) => op.projection === "graph");
    expect(graph).toHaveLength(1);
    expect(graph[0]?.schemaHash).toBe(
      cfg.schemaHashes[GRAPH_EDGE_OUT_SCHEMA_KEY] ?? TEST_GRAPH_EDGE_OUT_HASH,
    );
    expect(graph[0]?.keyRange).toBe("mentions#other-note");
    expect(plan.ops.some((op) => op.projection === "lifecycle")).toBe(false);
  });

  test("retained graph edge is a no-op and a dropped edge is a delete", async () => {
    const cfg = buildTestCfg();
    const previous = recordFromPrimaryFields({
      slug: "resident-plan",
      title: "Plan",
      body: "See [[keep]] and [[drop]].",
      status: "active",
      tags: [],
      created_at: "2026-08-29T00:00:00.000Z",
      updated_at: "2026-08-29T00:00:00.000Z",
    });
    const next = recordFromPrimaryFields({
      slug: "resident-plan",
      title: "Plan",
      body: "See [[keep]].",
      status: "active",
      tags: [],
      created_at: previous.created_at,
      updated_at: "2026-08-29T01:00:00.000Z",
    });
    const plan = await buildResidentWritePlan({
      node: mockNode(),
      cfg,
      type: "concept",
      schemaHash: TEST_HASHES.concept,
      previous,
      next,
      primaryFields: {
        slug: next.slug,
        title: next.title,
        body: next.body,
        status: next.status,
        tags: next.tags,
        created_at: next.created_at,
        updated_at: next.updated_at,
      },
    });
    const graph = plan.ops.filter((op) => op.projection === "graph");
    expect(graph.some((op) => op.keyRange === "mentions#keep")).toBe(false);
    const dropped = graph.find((op) => op.keyRange === "mentions#drop");
    expect(dropped?.mutationType).toBe("delete");
  });
});
