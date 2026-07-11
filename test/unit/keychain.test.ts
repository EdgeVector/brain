// Unit tests for the SDK-backed capability store adapter (keychain.ts).
//
// The storage implementation is @lastdb/app-sdk's FileCapabilityStore (a 0600
// file store under `~/.fbrain/capabilities/`). What fbrain owns — and what
// these tests pin — is the adapter around it:
//
//   - StoredCapability round-trip through the SDK store (entries keyed
//     `capabilityStoreKey(appId, nodeUrl)`, value = the SDK's {v, capability,
//     boundNode} envelope under `~/.fbrain/capabilities/`),
//   - the SDK wrong-node guard (an entry bound to node A is absent for node B).
//
// Every test runs with a temp FBRAIN_CAPABILITY_DIR — no test ever touches a
// real OS keychain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultCapabilityStore, fbrainDir } from "../../src/keychain.ts";
import type { CapabilityToken, StoredCapability } from "../../src/capability.ts";
import { canonicalize, type JsonValue } from "../../src/jcs.ts";
import { sha256Hex } from "../../src/hash.ts";

const NODE_URL = "http://127.0.0.1:9001";
const OTHER_NODE_URL = "http://127.0.0.1:9101";
const NODE_PUBKEY = "bm9kZS1wdWJrZXk=";

// A structurally-valid CapabilityToken blob (correct JCS payload_hash) so the
// adapter's decode-derived fields (nodePubkey, capabilityId) are real.
async function mintBlob(capabilityId = "cap-123"): Promise<string> {
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
    capability_id: capabilityId,
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

async function makeCap(): Promise<StoredCapability> {
  return {
    appId: "fbrain",
    nodeUrl: NODE_URL,
    nodePubkey: NODE_PUBKEY,
    capabilityId: "cap-123",
    blob: await mintBlob(),
  };
}

// The SDK store key: <appId>@<sha256(nodeUrl)[:16]>.
function sdkKeyFor(appId: string, nodeUrl: string): string {
  return `${appId}@${createHash("sha256").update(nodeUrl).digest("hex").slice(0, 16)}`;
}

function sdkEntryPath(dir: string, nodeUrl: string): string {
  return join(dir, "capabilities", `${sdkKeyFor("fbrain", nodeUrl)}.cap`);
}

let tempDir: string;
const savedCapDir = process.env.FBRAIN_CAPABILITY_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fbrain-kc-"));
  process.env.FBRAIN_CAPABILITY_DIR = tempDir;
});

afterEach(() => {
  if (savedCapDir === undefined) delete process.env.FBRAIN_CAPABILITY_DIR;
  else process.env.FBRAIN_CAPABILITY_DIR = savedCapDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SDK-backed store: round-trip + wrong-node guard", () => {
  test("save() persists via the SDK store (bound-node envelope) and load() round-trips", async () => {
    const store = defaultCapabilityStore();
    const cap = await makeCap();
    await store.save(cap);

    // On-disk: the SDK envelope under capabilities/<appId>@<nodeHash>.cap.
    const entryPath = sdkEntryPath(tempDir, NODE_URL);
    expect(existsSync(entryPath)).toBe(true);
    const envelope = JSON.parse(readFileSync(entryPath, "utf8")) as {
      v: number;
      capability: string;
      boundNode: string;
    };
    expect(envelope.v).toBe(1);
    expect(envelope.capability).toBe(cap.blob);
    expect(envelope.boundNode).toBe(NODE_URL);

    // Round-trip: blob verbatim; nodePubkey/capabilityId re-derived from it.
    const loaded = await store.load(NODE_URL);
    expect(loaded).not.toBeNull();
    expect(loaded!.blob).toBe(cap.blob);
    expect(loaded!.nodePubkey).toBe(NODE_PUBKEY);
    expect(loaded!.capabilityId).toBe("cap-123");
    expect(loaded!.appId).toBe("fbrain");
    expect(loaded!.nodeUrl).toBe(NODE_URL);
  });

  test("an entry bound to node A is treated as absent for node B (wrong-node guard)", async () => {
    const store = defaultCapabilityStore();
    await store.save(await makeCap());
    expect(await store.load(OTHER_NODE_URL)).toBeNull();
    expect(await store.load(NODE_URL)).not.toBeNull();
  });

  test("clear() removes the entry", async () => {
    const store = defaultCapabilityStore();
    await store.save(await makeCap());
    await store.clear(NODE_URL);
    expect(await store.load(NODE_URL)).toBeNull();
    expect(existsSync(sdkEntryPath(tempDir, NODE_URL))).toBe(false);
  });

  test("a stored blob that no longer decodes still loads, with empty derived fields", async () => {
    // The session's verifyCapabilityBlob is the layer that discards corrupt
    // cache; the store must surface the entry rather than mask it.
    const store = defaultCapabilityStore();
    const cap = await makeCap();
    cap.blob = Buffer.from("not json", "utf8").toString("base64");
    await store.save(cap);
    const loaded = await store.load(NODE_URL);
    expect(loaded).not.toBeNull();
    expect(loaded!.blob).toBe(cap.blob);
    expect(loaded!.nodePubkey).toBe("");
    expect(loaded!.capabilityId).toBe("");
  });
});

// Sanity: the temp-dir indirection actually points fbrainDir() at our temp dir,
// so the assertions above are reading the files the store wrote.
describe("keychain store: temp-dir wiring", () => {
  test("FBRAIN_CAPABILITY_DIR redirects fbrainDir()", () => {
    expect(fbrainDir()).toBe(tempDir);
  });
});
