import { describe, expect, test } from "bun:test";

import { FbrainError, type NodeClient } from "../../src/client.ts";
import {
  GRAPH_EDGE_OUT_SCHEMA_KEY,
  PAPERCUT_STATUS_INDEX_SCHEMA_KEY,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
} from "../../src/schemas.ts";
import {
  buildResidentWritePlan,
  commitResidentWritePlan,
  recordFromPrimaryFields,
} from "../../src/resident-write-plan.ts";
import {
  TEST_HASHES,
  TEST_GRAPH_EDGE_OUT_HASH,
  TEST_RECORD_LIST_ENTRY_HASH,
  buildTestCfg,
} from "../util.ts";

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

  test("a papercut transition repairs exact list and status rows in the resident batch", async () => {
    const papercutStatusHash = "3".repeat(64);
    const cfg = buildTestCfg({
      schemaHashes: {
        ...TEST_HASHES,
        [RECORD_LIST_ENTRY_SCHEMA_KEY]: TEST_RECORD_LIST_ENTRY_HASH,
        [PAPERCUT_STATUS_INDEX_SCHEMA_KEY]: papercutStatusHash,
      },
    });
    const previous = recordFromPrimaryFields({
      slug: "index-repair",
      title: "Index repair",
      body: "Evidence",
      status: "open",
      tags: [],
      component: "brain",
      severity: "p1",
      kind: "recurring",
      created_at: "2026-08-29T00:00:00.000Z",
      updated_at: "2026-08-29T00:00:00.000Z",
    });
    const next = {
      ...previous,
      status: "verified",
      updated_at: "2026-08-29T01:00:00.000Z",
    };
    const node = {
      ...mockNode(),
      queryAll: async ({
        schemaHash,
        filter,
      }: {
        schemaHash: string;
        filter?: {
          HashRangeKey?: { hash: string; range: string };
        };
      }) => ({
        ok: true,
        results:
          schemaHash === papercutStatusHash &&
          filter?.HashRangeKey?.hash === "verified" &&
          filter.HashRangeKey.range === next.slug
            ? [
                {
                  fields: { psi_h: "verified", psi_r: next.slug },
                  key: { hash: "verified", range: next.slug },
                },
              ]
            : [],
      }),
    } as unknown as NodeClient;
    const primaryFields = {
      slug: next.slug,
      title: next.title,
      body: next.body,
      status: next.status,
      tags: next.tags,
      component: "brain",
      severity: "p1",
      kind: "recurring",
      created_at: next.created_at,
      updated_at: next.updated_at,
    };
    const plan = await buildResidentWritePlan({
      node,
      cfg,
      type: "papercut",
      schemaHash: TEST_HASHES.papercut,
      previous,
      next,
      primaryFields,
    });
    expect(
      plan.ops.find((op) => op.projection === "primary")?.mutationType,
    ).toBe("update");
    expect(
      plan.ops.find((op) => op.projection === "list")?.mutationType,
    ).toBe("create");
    expect(
      plan.ops.find(
        (op) =>
          op.projection === "papercut-status" && op.keyHash === "open",
      )?.mutationType,
    ).toBe("delete");
    expect(
      plan.ops.find(
        (op) =>
          op.projection === "papercut-status" && op.keyHash === "verified",
      )?.mutationType,
    ).toBe("update");
  });

  test("resident commit wraps a batch rejection with exact projection context", async () => {
    const node = {
      ...mockNode(),
      mutateBatch: async () => {
        throw new Error("batch rejected");
      },
    } as unknown as NodeClient;
    try {
      await commitResidentWritePlan({
        node,
        type: "papercut",
        slug: "index-repair",
        plan: {
          action: "updated",
          counts: { created: 0, updated: 1, deleted: 0, no_op: 0 },
          ops: [
            {
              mutationType: "update",
              schemaHash: TEST_HASHES.papercut,
              keyHash: "index-repair",
              fields: {},
              projection: "primary",
            },
          ],
        },
      });
      throw new Error("expected resident commit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FbrainError);
      expect((error as FbrainError).code).toBe("resident_commit_failed");
      expect((error as Error).message).toContain("projections: primary");
    }
  });

  test("durable resident commit makes one batch call and accepts exact durable", async () => {
    const calls: unknown[][] = [];
    const node = {
      ...mockNode(),
      mutateBatch: async (...args: Parameters<NonNullable<NodeClient["mutateBatch"]>>) => {
        calls.push(args);
        return {
          mutationIds: ["m1"],
          count: 1,
          backgroundTasksDrained: false,
          convergencePending: true,
          durability: "durable" as const,
        };
      },
    } as NodeClient;
    const receipt = await commitResidentWritePlan({
      node,
      type: "concept",
      slug: "durable-note",
      durable: true,
      plan: {
        action: "created",
        counts: { created: 1, updated: 0, deleted: 0, no_op: 0 },
        ops: [
          {
            mutationType: "create",
            schemaHash: TEST_HASHES.concept,
            keyHash: "durable-note",
            fields: {},
            projection: "primary",
          },
        ],
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ durability: "durable" });
    expect(receipt.durability).toBe("durable");
  });

  for (const durability of ["queued", undefined] as const) {
    test(`durable resident commit rejects ${durability ?? "missing"} without a retry`, async () => {
      let calls = 0;
      const node = {
        ...mockNode(),
        mutateBatch: async () => {
          calls++;
          return {
            mutationIds: ["m1"],
            count: 1,
            backgroundTasksDrained: true,
            convergencePending: false,
            ...(durability ? { durability } : {}),
          };
        },
      } as NodeClient;

      await expect(
        commitResidentWritePlan({
          node,
          type: "concept",
          slug: "durable-note",
          durable: true,
          plan: {
            action: "created",
            counts: { created: 1, updated: 0, deleted: 0, no_op: 0 },
            ops: [
              {
                mutationType: "create",
                schemaHash: TEST_HASHES.concept,
                keyHash: "durable-note",
                fields: {},
                projection: "primary",
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: "durability_not_confirmed" });
      expect(calls).toBe(1);
    });
  }
});
