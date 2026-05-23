// Unit tests for the raw passthrough command's path→service routing,
// method normalisation, and body-source selection.

import { afterEach, describe, expect, test } from "bun:test";

import {
  normalizeMethod,
  pickService,
  rawCmd,
  resolveBody,
} from "../../src/commands/raw.ts";
import { FbrainError } from "../../src/client.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";

const cfg: Config = {
  configVersion: CONFIG_VERSION,
  nodeUrl: "http://node.local",
  schemaServiceUrl: "http://schema.local",
  userHash: "uh-test",
  designSchemaHash: "a".repeat(64),
  taskSchemaHash: "b".repeat(64),
};

describe("pickService", () => {
  test("/api/ → node", () => {
    expect(pickService("/api/system/auto-identity")).toBe("node");
  });
  test("/v1/ → schema", () => {
    expect(pickService("/v1/schemas")).toBe("schema");
  });
  test("anything else throws", () => {
    expect(() => pickService("/random")).toThrow(FbrainError);
    expect(() => pickService("/api")).toThrow(FbrainError);
  });
});

describe("normalizeMethod", () => {
  test("uppercases", () => {
    expect(normalizeMethod("get")).toBe("GET");
    expect(normalizeMethod("Post")).toBe("POST");
  });
  test("supports all five verbs", () => {
    expect(normalizeMethod("GET")).toBe("GET");
    expect(normalizeMethod("POST")).toBe("POST");
    expect(normalizeMethod("PUT")).toBe("PUT");
    expect(normalizeMethod("PATCH")).toBe("PATCH");
    expect(normalizeMethod("DELETE")).toBe("DELETE");
  });
  test("rejects unknown methods", () => {
    expect(() => normalizeMethod("OPTIONS")).toThrow(FbrainError);
    expect(() => normalizeMethod("connect")).toThrow(FbrainError);
  });
});

describe("resolveBody", () => {
  test("undefined arg + no stdin reader → undefined", async () => {
    expect(await resolveBody(undefined, undefined)).toBeUndefined();
  });
  test("undefined arg reads stdin", async () => {
    const body = await resolveBody(undefined, async () => "from-stdin");
    expect(body).toBe("from-stdin");
  });
  test("'-' reads stdin", async () => {
    const body = await resolveBody("-", async () => '{"a":1}');
    expect(body).toBe('{"a":1}');
  });
  test("literal arg passes through", async () => {
    expect(await resolveBody('{"x":1}', async () => "ignored")).toBe('{"x":1}');
  });
  test("empty stdin returns undefined (no body)", async () => {
    expect(await resolveBody(undefined, async () => "")).toBeUndefined();
  });
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("rawCmd routing + stream", () => {
  test("GET /api/* sends X-User-Hash and prints body", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      capturedUrl = typeof input === "string" ? input : String(input);
      const h = init?.headers as Record<string, string> | undefined;
      capturedHeaders = h ?? {};
      return new Response(JSON.stringify({ user_hash: "deadbeef" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const lines: string[] = [];
    const code = await rawCmd({
      cfg,
      method: "GET",
      path: "/api/system/auto-identity",
      print: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(capturedUrl).toBe("http://node.local/api/system/auto-identity");
    expect(capturedHeaders["X-User-Hash"]).toBe("uh-test");
    expect(lines.join("\n")).toContain("deadbeef");
  });

  test("GET /v1/* never sends X-User-Hash", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const h = init?.headers as Record<string, string> | undefined;
      capturedHeaders = h ?? {};
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const code = await rawCmd({
      cfg,
      method: "GET",
      path: "/v1/schemas",
      print: () => {},
    });
    expect(code).toBe(0);
    expect(capturedHeaders["X-User-Hash"]).toBeUndefined();
  });

  test("non-2xx response → exit 1 and body goes to stderr", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as unknown as typeof globalThis.fetch;
    const out: string[] = [];
    const err: string[] = [];
    const code = await rawCmd({
      cfg,
      method: "GET",
      path: "/api/no",
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not_found");
    expect(out.length).toBe(0);
  });

  test("POST with body forwards body", async () => {
    let capturedBody = "";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response("ok", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const code = await rawCmd({
      cfg,
      method: "POST",
      path: "/api/mutation",
      body: '{"hello":"world"}',
      print: () => {},
    });
    expect(code).toBe(0);
    expect(capturedBody).toBe('{"hello":"world"}');
  });
});
