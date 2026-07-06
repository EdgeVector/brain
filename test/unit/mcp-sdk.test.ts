// SDK-LEVEL tests: drive the fbrain MCP server through a REAL MCP
// client/server pair (InMemoryTransport), so every call crosses the SDK's
// tools/call plumbing — including `validateToolOutput`, which rejects any
// successful result from a schema'd tool that lacks `structuredContent`.
//
// WHY THIS FILE EXISTS: test/unit/mcp.test.ts invokes tool handlers directly
// (via the registered-tool map), which BYPASSES the SDK layer. That bypass is
// exactly how the slug-only `fbrain_status {slug}` bug survived CI — the
// handler returned a text-only result that direct invocation accepted, while
// on the wire the SDK ^1.29 threw "Output validation error: Tool
// fbrain_status has an output schema but no structured content was provided".
// Every test here calls `client.callTool(...)` after `client.listTools()`
// (which caches output validators), so BOTH the server-side
// `validateToolOutput` AND the client-side structured-content validation run,
// exactly as they do for a real MCP client.
//
// Fetch is mocked (same pattern as mcp.test.ts) so no real node is needed.

import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createFbrainMcpServer } from "../../src/mcp/server.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

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

type MutationBody = {
  mutation_type?: string;
  fields_and_values?: Record<string, unknown>;
  schema_name?: string;
};

function parseBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
}

function conceptRow(slug: string, body = "existing body", status = "active") {
  return {
    fields: {
      slug,
      title: `T-${slug}`,
      body,
      status,
      tags: ["k"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
    key: { hash: slug, range: null },
  };
}

// A minimal CallToolResult view — enough for these assertions.
type ToolCallResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Stand up a real client↔server pair over an in-memory transport and cache
// the tool metadata (listTools) so the CLIENT-side output validation runs on
// every callTool too. Returns a callTool helper.
async function connectClient(): Promise<{
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  close: () => Promise<void>;
}> {
  const server = createFbrainMcpServer({ cfg });
  const client = new Client({ name: "fbrain-sdk-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Caches per-tool output validators — this arms the client-side check that
  // a schema'd tool returned (valid) structuredContent.
  await client.listTools();
  return {
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as ToolCallResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP SDK round-trip (validateToolOutput-inclusive)", () => {
  // THE regression this file pins: slug WITHOUT status is a per-record status
  // READ. Pre-fix it routed through the write runner, `statusCmd` show mode
  // never fired `onResult`, no structuredContent was attached, and the SDK
  // threw an output-validation error on the wire (invisible to the
  // direct-handler tests). It must now return {action:"status", ...} cleanly.
  test("fbrain_status slug-only (show mode) returns structured {action:'status'} through the SDK", async () => {
    const mutations: MutationBody[] = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = parseBody(init);
        if (body.schema_name === TEST_HASHES.concept) {
          return { status: 200, body: { ok: true, results: [conceptRow("c1", "b", "active")] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(parseBody(init) as MutationBody);
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const { callTool, close } = await connectClient();
    try {
      const res = await callTool("fbrain_status", { slug: "c1", type: "concept" });
      expect(res.isError).toBeFalsy();
      // A READ: nothing was mutated, and no write capability was demanded.
      expect(mutations).toHaveLength(0);
      expect(res.structuredContent).toEqual({
        action: "status",
        type: "concept",
        slug: "c1",
        status: "active",
      });
      expect(res.content[0]!.text).toBe("active");
    } finally {
      await close();
    }
  });

  // Write shape through the SDK: slug + status patches the record and the
  // `status_changed` payload passes both server- and client-side validation.
  test("fbrain_status slug+status (patch mode) returns structured {action:'status_changed'} through the SDK", async () => {
    const mutations: MutationBody[] = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = parseBody(init);
        if (body.schema_name === TEST_HASHES.concept) {
          return { status: 200, body: { ok: true, results: [conceptRow("c1", "the body", "active")] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(parseBody(init) as MutationBody);
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const { callTool, close } = await connectClient();
    try {
      const res = await callTool("fbrain_status", {
        slug: "c1",
        status: "archived",
        type: "concept",
      });
      expect(res.isError).toBeFalsy();
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.fields_and_values!.status).toBe("archived");
      expect(res.structuredContent).toEqual({
        action: "status_changed",
        type: "concept",
        slug: "c1",
        from: "active",
        to: "archived",
      });
    } finally {
      await close();
    }
  });

  // Bare-call shape through the SDK: no slug → node/overall health payload.
  test("fbrain_status bare {} (node status) returns structured {action:'node_status'} through the SDK", async () => {
    installMock((url) => {
      if (url.endsWith("/api/system/auto-identity")) {
        return { status: 200, body: { user_hash: "uh-test" } };
      }
      if (url.endsWith("/api/health")) {
        return { status: 200, body: { ok: true, uptime_s: 42, version: "9.9.9" } };
      }
      return { status: 404 };
    });
    const { callTool, close } = await connectClient();
    try {
      const res = await callTool("fbrain_status", {});
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({
        action: "node_status",
        reachable: true,
        provisioned: true,
        version: "9.9.9",
      });
    } finally {
      await close();
    }
  });

  // Read-tool shape through the SDK: fbrain_get (the paginating read runner)
  // must attach schema-valid structuredContent on the wire.
  test("fbrain_get returns schema-valid structured record content through the SDK", async () => {
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = parseBody(init);
        if (body.schema_name === TEST_HASHES.concept) {
          return { status: 200, body: { ok: true, results: [conceptRow("c1", "hello body")] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    const { callTool, close } = await connectClient();
    try {
      const res = await callTool("fbrain_get", { slug: "c1", type: "concept" });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({
        slug: "c1",
        type: "concept",
        body: "hello body",
      });
    } finally {
      await close();
    }
  });

  // Write-tool shape through the SDK: fbrain_append (the write runner) must
  // attach the {action:"appended", ...} payload on the wire.
  test("fbrain_append returns structured {action:'appended'} through the SDK", async () => {
    const mutations: MutationBody[] = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const body = parseBody(init);
        if (body.schema_name === TEST_HASHES.concept) {
          return { status: 200, body: { ok: true, results: [conceptRow("c1", "head")] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(parseBody(init) as MutationBody);
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    const { callTool, close } = await connectClient();
    try {
      const res = await callTool("fbrain_append", { slug: "c1", chunk: "tail", type: "concept" });
      expect(res.isError).toBeFalsy();
      expect(mutations).toHaveLength(1);
      expect(res.structuredContent).toMatchObject({
        action: "appended",
        type: "concept",
        slug: "c1",
      });
    } finally {
      await close();
    }
  });

  // Error-path naming through the SDK: a bad `chunk_b64` must name
  // fbrain_append and chunk_b64/chunk_path — NOT fbrain_put/body_b64/body_path
  // (the decoder is shared with fbrain_put and used to hardcode put's names).
  test("fbrain_append with invalid chunk_b64 errors naming fbrain_append + chunk_b64", async () => {
    installMock(() => ({ status: 404 }));
    const { callTool, close } = await connectClient();
    try {
      const res = await callTool("fbrain_append", { slug: "c1", chunk_b64: "not base64!!!" });
      expect(res.isError).toBe(true);
      const text = res.content[0]!.text ?? "";
      expect(text).toContain("fbrain_append");
      expect(text).toContain("chunk_b64");
      expect(text).toContain("chunk_path");
      expect(text).not.toContain("fbrain_put");
      expect(text).not.toContain("body_b64");
      expect(text).not.toContain("body_path");
    } finally {
      await close();
    }
  });
});
