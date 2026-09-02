import { afterEach, describe, expect, test } from "bun:test";

import { newNodeClient, type BatchMutationOp } from "../../src/client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const OPS: BatchMutationOp[] = [
  {
    mutationType: "create",
    schemaHash: "schema-primary",
    keyHash: "note",
    fields: { slug: "note" },
  },
  {
    mutationType: "update",
    schemaHash: "schema-list",
    keyHash: "concept",
    keyRange: "note",
    fields: { slug: "note" },
  },
];

describe("newNodeClient mutateBatch durability", () => {
  test("sets public durability on every operation and parses durable receipt", async () => {
    let calls = 0;
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls++;
      request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          mutation_ids: ["m1", "m2"],
          count: 2,
          background_tasks_drained: false,
          convergence_pending: true,
          durability: "durable",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const node = newNodeClient({ baseUrl: "http://node.test", userHash: "u" });
    const receipt = await node.mutateBatch!(OPS, { durability: "durable" });

    expect(calls).toBe(1);
    const mutations = request?.mutations as Record<string, unknown>[];
    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) {
      expect(mutation.durability).toBe("durable");
      expect(mutation).not.toHaveProperty("synchronous");
    }
    expect(request).not.toHaveProperty("synchronous");
    expect(receipt.durability).toBe("durable");
  });

  test("default request omits durability and parses queued receipt", async () => {
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          mutation_ids: ["m1", "m2"],
          count: 2,
          background_tasks_drained: false,
          convergence_pending: true,
          durability: "queued",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const node = newNodeClient({ baseUrl: "http://node.test", userHash: "u" });
    const receipt = await node.mutateBatch!(OPS);

    const mutations = request?.mutations as Record<string, unknown>[];
    for (const mutation of mutations) {
      expect(mutation).not.toHaveProperty("durability");
      expect(mutation).not.toHaveProperty("synchronous");
    }
    expect(receipt.durability).toBe("queued");
  });

  test("durable request does not retry a transport attestation rejection", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: "transport_not_attested" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const node = newNodeClient({ baseUrl: "http://node.test", userHash: "u" });
    await expect(
      node.mutateBatch!(OPS, { durability: "durable" }),
    ).rejects.toMatchObject({ code: "transport_not_attested" });
    expect(calls).toBe(1);
  });
});
