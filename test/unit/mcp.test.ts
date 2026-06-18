// Unit tests for the MCP server tool handlers — read (fbrain_search,
// fbrain_get, fbrain_list) and write (fbrain_put, fbrain_delete,
// fbrain_link). We construct the McpServer, then call the underlying
// handler captured at registration time via a small probe.
//
// Like the existing search/get/list/put tests, fetch is mocked so we
// don't stand up a real node.

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import pkg from "../../package.json" with { type: "json" };
import {
  buildPutInput,
  CONFIG_MISSING_HINT,
  createFbrainMcpServer,
  DROPPED_INPUT_HINT,
  FBRAIN_MCP_VERSION,
  resolvePutBody,
} from "../../src/mcp/server.ts";
import { ConfigMissingError } from "../../src/config.ts";
import { COMMAND_HELP } from "../../src/cli.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESIGN_HASH = TEST_HASHES.design;

const cfg = buildTestCfg({ userHash: "test-hash" });

const realFetch = globalThis.fetch;

type MockResponse = { status: number; body?: unknown };

// See test/unit/put.test.ts `installMock` for the rationale: auto-track
// create/update mutations and splice the row into a subsequent empty-page
// `/api/query` so the put-side verify-after-write (`verifyRecordVisible`)
// sees the row in tests that don't explicitly script the post-write echo.
type TrackedWrite = {
  schema: string;
  key: string;
  fields: Record<string, unknown>;
};

function installMock(handler: (url: string, init?: RequestInit) => MockResponse): void {
  const writes: TrackedWrite[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const next = handler(url, init);
    if (url.endsWith("/api/mutation") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const kind = body.mutation_type;
        if (kind === "create" || kind === "update") {
          const keyVal = body.key_value as Record<string, unknown> | undefined;
          writes.push({
            schema: String(body.schema ?? ""),
            key: String(keyVal?.hash ?? ""),
            fields: (body.fields_and_values as Record<string, unknown>) ?? {},
          });
        }
      } catch {
        // Non-JSON body — splice path doesn't apply.
      }
    }
    // Mirror the /api/query splice for the native (vector) index probe the
    // MCP `fbrain_put` handler now fires post-write (`verifyVectorIndexed`):
    // a warm fold_db indexes the embedding moments after the mutation, so a
    // search scoped to the written schema surfaces the just-written slug. When
    // a handler doesn't explicitly script the search endpoint, auto-answer it
    // from tracked writes so the put's index-confirmation passes (indexPending
    // false) without each put test re-stubbing /api/native-index/search — and
    // without paying the real verify backoff on an unhandled 404.
    if (
      url.includes("/api/native-index/search") &&
      next.status !== 200 &&
      writes.length > 0
    ) {
      const u = new URL(url, "http://node");
      const schemas = (u.searchParams.get("schemas") ?? "").split(",").filter(Boolean);
      const results = writes
        .filter((w) => schemas.length === 0 || schemas.includes(w.schema))
        .map((w) => ({
          schema_name: w.schema,
          field: "body",
          key_value: { hash: w.key, range: null },
          value: String(w.fields.body ?? ""),
          metadata: { score: 1 },
        }));
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      url.endsWith("/api/query") &&
      next.status === 200 &&
      typeof init?.body === "string"
    ) {
      const handlerResults = (next.body as Record<string, unknown> | undefined)?.results;
      if (Array.isArray(handlerResults) && handlerResults.length === 0) {
        try {
          const qBody = JSON.parse(init.body) as Record<string, unknown>;
          const schema = String(qBody.schema_name ?? "");
          const matches = writes
            .filter((w) => w.schema === schema)
            .map((w) => ({ fields: w.fields, key: { hash: w.key, range: null } }));
          if (matches.length > 0) {
            return new Response(
              JSON.stringify({ ...(next.body as object), results: matches }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        } catch {
          // Non-JSON body — splice path doesn't apply.
        }
      }
    }
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
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function toolsOf(server: ReturnType<typeof createFbrainMcpServer>): Record<string, ToolCallback> {
  const map = (server as unknown as { _registeredTools: Record<string, { handler: ToolCallback }> })
    ._registeredTools;
  const out: Record<string, ToolCallback> = {};
  for (const [name, t] of Object.entries(map)) out[name] = t.handler;
  return out;
}

// The registered-tool map also carries each tool's declared `outputSchema`
// (a ZodRawShape). We validate a tool's `structuredContent` against it to
// prove the typed result actually conforms to what the tool advertises —
// the same contract an MCP client's SDK enforces on the wire.
function outputSchemaOf(
  server: ReturnType<typeof createFbrainMcpServer>,
  name: string,
): z.ZodTypeAny | undefined {
  const map = (
    server as unknown as {
      _registeredTools: Record<string, { outputSchema?: z.ZodTypeAny }>;
    }
  )._registeredTools;
  return map[name]?.outputSchema;
}

function recordRow(slug: string, title = `T-${slug}`, body = "body text") {
  return {
    fields: {
      slug,
      title,
      body,
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

describe("fbrain_ask tool", () => {
  // The ask pipeline builds a BM25 corpus by walking record types via
  // /api/query (listRecords) and runs the vector ranker over
  // /api/native-index/search. Mock both so the hybrid path runs end-to-end
  // with no real node — and, critically, with NO Anthropic API key (LLM
  // expansion is off by default in the tool, so none is ever attempted).
  test("returns hybrid (BM25+vector RRF) results in a single text block, no API key needed", async () => {
    const priorKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      installMock((url) => {
        // BM25 corpus: only the Design type carries a record whose body has
        // the rare keyword the vector ranker would miss.
        if (url.includes("/api/query")) {
          return {
            status: 200,
            body: {
              ok: true,
              results: [
                {
                  fields: {
                    slug: "rrf-keyword-match",
                    title: "Reciprocal rank fusion notes",
                    body: "blueberry zzqx acronym keyword body",
                    status: "draft",
                    tags: ["x"],
                    created_at: "2026-01-01T00:00:00Z",
                    updated_at: "2026-01-02T00:00:00Z",
                  },
                  key: { hash: "rrf-keyword-match", range: null },
                },
              ],
            },
          };
        }
        if (url.includes("/api/native-index/search")) {
          return { status: 200, body: { ok: true, results: [] } };
        }
        return { status: 404, body: { error: "unknown" } };
      });
      const tools = toolsOf(createFbrainMcpServer({ cfg }));
      const res = await tools.fbrain_ask!({ query: "blueberry zzqx" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toHaveLength(1);
      expect(res.content[0]!.type).toBe("text");
      const text = res.content[0]!.text ?? "";
      // BM25 surfaced the keyword record even with an empty vector list —
      // proves the hybrid ranker ran and fused.
      expect(text).toContain("rrf-keyword-match");
      expect(text).toContain("Reciprocal rank fusion notes");
    } finally {
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = priorKey;
    }
  });

  test("passes type filter through to the ask pipeline", async () => {
    const queriedSchemas: string[] = [];
    installMock((url, init) => {
      if (url.includes("/api/query") && typeof init?.body === "string") {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          const schema = String(body.schema_name ?? "");
          queriedSchemas.push(schema);
          // Seed one live (non-matching) design row so the BM25 corpus is
          // non-empty: that lets ask's no-match empty-brain fast-path
          // short-circuit WITHOUT a `hasAnyLiveRecord` walk that would query
          // every type (including task) and break the type-filter assertion.
          if (schema === TEST_HASHES.design) {
            return {
              status: 200,
              body: {
                ok: true,
                results: [
                  {
                    fields: {
                      slug: "seed",
                      title: "Seed",
                      body: "octopus blueberry zucchini",
                      status: "draft",
                      tags: [],
                      created_at: "2026-01-01T00:00:00Z",
                      updated_at: "2026-01-01T00:00:00Z",
                    },
                    key: { hash: "seed", range: null },
                  },
                ],
              },
            };
          }
        } catch {
          // ignore
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 200, body: { ok: true, results: [] } };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    await tools.fbrain_ask!({ query: "q", type: ["design"] });
    // The corpus walk is restricted to the requested type's schema hash.
    expect(queriedSchemas).toContain(TEST_HASHES.design);
    expect(queriedSchemas).not.toContain(TEST_HASHES.task);
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
    // listCmd prints "no records" plus a context-aware empty-node hint when
    // the result is empty; the MCP wrapper passes both lines through verbatim.
    // Here the brain holds no live record → the create-your-first hint.
    expect(res.content[0]!.text).toContain("no records");
    expect(res.content[0]!.text).toContain("no records yet");
  });
});

// The whole point of this card: the 4 read tools must return typed JSON in
// `structuredContent` (mirroring the CLI `--json` shapes) AND declare an
// `outputSchema`, so an MCP client gets fields back instead of regex-parsing
// the human text block — while the text block is still returned as a
// readable fallback. Each test below proves: (1) structuredContent is
// NON-null, (2) it matches the declared outputSchema, and (3) the text
// content still renders.
describe("read tools — structuredContent + outputSchema", () => {
  test("fbrain_search returns { matches } matching its outputSchema, text still renders", async () => {
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
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_search!({ query: "blueberry" });
    expect(res.isError).toBeFalsy();
    // Structured payload is present and non-null.
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as { matches: Array<Record<string, unknown>> };
    expect(Array.isArray(sc.matches)).toBe(true);
    expect(sc.matches).toHaveLength(1);
    expect(sc.matches[0]).toMatchObject({ slug: "alpha", type: "design", title: "Alpha design" });
    expect(sc.matches[0]!.score).toBeCloseTo(0.42, 6);
    // The matching body snippet rides structuredContent so an agent reads the
    // answer inline without a follow-up fbrain_get. recordRow's body is
    // "body text"; the query shares no literal token, so the snippet is the
    // (short) body head — a non-empty string is the contract here.
    expect(typeof sc.matches[0]!.snippet).toBe("string");
    expect(sc.matches[0]!.snippet).toBe("body text");
    // Validates against the tool's declared outputSchema.
    const schema = outputSchemaOf(server, "fbrain_search")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    // Text content fallback still renders.
    expect(res.content[0]!.type).toBe("text");
    expect(res.content[0]!.text).toContain("Alpha design");
  });

  test("fbrain_search returns { matches: [] } (non-null) on no matches", async () => {
    installMock(() => ({ status: 200, body: { ok: true, results: [] } }));
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_search!({ query: "nothing" });
    expect(res.structuredContent).toEqual({ matches: [] });
    const schema = outputSchemaOf(server, "fbrain_search")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
  });

  test("fbrain_ask returns { matches } matching its outputSchema", async () => {
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
                metadata: { score: 0.5, match_type: "semantic" },
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
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_ask!({ query: "alpha" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as { matches: Array<Record<string, unknown>> };
    expect(sc.matches.length).toBeGreaterThanOrEqual(1);
    expect(sc.matches[0]).toMatchObject({ slug: "alpha", type: "design" });
    expect(typeof sc.matches[0]!.score).toBe("number");
    const schema = outputSchemaOf(server, "fbrain_ask")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    expect(res.content[0]!.text).toContain("alpha");
  });

  test("fbrain_ask structuredContent.matches[].snippet carries the matched body term", async () => {
    // The card's MCP contract: an agent can read the answer from
    // structuredContent without a follow-up fbrain_get. Body holds a known
    // fact; the query term ("TTL") must surface in the snippet.
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
                key_value: { hash: "caching-decision", range: null },
                value: "fragment",
                metadata: { score: 0.9, match_type: "semantic" },
              },
            ],
          },
        };
      }
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: {
            ok: true,
            results: [
              recordRow(
                "caching-decision",
                "Caching layer decision",
                "# Caching layer decision\n\nDecision: we picked a 5-minute TTL for the cache.",
              ),
            ],
          },
        };
      }
      return { status: 404, body: { error: "unknown" } };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_ask!({ query: "TTL" });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { matches: Array<{ slug: string; snippet: string }> };
    const hit = sc.matches.find((m) => m.slug === "caching-decision");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("5-minute TTL");
    // Leading H1 (== title) is stripped, so the snippet isn't the title echo.
    expect(hit!.snippet).not.toContain("Caching layer decision");
    // outputSchema still validates with the new field present.
    const schema = outputSchemaOf(server, "fbrain_ask")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
  });

  test("fbrain_get returns the single record object matching its outputSchema", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [recordRow("alpha", "Alpha design")] } };
      }
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_get!({ slug: "alpha", type: "design" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as Record<string, unknown>;
    // get returns the record object directly (not wrapped) — body included.
    expect(sc).toMatchObject({
      type: "design",
      slug: "alpha",
      title: "Alpha design",
      status: "draft",
      body: "body text",
    });
    expect(Array.isArray(sc.tags)).toBe(true);
    const schema = outputSchemaOf(server, "fbrain_get")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    expect(res.content[0]!.text).toContain("Alpha design");
  });

  test("fbrain_get error (unknown slug) returns no structuredContent", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_get!({ slug: "ghost", type: "design" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });

  test("fbrain_list returns { records } matching its outputSchema, text still renders", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return {
          status: 200,
          body: { ok: true, results: [recordRow("a", "A"), recordRow("b", "B")] },
        };
      }
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_list!({ type: "design", limit: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as { records: Array<Record<string, unknown>> };
    expect(Array.isArray(sc.records)).toBe(true);
    expect(sc.records).toHaveLength(2);
    expect(sc.records[0]).toMatchObject({ type: "design", status: "draft" });
    // Summary omits body (compact list shape).
    expect(sc.records[0]!).not.toHaveProperty("body");
    const schema = outputSchemaOf(server, "fbrain_list")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    expect(res.content[0]!.text).toContain("design");
  });

  test("fbrain_list returns { records: [] } (non-null) on empty result", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_list!({ type: "design" });
    expect(res.structuredContent).toEqual({ records: [] });
    const schema = outputSchemaOf(server, "fbrain_list")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
  });

  test("all 7 tools — read AND write — declare an outputSchema", () => {
    const server = createFbrainMcpServer({ cfg });
    // Read tools (typed since #262).
    expect(outputSchemaOf(server, "fbrain_search")).toBeDefined();
    expect(outputSchemaOf(server, "fbrain_ask")).toBeDefined();
    expect(outputSchemaOf(server, "fbrain_get")).toBeDefined();
    expect(outputSchemaOf(server, "fbrain_list")).toBeDefined();
    // Write tools (this card closes the gap #262 opened for the read tools).
    expect(outputSchemaOf(server, "fbrain_put")).toBeDefined();
    expect(outputSchemaOf(server, "fbrain_delete")).toBeDefined();
    expect(outputSchemaOf(server, "fbrain_link")).toBeDefined();
  });
});

// The write tools (put/delete/link) now mirror the read tools: each declares
// an `outputSchema` and returns typed `structuredContent` on success, with the
// one-line English confirmation preserved as the `content` text fallback
// (dual-emit). Each test proves: (1) structuredContent is non-null and equals
// the values in the printed line, (2) it validates against the declared
// outputSchema, and (3) the human text is unchanged.
describe("write tools — structuredContent + outputSchema", () => {
  test("fbrain_put returns {action,type,slug,indexPending:false} matching its outputSchema; text unchanged", async () => {
    installMock((url) => {
      // Native index already holds the slug → the post-write vector-index
      // confirmation passes on the first poll, so indexPending is false and
      // the text fallback stays the bare one-line confirmation.
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            results: [
              {
                schema_name: DESIGN_HASH,
                field: "body",
                key_value: { hash: "mcp-write-probe", range: null },
                value: "Probe",
                metadata: { score: 1 },
              },
            ],
          },
        };
      }
      if (url.includes("/api/query")) {
        // Empty page → put-side verify sees the row via installMock's splice.
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.includes("/api/mutation")) return { status: 200, body: { ok: true } };
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_put!({
      slug: "mcp-write-probe",
      type: "concept",
      title: "Probe",
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent).toEqual({
      action: "created",
      type: "concept",
      slug: "mcp-write-probe",
      indexPending: false,
    });
    const schema = outputSchemaOf(server, "fbrain_put")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    // Text fallback is the same one-line confirmation as before (no
    // indexPending suffix when the index has caught up).
    expect(res.content[0]!.text).toBe("created concept mcp-write-probe");
  });

  test("fbrain_put on an existing slug returns action:\"updated\"", async () => {
    installMock((url) => {
      if (url.includes("/api/native-index/search")) {
        return {
          status: 200,
          body: {
            results: [
              {
                schema_name: DESIGN_HASH,
                field: "body",
                key_value: { hash: "mcp-write-probe", range: null },
                value: "body text",
                metadata: { score: 1 },
              },
            ],
          },
        };
      }
      if (url.includes("/api/query")) {
        // Existing row present → putCmd resolves action=updated.
        return { status: 200, body: { ok: true, results: [recordRow("mcp-write-probe")] } };
      }
      if (url.includes("/api/mutation")) return { status: 200, body: { ok: true } };
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_put!({
      slug: "mcp-write-probe",
      type: "design",
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ action: "updated", type: "design", slug: "mcp-write-probe", indexPending: false });
    const schema = outputSchemaOf(server, "fbrain_put")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    expect(res.content[0]!.text).toBe("updated design mcp-write-probe");
  });

  test("fbrain_put error (no type) returns isError and NO structuredContent", async () => {
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_put!({ slug: "no-type-probe" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });

  test("fbrain_delete returns {action:'deleted',type,slug,soft:true} matching its outputSchema; text unchanged", async () => {
    // Mirror the `fbrain_delete tool` happy-path mock: first design query
    // returns the live row, subsequent ones return the tombstoned row so the
    // post-delete verify passes.
    let queryCount = 0;
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== TEST_HASHES.design) {
          return { status: 200, body: { ok: true, results: [] } };
        }
        queryCount += 1;
        if (queryCount === 1) {
          return { status: 200, body: { ok: true, results: [recordRow("doomed", "alive")] } };
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
      if (url.endsWith("/api/mutation")) return { status: 200, body: { ok: true, success: true } };
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_delete!({ slug: "doomed", type: "design" });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent).toEqual({
      action: "deleted",
      type: "design",
      slug: "doomed",
      soft: true,
    });
    const schema = outputSchemaOf(server, "fbrain_delete")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    // Text fallback unchanged — still the soft-delete confirmation line.
    expect(res.content[0]!.text).toContain("deleted design doomed (soft");
  });

  test("fbrain_delete error (missing slug) returns isError and NO structuredContent", async () => {
    installMock((url) => {
      if (url.includes("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_delete!({ slug: "ghost", type: "design" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
  });

  test("fbrain_link returns {action:'linked',from_*,to_*} matching its outputSchema; text unchanged", async () => {
    // Mirror the `fbrain_link tool` happy-path mock: task lookup returns t1,
    // design lookup returns d1, keyed on the schema hash.
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === TEST_HASHES.task) {
          return { status: 200, body: { ok: true, results: [recordRow("t1")] } };
        }
        if (body.schema_name === TEST_HASHES.design) {
          return { status: 200, body: { ok: true, results: [recordRow("d1")] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) return { status: 200, body: { ok: true, success: true } };
      return { status: 404 };
    });
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_link!({
      from_type: "task",
      from_slug: "t1",
      to_type: "design",
      to_slug: "d1",
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent).toEqual({
      action: "linked",
      from_type: "task",
      from_slug: "t1",
      to_type: "design",
      to_slug: "d1",
    });
    const schema = outputSchemaOf(server, "fbrain_link")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    expect(res.content[0]!.text).toBe("linked task t1 → design d1");
  });

  test("fbrain_link error (unsupported pair) returns isError and NO structuredContent", async () => {
    const server = createFbrainMcpServer({ cfg });
    const res = await toolsOf(server).fbrain_link!({
      from_type: "concept",
      from_slug: "c1",
      to_type: "design",
      to_slug: "d1",
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
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

  test("synthesizes status into frontmatter so the put applies it in a single mutation", () => {
    // Status used to be wired through a follow-up `statusCmd` after the
    // put. The atomic contract puts it in the synthesized frontmatter so
    // putCmd's pre-flight `ensureStatus(type, parsed.status)` validates it
    // BEFORE any mutation lands — see the "invalid status arg" tool test.
    const input = buildPutInput({
      slug: "x",
      type: "design",
      title: "Hello",
      status: "reviewed",
      body: "b",
    });
    expect(input).toBe("---\ntype: design\ntitle: Hello\nstatus: reviewed\n---\nb");
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

describe("resolvePutBody", () => {
  // body_path is the durable fix for the large-inline-body drop: a path is a
  // short string the transport never truncates, so a big record can always be
  // written by staging it to a file. resolvePutBody reads it back into `body`
  // before buildPutInput runs, keeping that serializer pure.
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("passes args through untouched when body_path is absent", () => {
    const args = { slug: "x", type: "concept", body: "inline" } as const;
    expect(resolvePutBody({ ...args })).toEqual(args);
  });

  test("reads the body from body_path when set", () => {
    dir = mkdtempSync(join(tmpdir(), "fbrain-bodypath-"));
    const p = join(dir, "body.md");
    const big = "# Title\n\n" + "x".repeat(50_000);
    writeFileSync(p, big, "utf8");
    const resolved = resolvePutBody({ slug: "x", type: "reference", body_path: p });
    expect(resolved.body).toBe(big);
    expect("body_path" in resolved).toBe(false);
    // And it serializes through buildPutInput like any other body.
    expect(buildPutInput(resolved)).toBe(`---\ntype: reference\n---\n${big}`);
  });

  test("rejects passing both body and body_path", () => {
    expect(() =>
      resolvePutBody({ slug: "x", type: "concept", body: "a", body_path: "/tmp/b.md" }),
    ).toThrow(/either `body` or `body_path`, not both/);
  });

  test("errors clearly when body_path is unreadable", () => {
    expect(() =>
      resolvePutBody({ slug: "x", type: "concept", body_path: "/no/such/file-xyz.md" }),
    ).toThrow(/could not read body_path/);
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

  test("status arg lands atomically in the put's single mutation (no follow-up update)", async () => {
    // Pre-fix this fired TWO mutations: the put (with the type's default
    // status) followed by a `statusCmd` update to apply the requested
    // value. That was wasteful (an extra round trip on every status-bearing
    // put) and split-brain on errors (see the "invalid status arg" test).
    // The atomic contract: status rides into the put's frontmatter so a
    // single mutation carries the requested value and the tool's
    // documented "Returns one line: `created|updated <type> <slug>`"
    // contract holds.
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
      slug: "with-status",
      type: "design",
      title: "T",
      body: "b",
      status: "reviewed",
    });
    expect(res.isError).toBeFalsy();
    // Exactly one mutation — the put — with the requested status applied.
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("create");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.status).toBe("reviewed");
    // One-line output, matching the tool's documented contract.
    expect(res.content[0]!.text).toBe("created design with-status");
  });

  test("invalid status arg errors atomically — no mutation lands before the status validation throws", async () => {
    // Pre-fix, `fbrain_put` synthesized frontmatter WITHOUT the status arg
    // and fired a SECOND mutation via `statusCmd` to apply it. On an invalid
    // status, the put already committed (with the type's default status)
    // before `statusCmd`'s `ensureStatus` validation threw. `runTool`'s
    // try/catch dropped the accumulated `created <type> <slug>` line and
    // returned `isError: true` — so the agent saw a clean error envelope but
    // a record had silently landed in the DB with the wrong status. Atomic
    // contract: a single mutation carries the status, validated up-front by
    // putCmd's pre-flight `ensureStatus`, so an invalid status never lands a
    // partial write.
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
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
    // The fix: an invalid status must not leave a record behind. Pre-fix
    // a `create` mutation fired before the status check ever ran, so the
    // record landed with the default status — invisible to the agent.
    expect(mutations).toHaveLength(0);
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

  // Read-your-writes regression — task 920a3. The MCP path is the bite-y
  // case: a `fbrain_put` followed by an immediate `fbrain_get` runs in the
  // SAME warm process, with no bun cold-start delay to mask fold_db's
  // mutation→query visibility lag. Pre-fix, the put returned "created"
  // before the row was queryable and the next-millisecond get returned
  // "No record". With the verify-after-write wired into putCmd, this loop
  // must be RYW-consistent: the get sees the same row the put just created.
  test("put then immediate get sees the row (read-your-writes via MCP)", async () => {
    // Drive both tools through the auto-stateful `installMock` — its
    // mutation-tracking + empty-page splice mirrors a warm fold_db: after
    // the put's create lands, the next /api/query for the same schema
    // surfaces the row. Without the put-side verify, the put would still
    // report "created" even on a flaky daemon; the regression test in
    // test/unit/put.test.ts pins that retry behavior. Here we just pin the
    // user-visible loop: put → get returns the just-written row.
    installMock((url, init) => {
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) {
        // Body is consumed by the wrapper's splice; no need to capture.
        void init;
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const putRes = await tools.fbrain_put!({
      slug: "ryw-mcp",
      type: "concept",
      title: "Hello",
      body: "world",
    });
    expect(putRes.isError).toBeFalsy();
    expect(putRes.content[0]!.text).toBe("created concept ryw-mcp");
    const getRes = await tools.fbrain_get!({ slug: "ryw-mcp", type: "concept" });
    expect(getRes.isError).toBeFalsy();
    expect(getRes.content[0]!.text ?? "").toContain("ryw-mcp");
  });

  // The card's core repro: in ONE long-lived MCP process, `fbrain_put` then an
  // immediate `fbrain_search`/`fbrain_ask` for the just-written record. Before
  // this fix, the put returned "created" before the vector index caught up, so
  // the back-to-back search returned every OTHER record except the one just
  // written. The post-write vector-index confirmation closes that window: the
  // put reports `indexPending: false` only once the slug is in the native
  // index, so the very next search surfaces it.
  test("put then immediate search AND ask return the just-written record (read-after-write via one MCP process)", async () => {
    // Auto-stateful mock: tracks the put's mutation and answers BOTH the
    // /api/query (record-list) AND /api/native-index/search (vector) surfaces
    // from it — mirroring a warm fold_db that has finished indexing. So the
    // put's confirmation passes (indexPending false) and the following
    // search/ask see the row.
    installMock((url, init) => {
      void init;
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) return { status: 200, body: { ok: true } };
      // Native-index search is auto-spliced from tracked writes by installMock.
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const putRes = await tools.fbrain_put!({
      slug: "raw-quokka-marker",
      type: "concept",
      title: "Raw quokka marker",
      body: "A unique raw quokka marker phrase for read-after-write.",
    });
    expect(putRes.isError).toBeFalsy();
    // Confirmed in the index → no pending signal, bare confirmation text.
    expect(putRes.structuredContent).toMatchObject({
      action: "created",
      slug: "raw-quokka-marker",
      indexPending: false,
    });
    expect(putRes.content[0]!.text).toBe("created concept raw-quokka-marker");

    // The immediately-following search in the SAME process surfaces the row.
    const searchRes = await tools.fbrain_search!({ query: "raw quokka marker" });
    expect(searchRes.isError).toBeFalsy();
    expect(searchRes.content[0]!.text ?? "").toContain("raw-quokka-marker");
    const searchHit = (searchRes.structuredContent?.matches as Array<{ slug: string }>)[0];
    expect(searchHit?.slug).toBe("raw-quokka-marker");

    // ...and so does ask (BM25 record-list + vector hybrid).
    const askRes = await tools.fbrain_ask!({ query: "raw quokka marker" });
    expect(askRes.isError).toBeFalsy();
    expect(askRes.content[0]!.text ?? "").toContain("raw-quokka-marker");
  });

  // The honest-timeout branch: the row persists and is record-list-visible,
  // but the vector index never catches up within the confirmation budget. The
  // write still succeeds — it must NEVER fail or block indefinitely — and the
  // result carries `indexPending: true` (plus a text note) so the agent knows
  // an immediate semantic search may miss it and to re-query shortly.
  test("genuine vector-index timeout still succeeds and reports indexPending:true", async () => {
    installMock((url, init) => {
      void init;
      if (url.endsWith("/api/query")) return { status: 200, body: { ok: true, results: [] } };
      if (url.endsWith("/api/mutation")) return { status: 200, body: { ok: true } };
      // Explicit 200 with NO hits → the auto-splice is bypassed (status 200),
      // so the vector-index confirmation polls its whole budget and times out.
      if (url.includes("/api/native-index/search")) {
        return { status: 200, body: { results: [] } };
      }
      return { status: 404 };
    });
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    const res = await tools.fbrain_put!({
      slug: "slow-index-marker",
      type: "concept",
      title: "Slow index marker",
      body: "Indexing lags here.",
    });
    // Write succeeds despite the index never confirming.
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      action: "created",
      type: "concept",
      slug: "slow-index-marker",
      indexPending: true,
    });
    const schema = outputSchemaOf(createFbrainMcpServer({ cfg }), "fbrain_put")!;
    expect(() => schema.parse(res.structuredContent)).not.toThrow();
    // Text fallback carries an honest catching-up note.
    expect(res.content[0]!.text).toContain("indexPending");
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

describe("empty/dropped tool input guard", () => {
  // The bite-y real-world failure: an MCP client delivers a tool call whose
  // arguments were dropped before reaching the server (observed repeatedly
  // with large `fbrain_put` bodies in long agent sessions — the call lands as
  // an empty `{}`). The MCP SDK validates a tool's `inputSchema` and returns a
  // -32602 BEFORE the handler runs, so the only layer that can improve the
  // message is the zod schema itself. These tests parse the *registered*
  // inputSchema directly (what the SDK validates against), not the handler,
  // so they exercise that real path.
  function inputSchemaOf(name: string): unknown {
    const server = createFbrainMcpServer({ cfg });
    const map = (server as unknown as {
      _registeredTools: Record<string, { inputSchema: unknown }>;
    })._registeredTools;
    return map[name]!.inputSchema;
  }

  for (const name of ["fbrain_put", "fbrain_get", "fbrain_delete"]) {
    test(`${name}: empty {} input yields the dropped-input recovery hint`, () => {
      const res = z.safeParse(inputSchemaOf(name) as never, {});
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]!.message).toBe(DROPPED_INPUT_HINT);
      }
    });
  }

  test("a valid fbrain_put still parses cleanly (no regression)", () => {
    const res = z.safeParse(inputSchemaOf("fbrain_put") as never, {
      slug: "ok-slug",
      type: "concept",
      body: "b",
    });
    expect(res.success).toBe(true);
  });

  test("an empty-string slug keeps zod's default message — the hint is for missing/dropped input only", () => {
    const res = z.safeParse(inputSchemaOf("fbrain_put") as never, { slug: "" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]!.message).not.toBe(DROPPED_INPUT_HINT);
      expect(res.error.issues[0]!.message).toContain("Too small");
    }
  });
});

describe("createFbrainMcpServer", () => {
  test("registers the 7 read+write tools", () => {
    const tools = toolsOf(createFbrainMcpServer({ cfg }));
    expect(Object.keys(tools).sort()).toEqual([
      "fbrain_ask",
      "fbrain_delete",
      "fbrain_get",
      "fbrain_link",
      "fbrain_list",
      "fbrain_put",
      "fbrain_search",
    ]);
  });

  // Pins `fbrain help mcp` text to the actually-registered MCP tool set so the
  // subcommand help can't drift behind the server again (it claimed "six
  // tools" and omitted fbrain_ask long after the tool shipped — done card
  // help-mcp-says-six-tools-omits-ask, dogfood run 30, 2026-06-16).
  test("COMMAND_HELP.mcp names every registered tool and says seven, not six", () => {
    const help = COMMAND_HELP.mcp;
    const registered = Object.keys(toolsOf(createFbrainMcpServer({ cfg })));
    // 7 is the contract — the help must not undercount the server.
    expect(registered).toHaveLength(7);
    for (const name of registered) {
      expect(help).toContain(name);
    }
    // fbrain_ask was the specific omission; assert it explicitly.
    expect(help).toContain("fbrain_ask");
    expect(help).toContain("seven tools");
    expect(help).not.toContain("six tools");
  });
});

describe("server starts without a config (lazy config resolution)", () => {
  // The new-developer path: `claude mcp add fbrain fbrain-mcp` is run BEFORE
  // `fbrain init`, so there is no ~/.fbrain/config.json yet. The server must
  // still construct and list its tools (so the MCP handshake succeeds and the
  // client connects); the missing config only surfaces when a tool is CALLED,
  // as a clean `isError` "run `fbrain init`" hint — not a startup crash.
  //
  // The `getCfg` thunk stands in for `readConfig()` here: throwing a
  // ConfigMissingError models a missing config file without touching disk, and
  // never calling it (until a tool runs) proves config resolution is lazy.

  function missingConfigLoader(): () => never {
    return () => {
      throw new ConfigMissingError("/nope/.fbrain/config.json");
    };
  }

  test("constructs and lists all 7 tools with no config (handshake survives)", () => {
    let loaderCalls = 0;
    const getCfg = () => {
      loaderCalls += 1;
      throw new ConfigMissingError("/nope/.fbrain/config.json");
    };
    const tools = toolsOf(createFbrainMcpServer({ getCfg }));
    // tools/list never resolves config — the loader must not have run yet.
    expect(loaderCalls).toBe(0);
    expect(Object.keys(tools).sort()).toEqual([
      "fbrain_ask",
      "fbrain_delete",
      "fbrain_get",
      "fbrain_link",
      "fbrain_list",
      "fbrain_put",
      "fbrain_search",
    ]);
  });

  test("a tool call with no config returns an isError result naming `fbrain init` (not a crash)", async () => {
    // No fetch mock installed: if the handler reached the node at all this
    // would throw a network error instead of the clean hint. The config guard
    // must short-circuit BEFORE any HTTP traffic.
    const tools = toolsOf(createFbrainMcpServer({ getCfg: missingConfigLoader() }));
    for (const name of [
      "fbrain_search",
      "fbrain_ask",
      "fbrain_get",
      "fbrain_list",
      "fbrain_put",
      "fbrain_delete",
      "fbrain_link",
    ]) {
      const res = await tools[name]!(
        // Minimal valid args per tool so zod's inputSchema passes and the
        // handler runs (where the config guard fires). The args themselves
        // don't matter — config resolution happens first.
        name === "fbrain_link"
          ? { from_type: "task", from_slug: "t", to_type: "design", to_slug: "d" }
          : name === "fbrain_get" || name === "fbrain_delete"
            ? { slug: "x" }
            : name === "fbrain_put"
              ? { slug: "x", type: "concept", body: "b" }
              : name === "fbrain_list"
                ? {}
                : { query: "q" },
      );
      expect(res.isError).toBe(true);
      const text = res.content[0]!.text ?? "";
      expect(text).toBe(CONFIG_MISSING_HINT);
      expect(text).toContain("fbrain init");
    }
  });

  test("the loader runs per call (config resolved lazily, once a tool is invoked)", async () => {
    let loaderCalls = 0;
    const getCfg = () => {
      loaderCalls += 1;
      throw new ConfigMissingError("/nope/.fbrain/config.json");
    };
    const tools = toolsOf(createFbrainMcpServer({ getCfg }));
    expect(loaderCalls).toBe(0);
    await tools.fbrain_list!({});
    expect(loaderCalls).toBe(1);
  });
});

describe("CONFIG_MISSING_HINT wording", () => {
  // Pin the actionable shape the new-dev path depends on: it must name the
  // exact recovery command and where it writes, mirroring the fkanban
  // `mcp-start-without-config` per-tool hint UX.
  test("names `fbrain init` and the config path", () => {
    expect(CONFIG_MISSING_HINT).toContain("fbrain init");
    expect(CONFIG_MISSING_HINT).toContain("~/.fbrain/config.json");
    expect(CONFIG_MISSING_HINT).toContain("not initialized");
  });
});

describe("FBRAIN_MCP_VERSION", () => {
  // Anti-drift pin: `fbrain --version` (src/cli.ts) and MCP
  // `serverInfo.version` both flow through getFbrainVersion(), which
  // returns `<pkg.version>` optionally suffixed with ` (<sha>[-dirty])`
  // when the running source lives in a git checkout. Before this was
  // single-sourced, the constant was a hardcoded "0.0.1" literal that sat
  // unchanged across ~175 merged PRs while package.json was already meant
  // to be the source of truth. Pin agreement so a future package.json bump
  // can't leave the MCP surface behind.
  test("starts with package.json version (single-sourced via getFbrainVersion)", () => {
    expect(FBRAIN_MCP_VERSION.startsWith(pkg.version)).toBe(true);
    // Either bare version or version + space-paren build identifier.
    const rest = FBRAIN_MCP_VERSION.slice(pkg.version.length);
    expect(rest === "" || /^ \([0-9a-f]{7,}(-dirty)?\)$/.test(rest)).toBe(true);
  });

  test("is not the historical 0.0.1 placeholder", () => {
    // Cheap guard against a future hand-edit that re-pins the literal.
    expect(FBRAIN_MCP_VERSION).not.toBe("0.0.1");
  });
});
