// newWriteNodeClient integration: verifies that with enforcement ON and a
// cached capability, every mutation carries X-App-Capability (the verbatim
// blob) + a fresh X-Capability-Ts (unix epoch secs); and that with enforcement
// OFF, no capability headers are sent and no consent handshake fires.
//
// These tests drive enforcement explicitly via FBRAIN_APP_IDENTITY_ENFORCE,
// overriding the suite default (test/setup.ts sets it OFF for the command
// tests). A real fetch mock captures the outgoing headers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { newWriteNodeClient } from "../../src/write-context.ts";
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

function captureFetch(captured: Captured[], status = 200): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === "object" && !Array.isArray(h)) {
      for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    }
    captured.push({ url, headers, body: typeof init?.body === "string" ? init.body : "" });
    // Mutations return 200 ok; everything else also 200 ok.
    return new Response(JSON.stringify({ ok: true }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  else process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
});

describe("newWriteNodeClient — enforcement ON", () => {
  test("attaches X-App-Capability + X-Capability-Ts to a mutation using a cached grant", async () => {
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
    captureFetch(captured);

    const { node } = newWriteNodeClient({
      baseUrl: NODE_URL,
      userHash: "u",
      store,
      print: () => {},
    });
    await node.createRecord({ schemaHash: "h", fields: { slug: "s" }, keyHash: "s" });

    const mutation = captured.find((c) => c.url.endsWith("/api/mutation"));
    expect(mutation).toBeDefined();
    expect(mutation!.headers["X-App-Capability"]).toBe(blob);
    const ts = Number(mutation!.headers["X-Capability-Ts"]);
    // Fresh unix-epoch-seconds timestamp within a few seconds of now.
    expect(Number.isInteger(ts)).toBe(true);
    expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    // No consent handshake — the cached grant was reused.
    expect(captured.some((c) => c.url.includes("/api/apps/"))).toBe(false);
  });

  test("a read through the same client carries NO capability headers", async () => {
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
    captureFetch(captured);

    const { node } = newWriteNodeClient({ baseUrl: NODE_URL, userHash: "u", store, print: () => {} });
    await node.queryAll({ schemaHash: "h", fields: ["slug"] });

    const query = captured.find((c) => c.url.includes("/api/query"));
    expect(query).toBeDefined();
    expect(query!.headers["X-App-Capability"]).toBeUndefined();
    expect(query!.headers["X-Capability-Ts"]).toBeUndefined();
  });
});

describe("newWriteNodeClient — non-interactive consent fast-fail", () => {
  // End-to-end thread-through test for the non-TTY fast-fail. Without a cached
  // capability and with `isTty: () => false`, the FIRST mutation should reject
  // immediately with `consent_required_non_interactive` instead of polling for
  // 5 minutes against /api/apps/consent-status. Regression pin for the agent /
  // CI install path (the actual fbrain consumption pattern).
  test("first mutation rejects with consent_required_non_interactive when isTty returns false", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    const captured: Captured[] = [];
    captureFetch(captured);

    const { node } = newWriteNodeClient({
      baseUrl: NODE_URL,
      userHash: "u",
      store: inMemoryCapabilityStore(), // empty: no cached capability
      print: () => {},
      isTty: () => false,
      // Belt-and-suspenders: if a regression slipped in and the poll WAS
      // entered, a tiny maxWaitMs makes it fail as a timeout fast rather
      // than hanging the test.
      pollIntervalMs: 1,
      sleep: async () => {},
      maxWaitMs: 50,
    });

    const start = Date.now();
    await expect(
      node.createRecord({ schemaHash: "h", fields: { slug: "s" }, keyHash: "s" }),
    ).rejects.toMatchObject({ code: "consent_required_non_interactive" });
    // Fast-fail truly fast — well under the 5-min default we're protecting
    // against, and under the test's own maxWaitMs.
    expect(Date.now() - start).toBeLessThan(50);
    // And no consent traffic was generated.
    expect(captured.some((c) => c.url.includes("/api/apps/"))).toBe(false);
  });
});

describe("newWriteNodeClient — enforcement OFF", () => {
  test("sends no capability headers and runs no consent handshake", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
    const captured: Captured[] = [];
    captureFetch(captured);

    const { node } = newWriteNodeClient({
      baseUrl: NODE_URL,
      userHash: "u",
      store: inMemoryCapabilityStore(),
      print: () => {},
    });
    await node.createRecord({ schemaHash: "h", fields: { slug: "s" }, keyHash: "s" });

    const mutation = captured.find((c) => c.url.endsWith("/api/mutation"));
    expect(mutation).toBeDefined();
    expect(mutation!.headers["X-App-Capability"]).toBeUndefined();
    expect(captured.some((c) => c.url.includes("/api/apps/"))).toBe(false);
  });
});
