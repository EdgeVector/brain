// Unit tests for the MCP read-server tool handlers (fbrain_search,
// fbrain_get, fbrain_list). We construct the McpServer, then call the
// underlying handler captured at registration time via a small probe.
//
// Like the existing search/get/list tests, fetch is mocked so we don't
// stand up a real node.

import { afterEach, describe, expect, test } from "bun:test";

import { createFbrainMcpServer } from "../../src/mcp/server.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;

const cfg = buildTestCfg({ userHash: "test-hash" });

const realFetch = globalThis.fetch;

type MockResponse = { status: number; body?: unknown };

function installMock(handler: (url: string, init?: RequestInit) => MockResponse): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const next = handler(url, init);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// The McpServer exposes registered tools via a private map but also lets
// us invoke each tool's `callback` through the public registration return
// value. We grab those callbacks via a thin reflective probe — the
// alternative (driving the whole MCP RPC layer) adds a lot of surface
// without exercising any more of our code.
type ToolCallback = (
  args: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function toolsOf(server: ReturnType<typeof createFbrainMcpServer>): Record<string, ToolCallback> {
  const map = (server as unknown as { _registeredTools: Record<string, { handler: ToolCallback }> })
    ._registeredTools;
  const out: Record<string, ToolCallback> = {};
  for (const [name, t] of Object.entries(map)) out[name] = t.handler;
  return out;
}

function recordRow(slug: string, title = `T-${slug}`) {
  return {
    fields: {
      slug,
      title,
      body: "body text",
      status: "draft",
      tags: ["x"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
    key: { hash: slug, range: null },
  };
}

describe("fbrain_search tool", () => {
  test("returns slug+score+type+title in a single text content block", async () => {
    installMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                schema_name: DESIGN_HASH,
                schema_display_name: "Design",
                field: "body",
                key_value: { hash: "alpha", range: null },
                value: "fragment",
                metadata: { score: 0.42, match_type: "semantic" },
              },
            ],
          },
        };
      }
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow("alpha", "Alpha design")] } };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_search!({ query: "blueberry" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);
    expect(res.content[0]!.type).toBe("text");
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("alpha");
    expect(text).toContain("0.420");
    expect(text).toContain("Design");
    expect(text).toContain("Alpha design");
  });

  test("passes limit and exact through to the underlying client", async () => {
    let capturedUrl = "";
    installMock((url) => {
      if (url.includes("/api/native-index/search")) {
        capturedUrl = url;
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_search!({
      query: "blue",
      exact: true,
      min_score: 0.6,
      limit: 5,
    });
    expect(capturedUrl).toContain("exact=true");
    expect(capturedUrl).toContain("min_score=0.6");
    expect(res.content[0]!.text).toContain("no matches");
  });

  test("returns isError=true when the node call fails", async () => {
    installMock(() => ({
      status: 503,
      body: { error: "node_not_provisioned", message: "node not set up" },
    }));
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_search!({ query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("error:");
  });
});

describe("fbrain_get tool", () => {
  test("returns a single record formatted for display", async () => {
    let queryCount = 0;
    installMock((url) => {
      if (url.includes("/api/query")) {
        queryCount += 1;
        // First registered type is `design` — return the record there,
        // empty for everything else, to mirror real multi-type search.
        if (queryCount === 1) {
          return { status: 200, body: { ok: true, results: [recordRow("alpha", "Alpha")] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_get!({ slug: "alpha", type: "design" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("[design] alpha");
    expect(text).toContain("title:      Alpha");
    expect(text).toContain("status:     draft");
  });

  test("returns isError when slug is not found", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_get!({ slug: "ghost", type: "design" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("No design: ghost");
  });
});

describe("fbrain_list tool", () => {
  test("lists records of the requested type", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [recordRow("a", "A"), recordRow("b", "B")],
          },
        };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_list!({ type: "design", limit: 5 });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("design");
    expect(text).toContain("a");
    expect(text).toContain("b");
  });

  test("filters by tag", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        const rows = [
          {
            fields: {
              slug: "a",
              title: "A",
              body: "",
              status: "draft",
              tags: ["wanted"],
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            key: { hash: "a", range: null },
          },
          {
            fields: {
              slug: "b",
              title: "B",
              body: "",
              status: "draft",
              tags: ["other"],
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            key: { hash: "b", range: null },
          },
        ];
        return { status: 200, body: { ok: true, results: rows } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_list!({ type: "design", tag: "wanted" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("a");
    expect(text).not.toContain(" b ");
  });

  test("handles empty result set with '(empty)' placeholder when no records match", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_list!({ type: "design" });
    expect(res.isError).toBeFalsy();
    // listCmd prints "no records" when the result is empty; the MCP
    // wrapper passes that through verbatim.
    expect(res.content[0]!.text).toBe("no records");
  });
});

describe("createFbrainMcpServer", () => {
  test("registers exactly the 3 read tools", () => {
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    expect(Object.keys(tools).sort()).toEqual([
      "fbrain_get",
      "fbrain_list",
      "fbrain_search",
    ]);
  });
});
