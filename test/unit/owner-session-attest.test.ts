// Unit tests for owner-session attestation (the app-isolation flip, fold#739).
//
// fbrain mints a one-time pairing code over the node's UDS control socket,
// exchanges it for a session token over TCP, and presents that token as
// `X-Folddb-Session` on every node request — mirroring the CLI's
// `attest_owner_session` (fold_db_node `src/bin/folddb/commands/ui.rs`). These
// tests pin: (1) the socketless fallback (no socket → null → no header → fbrain
// behaves exactly as today), (2) the happy mint+exchange path attaches the
// header to a node read, and (3) a `transport_not_attested` 403 re-pairs once
// and retries.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FOLDDB_SESSION_HEADER,
  attestOwnerSession,
  newNodeClient,
} from "../../src/client.ts";

const realFetch = globalThis.fetch;
// The unit-suite preload (test/setup.ts) points FBRAIN_FOLDDB_SOCKET at a
// nonexistent path so attestation stays inert by default. Capture that suite
// default so each test that opts into a real fixture socket can restore it.
const suiteSocketEnv = process.env.FBRAIN_FOLDDB_SOCKET;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (suiteSocketEnv === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
  else process.env.FBRAIN_FOLDDB_SOCKET = suiteSocketEnv;
});

// A throwaway path that exists on disk (so existsSync passes) standing in for
// the node's control socket. We never actually speak UDS — the mint fetch is
// stubbed — but the helper guards on existsSync(socketPath) before fetching,
// so the path must be real for the mint branch to run. The env override is the
// highest-precedence socket selector (it wins over opts.socketPath and the
// default), so point it at this fixture: the suite preload pins it elsewhere
// to stay hermetic, and a test that wants attestation to actually fire must
// re-point it here. afterEach restores the suite default.
function fakeSocket(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-sock-"));
  const path = join(dir, "folddb.sock");
  writeFileSync(path, "");
  process.env.FBRAIN_FOLDDB_SOCKET = path;
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("attestOwnerSession", () => {
  test("no socket → null (proceed unattested), issues no fetch", async () => {
    let fetched = false;
    globalThis.fetch = (async (): Promise<Response> => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const token = await attestOwnerSession(
      "http://127.0.0.1:9311",
      "/nonexistent/path/folddb.sock",
    );
    expect(token).toBeNull();
    expect(fetched).toBe(false);
  });

  test("mint + exchange → returns the session token", async () => {
    const sock = fakeSocket();
    try {
      const seen: string[] = [];
      globalThis.fetch = (async (input: unknown): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);
        seen.push(url);
        if (url.includes("/control/browser-pairing-code")) {
          return new Response(JSON.stringify({ pairing_code: "code-xyz" }), { status: 200 });
        }
        if (url.includes("/api/session/browser-pair")) {
          return new Response(JSON.stringify({ session_token: "tok-123" }), { status: 200 });
        }
        return new Response("{}", { status: 500 });
      }) as unknown as typeof globalThis.fetch;
      const token = await attestOwnerSession("http://127.0.0.1:9311", sock.path);
      expect(token).toBe("tok-123");
      expect(seen.some((u) => u.includes("/control/browser-pairing-code"))).toBe(true);
      expect(seen.some((u) => u.includes("/api/session/browser-pair"))).toBe(true);
    } finally {
      sock.cleanup();
    }
  });

  test("mint refused (non-2xx) → null, no exchange attempted", async () => {
    const sock = fakeSocket();
    try {
      let exchangeCalled = false;
      globalThis.fetch = (async (input: unknown): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);
        if (url.includes("/api/session/browser-pair")) exchangeCalled = true;
        return new Response("{}", { status: 403 });
      }) as unknown as typeof globalThis.fetch;
      const token = await attestOwnerSession("http://127.0.0.1:9311", sock.path);
      expect(token).toBeNull();
      expect(exchangeCalled).toBe(false);
    } finally {
      sock.cleanup();
    }
  });
});

describe("newNodeClient owner-session header injection", () => {
  test("attested node: X-Folddb-Session attached to a node read", async () => {
    const sock = fakeSocket();
    try {
      const headersSeen: Array<Record<string, string>> = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (url.includes("/control/browser-pairing-code")) {
          return new Response(JSON.stringify({ pairing_code: "code-xyz" }), { status: 200 });
        }
        if (url.includes("/api/session/browser-pair")) {
          return new Response(JSON.stringify({ session_token: "tok-123" }), { status: 200 });
        }
        // The actual node read (/api/schemas).
        headersSeen.push(hdrs);
        return new Response(JSON.stringify({ schemas: [] }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const c = newNodeClient({
        baseUrl: "http://127.0.0.1:9311",
        userHash: "u",
        socketPath: sock.path,
      });
      await c.listLoadedSchemas();
      expect(headersSeen.length).toBe(1);
      expect(headersSeen[0]?.[FOLDDB_SESSION_HEADER]).toBe("tok-123");
    } finally {
      sock.cleanup();
    }
  });

  test("socketless node: no session header, request still made (back-compat)", async () => {
    const headersSeen: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      headersSeen.push(hdrs);
      return new Response(JSON.stringify({ schemas: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({
      baseUrl: "http://127.0.0.1:9311",
      userHash: "u",
      socketPath: "/nonexistent/path/folddb.sock",
    });
    await c.listLoadedSchemas();
    expect(headersSeen.length).toBe(1);
    expect(headersSeen[0]?.[FOLDDB_SESSION_HEADER]).toBeUndefined();
    expect(headersSeen[0]?.["X-User-Hash"]).toBe("u");
  });

  test("transport_not_attested 403 → re-pair once and retry", async () => {
    const sock = fakeSocket();
    try {
      let readAttempts = 0;
      let mintCount = 0;
      const tokens = ["tok-stale", "tok-fresh"];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);
        if (url.includes("/control/browser-pairing-code")) {
          return new Response(JSON.stringify({ pairing_code: `c${mintCount}` }), { status: 200 });
        }
        if (url.includes("/api/session/browser-pair")) {
          const t = tokens[mintCount] ?? "tok-fresh";
          mintCount++;
          return new Response(JSON.stringify({ session_token: t }), { status: 200 });
        }
        // First read with the stale token → 403; retried read with the fresh
        // token → 200.
        readAttempts++;
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (hdrs[FOLDDB_SESSION_HEADER] === "tok-stale") {
          return new Response(JSON.stringify({ error: "transport_not_attested" }), { status: 403 });
        }
        return new Response(JSON.stringify({ schemas: [] }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const c = newNodeClient({
        baseUrl: "http://127.0.0.1:9311",
        userHash: "u",
        socketPath: sock.path,
      });
      await c.listLoadedSchemas();
      // Two read attempts (stale 403 → re-pair → fresh 200), two mints.
      expect(readAttempts).toBe(2);
      expect(mintCount).toBe(2);
    } finally {
      sock.cleanup();
    }
  });
});
