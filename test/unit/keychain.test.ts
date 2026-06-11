// Unit tests for the SDK-backed capability store adapter (keychain.ts).
//
// The storage implementation is @folddb/app-sdk's keychain-with-file-fallback
// store (timeout-bounded `security` calls; the hang-degradation behavior is
// pinned in the SDK). What fbrain owns — and what these tests pin — is the
// adapter around it:
//
//   - StoredCapability round-trip through the SDK store (entries keyed
//     `capabilityStoreKey(appId, nodeUrl)`, value = the SDK's {v, capability,
//     boundNode} envelope under `~/.fbrain/capabilities/`),
//   - the SDK wrong-node guard (an entry bound to node A is absent for node B),
//   - the ONE-SHOT LEGACY MIGRATION: pre-SDK entries (keychain account
//     sha256("<appId> <nodeUrl>") under com.edgevector.fbrain.capability, or
//     that account key in ~/.fbrain/capabilities.json) keep working — an
//     existing install must NOT lose its grant or silently re-prompt,
//   - clear() removing the legacy copies too, so a deliberately-discarded
//     token cannot resurrect through the migration read.
//
// Every test runs with FBRAIN_FORCE_FILE_KEYCHAIN=1 (the SDK store uses its
// file backend under a temp FBRAIN_CAPABILITY_DIR) and, where the legacy
// KEYCHAIN path is exercised, injects a fake `security` runner via
// `__setSecuritySpawn` — no test ever touches a real OS keychain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setSecuritySpawn,
  defaultCapabilityStore,
  fbrainDir,
} from "../../src/keychain.ts";
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

// The pre-SDK account key: sha256("<appId> <nodeUrl>").
function legacyAccountFor(appId: string, nodeUrl: string): string {
  return createHash("sha256").update(`${appId} ${nodeUrl}`).digest("hex");
}

// The SDK store key: <appId>@<sha256(nodeUrl)[:16]>.
function sdkKeyFor(appId: string, nodeUrl: string): string {
  return `${appId}@${createHash("sha256").update(nodeUrl).digest("hex").slice(0, 16)}`;
}

function sdkEntryPath(dir: string, nodeUrl: string): string {
  return join(dir, "capabilities", `${sdkKeyFor("fbrain", nodeUrl)}.cap`);
}

function legacyFilePath(dir: string): string {
  return join(dir, "capabilities.json");
}

let tempDir: string;
const savedCapDir = process.env.FBRAIN_CAPABILITY_DIR;
const savedForceFile = process.env.FBRAIN_FORCE_FILE_KEYCHAIN;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fbrain-kc-"));
  process.env.FBRAIN_CAPABILITY_DIR = tempDir;
  process.env.FBRAIN_FORCE_FILE_KEYCHAIN = "1";
});

afterEach(() => {
  __setSecuritySpawn(null);
  if (savedCapDir === undefined) delete process.env.FBRAIN_CAPABILITY_DIR;
  else process.env.FBRAIN_CAPABILITY_DIR = savedCapDir;
  if (savedForceFile === undefined) delete process.env.FBRAIN_FORCE_FILE_KEYCHAIN;
  else process.env.FBRAIN_FORCE_FILE_KEYCHAIN = savedForceFile;
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

describe("legacy migration: pre-SDK entries keep working", () => {
  test("a legacy ~/.fbrain/capabilities.json entry is returned and migrated to the SDK store", async () => {
    const cap = await makeCap();
    const account = legacyAccountFor(cap.appId, cap.nodeUrl);
    writeFileSync(
      legacyFilePath(tempDir),
      JSON.stringify({ [account]: cap }, null, 2),
      "utf8",
    );

    const store = defaultCapabilityStore();
    const loaded = await store.load(NODE_URL);
    expect(loaded).not.toBeNull();
    expect(loaded!.blob).toBe(cap.blob);
    expect(loaded!.capabilityId).toBe(cap.capabilityId);

    // One-shot migration: the entry now ALSO lives under the SDK key, so the
    // next load succeeds without the legacy file.
    expect(existsSync(sdkEntryPath(tempDir, NODE_URL))).toBe(true);
    rmSync(legacyFilePath(tempDir), { force: true });
    const reloaded = await store.load(NODE_URL);
    expect(reloaded?.blob).toBe(cap.blob);
  });

  test("a legacy KEYCHAIN entry (same service, sha256 account) is returned and migrated", async () => {
    const cap = await makeCap();
    const account = legacyAccountFor(cap.appId, cap.nodeUrl);
    const calls: string[][] = [];
    __setSecuritySpawn((args, _capture) => {
      calls.push(args);
      if (
        args[0] === "find-generic-password" &&
        args[args.indexOf("-a") + 1] === account
      ) {
        return { status: 0, stdout: JSON.stringify(cap), timedOut: false };
      }
      return { status: 44, stdout: "", timedOut: false };
    });

    const store = defaultCapabilityStore();
    const loaded = await store.load(NODE_URL);
    expect(loaded).not.toBeNull();
    expect(loaded!.blob).toBe(cap.blob);
    // The legacy read targeted fbrain's keychain service.
    const find = calls.find((c) => c[0] === "find-generic-password");
    expect(find).toContain("com.edgevector.fbrain.capability");
    // Migrated: present under the SDK key (file backend), so the next load
    // does not need the keychain at all.
    expect(existsSync(sdkEntryPath(tempDir, NODE_URL))).toBe(true);
  });

  test("a hung legacy keychain read degrades to 'no legacy entry' (never wedges)", async () => {
    __setSecuritySpawn(() => ({ status: null, stdout: "", timedOut: true }));
    const store = defaultCapabilityStore();
    // If the legacy path hung the process, this await would never resolve.
    expect(await store.load(NODE_URL)).toBeNull();
  });

  test("an SDK-store entry wins over a stale legacy entry", async () => {
    const fresh = await makeCap();
    const stale: StoredCapability = {
      ...fresh,
      capabilityId: "cap-stale",
      blob: await mintBlob("cap-stale"),
    };
    const account = legacyAccountFor("fbrain", NODE_URL);
    writeFileSync(legacyFilePath(tempDir), JSON.stringify({ [account]: stale }), "utf8");

    const store = defaultCapabilityStore();
    await store.save(fresh);
    const loaded = await store.load(NODE_URL);
    expect(loaded?.capabilityId).toBe("cap-123"); // the fresh SDK entry, not cap-stale
  });

  test("clear() also removes the legacy copies, so a discarded token cannot resurrect", async () => {
    const cap = await makeCap();
    const account = legacyAccountFor(cap.appId, cap.nodeUrl);
    writeFileSync(legacyFilePath(tempDir), JSON.stringify({ [account]: cap }), "utf8");
    const deleted: string[][] = [];
    __setSecuritySpawn((args) => {
      if (args[0] === "delete-generic-password") {
        deleted.push(args);
        return { status: 0, stdout: "", timedOut: false };
      }
      return { status: 44, stdout: "", timedOut: false };
    });

    const store = defaultCapabilityStore();
    await store.clear(NODE_URL);

    // Legacy file entry gone → a later load() cannot migrate it back.
    expect(await store.load(NODE_URL)).toBeNull();
    const fileStore = JSON.parse(readFileSync(legacyFilePath(tempDir), "utf8")) as Record<
      string,
      unknown
    >;
    expect(account in fileStore).toBe(false);
    // And the legacy keychain delete was issued against fbrain's service.
    expect(deleted.length).toBe(1);
    expect(deleted[0]).toContain("com.edgevector.fbrain.capability");
  });
});

// Sanity: the temp-dir indirection actually points fbrainDir() at our temp dir,
// so the assertions above are reading the files the store wrote.
describe("keychain store: temp-dir wiring", () => {
  test("FBRAIN_CAPABILITY_DIR redirects fbrainDir()", () => {
    expect(fbrainDir()).toBe(tempDir);
  });
});
