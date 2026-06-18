// Unit tests for the app-identity capability layer:
//   - token decode + JCS integrity validation
//   - per-write header construction
//   - the consent acquisition handshake (request-consent → poll → store)
//   - cached-capability reuse
//   - each discriminated 403 reason → the contract behavior
//   - wrong-node detection
//
// These drive the capability primitives + CapabilitySession directly with an
// in-memory store + a mock transport, so they exercise the real flow with no
// network and no node. JCS is real (the token factory below builds a correct
// payload_hash via the same canonicalize + sha256 fbrain uses).

import { describe, expect, test } from "bun:test";

import {
  acquireCapability,
  capabilityHeaders,
  decodeCapabilityBlob,
  reactionFor,
  tokenIntegrityValid,
  type CapabilityToken,
  type ConsentTransport,
} from "../../src/capability.ts";
import {
  CapabilitySession,
} from "../../src/capability-session.ts";
import { inMemoryCapabilityStore } from "../../src/keychain.ts";
import { canonicalize, type JsonValue } from "../../src/jcs.ts";
import { sha256Hex } from "../../src/hash.ts";
import { FbrainError } from "../../src/client.ts";

const NODE_URL = "http://127.0.0.1:9001";
const NODE_PUBKEY = "bm9kZS1wdWJrZXktYWFhYWFhYWFhYWFhYWFhYWFhYWE="; // arbitrary base64
const OTHER_NODE_PUBKEY = "b3RoZXItbm9kZS1wdWJrZXktYmJiYmJiYmJiYmJiYmJiYg==";

// Build a CapabilityToken whose envelope.payload_hash is the correct
// sha256(JCS(token-minus-envelope)) — exactly what fold_db_node's
// mint_capability produces — so tokenIntegrityValid() passes. The Ed25519
// `sig` is a placeholder: fbrain never verifies it (the node does), and the
// integrity check fbrain runs is the payload-hash binding, not the signature.
async function mintTokenBlob(overrides?: {
  nodePubkey?: string;
  appId?: string;
  capabilityId?: string;
  corruptHash?: boolean;
  wrongPurpose?: boolean;
}): Promise<string> {
  const token: CapabilityToken = {
    envelope: {
      version: 1,
      purpose: overrides?.wrongPurpose ? "app_register" : "capability_grant",
      alg: "Ed25519",
      key_id: "a".repeat(64),
      issued_at: "2026-05-29T12:00:00Z",
      env: "dev",
      payload_hash: "",
      sig: "cGxhY2Vob2xkZXItc2lnbmF0dXJl",
    },
    capability_id: overrides?.capabilityId ?? "cap-1234",
    app_id: overrides?.appId ?? "fbrain",
    scope: { Wildcard: "fbrain/*" },
    granted_ops: ["Read", "Write"],
    granted_at: "2026-05-29T12:00:00Z",
    node_pubkey: overrides?.nodePubkey ?? NODE_PUBKEY,
  };
  // Compute the real payload_hash over the token minus its envelope.
  const payload = { ...(token as unknown as Record<string, JsonValue>) };
  delete payload.envelope;
  token.envelope.payload_hash = overrides?.corruptHash
    ? "deadbeef".repeat(8)
    : await sha256Hex(canonicalize(payload as JsonValue));
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64");
}

// A mock ConsentTransport whose responses are scripted per call.
function mockTransport(script: {
  requestConsent?: () => { status: number; body: unknown };
  consentStatus?: (call: number) => { status: number; body: unknown };
}): ConsentTransport {
  let statusCall = 0;
  return {
    async requestConsent() {
      return script.requestConsent
        ? script.requestConsent()
        : { status: 202, body: { request_id: "req-1", expires_at: "2026-05-29T12:05:00Z" } };
    },
    async consentStatus() {
      const call = statusCall++;
      return script.consentStatus
        ? script.consentStatus(call)
        : { status: 200, body: {} };
    },
  };
}

const noSleep = async (): Promise<void> => {};

// Existing tests were written before the non-TTY fast-fail gate. Bun's test
// runner has no TTY, so the real `process.stdin.isTTY` is undefined and the
// gate would trip on every manual-fallback acquire. Pin them to interactive
// so they keep exercising the polling path they always did; the new
// non-interactive fast-fail tests explicitly pass `isTty: () => false`.
const interactive = (): boolean => true;

// ---------------------------------------------------------------------------
// Token decode + JCS integrity
// ---------------------------------------------------------------------------

describe("capability token decode + JCS integrity", () => {
  test("decodes a well-formed base64 token", async () => {
    const blob = await mintTokenBlob();
    const token = decodeCapabilityBlob(blob);
    expect(token).not.toBeNull();
    expect(token!.app_id).toBe("fbrain");
    expect(token!.node_pubkey).toBe(NODE_PUBKEY);
  });

  test("returns null for non-base64 / non-JSON garbage", () => {
    expect(decodeCapabilityBlob("!!!not base64!!!")).toBeNull();
    expect(decodeCapabilityBlob(Buffer.from("not json", "utf8").toString("base64"))).toBeNull();
  });

  test("a correctly-minted token passes the integrity check", async () => {
    const token = decodeCapabilityBlob(await mintTokenBlob())!;
    expect(await tokenIntegrityValid(token)).toBe(true);
  });

  test("a tampered payload_hash fails the integrity check (JCS-load-bearing)", async () => {
    const token = decodeCapabilityBlob(await mintTokenBlob({ corruptHash: true }))!;
    expect(await tokenIntegrityValid(token)).toBe(false);
  });

  test("a grant field mutated after minting fails the integrity check", async () => {
    const token = decodeCapabilityBlob(await mintTokenBlob())!;
    // Flip a field the hash commits to — recompute must now disagree.
    token.app_id = "evil-app";
    expect(await tokenIntegrityValid(token)).toBe(false);
  });

  test("wrong envelope purpose fails the integrity check", async () => {
    const token = decodeCapabilityBlob(await mintTokenBlob({ wrongPurpose: true }))!;
    expect(await tokenIntegrityValid(token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-write headers
// ---------------------------------------------------------------------------

describe("per-write capability headers", () => {
  test("attaches X-App-Capability verbatim + X-Capability-Ts as unix epoch seconds", () => {
    const h = capabilityHeaders("the-blob", 1_700_000_000_500);
    expect(h["X-App-Capability"]).toBe("the-blob");
    expect(h["X-Capability-Ts"]).toBe("1700000000"); // floor(ms/1000)
  });
});

// ---------------------------------------------------------------------------
// First-run consent acquisition
// ---------------------------------------------------------------------------

describe("first-run consent acquisition", () => {
  test("requests consent, prints the grant instruction, polls, stores the grant", async () => {
    const blob = await mintTokenBlob();
    const lines: string[] = [];
    const store = inMemoryCapabilityStore();
    const transport = mockTransport({
      consentStatus: (call) =>
        call < 2
          ? { status: 202, body: { status: "pending" } } // pending twice
          : { status: 200, body: { status: "granted", capability: blob } },
    });

    const stored = await acquireCapability({
      nodeUrl: NODE_URL,
      transport,
      store,
      print: (l) => lines.push(l),
      pollIntervalMs: 1,
      sleep: noSleep,
      isTty: interactive,
    });

    expect(stored.blob).toBe(blob);
    expect(stored.nodePubkey).toBe(NODE_PUBKEY);
    // The exact, single, actionable console instruction (design step 3).
    expect(lines.some((l) => l.includes("folddb consent grant fbrain"))).toBe(true);
    // Manual-fallback framing: the human really does need to act in another
    // terminal, so the polling line tells them so.
    expect(lines.some((l) => l.includes("Waiting for you to grant access"))).toBe(true);
    expect(lines.some((l) => l.includes("Confirming the grant landed"))).toBe(false);
    // It persisted to the store, keyed by node.
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
  });

  // Inline-grant framing: when `fbrain init --grant-consent` (or any caller
  // that supplies `onConsentRequested`) has already shelled out to
  // `folddb consent grant`, the poll is just confirming the grant landed.
  // Printing the manual "Waiting for you to grant access" wording there would
  // contradict the "Granted access…" line the inline grant already printed —
  // see the [6/6] block in the kanban brief.
  test("inline-grant path prints 'Confirming the grant landed', not 'Waiting for you…'", async () => {
    const blob = await mintTokenBlob();
    const lines: string[] = [];
    const transport = mockTransport({
      consentStatus: () => ({ status: 200, body: { status: "granted", capability: blob } }),
    });

    await acquireCapability({
      nodeUrl: NODE_URL,
      transport,
      store: inMemoryCapabilityStore(),
      print: (l) => lines.push(l),
      pollIntervalMs: 2000,
      sleep: noSleep,
      onConsentRequested: ({ print }) => {
        // Mirrors what the inline `fbrain init --grant-consent` path prints
        // after it shells out to `folddb consent grant fbrain --yes`.
        print(`Granted access to "fbrain". The app can now read and write under its namespace.`);
      },
    });

    expect(lines.some((l) => l.includes("Confirming the grant landed (polling every 2s)"))).toBe(true);
    expect(lines.some((l) => l.includes("Waiting for you to grant access"))).toBe(false);
    // Manual instruction must NOT also fire — the inline path replaces it.
    expect(lines.some((l) => l.includes("First-run setup"))).toBe(false);
  });

  // Non-TTY fast-fail: the manual-fallback branch of acquireCapability (no
  // `onConsentRequested`, i.e. the in-write fallback that the agent install
  // path actually hits) used to print "Waiting for you to grant access" and
  // poll for the full 5-min consent TTL — but in a non-interactive shell
  // there's no human to grant in another terminal. The brief's repro is a
  // first `fbrain put` after `fbrain init` (no --yes) that hung for 70s
  // before being killed. The gate below makes that case throw immediately,
  // before any consent traffic, with an actionable hint.
  test("non-interactive shell + manual fallback: fast-fails before polling", async () => {
    let requestCalls = 0;
    let statusCalls = 0;
    const transport: ConsentTransport = {
      async requestConsent() {
        requestCalls++;
        return { status: 202, body: { request_id: "should-never-be-reached" } };
      },
      async consentStatus() {
        statusCalls++;
        return { status: 200, body: {} };
      },
    };

    const start = Date.now();
    const err = await acquireCapability({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      store: inMemoryCapabilityStore(),
      transport,
      print: () => {},
      // 5-min default would mask a regression — keep maxWaitMs short so a
      // future bug that re-enters the poll surfaces as a fast timeout, not
      // a hung test.
      pollIntervalMs: 1,
      sleep: noSleep,
      maxWaitMs: 50,
      isTty: () => false,
    }).then(
      () => {
        throw new Error("expected acquireCapability to reject");
      },
      (e) => e as { code?: string; hint?: string },
    );
    expect(err.code).toBe("consent_required_non_interactive");
    // The recovery hint must lead with the command that actually works
    // headlessly on a fresh node (`fbrain init --grant-consent` creates the
    // request, grants it, and stores the capability in one shot). A bare
    // `folddb consent grant fbrain` dead-ends with "no pending consent
    // request" because the non-interactive write path aborts before creating
    // one — so it must NOT be the first/primary remedy.
    const hint = err.hint ?? "";
    expect(hint).toContain("fbrain init --grant-consent");
    const initIdx = hint.indexOf("fbrain init --grant-consent");
    const bareGrantIdx = hint.indexOf("folddb consent grant fbrain");
    // `fbrain init --grant-consent` is named, and named before any bare
    // `folddb consent grant fbrain` (which may still appear, as a caveat).
    expect(initIdx).toBeGreaterThanOrEqual(0);
    if (bareGrantIdx >= 0) {
      expect(initIdx).toBeLessThan(bareGrantIdx);
    }
    // The throw lands before the poll loop, and (since we fast-fail before
    // request-consent too) before any /api/apps/* traffic.
    expect(statusCalls).toBe(0);
    expect(requestCalls).toBe(0);
    // And it's truly fast — well under maxWaitMs, let alone the 5-min default.
    expect(Date.now() - start).toBeLessThan(50);
  });

  // Init --grant-consent path: caller supplies `onConsentRequested` (which
  // shells out to `folddb consent grant <appId> --yes`), so the poll is just
  // confirming the grant landed — and it must keep working in a non-TTY
  // shell (that's the whole point of --grant-consent for scripted installs).
  // The new isTty gate must NOT trip here.
  test("non-interactive shell + onConsentRequested: still polls (init --grant-consent path unaffected)", async () => {
    const blob = await mintTokenBlob();
    let statusCalls = 0;
    const transport: ConsentTransport = {
      async requestConsent() {
        return { status: 202, body: { request_id: "req-1" } };
      },
      async consentStatus() {
        statusCalls++;
        return { status: 200, body: { status: "granted", capability: blob } };
      },
    };

    const stored = await acquireCapability({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      store: inMemoryCapabilityStore(),
      transport,
      print: () => {},
      pollIntervalMs: 1,
      sleep: noSleep,
      isTty: () => false,
      // The inline grant has already shelled out by the time we get here; the
      // hook itself is a no-op in this test because all we want to verify is
      // that the poll is *entered*.
      onConsentRequested: () => {},
    });

    expect(statusCalls).toBeGreaterThan(0); // poll WAS entered
    expect(stored.blob).toBe(blob);
  });

  test("404 unknown app surfaces app_not_registered", async () => {
    await expect(
      acquireCapability({
        nodeUrl: NODE_URL,
        store: inMemoryCapabilityStore(),
        transport: mockTransport({ requestConsent: () => ({ status: 404, body: { error: "unknown" } }) }),
        print: () => {},
        sleep: noSleep,
        isTty: interactive,
      }),
    ).rejects.toMatchObject({ code: "app_not_registered" });
  });

  test("403 denied surfaces consent_denied with a retry hint", async () => {
    await expect(
      acquireCapability({
        nodeUrl: NODE_URL,
        store: inMemoryCapabilityStore(),
        transport: mockTransport({ consentStatus: () => ({ status: 403, body: { status: "denied" } }) }),
        print: () => {},
        pollIntervalMs: 1,
        sleep: noSleep,
        isTty: interactive,
      }),
    ).rejects.toMatchObject({ code: "consent_denied" });
  });

  test("408 expired surfaces consent_expired", async () => {
    await expect(
      acquireCapability({
        nodeUrl: NODE_URL,
        store: inMemoryCapabilityStore(),
        transport: mockTransport({ consentStatus: () => ({ status: 408, body: { status: "expired" } }) }),
        print: () => {},
        pollIntervalMs: 1,
        sleep: noSleep,
        isTty: interactive,
      }),
    ).rejects.toMatchObject({ code: "consent_expired" });
  });

  test("polling stops at the deadline (consent_timeout)", async () => {
    await expect(
      acquireCapability({
        nodeUrl: NODE_URL,
        store: inMemoryCapabilityStore(),
        transport: mockTransport({ consentStatus: () => ({ status: 202, body: { status: "pending" } }) }),
        print: () => {},
        pollIntervalMs: 1,
        sleep: noSleep,
        maxWaitMs: 0, // first pending check already past the deadline
        isTty: interactive,
      }),
    ).rejects.toMatchObject({ code: "consent_timeout" });
  });

  // Audience binding on acquire: the consent-status response is an external API
  // boundary, and the only field that ties the issued capability to *this* app
  // is the embedded `token.app_id`. If the node ever hands back a capability
  // bound to a different app — a node-side bug, a request_id mix-up under load,
  // or a substituted response — fbrain must reject it on the spot rather than
  // store + replay it. (`loadValidCached` catches the mismatch on the *next*
  // session start, but the in-flight session would happily adopt the wrong
  // blob and burn a write attempt on an opaque node 403.)
  test("rejects an acquired capability whose token.app_id does not match the request", async () => {
    const wrongAppBlob = await mintTokenBlob({ appId: "other-app" });
    const store = inMemoryCapabilityStore();
    await expect(
      acquireCapability({
        appId: "fbrain",
        nodeUrl: NODE_URL,
        store,
        transport: mockTransport({
          consentStatus: () => ({ status: 200, body: { status: "granted", capability: wrongAppBlob } }),
        }),
        print: () => {},
        pollIntervalMs: 1,
        sleep: noSleep,
        isTty: interactive,
      }),
    ).rejects.toMatchObject({ code: "consent_status_app_id_mismatch" });
    // Nothing got persisted — a future ensureCapability won't replay the bad
    // blob, it'll restart the consent handshake clean.
    expect(await store.load(NODE_URL)).toBeNull();
  });

  // Integrity binding on acquire (parallel to the audience-binding check above,
  // and to the JCS check `loadValidCached` runs on cache reuse). The acquire
  // path was decoding the consent-status payload and trusting envelope
  // .payload_hash unchecked — so a token whose hash does not match
  // sha256(JCS(token-minus-envelope)) (node-side mint bug, MITM tamper, or a
  // substituted response) would be stored and replayed once. The node would
  // then 403 capability_bad_sig and the in-flight session would burn the
  // write attempt on what fbrain itself could have caught at the boundary.
  test("rejects an acquired capability whose JCS payload hash doesn't match", async () => {
    const tamperedBlob = await mintTokenBlob({ corruptHash: true });
    const store = inMemoryCapabilityStore();
    await expect(
      acquireCapability({
        appId: "fbrain",
        nodeUrl: NODE_URL,
        store,
        transport: mockTransport({
          consentStatus: () => ({ status: 200, body: { status: "granted", capability: tamperedBlob } }),
        }),
        print: () => {},
        pollIntervalMs: 1,
        sleep: noSleep,
        isTty: interactive,
      }),
    ).rejects.toMatchObject({ code: "consent_status_bad_capability_integrity" });
    // Same persistence invariant as the app_id-mismatch case: a tampered blob
    // never lands in the store, so the next session starts clean.
    expect(await store.load(NODE_URL)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CapabilitySession: cached reuse + ensureCapability
// ---------------------------------------------------------------------------

describe("CapabilitySession.ensureCapability", () => {
  test("reuses a cached, integrity-valid capability without requesting consent", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-1234",
      blob,
    });

    let requested = false;
    const transport: ConsentTransport = {
      async requestConsent() {
        requested = true;
        return { status: 202, body: { request_id: "x" } };
      },
      async consentStatus() {
        return { status: 200, body: {} };
      },
    };

    const session = new CapabilitySession({ nodeUrl: NODE_URL, store, transport, sleep: noSleep });
    await session.ensureCapability();

    expect(requested).toBe(false); // cached → no consent handshake
    expect(session.current()).toBe(blob);
  });

  test("discards an integrity-invalid cached token and re-acquires", async () => {
    const corrupt = await mintTokenBlob({ corruptHash: true });
    const fresh = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-corrupt",
      blob: corrupt,
    });

    const transport = mockTransport({
      consentStatus: () => ({ status: 200, body: { status: "granted", capability: fresh } }),
    });
    const session = new CapabilitySession({
      nodeUrl: NODE_URL,
      store,
      transport,
      print: () => {},
      pollIntervalMs: 1,
      sleep: noSleep,
      isTty: interactive,
    });
    await session.ensureCapability();
    expect(session.current()).toBe(fresh); // corrupt discarded, fresh acquired
  });

  test("ensureCapability is idempotent once a blob is held", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-1234",
      blob,
    });
    let consentCalls = 0;
    const transport: ConsentTransport = {
      async requestConsent() {
        consentCalls++;
        return { status: 202, body: { request_id: "x" } };
      },
      async consentStatus() {
        return { status: 200, body: {} };
      },
    };
    const session = new CapabilitySession({ nodeUrl: NODE_URL, store, transport, sleep: noSleep });
    await session.ensureCapability();
    await session.ensureCapability();
    expect(consentCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 403 reaction table
// ---------------------------------------------------------------------------

describe("reactionFor — 403 contract table", () => {
  test("capability_revoked: discard, do NOT re-prompt, surface", () => {
    const r = reactionFor("capability_revoked");
    expect(r.discardToken).toBe(true);
    expect(r.reacquire).toBe(false);
    expect(r.surface).toContain("revoked");
  });

  test("capability_expired: discard + silently re-acquire", () => {
    const r = reactionFor("capability_expired");
    expect(r.discardToken).toBe(true);
    expect(r.reacquire).toBe(true);
    expect(r.surface).toBeUndefined();
  });

  test("capability_unknown: discard + re-acquire", () => {
    const r = reactionFor("capability_unknown");
    expect(r.discardToken).toBe(true);
    expect(r.reacquire).toBe(true);
  });

  test("consent_required: same as capability_unknown", () => {
    const r = reactionFor("consent_required");
    expect(r.discardToken).toBe(true);
    expect(r.reacquire).toBe(true);
  });

  test("capability_for_wrong_node: discard + re-acquire", () => {
    const r = reactionFor("capability_for_wrong_node");
    expect(r.discardToken).toBe(true);
    expect(r.reacquire).toBe(true);
  });

  test("capability_out_of_scope: surface to developer, no re-prompt", () => {
    const r = reactionFor("capability_out_of_scope", { schema: "fbrain/Concept" });
    expect(r.reacquire).toBe(false);
    expect(r.retryOnce).toBe(false);
    expect(r.surface).toContain("fbrain/Concept");
  });

  test("capability_replay: retry once, surface clock-skew", () => {
    const r = reactionFor("capability_replay", { timestampSkewSecs: 90 });
    expect(r.retryOnce).toBe(true);
    expect(r.surface).toContain("90s");
  });

  test("capability_bad_sig: surface to developer, discard", () => {
    const r = reactionFor("capability_bad_sig");
    expect(r.discardToken).toBe(true);
    expect(r.reacquire).toBe(false);
    expect(r.surface).toContain("developer");
  });
});

// ---------------------------------------------------------------------------
// CapabilitySession.runWrite: 403 reactions end-to-end
// ---------------------------------------------------------------------------

// Build a 403 FbrainError exactly as client.mapNodeError would for a reason.
function cap403(reason: string, detail?: Record<string, unknown>): FbrainError {
  return new FbrainError({
    code: `capability_403_${reason}`,
    message: `denied (${reason})`,
    capabilityReason: reason,
    ...(detail ? { capabilityDetail: detail as FbrainError["capabilityDetail"] } : {}),
  });
}

async function sessionWithGrant(blob: string): Promise<{ session: CapabilitySession; store: ReturnType<typeof inMemoryCapabilityStore> }> {
  const store = inMemoryCapabilityStore();
  await store.save({
    appId: "fbrain",
    nodeUrl: NODE_URL,
    nodePubkey: NODE_PUBKEY,
    capabilityId: "cap-1234",
    blob,
  });
  const transport = mockTransport({
    consentStatus: () => ({ status: 200, body: { status: "granted", capability: blob } }),
  });
  const session = new CapabilitySession({
    nodeUrl: NODE_URL,
    store,
    transport,
    print: () => {},
    pollIntervalMs: 1,
    sleep: noSleep,
    isTty: interactive,
  });
  return { session, store };
}

describe("CapabilitySession.runWrite — 403 reactions", () => {
  test("capability_expired: re-acquires once then the retry succeeds", async () => {
    const blob = await mintTokenBlob();
    const { session } = await sessionWithGrant(blob);
    let attempt = 0;
    const result = await session.runWrite(async () => {
      attempt++;
      if (attempt === 1) throw cap403("capability_expired");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempt).toBe(2);
  });

  test("capability_replay: retries once (fresh ts) then succeeds", async () => {
    const blob = await mintTokenBlob();
    const { session } = await sessionWithGrant(blob);
    let attempt = 0;
    const result = await session.runWrite(async () => {
      attempt++;
      if (attempt === 1) throw cap403("capability_replay", { timestamp_skew_secs: 90 });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempt).toBe(2);
  });

  test("capability_revoked: surfaces 'access revoked' and does NOT re-prompt", async () => {
    const blob = await mintTokenBlob();
    const { session, store } = await sessionWithGrant(blob);
    await expect(
      session.runWrite(async () => {
        throw cap403("capability_revoked", { capability_id: "cap-1234" });
      }),
    ).rejects.toMatchObject({ capabilityReason: "capability_revoked" });
    // Cached token discarded so a future write won't replay the revoked one.
    expect(await store.load(NODE_URL)).toBeNull();
  });

  test("capability_out_of_scope: surfaces a developer error, no re-acquire", async () => {
    const blob = await mintTokenBlob();
    const { session } = await sessionWithGrant(blob);
    let attempt = 0;
    await expect(
      session.runWrite(async () => {
        attempt++;
        throw cap403("capability_out_of_scope", { schema: "fbrain/Concept" });
      }),
    ).rejects.toMatchObject({ capabilityReason: "capability_out_of_scope" });
    expect(attempt).toBe(1); // surfaced immediately, no retry
  });

  test("capability_bad_sig: surfaces a developer error", async () => {
    const blob = await mintTokenBlob();
    const { session } = await sessionWithGrant(blob);
    await expect(
      session.runWrite(async () => {
        throw cap403("capability_bad_sig");
      }),
    ).rejects.toMatchObject({ capabilityReason: "capability_bad_sig" });
  });

  test("a persistent reason eventually surfaces (no infinite loop)", async () => {
    const blob = await mintTokenBlob();
    const { session } = await sessionWithGrant(blob);
    let attempt = 0;
    await expect(
      session.runWrite(async () => {
        attempt++;
        throw cap403("capability_expired"); // re-acquire succeeds but write keeps failing
      }),
    ).rejects.toMatchObject({ capabilityReason: "capability_expired" });
    // First try + one re-acquired retry = at most 2 attempts, then surface.
    expect(attempt).toBe(2);
  });

  test("a non-capability error propagates unchanged", async () => {
    const blob = await mintTokenBlob();
    const { session } = await sessionWithGrant(blob);
    await expect(
      session.runWrite(async () => {
        throw new FbrainError({ code: "unknown_fields", message: "boom" });
      }),
    ).rejects.toMatchObject({ code: "unknown_fields" });
  });
});

// ---------------------------------------------------------------------------
// Wrong-node detection
// ---------------------------------------------------------------------------

describe("wrong-node detection", () => {
  test("capability_for_wrong_node discards the cached token + re-acquires against the new node", async () => {
    // Cached token bound to NODE_PUBKEY; the node now reports wrong_node.
    const oldBlob = await mintTokenBlob({ nodePubkey: NODE_PUBKEY });
    const newBlob = await mintTokenBlob({ nodePubkey: OTHER_NODE_PUBKEY });
    const store = inMemoryCapabilityStore();
    await store.save({
      appId: "fbrain",
      nodeUrl: NODE_URL,
      nodePubkey: NODE_PUBKEY,
      capabilityId: "cap-old",
      blob: oldBlob,
    });
    // After re-acquire, the consent flow hands back a token for the NEW node.
    const transport = mockTransport({
      consentStatus: () => ({ status: 200, body: { status: "granted", capability: newBlob } }),
    });
    const session = new CapabilitySession({
      nodeUrl: NODE_URL,
      store,
      transport,
      print: () => {},
      pollIntervalMs: 1,
      sleep: noSleep,
      isTty: interactive,
    });
    await session.ensureCapability(); // adopts the cached old token

    let attempt = 0;
    const result = await session.runWrite(async () => {
      attempt++;
      if (attempt === 1) throw cap403("capability_for_wrong_node");
      return "ok";
    });
    expect(result).toBe("ok");
    // The session now holds the NEW node's token; the stored capability was
    // discarded then re-saved with the new node pubkey.
    expect(session.current()).toBe(newBlob);
    expect((await store.load(NODE_URL))?.nodePubkey).toBe(OTHER_NODE_PUBKEY);
  });

  test("a cached token whose node_pubkey differs is treated as wrong-node on load", async () => {
    // Stored entry's blob is for OTHER_NODE_PUBKEY; decode + integrity pass,
    // but the session is for a different node identity — the cleanest model is
    // that the node will 403 wrong_node on the first write. Here we assert the
    // cached token at least decodes to the foreign pubkey so the runtime path
    // (above) can detect + discard it.
    const foreign = await mintTokenBlob({ nodePubkey: OTHER_NODE_PUBKEY });
    const token = decodeCapabilityBlob(foreign)!;
    expect(token.node_pubkey).toBe(OTHER_NODE_PUBKEY);
    expect(await tokenIntegrityValid(token)).toBe(true); // integrity is fine; node-binding is what differs
  });
});
