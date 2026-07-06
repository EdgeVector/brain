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
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultRunFolddbGrant,
  establishConsentInline,
  folddbGrantTimeoutMs,
  loopbackPortFromUrl,
  looksLikeMasterKeyFailure,
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
    // The skip message must lead with the headless one-shot recovery
    // (`fbrain init --grant-consent`) — a bare `folddb consent grant fbrain`
    // dead-ends on a fresh node ("no pending consent request"), so if it's
    // mentioned at all it must come AFTER the working command as a caveat.
    const skipLine = lines.find((l) => l.includes("fbrain init --grant-consent"));
    expect(skipLine).toBeDefined();
    const initIdx = skipLine!.indexOf("fbrain init --grant-consent");
    const bareGrantIdx = skipLine!.indexOf("lastdb consent grant fbrain");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    if (bareGrantIdx >= 0) {
      expect(initIdx).toBeLessThan(bareGrantIdx);
    }
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
    expect(lines.some((l) => l.includes("lastdb consent grant fbrain"))).toBe(true);
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
          l.includes("`lastdb` not found on PATH") &&
          l.includes("lastdb consent grant fbrain"),
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

    const grantInvocations: Array<{ path: string; appId: string; nodeUrl: string }> = [];
    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: yesAsk,
      isTty: ttyOn,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (path, appId, nodeUrl) => {
        grantInvocations.push({ path, appId, nodeUrl });
        return { status: 0 };
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "granted_inline", folddbUsed: true });
    expect(grantInvocations).toEqual([
      { path: "/opt/homebrew/bin/folddb", appId: "fbrain", nodeUrl: NODE_URL },
    ]);
    expect(transport.requestConsentCalls).toBe(1);
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
    expect(
      lines.some((l) => l.includes("running `lastdb consent grant fbrain --yes`")),
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
          l.includes("`lastdb consent grant` exited with status 1") &&
          l.includes("permission denied"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes("retry manually with `lastdb consent grant fbrain`")),
    ).toBe(true);
  });

  // Repro from the brief: an enforced node started with FOLDDB_MASTER_KEY
  // (Lane-D durable-autostart shape), but the shell running `fbrain init`
  // doesn't have the key exported, so `folddb consent grant` exits 1 with
  // the encrypted-node-identity / keychain error. We want an fbrain-level
  // hint naming FOLDDB_MASTER_KEY — not the raw folddb error leaking with
  // only the generic "retry manually" line.
  test("folddb stderr names FOLDDB_MASTER_KEY → emits targeted master-key hint instead of the generic retry line", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const masterKeyStderr =
      "error: Cannot read existing node identity:\n" +
      "Encrypted node identity exists on disk, but this binary was built without the os-keychain\n" +
      "feature. Run from a build that has keychain access (the Tauri app), or set\n" +
      "FOLDDB_MASTER_KEY=<64-hex-bytes> to decrypt explicitly.";

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: yesAsk,
      isTty: ttyOn,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (): GrantResult => ({ status: 1, stderr: masterKeyStderr }),
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "granted_inline", folddbUsed: false });
    // The targeted hint MUST appear and name both the env var and the
    // re-run shape an operator can copy-paste.
    expect(
      lines.some(
        (l) =>
          l.includes("FOLDDB_MASTER_KEY") &&
          l.includes("fbrain init --grant-consent"),
      ),
    ).toBe(true);
    // The generic "retry manually" line MUST NOT appear on this branch —
    // re-running `folddb consent grant` in the same shell would fail the
    // same way, so leaking that hint is actively misleading.
    expect(
      lines.some((l) => l.includes("retry manually with `lastdb consent grant fbrain`")),
    ).toBe(false);
  });
});

// The freeze we're guarding against: a wedged folddb CLI (0.15.0 brew hangs on
// ANY startup) makes `fbrain init --grant-consent` hang forever at [6/6] with
// no feedback. defaultRunFolddbGrant now bounds the shell-out with a timeout
// and surfaces a distinct timedOut GrantResult; the handler degrades to a
// NEUTRAL "the CLI was slow; confirming whether the grant landed anyway" note
// instead of hanging — and crucially does NOT pre-print a prescriptive "grant
// manually / re-run fbrain doctor" recovery instruction, because the very next
// poll is the authoritative verdict (it owns the success line on success and
// the consent_timeout/denied/expired hints on genuine failure). Printing
// manual-recovery here contradicts the `Access granted.` success that follows
// on the (common) slow-but-landed happy path.
describe("establishConsentInline — folddb grant times out (slow CLI)", () => {
  test("timedOut GrantResult → prints a neutral 'confirming the grant landed' note (no stale manual-recovery), keeps polling (no hang)", async () => {
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
      // Simulate the wedged-binary outcome: spawnSync killed it on timeout.
      runFolddbGrant: (): GrantResult => ({ status: null, timedOut: true }),
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    // Polling still completed (transport returns granted on the 2nd call) — so
    // init reaches a stored capability via the manual fallback rather than
    // freezing. The whole point: it RETURNS.
    expect(result).toEqual({ state: "granted_inline", folddbUsed: false });
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
    // The timeout note must be NEUTRAL: it says the CLI is slow and that init
    // will confirm whether the grant landed anyway — it does NOT prescribe a
    // recovery path, because the poll is the authoritative verdict.
    expect(
      lines.some(
        (l) =>
          l.includes("is taking longer than") &&
          l.includes("confirming whether the grant landed"),
      ),
    ).toBe(true);
    // The stale, contradictory manual-recovery instruction MUST NOT be printed
    // before the poll's verdict — this was the bug: a "may be wedged / Grant
    // manually / re-run fbrain doctor" line appearing ABOVE a successful
    // `Access granted.` on the slow-but-landed happy path.
    expect(lines.some((l) => l.includes("may be wedged"))).toBe(false);
    expect(lines.some((l) => l.includes("re-run `fbrain doctor`"))).toBe(false);
    // The generic non-zero-exit "retry manually" / "exited with status" lines
    // MUST NOT appear — this is a distinct branch from a real exec failure.
    expect(
      lines.some((l) => l.includes("exited with status")),
    ).toBe(false);
    expect(
      lines.some((l) => l.includes("retry manually with `lastdb consent grant fbrain`")),
    ).toBe(false);
  });

  test("--grant-consent (non-TTY) path also degrades on timeout instead of hanging", async () => {
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
      isTty: ttyOff,
      nonInteractiveGrant: true,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (): GrantResult => ({ status: null, timedOut: true }),
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "granted_inline", folddbUsed: false });
    expect(lines.some((l) => l.includes("is taking longer than"))).toBe(true);
    expect(lines.some((l) => l.includes("may be wedged"))).toBe(false);
  });
});

// End-to-end of the actual shell-out guard: point defaultRunFolddbGrant at a
// real stub that sleeps far longer than a tiny override timeout and assert it
// returns a timedOut GrantResult in ~the timeout window rather than blocking
// for the stub's full sleep. This is the regression that the brief calls out:
// a hanging `folddb` binary must NOT freeze the grant.
describe("defaultRunFolddbGrant — bounded by FBRAIN_FOLDDB_GRANT_TIMEOUT_MS", () => {
  let dir: string;
  let savedTimeout: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fbrain-grant-timeout-"));
    savedTimeout = process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS;
  });
  afterEach(() => {
    if (savedTimeout === undefined) {
      delete process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS;
    } else {
      process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS = savedTimeout;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a folddb stub that sleeps > timeout → timedOut result, returns within the timeout window", () => {
    // Stub binary that hangs far longer than our override timeout. `exec` so
    // the shell is REPLACED by sleep — spawnSync's timeout SIGTERM then reaches
    // the sleep directly, leaving no orphan to keep the test process alive.
    const stub = join(dir, "hanging-folddb");
    writeFileSync(stub, "#!/bin/sh\nexec sleep 999\n", { mode: 0o755 });
    chmodSync(stub, 0o755);

    process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS = "300";
    expect(folddbGrantTimeoutMs()).toBe(300);

    const start = Date.now();
    const result = defaultRunFolddbGrant(stub, "fbrain", NODE_URL);
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    // It must NOT have waited the stub's full 999s — generous ceiling well
    // under the sleep so a hang is unambiguously caught.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("a folddb stub that exits 0 quickly → normal success result, not timedOut", () => {
    const stub = join(dir, "fast-folddb");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(stub, 0o755);

    process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS = "5000";
    const result = defaultRunFolddbGrant(stub, "fbrain", NODE_URL);

    expect(result.timedOut).toBeUndefined();
    expect(result.status).toBe(0);
  });
});

describe("folddbGrantTimeoutMs", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS;
    else process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS = saved;
  });

  test("defaults to 45000ms when the env var is unset", () => {
    delete process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS;
    expect(folddbGrantTimeoutMs()).toBe(45_000);
  });

  test("honours a positive-integer override", () => {
    process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS = "12000";
    expect(folddbGrantTimeoutMs()).toBe(12_000);
  });

  test("ignores non-positive / non-numeric overrides (falls back to default)", () => {
    for (const bad of ["0", "-1", "abc", "", "12.5"]) {
      process.env.FBRAIN_FOLDDB_GRANT_TIMEOUT_MS = bad;
      expect(folddbGrantTimeoutMs()).toBe(45_000);
    }
  });
});

describe("looksLikeMasterKeyFailure", () => {
  test("matches the env-var name in folddb's keychain error", () => {
    expect(
      looksLikeMasterKeyFailure("...set FOLDDB_MASTER_KEY=<64-hex-bytes>..."),
    ).toBe(true);
  });

  test("matches the os-keychain feature phrasing (wording drift safety net)", () => {
    expect(
      looksLikeMasterKeyFailure("built without the os-keychain feature"),
    ).toBe(true);
  });

  test("returns false for unrelated failures so we don't mis-route the generic hint", () => {
    expect(looksLikeMasterKeyFailure("permission denied")).toBe(false);
    expect(looksLikeMasterKeyFailure("connection refused")).toBe(false);
    expect(looksLikeMasterKeyFailure("")).toBe(false);
    expect(looksLikeMasterKeyFailure(undefined)).toBe(false);
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

// nonInteractiveGrant is the engine behind `fbrain init --grant-consent`:
// scripted / CI / agent installs that have no TTY but still need to reach a
// ready-to-write state in one shot. The flag itself is the operator's
// explicit approval (they typed it on the install command line), so we skip
// the [Y/n] ask and the non-TTY skip — but enforce-off and the
// already-granted idempotency still hold.
describe("establishConsentInline — nonInteractiveGrant (--grant-consent)", () => {
  test("non-TTY + nonInteractiveGrant → shells out, polls, stores; never calls ask", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const lines: string[] = [];

    const grantInvocations: Array<{ path: string; appId: string; nodeUrl: string }> = [];
    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: async () => {
        throw new Error("ask must not be called when nonInteractiveGrant is set");
      },
      isTty: ttyOff,
      nonInteractiveGrant: true,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (path, appId, nodeUrl) => {
        grantInvocations.push({ path, appId, nodeUrl });
        return { status: 0 };
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "granted_inline", folddbUsed: true });
    expect(grantInvocations).toEqual([
      { path: "/opt/homebrew/bin/folddb", appId: "fbrain", nodeUrl: NODE_URL },
    ]);
    expect(transport.requestConsentCalls).toBe(1);
    expect((await store.load(NODE_URL))?.blob).toBe(blob);
    // The non-TTY "skip" line MUST NOT appear when the operator opted in.
    expect(lines.some((l) => l.includes("non-interactive shell — skipping"))).toBe(false);
  });

  test("non-TTY + nonInteractiveGrant + folddb missing → fast-fail, no poll", async () => {
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
        throw new Error("ask must not be called when nonInteractiveGrant is set");
      },
      isTty: ttyOff,
      nonInteractiveGrant: true,
      resolveFolddb: () => null,
      runFolddbGrant: () => {
        throw new Error("runFolddbGrant must not run when folddb is missing");
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "skipped", reason: "no_folddb_bin" });
    // Crucially: never entered the up-to-5-min poll loop.
    expect(transport.requestConsentCalls).toBe(0);
    expect(transport.consentStatusCalls).toBe(0);
    expect(lines.some((l) => l.includes("not found on PATH"))).toBe(true);
  });

  test("live capability + nonInteractiveGrant → already_granted (idempotent re-run in scripts)", async () => {
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
    const lines: string[] = [];

    const result = await establishConsentInline({
      nodeUrl: NODE_URL,
      userHash: USER_HASH,
      store,
      transport,
      print: (l) => lines.push(l),
      ask: async () => {
        throw new Error("ask must not run when already granted");
      },
      isTty: ttyOff,
      nonInteractiveGrant: true,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: () => {
        throw new Error("runFolddbGrant must not run when already granted");
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "already_granted" });
    expect(transport.requestConsentCalls).toBe(0);
    expect(lines.some((l) => l.includes("already granted"))).toBe(true);
  });

  test("enforce-off + nonInteractiveGrant → skipped with a friendly no-op note (not silent failure)", async () => {
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
      isTty: ttyOff,
      nonInteractiveGrant: true,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: () => {
        throw new Error("runFolddbGrant must not run when enforcement is off");
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ state: "skipped", reason: "enforce_off" });
    expect(transport.requestConsentCalls).toBe(0);
    // The operator typed --grant-consent; tell them it was a no-op so they
    // don't think the flag silently failed.
    expect(
      lines.some(
        (l) => l.includes("enforcement off") && l.includes("--grant-consent is a no-op"),
      ),
    ).toBe(true);
  });
});

// The regression we're guarding: without threading nodeUrl into the grant
// shell-out, `folddb consent grant` discovers its target by reading
// `$FOLDDB_HOME/port` — which can point at a sibling daemon, leaving fbrain's
// first write stalled forever. We propagate the URL through the seam so the
// default impl can pin FOLDDB_PORT at the right daemon.
describe("establishConsentInline — node targeting", () => {
  test("runFolddbGrant receives the fbrain --node-url so the default impl can pin FOLDDB_PORT", async () => {
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const slottedNode = "http://127.0.0.1:9123";

    const seenUrls: string[] = [];
    await establishConsentInline({
      nodeUrl: slottedNode,
      userHash: USER_HASH,
      store,
      transport,
      print: () => {},
      ask: yesAsk,
      isTty: ttyOn,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (_path, _appId, nodeUrl) => {
        seenUrls.push(nodeUrl);
        return { status: 0 };
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(seenUrls).toEqual([slottedNode]);
    // loopbackPortFromUrl is what defaultRunFolddbGrant uses to derive
    // FOLDDB_PORT — assert it gives the slotted port, not 9001 (the brew
    // default that the portfile would point at).
    expect(loopbackPortFromUrl(slottedNode)).toBe(9123);
  });

  test("--grant-consent path also threads nodeUrl into runFolddbGrant", async () => {
    // The non-interactive path is the one most likely to run on ephemeral /
    // slotted nodes (CI, agents), so it's the place the misrouting hurts most.
    const blob = await mintTokenBlob();
    const store = inMemoryCapabilityStore();
    const transport = scriptedTransport(blob);
    const slottedNode = "http://127.0.0.1:19999";

    const seenUrls: string[] = [];
    await establishConsentInline({
      nodeUrl: slottedNode,
      userHash: USER_HASH,
      store,
      transport,
      print: () => {},
      isTty: ttyOff,
      nonInteractiveGrant: true,
      resolveFolddb: () => "/opt/homebrew/bin/folddb",
      runFolddbGrant: (_path, _appId, nodeUrl) => {
        seenUrls.push(nodeUrl);
        return { status: 0 };
      },
      sleep: noSleep,
      pollIntervalMs: 1,
    });

    expect(seenUrls).toEqual([slottedNode]);
  });
});

describe("loopbackPortFromUrl", () => {
  test("returns the port for loopback hosts with an explicit port", () => {
    expect(loopbackPortFromUrl("http://127.0.0.1:9001")).toBe(9001);
    expect(loopbackPortFromUrl("http://127.0.0.1:9123")).toBe(9123);
    expect(loopbackPortFromUrl("http://localhost:9001")).toBe(9001);
    expect(loopbackPortFromUrl("http://LOCALHOST:9001")).toBe(9001);
    expect(loopbackPortFromUrl("http://[::1]:9001")).toBe(9001);
  });

  test("returns null for non-loopback hosts (don't break remote-node setups)", () => {
    expect(loopbackPortFromUrl("http://node.example.com:9001")).toBeNull();
    expect(loopbackPortFromUrl("http://10.0.0.5:9001")).toBeNull();
    expect(loopbackPortFromUrl("http://192.168.1.10:9001")).toBeNull();
  });

  test("returns null when no port is set (fall back to folddb portfile discovery)", () => {
    expect(loopbackPortFromUrl("http://127.0.0.1")).toBeNull();
    expect(loopbackPortFromUrl("http://localhost/")).toBeNull();
  });

  test("returns null for unparseable URLs", () => {
    expect(loopbackPortFromUrl("not a url")).toBeNull();
    expect(loopbackPortFromUrl("")).toBeNull();
  });
});
