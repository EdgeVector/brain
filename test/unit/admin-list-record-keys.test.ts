import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryRow } from "../../src/client.ts";
import { listRecordsAdminScan } from "../../src/record.ts";

function conceptRow(slug: string): QueryRow {
  return {
    key: { hash: slug, range: null },
    fields: {
      slug,
      title: `Title ${slug}`,
      body: `Body ${slug}`,
      status: "active",
      tags: [],
      created_at: "2026-08-18T00:00:00Z",
      updated_at: "2026-08-18T00:00:00Z",
    },
  };
}

describe("listRecordsAdminScan keys-only drain", () => {
  test("pages /api/list identities and point-gets every live slug", async () => {
    let live = ["alpha", "beta", "gamma"];
    const calls: string[] = [];
    const node = {
      baseUrl: "mock",
      userHash: "u",
      async listRecordKeys(_schemaHash: string, opts?: { cursor?: string }) {
        calls.push(`GET /api/list cursor=${opts?.cursor ?? ""}`);
        const start = opts?.cursor === "after-beta" ? 2 : 0;
        const keys = live.slice(start, start + 2).map((hash) => ({ hash }));
        const hasMore = start + 2 < live.length;
        return { keys, hasMore, nextCursor: hasMore ? "after-beta" : null };
      },
      async queryByKey({ keyHash }: { keyHash: string }) {
        calls.push(`POST /api/query HashKey=${keyHash}`);
        return live.includes(keyHash) ? conceptRow(keyHash) : null;
      },
      async queryAll() {
        throw new Error("full scan must not run");
      },
    } as unknown as NodeClient;

    const first = await listRecordsAdminScan(node, "concept", "concept-hash");
    expect(first.map((record) => record.slug)).toEqual(["alpha", "beta", "gamma"]);
    expect(calls).toEqual([
      "GET /api/list cursor=",
      "POST /api/query HashKey=alpha",
      "POST /api/query HashKey=beta",
      "GET /api/list cursor=after-beta",
      "POST /api/query HashKey=gamma",
    ]);

    live = ["alpha", "gamma"];
    calls.length = 0;
    const afterDelete = await listRecordsAdminScan(node, "concept", "concept-hash");
    expect(afterDelete.map((record) => record.slug)).toEqual(["alpha", "gamma"]);
    expect(calls.every((call) => !call.includes("Allow-Full-Scan"))).toBe(true);
  });
});
