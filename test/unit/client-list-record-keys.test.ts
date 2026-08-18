import { afterEach, describe, expect, test } from "bun:test";

import { newNodeClient } from "../../src/client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("newNodeClient.listRecordKeys", () => {
  test("GETs one keys-only /api/list page without a full-scan header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          ok: true,
          list: {
            keys: [{ hash: "alpha" }, { hash: "beta", range: "r:2" }],
            next_cursor: "cursor/with spaces",
            has_more: true,
            truncated: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const node = newNodeClient({
      baseUrl: "http://10.0.0.1:9001",
      userHash: "u",
    });
    const page = await node.listRecordKeys!("fbrain/Concept", {
      limit: 2,
      cursor: "start/one",
    });

    expect(page).toEqual({
      keys: [{ hash: "alpha" }, { hash: "beta", range: "r:2" }],
      nextCursor: "cursor/with spaces",
      hasMore: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/list");
    expect(url.searchParams.get("schema")).toBe("fbrain/Concept");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("cursor")).toBe("start/one");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.has("X-LastDB-Allow-Full-Scan")).toBe(false);
  });

  test("rejects a truncated page without a continuation cursor", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ list: { keys: [{ hash: "alpha" }], has_more: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const node = newNodeClient({ baseUrl: "http://10.0.0.1:9001", userHash: "u" });
    await expect(node.listRecordKeys!("h")).rejects.toMatchObject({
      code: "list_keys_bad_response",
    });
  });
});
