// newSearchNodeClient integration: verifies that `/api/app/search` — which
// LastDB 0.22.4 moved behind capability enforcement — carries the cached
// capability, so `fbrain ask` / `fbrain search` (and the MCP tools that wrap
// them) keep working on an enforcing node. Regression pin for the
// `capability_403_capability_required` papercut observed 2026-07-10 on v0.22.4.
//
// These tests drive enforcement explicitly via FBRAIN_APP_IDENTITY_ENFORCE,
// overriding the suite default (test/setup.ts sets it OFF). A real fetch mock
// captures the outgoing headers and canned responses per route.

import { afterEach, describe, expect, test } from "bun:test";

import { newSearchNodeClient } from "../../src/write-context.ts";
import { inMemoryCapabilityStore } from "../../src/keychain.ts";
import { canonicalize, type JsonValue } from "../../src/jcs.ts";
import { sha256Hex } from "../../src/hash.ts";
import type { CapabilityToken } from "../../src/capability.ts";

const NODE_URL = "http://127.0.0.1:9001";
const NODE_PUBKEY = "bm9kZS1wdWJrZXktYWFhYWFhYWFhYWFhYWFhYWFhYWE=";

async function mintTokenBlob(): Promise<string> {
  const token: CapabilityToken = {
    envelope: {
      version: 1,
      purpose: "capability_grant",
      alg: "Ed25519",
      key_id: "a".repeat(64),
      issued_at: "2026-05-29T12:00:00Z",
      env: "dev",
      payload_hash: "",
      sig: "cGxhY2Vob2xkZXI=",
    },
    capability_id: "cap-1234",
    app_id: "fbrain",
    scope: { Wildcard: "fbrain/*" },
    granted_ops: ["Read", "Write"],
    granted_at: "2026-05-29T12:00:00Z",
    node_pubkey: NODE_PUBKEY,
  };
  const payload = { ...(token as unknown as Record<string, JsonValue>) };
  delete payload.envelope;
  token.envelope.payload_hash = await sha256Hex(canonicalize(payload as JsonValue));
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64");
}

const realFetch = globalThis.fetch;
const savedEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;

type Captured = { url: string; headers: Record<string, string>; body: string };

// A fetch mock that answers `/api/app/search` with `searchStatus` (200 → an
// empty `results` array the SDK parses; 403 → a `capability_required` denial
// body) and every other route with 200 ok.
function captureFetch(captured: Captured[], searchStatus = 200): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === "object" && !Array.isArray(h)) {
      for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    }
    captured.push({ url, headers, body: typeof init?.body === "string" ? init.body : "" });
    if (url.includes("/api/app/search")) {
      if (searchStatus === 200) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: 403, reason: "capability_required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  else process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
});

describe("newSearchNodeClient — enforcement ON", () => {
  test("attaches X-App-Capability + X-Capability-Ts to /api/app/search using a cached grant", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-1234",
      blob,
    });

    const captured: Captured[] = [];
    captureFetch(captured, 200);

    const { node } = newSearchNodeClient({
      baseUrl: NODE_URL,
      userHash: "u",
      store,
      print: () => {},
    });
    await node.search("hello", {});

    const search = captured.find((c) => c.url.includes("/api/app/search"));
    expect(search).toBeDefined();
    expect(search!.headers["X-App-Capability"]).toBe(blob);
    const ts = Number(search!.headers["X-Capability-Ts"]);
    expect(Number.isInteger(ts)).toBe(true);
    expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    // A cache hit means NO consent handshake fires.
    expect(captured.some((c) => c.url.includes("/api/apps/"))).toBe(false);
  });

  test("a non-search read through the same client carries NO capability headers", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-1234",
      blob,
    });
    const captured: Captured[] = [];
    captureFetch(captured, 200);

    const { node } = newSearchNodeClient({ baseUrl: NODE_URL, userHash: "u", store, print: () => {} });
    await node.queryAll({ schemaHash: "h", fields: ["slug"] });

    const query = captured.find((c) => c.url.includes("/api/query"));
    expect(query).toBeDefined();
    expect(query!.headers["X-App-Capability"]).toBeUndefined();
    expect(query!.headers["X-Capability-Ts"]).toBeUndefined();
  });

  test("header-less capability_required with no cached grant fast-fails non-interactively", async () => {
    // The node gates search but nothing is cached: runSearch reacts to
    // `capability_required` by trying to acquire, which — with isTty false and
    // no inline consent — fast-fails instead of polling for 5 minutes. This is
    // the fresh-owner-node case an MCP agent would hit.
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    const captured: Captured[] = [];
    captureFetch(captured, 403);

    const { node } = newSearchNodeClient({
      baseUrl: NODE_URL,
      userHash: "u",
      store: inMemoryCapabilityStore(), // empty
      print: () => {},
      isTty: () => false,
      pollIntervalMs: 1,
      sleep: async () => {},
      maxWaitMs: 50,
    });

    const start = Date.now();
    await expect(node.search("hello", {})).rejects.toMatchObject({
      code: "consent_required_non_interactive",
    });
    expect(Date.now() - start).toBeLessThan(200);
    // No consent traffic was generated (the fast-fail is BEFORE request-consent).
    expect(captured.some((c) => c.url.includes("/api/apps/"))).toBe(false);
  });
});

describe("newSearchNodeClient — enforcement OFF", () => {
  test("sends no capability headers on search and runs no consent handshake", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
    const captured: Captured[] = [];
    captureFetch(captured, 200);

    const { node } = newSearchNodeClient({
      baseUrl: NODE_URL,
      userHash: "u",
      store: inMemoryCapabilityStore(),
      print: () => {},
    });
    await node.search("hello", {});

    const search = captured.find((c) => c.url.includes("/api/app/search"));
    expect(search).toBeDefined();
    expect(search!.headers["X-App-Capability"]).toBeUndefined();
    expect(captured.some((c) => c.url.includes("/api/apps/"))).toBe(false);
  });
});
