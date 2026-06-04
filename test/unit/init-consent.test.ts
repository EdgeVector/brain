// Unit coverage for `fbrain init`'s inline consent step (closes the
// "two-terminal dance" on first write — see brief ce9ca).
//
// What we lock in:
//   - Idempotency: a live capability on disk → silent no-op.
//   - Non-TTY: skipped with a clear note (no prompt blocking).
//   - Declined ("n"): skipped, no transport calls.
//   - `folddb` missing: prints the manual instruction, still polls + stores.
//   - `folddb` present: shells out (verified via mock), still polls + stores.
//   - Enforcement off: skipped immediately, no transport calls.
//
// The capability flow primitives (request-consent, polling, JCS check) are
// covered by capability.test.ts; this suite drives the new orchestrator
// directly with a mock transport + in-memory store, no node required.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  establishConsentInline,
  type GrantResult,
} from "../../src/commands/init-consent.ts";
import {
  type CapabilityToken,
  type ConsentTransport,
} from "../../src/capability.ts";
import { inMemoryCapabilityStore } from "../../src/keychain.ts";
import { canonicalize, type JsonValue } from "../../src/jcs.ts";
import { sha256Hex } from "../../src/hash.ts";

const NODE_URL = "http://127.0.0.1:9001";
const USER_HASH = "uh-test";
const NODE_PUBKEY = "bm9kZS1wdWJrZXktYWFhYWFhYWFhYWFhYWFhYWFhYWE=";

// Mirror of capability.test.ts's mintTokenBlob — keep this self-contained so
// the suite isn't entangled with capability.test.ts's helpers.
async function mintTokenBlob(): Promise<string> {
  const token: CapabilityToken = {
    envelope: {
      version: 1,
      purpose: "capability_grant",
      alg: "Ed25519",
      key_id: "a".repeat(64),
      issued_at: "2026-06-04T12:00:00Z",
      env: "dev",
      payload_hash: "",
      sig: "cGxhY2Vob2xkZXItc2lnbmF0dXJl",
    },
    capability_id: "cap-init-1",
    app_id: "fbrain",
    scope: { Wildcard: "fbrain/*" },
    granted_ops: ["Read", "Write"],
    granted_at: "2026-06-04T12:00:00Z",
    node_pubkey: NODE_PUBKEY,
  };
  const payload = { ...(token as unknown as Record<string, JsonValue>) };
  delete payload.envelope;
  token.envelope.payload_hash = await sha256Hex(canonicalize(payload as JsonValue));
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64");
}

type ScriptedTransport = ConsentTransport & {
  requestConsentCalls: number;
  consentStatusCalls: number;
};

function scriptedTransport(blob: string): ScriptedTransport {
  let consentStatusCalls = 0;
  let requestConsentCalls = 0;
  return {
    get requestConsentCalls() {
      return requestConsentCalls;
    },
    get consentStatusCalls() {
      return consentStatusCalls;
    },
    async requestConsent() {
      requestConsentCalls++;
      return { status: 202, body: { request_id: "req-init-1" } };
    },
    async consentStatus() {
      consentStatusCalls++;
      // First call pending → forces a poll iteration so we exercise the loop.
      if (consentStatusCalls === 1) {
        return { status: 202, body: { status: "pending" } };
      }
      return { status: 200, body: { status: "granted", capability: blob } };
    },
  };
}

// Force enforcement ON for this suite — the bun preload (test/setup.ts)
// defaults it OFF for command tests that don't exercise the capability path.
let savedEnforce: string | undefined;
beforeEach(() => {
  savedEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
});
afterEach(() => {
  if (savedEnforce === undefined) {
    delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  } else {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
  }
});

const yesAsk = async () => "y";
const noSleep = async () => {};
const ttyOn = () => true;
const ttyOff = () => false;

describe("establishConsentInline — idempotency", () => {
  test("live capability on disk → already_granted, no transport calls", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-init-1",
      blob,
    });

    const transport = scriptedTransport(blob);
    let asked = false;
    const lines: string[] = [];

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: async () => {
        asked = true;
        return "y";
      },
      isTty: ttyOn,
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "already_granted" });
    expect(asked).toBe(false);
    expect(transport.requestConsentCalls).toBe(0);
    expect(transport.consentStatusCalls).toBe(0);
    expect(lines.some((l) => l.includes("already granted"))).toBe(true);
  });
});

describe("establishConsentInline — non-interactive skip", () => {
  test("stdin not a TTY → skipped with a clear note, no transport calls", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: async () => {
        throw new Error("ask must not be called when non-TTY");
      },
      isTty: ttyOff,
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "skipped", reason: "non_tty" });
    expect(transport.requestConsentCalls).toBe(0);
    expect(transport.consentStatusCalls).toBe(0);
    expect(lines.some((l) => l.includes("non-interactive"))).toBe(true);
    expect(lines.some((l) => l.includes("folddb consent grant fbrain"))).toBe(true);
  });
});

describe("establishConsentInline — user declines", () => {
  test('answer "n" → skipped, no transport calls, suggests manual fallback', async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: async () => "n",
      isTty: ttyOn,
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "skipped", reason: "declined" });
    expect(transport.requestConsentCalls).toBe(0);
    expect(transport.consentStatusCalls).toBe(0);
    expect(lines.some((l) => l.includes("folddb consent grant fbrain"))).toBe(true);
  });
});

describe("establishConsentInline — folddb missing fallback", () => {
  test("resolveFolddb returns null → prints manual instruction, still polls and stores", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    let grantCalls = 0;
    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: yesAsk,
      isTty: ttyOn,
      resolveFolddb: () => null,
      runFolddbGrant: () => {
        grantCalls++;
        return { status: 0 };
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "granted_inline", folddbUsed: false });
    expect(grantCalls).toBe(0);
    expect(transport.requestConsentCalls).toBe(1);
    // The capability eventually landed in the store (polling completed).
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
    // The user saw the fallback line they need to act on.
    expect(
      lines.some(
        (l) =>
          l.includes("`folddb` not found on PATH") &&
          l.includes("folddb consent grant fbrain"),
      ),
    ).toBe(true);
  });
});

describe("establishConsentInline — folddb present happy path", () => {
  test("folddb on PATH → shells out, polls, stores; runFolddbGrant invoked with the right args", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const grantInvocations: Array<{ path: string; appId: string }> = [];
    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: yesAsk,
      isTty: ttyOn,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (path, appId) => {
        grantInvocations.push({ path, appId });
        return { status: 0 };
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "granted_inline", folddbUsed: true });
    expect(grantInvocations).toEqual([
      { path: "/opt/homebrew/bin/folddb", appId: "fbrain" },
    ]);
    expect(transport.requestConsentCalls).toBe(1);
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
    expect(
      lines.some((l) => l.includes("running `folddb consent grant fbrain --yes`")),
    ).toBe(true);
  });

  test("folddb exits non-zero → prints retry hint, keeps polling (so manual grant in another terminal still completes init)", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: yesAsk,
      isTty: ttyOn,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (): GrantResult => ({ status: 1, stderr: "permission denied" }),
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    // Polling still completed (transport returns granted on the 2nd call) →
    // init ends with a stored capability even though folddb exec failed.
    expect(result).toEqual({ state: "granted_inline", folddbUsed: false });
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
    expect(
      lines.some(
        (l) =>
          l.includes("`folddb consent grant` exited with status 1") &&
          l.includes("permission denied"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes("retry manually with `folddb consent grant fbrain`")),
    ).toBe(true);
  });
});

describe("establishConsentInline — enforcement off", () => {
  test("FBRAIN_APP_IDENTITY_ENFORCE=false → skipped, no transport calls", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: async () => {
        throw new Error("ask must not run when enforcement is off");
      },
      isTty: ttyOn,
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "skipped", reason: "enforce_off" });
    expect(transport.requestConsentCalls).toBe(0);
    expect(lines.some((l) => l.includes("enforcement off"))).toBe(true);
  });
});
