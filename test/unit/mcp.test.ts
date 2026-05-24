// Unit tests for the MCP server tool handlers — read (fbrain_search,
// fbrain_get, fbrain_list) and write (fbrain_put, fbrain_delete,
// fbrain_link). We construct the McpServer, then call the underlying
// handler captured at registration time via a small probe.
//
// Like the existing search/get/list/put tests, fetch is mocked so we
// don't stand up a real node.

import { afterEach, describe, expect, test } from "bun:test";

import { buildPutInput, createFbrainMcpServer } from "../../src/mcp/server.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
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

describe("buildPutInput", () => {
  test("synthesizes frontmatter with type, title, tags when none of frontmatter is passed", () => {
    const input = buildPutInput({
      slug: "x",
      type: "concept",
      title: "Hello",
      tags: ["a", "b"],
      body: "the body",
    });
    expect(input).toBe("---\ntype: concept\ntitle: Hello\ntags: [a, b]\n---\nthe body");
  });

  test("defaults type to design when omitted", () => {
    const input = buildPutInput({ slug: "x" });
    expect(input.startsWith("---\ntype: design\n---")).toBe(true);
  });

  test("quotes scalar values that contain YAML-significant characters", () => {
    const input = buildPutInput({
      slug: "x",
      title: 'Has "quotes" and: colon',
      tags: ["has, comma", "ok-tag"],
    });
    expect(input).toContain('title: "Has \\"quotes\\" and: colon"');
    expect(input).toContain('tags: ["has, comma", ok-tag]');
  });

  test("raw frontmatter passthrough overrides synthesis", () => {
    const input = buildPutInput({
      slug: "x",
      type: "concept",
      title: "Ignored",
      frontmatter: "type: preference\ntitle: From Raw",
      body: "body",
    });
    expect(input).toBe("---\ntype: preference\ntitle: From Raw\n---\nbody");
  });

  test("empty body is preserved", () => {
    const input = buildPutInput({ slug: "x", type: "design", title: "T" });
    expect(input.endsWith("---\n")).toBe(true);
  });

  test("empty frontmatter passthrough strips the fences and just returns body", () => {
    expect(buildPutInput({ slug: "x", frontmatter: "", body: "raw" })).toBe("raw");
  });
});

describe("fbrain_put tool", () => {
  test("synthesizes frontmatter from args and creates a record", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_put!({
      slug: "ask-test",
      type: "concept",
      body: "hello world from MCP",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe("created concept ask-test");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("create");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.slug).toBe("ask-test");
    expect(fields.body).toBe("hello world from MCP");
    expect(fields.kind).toBe("concept");
  });

  test("raw frontmatter passthrough wins over title/tags args", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    await tools.fbrain_put!({
      slug: "raw-fm",
      title: "Ignored",
      frontmatter: "type: preference\ntitle: From Raw\ntags: [from-raw]",
      body: "raw body",
    });
    expect(mutations).toHaveLength(1);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.title).toBe("From Raw");
    expect(fields.tags).toEqual(["from-raw"]);
    expect(fields.kind).toBe("preference");
  });

  test("status arg fires a follow-up status update after the put", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    let queryCount = 0;
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCount += 1;
        // First query: pre-put existence check (empty).
        // Second query: status command's findBySlug for the just-created record.
        if (queryCount === 1) return { status: 200, body: { ok: true, results: [] } };
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                fields: {
                  slug: "with-status",
                  title: "T",
                  body: "b",
                  status: "draft",
                  tags: [],
                  kind: null,
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                },
                key: { hash: "with-status", range: null },
              },
            ],
          },
        };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_put!({
      slug: "with-status",
      type: "design",
      title: "T",
      body: "b",
      status: "reviewed",
    });
    expect(res.isError).toBeFalsy();
    // Two mutations: the put's create, then the status update.
    expect(mutations.length).toBe(2);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[1]!.mutation_type).toBe("update");
    const updatedFields = mutations[1]!.fields_and_values as Record<string, unknown>;
    expect(updatedFields.status).toBe("reviewed");
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("created design with-status");
    expect(text).toContain("design with-status: draft → reviewed");
  });

  test("invalid status arg errors and surfaces through MCP isError", async () => {
    let queryCount = 0;
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCount += 1;
        if (queryCount === 1) return { status: 200, body: { ok: true, results: [] } };
        // The status command's findBySlug needs to see the record.
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                fields: {
                  slug: "bad-status",
                  title: "T",
                  body: "b",
                  status: "draft",
                  tags: [],
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                },
                key: { hash: "bad-status", range: null },
              },
            ],
          },
        };
      }
      if (url.endsWith("/api/mutation")) return { status: 200, body: { ok: true } };
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_put!({
      slug: "bad-status",
      type: "design",
      body: "b",
      status: "totally-made-up",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("not a valid design status");
  });

  test("invalid slug errors before any HTTP traffic", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_put!({ slug: "Bad Slug", type: "design", body: "b" });
    expect(res.isError).toBe(true);
    expect(touched).toBe(false);
  });
});

describe("fbrain_delete tool", () => {
  test("happy path on design — fires update with tombstone tag, verifies, prints success", async () => {
    let queryCount = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== TEST_HASHES.design) {
          return { status: 200, body: { ok: true, results: [] } };
        }
        queryCount += 1;
        if (queryCount === 1) {
          return {
            status: 200,
            body: {
              ok: true,
              results: [
                {
                  fields: {
                    slug: "doomed",
                    title: "alive",
                    body: "b",
                    status: "draft",
                    tags: [],
                    created_at: "2026-05-01T00:00:00Z",
                    updated_at: "2026-05-01T00:00:00Z",
                  },
                  key: { hash: "doomed", range: null },
                },
              ],
            },
          };
        }
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              {
                fields: {
                  slug: "doomed",
                  title: "(deleted)",
                  body: "",
                  status: "archived",
                  tags: [TOMBSTONE_TAG],
                  created_at: "2026-05-01T00:00:00Z",
                  updated_at: "2026-05-23T10:00:00Z",
                },
                key: { hash: "doomed", range: null },
              },
            ],
          },
        };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true, success: true } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_delete!({ slug: "doomed", type: "design" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text ?? "").toContain("deleted design doomed");
    // update + delete mutations.
    expect(mutations.map((m) => m.mutation_type)).toEqual(["update", "delete"]);
  });

  test("missing slug surfaces not_found via isError", async () => {
    installMock(() => ({ status: 200, body: { ok: true, results: [] } }));
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_delete!({ slug: "ghost", type: "design" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("No design: ghost");
  });
});

describe("fbrain_link tool", () => {
  test("happy path — task → design fires an update on the task with design_slug set", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === TEST_HASHES.task) {
          return {
            status: 200,
            body: {
              ok: true,
              results: [
                {
                  fields: {
                    slug: "t1",
                    title: "T1",
                    body: "b",
                    status: "open",
                    tags: [],
                    design_slug: "",
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-01-01T00:00:00Z",
                  },
                  key: { hash: "t1", range: null },
                },
              ],
            },
          };
        }
        if (body.schema_name === TEST_HASHES.design) {
          return {
            status: 200,
            body: {
              ok: true,
              results: [
                {
                  fields: {
                    slug: "d1",
                    title: "D1",
                    body: "b",
                    status: "draft",
                    tags: [],
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-01-01T00:00:00Z",
                  },
                  key: { hash: "d1", range: null },
                },
              ],
            },
          };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_link!({
      from_type: "task",
      from_slug: "t1",
      to_type: "design",
      to_slug: "d1",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text ?? "").toContain("linked task t1 → design d1");
    expect(mutations).toHaveLength(1);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("d1");
  });

  test("unsupported pair (concept → design) errors with unsupported_link_pair", async () => {
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_link!({
      from_type: "concept",
      from_slug: "c1",
      to_type: "design",
      to_slug: "d1",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("not supported");
    expect(touched).toBe(false);
  });

  test("missing design surfaces dangling_design_slug via isError", async () => {
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === TEST_HASHES.task) {
          return {
            status: 200,
            body: {
              ok: true,
              results: [
                {
                  fields: {
                    slug: "t1",
                    title: "T",
                    body: "b",
                    status: "open",
                    tags: [],
                    design_slug: "",
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-01-01T00:00:00Z",
                  },
                  key: { hash: "t1", range: null },
                },
              ],
            },
          };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_link!({
      from_type: "task",
      from_slug: "t1",
      to_type: "design",
      to_slug: "missing",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("No design: missing");
  });
});

describe("createFbrainMcpServer", () => {
  test("registers the 6 read+write tools", () => {
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    expect(Object.keys(tools).sort()).toEqual([
      "fbrain_delete",
      "fbrain_get",
      "fbrain_link",
      "fbrain_list",
      "fbrain_put",
      "fbrain_search",
    ]);
  });
});
