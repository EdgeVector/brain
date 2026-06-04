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

  test("passes type filter through to the underlying client (single + multiple types)", async () => {
    // The CLI restricts the wire-level search to the requested type's schema
    // hashes by setting `schemas=<hash>`. Asserting the URL carries exactly
    // those hashes proves `args.type` was threaded into `sOpts.types` and
    // through to the client.
    let lastSearchUrl = "";
    installMock((url) => {
      if (url.includes("/api/native-index/search")) {
        lastSearchUrl = url;
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));

    await tools.fbrain_search!({ query: "q", type: ["design"] });
    expect(lastSearchUrl).toContain(`schemas=${TEST_HASHES.design}`);
    expect(lastSearchUrl).not.toContain(TEST_HASHES.task);

    await tools.fbrain_search!({ query: "q", type: ["design", "task"] });
    expect(lastSearchUrl).toContain(TEST_HASHES.design);
    expect(lastSearchUrl).toContain(TEST_HASHES.task);
    expect(lastSearchUrl).not.toContain(TEST_HASHES.concept);

    // Sanity check: without `type`, every fbrain schema hash is on the wire.
    await tools.fbrain_search!({ query: "q" });
    expect(lastSearchUrl).toContain(TEST_HASHES.design);
    expect(lastSearchUrl).toContain(TEST_HASHES.task);
    expect(lastSearchUrl).toContain(TEST_HASHES.concept);
  });

  test("type filter drops resolved hits whose type isn't requested", async () => {
    // The shared MEMO schema returns rows for multiple Phase 6 types; the
    // post-resolve filter in searchCmd should hide rows that aren't in the
    // requested set. Here we ask for `concept` only — a `design` hit must
    // not appear in the output.
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
    const res = await tools.fbrain_search!({ query: "blueberry", type: ["concept"] });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text ?? "";
    expect(text).not.toContain("alpha");
    expect(text).toContain("no matches");
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

  test("embedding-down error is channel-neutral — no CLI/brew remediation reaches the agent", async () => {
    // The node fails to load its embedding model; client.ts maps that to a
    // rich FbrainError whose CLI `hint` names `folddb daemon`,
    // `fbrain doctor --freshness`, and a homebrew log path, and whose message
    // carries the `fbrain doctor` tip. None of that is actionable for an MCP
    // agent — the boundary must strip the doctor tip and swap in the
    // channel-neutral `agentHint`.
    installMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 400,
          body: {
            error:
              "Bad request: Schema error: Invalid data: Failed to init embedding model: Failed to retrieve model.onnx",
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_search!({ query: "anything" });
    expect(res.isError).toBe(true);
    const text = res.content[0]!.text ?? "";
    // Still tells the agent what's wrong …
    expect(text).toContain("Semantic search is unavailable");
    // … but no CLI-/brew-only remediation it can't perform.
    expect(text).not.toContain("fbrain doctor");
    expect(text).not.toContain("folddb daemon");
    expect(text).not.toContain("brew");
    expect(text).not.toContain("Library/Logs");
    expect(text).not.toContain("--freshness");
    // Carries the channel-neutral, operator-facing hint instead.
    expect(text).toContain("operator");
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

  test("ambiguous slug error names the `type` arg, not the CLI `--type` flag", async () => {
    // A slug present in multiple schemas resolves to ambiguous_slug. The
    // shared message is consumed by the CLI (`--type`) AND this MCP tool
    // (a `type` argument), so it must not reference the CLI-only flag.
    installMock((url) => {
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow("dual")] } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_get!({ slug: "dual" });
    expect(res.isError).toBe(true);
    const text = res.content[0]!.text ?? "";
    expect(text).toContain("exists in multiple schemas");
    expect(text).not.toContain("--type");
    expect(text).toContain("Specify a `type`");
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

  test("throws missing_type when no type and no frontmatter (no silent default)", () => {
    // Mirror of the CLI `put` contract (#70): an untyped synthesized put
    // must error loudly instead of silently filing a `design` record.
    expect(() => buildPutInput({ slug: "x", body: "b" })).toThrow(/requires a `type`/);
  });

  test("quotes scalar values that contain YAML-significant characters", () => {
    const input = buildPutInput({
      slug: "x",
      type: "design",
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

  // Regression: the MCP serializer always escapes `\` and `"` when wrapping a
  // tag in double quotes, but the put-side parser didn't honor those escapes
  // — so a tag containing a backslash or an embedded quote round-tripped
  // corrupted (`a\b` → `a\\b`, `a"b` → `a\"b`, `a"b,c` even split into two
  // malformed items). The serializer and parser must agree on the escape
  // protocol or the put→get round-trip silently mangles the tag list.
  test("inline tag list round-trips through buildPutInput → parseFrontmatter", async () => {
    const { parseFrontmatter, splitFrontmatter } = await import(
      "../../src/commands/put.ts"
    );
    const cases: string[][] = [
      ["a\\b"],
      ['a"b'],
      ['a"b,c', "plain"],
      ["foo,bar", "plain"],
    ];
    for (const tags of cases) {
      const input = buildPutInput({ slug: "x", type: "concept", tags });
      const { frontmatter } = splitFrontmatter(input);
      const parsed = parseFrontmatter(frontmatter);
      expect(parsed.tags).toEqual(tags);
    }
  });

  // Regression: pre-fix, `yamlScalar` emitted a literal `\n` inside the
  // double quotes for any value carrying a newline. That broke the
  // line-based frontmatter parser: the continuation half of the title
  // landed on its own line and `parseFrontmatter` errored with
  // `frontmatter_malformed` ("line N is not 'key: value'"). An MCP agent
  // calling `fbrain_put` with a multi-line title (or any multi-line
  // scalar) hit this on every call — the put failed entirely instead of
  // silently mangling. Sibling of #122 (block scalars at parse time): the
  // serializer side needs to keep multi-line scalars on a single line by
  // escaping the newline, and the parser must reverse it.
  test("scalar values containing a newline round-trip through buildPutInput → parseFrontmatter", async () => {
    const { parseFrontmatter, splitFrontmatter } = await import(
      "../../src/commands/put.ts"
    );
    // Realistic multi-line title an agent might pass — copy-pasted from a
    // PR description, an error trace, or generated by an LLM that didn't
    // collapse newlines.
    const title = "line one\nline two\nline three";
    const input = buildPutInput({ slug: "x", type: "concept", title, body: "b" });
    const { frontmatter } = splitFrontmatter(input);
    const parsed = parseFrontmatter(frontmatter);
    expect(parsed.title).toBe(title);
    expect(parsed.type).toBe("concept");
    // CRLF and bare CR variants too — both can sneak in via copy/paste
    // from Windows-line-ending files or terminal output.
    const crlfTitle = "line one\r\nline two";
    const crlfInput = buildPutInput({
      slug: "x",
      type: "concept",
      title: crlfTitle,
      body: "b",
    });
    const crlfParsed = parseFrontmatter(splitFrontmatter(crlfInput).frontmatter);
    expect(crlfParsed.title).toBe(crlfTitle);
    // And tags carrying a newline: rarer than multi-line titles but still
    // a real corruption surface — same fix covers both.
    const tags = ["tag\nwith newline", "plain"];
    const tagInput = buildPutInput({ slug: "x", type: "concept", tags });
    const tagParsed = parseFrontmatter(splitFrontmatter(tagInput).frontmatter);
    expect(tagParsed.tags).toEqual(tags);
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
    // Post-Phase-E concept lives in its own dedicated schema; the legacy
    // `kind` discriminator is no longer written on new records.
    expect("kind" in fields).toBe(false);
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
    // Per-kind preference schema has no `kind` field.
    expect("kind" in fields).toBe(false);
  });

  test("status arg fires a follow-up status update after the put", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    // putCmd's pre-existence check now retries through withReadRetry —
    // it must see "no row" through the entire retry budget so the put
    // routes to createRecord (not updateRecord). After the create
    // mutation lands, the status command's findBySlug must see the row.
    // Gate the mock on whether a mutation has happened, not on query
    // index — the latter is brittle to retry-count changes.
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        if (mutations.length === 0) {
          return { status: 200, body: { ok: true, results: [] } };
        }
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
    const mutations: Array<Record<string, unknown>> = [];
    // Same gating as the "fires a follow-up status update" test above:
    // putCmd's pre-existence check retries, so we can't condition on
    // queryCount === 1. Use mutation-fired as the boundary instead.
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        if (mutations.length === 0) {
          return { status: 200, body: { ok: true, results: [] } };
        }
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
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
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

  test("no type and no frontmatter errors via isError before any HTTP traffic", async () => {
    // The MCP write surface honors the same no-silent-default contract as the
    // CLI `put` (#70): an untyped put must not silently become a `design` row.
    let touched = false;
    installMock(() => {
      touched = true;
      return { status: 500 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_put!({ slug: "untyped", body: "hello" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text ?? "").toContain("requires a `type`");
    expect(touched).toBe(false);
  });

  test("type carried in raw frontmatter satisfies the contract (no top-level type)", async () => {
    // Mirrors the CLI's "one of frontmatter `type:` or `--type`" — the
    // frontmatter escape hatch supplies the type, so no `type` arg is needed.
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
      slug: "fm-typed",
      frontmatter: "type: concept\ntitle: From Raw",
      body: "raw body",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe("created concept fm-typed");
    expect(mutations).toHaveLength(1);
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
