// Unit tests for client.ts's Error Registry — mock fetch, assert that
// every Error Registry row maps to a recognisable FbrainError.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FbrainError,
  isNodeReachableButErroring,
  mapNodeError,
  newNodeClient,
  newSchemaServiceClient,
  nodeDownHint,
  nodeHttpErrorHint,
  nodePortOf,
  schemaDownHint,
} from "../../src/client.ts";

type MockResponse = { status: number; body?: unknown };

const realFetch = globalThis.fetch;

function installMock(responses: MockResponse[] | ((url: string) => MockResponse)): void {
  let i = 0;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const next: MockResponse =
      typeof responses === "function" ? responses(url) : responses[i++] ?? { status: 500 };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("client error mapping", () => {
  // Regression: a LOCAL (loopback) node is socket-only — when the socket connect
  // fails, the client must NOT fall back to the retired loopback TCP port. Every
  // fetch attempt must carry a `unix:` socket, and the error must be the
  // socket-accurate diagnostic, never a ":9001" message. (The harness points
  // FBRAIN_FOLDDB_SOCKET at a guaranteed-nonexistent path — test/setup.ts.)
  test("loopback node never falls back to TCP — every attempt is over a unix socket", async () => {
    const calls: Array<{ url: string; unix?: string }> = [];
    globalThis.fetch = (async (
      input: unknown,
      init?: RequestInit & { unix?: string },
    ): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : String(input), unix: init?.unix });
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    let caught: unknown;
    try {
      await c.health();
    } catch (e) {
      caught = e;
    }
    // At least one attempt was made, and EVERY attempt carried a unix socket —
    // i.e. a bare TCP fetch was never issued.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((x) => typeof x.unix === "string" && x.unix.length > 0)).toBe(true);
    // Socket-accurate diagnostic, never the retired :9001 port.
    expect(caught).toBeInstanceOf(FbrainError);
    const fe = caught as FbrainError;
    expect(fe.code).toBe("service_unreachable");
    expect(fe.message).not.toContain("9001");
  });

  // Regression (papercut-fbrain-cli-socket-route-regression, 2026-07-04): the
  // WRITE/mutation path rides the SDK transport (`fetchTransport`), which — unlike
  // the read path (`verboseFetch`, pinned above) — still fell through to the
  // retired loopback TCP port when the existsSync-gated socket selection returned
  // null. A local `fbrain put` then failed with "node not reachable at
  // http://127.0.0.1:9001" even with `FBRAIN_FOLDDB_SOCKET` set. A LOCAL node is
  // socket-only for writes too: every attempt must carry a `unix:` socket, and a
  // down node must produce the socket-accurate diagnostic — never a `:9001`
  // message that misreports the socket config as ignored.
  test("loopback WRITE never falls back to TCP — every attempt is over a unix socket", async () => {
    const calls: Array<{ url: string; unix?: string }> = [];
    globalThis.fetch = (async (
      input: unknown,
      init?: RequestInit & { unix?: string },
    ): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : String(input), unix: init?.unix });
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    let caught: unknown;
    try {
      await c.createRecord({ schemaHash: "abc", fields: { slug: "x" }, keyHash: "x" });
    } catch (e) {
      caught = e;
    }
    // At least one attempt was made, and EVERY attempt carried a unix socket —
    // i.e. a bare TCP fetch to the retired :9001 port was never issued.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((x) => typeof x.unix === "string" && x.unix.length > 0)).toBe(true);
    expect(calls.every((x) => !x.url.includes("9001"))).toBe(true);
    expect(caught).toBeInstanceOf(FbrainError);
    const fe = caught as FbrainError;
    expect(fe.code).toBe("service_unreachable");
    expect(fe.message).not.toContain("9001");
  });

  // The write-path twin of the read-path diagnostics below: a MISSING socket
  // (config honored, but the node is down) reports "Unix socket not found" —
  // NOT a :9001 message. This is the "socket config ignored" vs "real socket
  // outage" distinction the card's END STATE requires, proven on the write path.
  test("local WRITE with a missing socket reports the absent Unix socket, not retired :9001", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-write-missing-socket-"));
    const socketPath = join(dir, "folddb.sock");
    const priorSocket = process.env.FBRAIN_FOLDDB_SOCKET;
    process.env.FBRAIN_FOLDDB_SOCKET = socketPath;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      await c.createRecord({ schemaHash: "abc", fields: { slug: "x" }, keyHash: "x" });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("service_unreachable");
      expect(fe.message).toContain("node not running");
      expect(fe.message).toContain("Unix socket not found");
      expect(fe.message).toContain(socketPath);
      expect(fe.message).not.toContain("http://127.0.0.1:9001");
    } finally {
      if (priorSocket === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
      else process.env.FBRAIN_FOLDDB_SOCKET = priorSocket;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other side of that distinction on the write path: a socket that EXISTS
  // but refuses the connection is a genuine outage of THAT socket — reported as
  // "node socket not reachable at unix:<path>", never a TCP-fallback :9001
  // message. Pins that the write path never silently retries the retired port.
  test("local WRITE with a stale socket reports the Unix socket that refused, not retired :9001", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-write-stale-socket-"));
    const socketPath = join(dir, "folddb.sock");
    writeFileSync(socketPath, "");
    const priorSocket = process.env.FBRAIN_FOLDDB_SOCKET;
    process.env.FBRAIN_FOLDDB_SOCKET = socketPath;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit & { unix?: string }) => {
      if (init?.unix) throw new TypeError("connection refused on unix socket");
      throw new TypeError("connection refused on tcp fallback");
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      await c.createRecord({ schemaHash: "abc", fields: { slug: "x" }, keyHash: "x" });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("service_unreachable");
      expect(fe.message).toContain(`node socket not reachable at unix:${socketPath}`);
      expect(fe.message).not.toContain("node not reachable at http://127.0.0.1:9001");
    } finally {
      if (priorSocket === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
      else process.env.FBRAIN_FOLDDB_SOCKET = priorSocket;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remote READ uses the configured URL even when a local socket exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-remote-read-socket-"));
    const socketPath = join(dir, "folddb.sock");
    writeFileSync(socketPath, "");
    const calls: Array<{ url: string; unix?: string }> = [];
    globalThis.fetch = (async (
      input: unknown,
      init?: RequestInit & { unix?: string },
    ): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : String(input), unix: init?.unix });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = newNodeClient({
        baseUrl: "http://10.0.0.1:9001",
        userHash: "u",
        socketPath,
      });
      await c.health();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((x) => x.unix === undefined)).toBe(true);
      expect(calls.some((x) => x.url === "http://10.0.0.1:9001/api/health")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remote WRITE uses the configured URL even when a local socket exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-remote-write-socket-"));
    const socketPath = join(dir, "folddb.sock");
    writeFileSync(socketPath, "");
    const calls: Array<{ url: string; unix?: string }> = [];
    globalThis.fetch = (async (
      input: unknown,
      init?: RequestInit & { unix?: string },
    ): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : String(input), unix: init?.unix });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = newNodeClient({
        baseUrl: "http://10.0.0.1:9001",
        userHash: "u",
        socketPath,
      });
      await c.createRecord({ schemaHash: "abc", fields: { slug: "x" }, keyHash: "x" });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((x) => x.unix === undefined)).toBe(true);
      expect(calls.some((x) => x.url.startsWith("http://10.0.0.1:9001"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("node 503 node_not_provisioned → identity{provisioned:false}", async () => {
    installMock([{ status: 503, body: { error: "node_not_provisioned" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    const r = await c.autoIdentity();
    expect(r.provisioned).toBe(false);
  });

  test("node /api/health 200 → parses { ok, uptime_s, version }", async () => {
    installMock([{ status: 200, body: { ok: true, uptime_s: 12, version: "0.14.1" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    const h = await c.health();
    expect(h).toEqual({ ok: true, uptime_s: 12, version: "0.14.1" });
  });

  test("node /api/health 200 without a version → version omitted (tolerate older nodes)", async () => {
    installMock([{ status: 200, body: { ok: true, uptime_s: 7 } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    const h = await c.health();
    expect(h.ok).toBe(true);
    expect(h.uptime_s).toBe(7);
    expect(h.version).toBeUndefined();
  });

  test("node /api/health non-200 → throws a FbrainError", async () => {
    installMock([{ status: 500, body: { error: "boom" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    await expect(c.health()).rejects.toBeInstanceOf(FbrainError);
  });

  test("node 401 MISSING_USER_CONTEXT maps to missing_user_context", async () => {
    installMock([{ status: 401, body: { code: "MISSING_USER_CONTEXT", error: "MISSING_USER_CONTEXT" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    try {
      await c.loadSchemas();
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("missing_user_context");
    }
  });

  // Regression: the real fold_db_node's missing_user_context_response()
  // (fold_db_node/src/utils/http_errors.rs) puts the discriminator in `code`
  // and a human sentence in `error`:
  //   { ok:false, code:"MISSING_USER_CONTEXT", error:"Authentication required. Please provide X-User-Hash header.", next:"GET /api/system/auto-identity" }
  // mapNodeError was reading the `error` field for the literal token
  // "MISSING_USER_CONTEXT" — which the real node NEVER sends in `error`;
  // that field carries the human sentence. The msg-side fallback
  // (`msg?.includes("Authentication")`) reads `message`, but the node
  // doesn't populate `message` either. Net effect: every real 401 from
  // a deployed daemon fell through to the generic `node_http_401` mapping
  // and the actionable "Re-run `fbrain init`" hint never reached the
  // user. Pin the real shape so the discriminator lands.
  test("node 401 with the real fold_db_node body shape (discriminator in `code`) maps to missing_user_context", async () => {
    installMock([{
      status: 401,
      body: {
        ok: false,
        code: "MISSING_USER_CONTEXT",
        error: "Authentication required. Please provide X-User-Hash header.",
        next: "GET /api/system/auto-identity",
      },
    }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    try {
      await c.loadSchemas();
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("missing_user_context");
      expect(fe.message).toContain("missing X-User-Hash");
      expect(fe.hint ?? "").toContain("fbrain init");
    }
  });

  test("node 409 ambiguous_schema_name maps to ambiguous_schema_name", async () => {
    installMock([
      {
        status: 409,
        body: {
          ok: false,
          error: "ambiguous_schema_name",
          schema_name: "Design",
          ambiguous_schemas: ["aaa", "bbb"],
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    try {
      await c.queryAll({ schemaHash: "Design", fields: ["slug"], allowFullScan: true });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("ambiguous_schema_name");
      expect((err as FbrainError).message).toContain("aaa");
      expect((err as FbrainError).message).toContain("bbb");
    }
  });

  test("node 400 unknown_fields maps to unknown_fields", async () => {
    installMock([{ status: 400, body: { error: "unknown_fields", message: "no field foo" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9101", userHash: "u" });
    try {
      await c.queryAll({ schemaHash: "h", fields: ["foo"], allowFullScan: true });
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("unknown_fields");
    }
  });

  test("bootstrap 410 onboarding_already_complete surfaces node message + drops obsolete hint", async () => {
    // Reproduces the real homebrew daemon's contradictory state — auto-identity
    // says not_provisioned, bootstrap returns 410 with a pointer at /api/auth/restore.
    installMock([
      {
        status: 410,
        body: {
          ok: false,
          error: "onboarding_already_complete",
          message:
            "This node has already been bootstrapped. POST /api/auth/restore to restore from a recovery phrase.",
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.bootstrap("x");
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("onboarding_already_complete");
      // The node's own message field must be surfaced so the user sees the
      // /api/auth/restore suggestion the daemon supplied.
      expect(fe.message).toContain("/api/auth/restore");
      // The misleading "should probe /api/system/auto-identity first" hint
      // is gone — init.ts already probes that endpoint at step [1/5].
      expect(fe.message).not.toContain("should probe");
      expect(fe.hint ?? "").not.toContain("should probe");
      // Hint references the three actionable recovery paths.
      expect(fe.hint ?? "").toContain("~/.fbrain/config.json");
      // The "start fresh" recovery path is built from resolveNodeHome(), so it
      // points at the dev's real node home rather than a hardcoded ~/.folddb.
      // With LASTDB_HOME set below it resolves to that explicit home's config/.
    }
  });

  test("bootstrap 410 recovery hint derives the reset path from resolveNodeHome (lastdb rebrand)", async () => {
    // The FoldDB→LastDB rebrand moved the onboarding state from ~/.folddb/config
    // to ~/.lastdb/config on a v0.15.1+ node; the recovery hint must point at the
    // resolved home (LASTDB_HOME wins), not a dead hardcoded ~/.folddb path.
    const priorLastdb = process.env.LASTDB_HOME;
    const priorFolddb = process.env.FOLDDB_HOME;
    process.env.LASTDB_HOME = "/tmp/lastdb-fixture-home";
    delete process.env.FOLDDB_HOME;
    try {
      installMock([
        {
          status: 410,
          body: { ok: false, error: "onboarding_already_complete", message: "already bootstrapped" },
        },
      ]);
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      try {
        await c.bootstrap("x");
        throw new Error("did not throw");
      } catch (err) {
        const fe = err as FbrainError;
        // Points at the resolved home's config dir, NOT the dead ~/.folddb/config.
        expect(fe.hint ?? "").toContain("/tmp/lastdb-fixture-home/config/");
        expect(fe.hint ?? "").not.toContain("~/.folddb/config/");
      }
      // Back-compat: a legacy 0.14.x layout (only FOLDDB_HOME) still resolves to
      // its ~/.folddb-style config dir.
      delete process.env.LASTDB_HOME;
      process.env.FOLDDB_HOME = "/tmp/folddb-legacy-home";
      installMock([
        {
          status: 410,
          body: { ok: false, error: "onboarding_already_complete", message: "already bootstrapped" },
        },
      ]);
      const c2 = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      try {
        await c2.bootstrap("x");
        throw new Error("did not throw");
      } catch (err) {
        const fe = err as FbrainError;
        expect(fe.hint ?? "").toContain("/tmp/folddb-legacy-home/config/");
      }
    } finally {
      if (priorLastdb === undefined) delete process.env.LASTDB_HOME;
      else process.env.LASTDB_HOME = priorLastdb;
      if (priorFolddb === undefined) delete process.env.FOLDDB_HOME;
      else process.env.FOLDDB_HOME = priorFolddb;
    }
  });

  test("search 400 'Failed to retrieve model.onnx' (error-field shape) → embedding_model_unavailable + folddb daemon restart hint", async () => {
    // Reproduces the exact body the homebrew fold_db_node returns on
    // GET /api/native-index/search?q=… when its on-disk ONNX cache is
    // missing or corrupt — typically after `brew upgrade folddb`.
    // The current homebrew daemon puts the failure text in `error`
    // (no `message` field); the opaque ONNX error has historically been
    // the #1 papercut on `fbrain search` / `fbrain ask`. We grep both
    // fields so future daemon versions that move the text to `message`
    // keep matching.
    installMock([
      {
        status: 400,
        body: {
          error:
            "Bad request: Schema error: Invalid data: Failed to init embedding model: Failed to retrieve model.onnx",
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.search("anything");
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("embedding_model_unavailable");
      expect(fe.message).toContain("Semantic search is unavailable");
      expect(fe.message).toContain("embedding model");
      expect(fe.message).toContain("fbrain doctor");
      expect(fe.hint ?? "").toContain("lastdb daemon stop && lastdb daemon start");
      expect(fe.hint ?? "").toContain("fbrain doctor --freshness");
      expect(fe.hint ?? "").toContain("~/Library/Logs/Homebrew/lastdb/");
      // The channel-neutral variant (shown over `hint` on the MCP boundary)
      // must carry none of that CLI/brew remediation an agent can't run.
      expect(fe.agentHint ?? "").not.toContain("lastdb daemon");
      expect(fe.agentHint ?? "").not.toContain("fbrain doctor");
      expect(fe.agentHint ?? "").not.toContain("brew");
      expect(fe.agentHint ?? "").toContain("operator");
    }
  });

  test("search 400 'Failed to retrieve model.onnx' (message-field shape) → embedding_model_unavailable", async () => {
    // Same condition, but with the failure text in `message` and a short
    // machine code in `error`. Pin both shapes so a future daemon refactor
    // can't silently regress the mapping.
    installMock([
      {
        status: 400,
        body: {
          error: "schema_error",
          message:
            "Bad request: Schema error: Invalid data: Failed to init embedding model: Failed to retrieve model.onnx",
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.search("anything");
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("embedding_model_unavailable");
      expect(fe.hint ?? "").toContain("lastdb daemon stop && lastdb daemon start");
    }
  });

  test("connection refused → service_unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:1", userHash: "u" });
    try {
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("service_unreachable");
      // Non-doctor callers (list/put/etc.) need to see the doctor tip in
      // the error message so they know where to look for a diagnosis.
      // Doctor strips this tip from its own output (see doctor.test.ts);
      // here we pin that connectionError still appends it for everyone else.
      expect((err as FbrainError).message).toContain("fbrain doctor");
    }
  });

  test("default local node down with no socket reports the missing Unix socket, not retired :9001", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-node-missing-socket-"));
    const socketPath = join(dir, "folddb.sock");
    const priorSocket = process.env.FBRAIN_FOLDDB_SOCKET;
    process.env.FBRAIN_FOLDDB_SOCKET = socketPath;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("service_unreachable");
      expect(fe.message).toContain("node not running");
      expect(fe.message).toContain("Unix socket not found");
      expect(fe.message).toContain(socketPath);
      expect(fe.message).not.toContain("http://127.0.0.1:9001");
      expect(fe.hint ?? "").toContain("Unix socket");
      expect(fe.hint ?? "").toContain("fbrain doctor");
      expect(fe.hint ?? "").toContain("LastDB.app");
      expect(fe.hint ?? "").toContain("run.sh --local");
      expect(fe.hint ?? "").not.toContain("brew services start lastdb");
      expect(fe.hint ?? "").not.toContain("brew services restart lastdb");
      expect(fe.agentHint ?? "").toContain("FBRAIN_FOLDDB_SOCKET");
    } finally {
      if (priorSocket === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
      else process.env.FBRAIN_FOLDDB_SOCKET = priorSocket;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default local node down with a stale socket reports the Unix socket that refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-node-stale-socket-"));
    const socketPath = join(dir, "folddb.sock");
    writeFileSync(socketPath, "");
    const priorSocket = process.env.FBRAIN_FOLDDB_SOCKET;
    process.env.FBRAIN_FOLDDB_SOCKET = socketPath;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit & { unix?: string }) => {
      if (init?.unix) throw new TypeError("connection refused on unix socket");
      throw new TypeError("connection refused on tcp fallback");
    }) as unknown as typeof globalThis.fetch;
    try {
      const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("service_unreachable");
      expect(fe.message).toContain(`node socket not reachable at unix:${socketPath}`);
      expect(fe.message).not.toContain("node not reachable at http://127.0.0.1:9001");
      expect(fe.hint ?? "").toContain("socket file exists");
      expect(fe.hint ?? "").toContain("did not accept a connection");
    } finally {
      if (priorSocket === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
      else process.env.FBRAIN_FOLDDB_SOCKET = priorSocket;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // DX: the legacy default install URL (`127.0.0.1:9001`) is NOT a transport
  // hint anymore. fbrain uses a Unix socket, so node-down guidance must lead
  // with the socket + doctor path and only include CLI/Homebrew wording as a
  // clearly conditional note.
  test("node-down hint leads with the Unix socket for the default install URL", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9001",
      () => false,
      () => false,
    );
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("folddb.sock");
    expect(hint).toContain("fbrain doctor");
    expect(hint).toContain("LastDB.app");
    expect(hint).toContain("lastdb daemon start");
    expect(hint).not.toContain("brew services start lastdb");
    expect(hint).not.toContain("brew install edgevector/lastdb/lastdb");
    expect(hint.indexOf("Unix socket")).toBeLessThan(hint.indexOf("lastdb daemon start"));
    expect(hint).not.toContain("compiling Rust");
  });

  test("node-down hint keeps the from-source/compile framing when no CLI install path is detected", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9101",
      () => false,
      () => false,
    );
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("fbrain doctor");
    expect(hint).toContain("LastDB.app");
    expect(hint).toContain("run.sh");
    expect(hint).toContain("compiles Rust");
    expect(hint).not.toContain("brew services");
  });

  // DX regression: a downloaded user whose `folddb` is on a non-9001 port
  // (port conflict, two nodes, custom `--node-url` at init) still gets the
  // socket-first path, plus a conditional CLI/Homebrew note. The prebuilt
  // binary on PATH is the signal for that extra note.
  test("node-down hint is socket-first for a non-9001 port when the prebuilt binary is on PATH", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9050",
      () => true,
      () => false,
    );
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("fbrain doctor");
    expect(hint).toContain("lastdb daemon start");
    expect(hint).not.toContain("brew services start lastdb");
    expect(hint.indexOf("Unix socket")).toBeLessThan(hint.indexOf("lastdb daemon start"));
    expect(hint).not.toContain("compiles Rust");
  });

  // DX (init-node-bound-to-target-port-not-serving-hint): when SOMETHING is
  // bound to the TARGET port but not answering (wedged, hung mid-boot, or still
  // starting), that's the most misdiagnosed failure — it looks identical to
  // "not started" to a naive reachability check, so the old hint told the dev
  // to re-install / `brew services restart`, which just re-hangs a wedged node.
  // When the target-port probe reports a listener, the hint must instead name
  // that a node IS bound to that URL but isn't responding, and tell the dev to
  // STOP it before restarting — NOT the bare install/restart line.
  test("node-down hint names 'bound but not responding' + stop-before-restart when something is listening on the target port", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9711",
      () => true, // binary installed
      () => true, // something IS listening on the target port
    );
    expect(hint).toContain("isn't responding");
    expect(hint).toContain("http://127.0.0.1:9711");
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("fbrain doctor");
    expect(hint).toContain("LastDB.app");
    expect(hint).toContain("stop it before restarting");
    expect(hint).not.toContain("brew services stop lastdb");
    // It must NOT lead the dev back into the install/`brew services restart`
    // reflex that re-hangs a wedged node.
    expect(hint).not.toContain("brew install edgevector/lastdb/lastdb");
    expect(hint).not.toContain("brew services start lastdb");
    expect(hint).not.toContain("brew services restart lastdb");
  });

  // The wedged branch wins regardless of the node URL or whether the prebuilt
  // binary is detected — a listener on the target port is a stronger signal
  // than either.
  test("node-down hint prefers the 'bound but not responding' branch over the not-started branch", () => {
    // Default :9001 daemon, binary NOT on PATH, but something IS listening.
    const hint = nodeDownHint(
      "http://127.0.0.1:9001",
      () => false,
      () => true,
    );
    expect(hint).toContain("isn't responding");
    expect(hint).not.toContain("brew install edgevector/lastdb/lastdb");
  });

  // The genuine not-started case (nothing listening on the target port) must be
  // socket-first even for a default/installed node.
  test("node-down hint keeps socket-first guidance when nothing is listening on the target port", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9001",
      () => true,
      () => false,
    );
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("fbrain doctor");
    expect(hint).toContain("LastDB.app");
    expect(hint).not.toContain("brew services start lastdb");
    expect(hint).not.toContain("isn't responding");
  });

  // CARD (fbrain-init-down-hint-scope-to-target-port) case (a): a node is alive
  // on a DIFFERENT port while the TARGET port is down. The target-port probe
  // reports false (nothing on the target port) even though a host-wide `pgrep`
  // would have matched the sibling node — so the dev must get the
  // socket-first not-started branch, NOT a false "wedged / stop lastdb".
  test("node-down hint: sibling node on a different port + target down ⇒ socket-first, NOT 'wedged/stop'", () => {
    // Simulate the dogfooded bug: target :9876 is down (nothing listening),
    // a sibling node is alive on :55564 — but the probe is scoped to :9876.
    const isTargetPortListening = (url: string) =>
      nodePortOf(url) === 55564; // only the sibling port has a listener
    const hint = nodeDownHint(
      "http://127.0.0.1:9876",
      () => true, // prebuilt binary on PATH (downloaded user)
      isTargetPortListening,
    );
    // Must NOT misdiagnose the down :9876 as wedged or tell the dev to stop
    // their (unrelated) running node.
    expect(hint).not.toContain("isn't responding");
    expect(hint).not.toContain("brew services stop lastdb");
    // Must give the correct socket-first start guidance.
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("fbrain doctor");
    expect(hint).not.toContain("brew services start lastdb");
  });

  // CARD case (b): something is bound to the TARGET port but not serving
  // (genuinely wedged). The probe reports true for that exact port ⇒ the
  // stop-before-restart guidance.
  test("node-down hint: listener bound to the TARGET port but not serving ⇒ 'wedged / stop before restart'", () => {
    const isTargetPortListening = (url: string) => nodePortOf(url) === 9876;
    const hint = nodeDownHint(
      "http://127.0.0.1:9876",
      () => true,
      isTargetPortListening,
    );
    expect(hint).toContain("isn't responding");
    expect(hint).toContain("stop it before restarting");
    expect(hint).toContain("Unix socket");
    expect(hint).toContain("fbrain doctor");
    expect(hint).not.toContain("brew services stop lastdb");
  });

  // The port extractor underpins the scoping — pin its behaviour.
  test("nodePortOf extracts the target port (and falls back to scheme default)", () => {
    expect(nodePortOf("http://127.0.0.1:9876")).toBe(9876);
    expect(nodePortOf("http://localhost:55564/")).toBe(55564);
    expect(nodePortOf("http://example.com")).toBe(80);
    expect(nodePortOf("https://example.com")).toBe(443);
    expect(nodePortOf("not a url")).toBeNull();
  });

  test("connectionError node hint is socket-first for the default daemon", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).hint ?? "").toContain("Unix socket");
      expect((err as FbrainError).hint ?? "").toContain("fbrain doctor");
      expect((err as FbrainError).hint ?? "").not.toContain("brew services start lastdb");
    }
  });

  // DX regression (29ced): a node that is REACHABLE but returns an HTTP
  // error (e.g. 500 because it can't decrypt its identity) must NOT be told
  // to "start the node" — it plainly answered. The error is a real
  // FbrainError (mapped from the node's 500), so isNodeReachableButErroring
  // is true and the caller should use nodeHttpErrorHint, not nodeDownHint.
  test("a transport failure is NOT classified as reachable-but-erroring", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      // Transport failure → service_unreachable → still "start the node".
      expect(isNodeReachableButErroring(err)).toBe(false);
    }
  });

  test("an HTTP 500 from a reachable node IS classified as reachable-but-erroring", async () => {
    installMock([
      {
        status: 500,
        body: {
          error:
            "Failed to initialize node identity: Security error: Encrypted node identity exists on disk, but this binary was built without the os-keychain feature. Set FOLDDB_MASTER_KEY=<64-hex-bytes> to decrypt explicitly.",
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      expect(isNodeReachableButErroring(err)).toBe(true);
      const hint = nodeHttpErrorHint(err);
      // The reachable-but-erroring hint must NOT carry the nodeDownHint
      // "start a process that isn't running" remedies.
      expect(hint).not.toContain("brew services");
      expect(hint).not.toContain("run.sh");
      // It recognises the identity/master-key failure and points at the fix.
      expect(hint).toContain("FOLDDB_MASTER_KEY");
    }
  });

  test("nodeHttpErrorHint falls back to a generic 'up but erroring' message for a non-identity HTTP error", () => {
    const err = new FbrainError({ code: "node_http_502", message: "Node /x returned HTTP 502." });
    const hint = nodeHttpErrorHint(err);
    expect(hint).not.toContain("brew services");
    expect(hint).not.toContain("run.sh");
    expect(hint).toContain("502");
  });

  // DX regression (e2925): runtime commands (search/list/put/get/…) that hit a
  // reachable-but-500ing node funnel through mapNodeError's generic 5xx
  // fallthrough — NOT through doctor's nodeHttpErrorHint path. Before this
  // fix the user saw the dead-end "Check the node log; this looks like a
  // node-side bug." for an identity decrypt failure that has a known one-line
  // fix. The identity heuristic now lives in a shared helper used by both
  // surfaces, so a runtime `fbrain search` hits the same FOLDDB_MASTER_KEY
  // remedy `fbrain doctor` already surfaces.
  test("mapNodeError 5xx identity body → hint names FOLDDB_MASTER_KEY (not 'node-side bug')", () => {
    const err = mapNodeError(
      500,
      {
        error:
          "Failed to initialize user context: Security error: Encrypted node identity exists on disk, but this binary was built without the os-keychain feature. Set FOLDDB_MASTER_KEY=<64-hex-bytes> to decrypt explicitly.",
      },
      "/api/native-index/search",
    );
    expect(err.code).toBe("node_http_500");
    expect(err.hint ?? "").toContain("FOLDDB_MASTER_KEY");
    // The old dead-end wording must be gone for this body — the actionable
    // remedy now lives in its place.
    expect(err.hint ?? "").not.toContain("node-side bug");
    // And it must not steer the user toward "start the node" — the node
    // plainly answered.
    expect(err.hint ?? "").not.toContain("brew services");
    expect(err.hint ?? "").not.toContain("run.sh");
  });

  test("mapNodeError 5xx non-identity body → hint points the user at `fbrain doctor`", () => {
    // A 5xx whose body does not name the identity path falls back to a
    // generic remedy that still gives the user somewhere to go — `fbrain
    // doctor` runs the full diagnosis. Before this fix the hint was a
    // dead-end "Check the node log" with no pointer at the diagnostic.
    const err = mapNodeError(500, { error: "internal server error: out of memory" }, "/api/query");
    expect(err.code).toBe("node_http_500");
    expect(err.hint ?? "").toContain("fbrain doctor");
    // The generic remedy doesn't accidentally trigger the identity heuristic
    // — the FOLDDB_MASTER_KEY wording is reserved for actual identity bodies.
    expect(err.hint ?? "").not.toContain("FOLDDB_MASTER_KEY");
  });

  // 4xx errors that fall through to the generic mapping should not carry the
  // 5xx-only `fbrain doctor` pointer — the brief constrains this change to
  // the 5xx fallthrough, and 4xx bodies typically already carry their own
  // actionable detail (validation errors, bad input, etc.).
  test("mapNodeError 4xx generic fallthrough leaves the hint undefined", () => {
    const err = mapNodeError(418, { error: "teapot" }, "/api/x");
    expect(err.code).toBe("node_http_418");
    expect(err.hint).toBeUndefined();
  });

  // DX: a downloaded user has no local schema_service to "start" — an
  // unreachable cloud Lambda is a network/outage issue, not a missing
  // local process.
  test("schema-down hint reflects the cloud Lambda (no local schema_service) for a non-localhost URL", () => {
    const hint = schemaDownHint("https://axo709qs11.execute-api.us-east-1.amazonaws.com");
    expect(hint).toContain("cloud schema service");
    expect(hint).not.toContain("run.sh");
  });

  test("schema-down hint keeps the local-schema note for a localhost URL", () => {
    expect(schemaDownHint("http://127.0.0.1:8080")).toContain("run.sh");
  });

  test("schema service POST returns canonical hash", async () => {
    installMock([
      {
        status: 201,
        body: {
          schema: {
            name: "deadbeef",
            descriptive_name: "Design",
          },
          replaced_schema: null,
        },
      },
    ]);
    const c = newSchemaServiceClient("http://127.0.0.1:9102");
    const r = await c.registerSchema({
      schema: {
        name: "Design",
        owner_app_id: "fbrain",
        descriptive_name: "Design",
        schema_type: "Hash",
        key: { hash_field: "slug" },
        fields: ["slug"],
        field_types: { slug: "String" },
        field_descriptions: { slug: "x" },
        field_data_classifications: {
          slug: { sensitivity_level: 0, data_domain: "general" },
        },
      },
      mutation_mappers: {},
    });
    expect(r.canonicalHash).toBe("deadbeef");
  });

  test("schema service POST 401 cert_required → schema_cert_required with actionable hint", async () => {
    // App-identity v3.1 publish gate: POSTing an `owner_app_id`-tagged schema
    // without a DevCert is rejected `401 {"reason":"cert_required"}`. A fresh
    // consumer following the docs (download fbrain → run init against the
    // prod schema service) hits this every time, since the canonical hashes
    // are already published by the maintainer. Without the discriminated
    // mapping the user just sees "HTTP 401 — run fbrain doctor" and runs in
    // a loop. Pin the friendly mapping.
    installMock([{ status: 401, body: { reason: "cert_required" } }]);
    const c = newSchemaServiceClient("https://schema.example/v1");
    try {
      await c.registerSchema({
        schema: {
          name: "Design",
          owner_app_id: "fbrain",
          descriptive_name: "Design",
          schema_type: "Hash",
          key: { hash_field: "slug" },
          fields: ["slug"],
          field_types: { slug: "String" },
          field_descriptions: { slug: "x" },
          field_data_classifications: {
            slug: { sensitivity_level: 0, data_domain: "general" },
          },
        },
        mutation_mappers: {},
      });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("schema_cert_required");
      // Message names the gate and the cause.
      expect(fe.message).toContain("cert_required");
      expect(fe.message).toContain("DevCert");
      expect(fe.message).toContain("fresh consumer");
      // No raw "HTTP 401" wording — that's the dead-end the brief calls out.
      expect(fe.message).not.toMatch(/returned HTTP 401/);
      // Hint names the load-bearing remedies: ask a DevCert maintainer to
      // publish, or repoint at a schema service that already has them. The
      // pre-fix bare-publish escape hatch (FBRAIN_APP_IDENTITY_ENFORCE=off)
      // is gone — enforce-off now follows the same resolve-from-node path
      // as enforce-on and hits the same 401 — so it's no longer a remedy.
      expect(fe.hint ?? "").toContain("maintainer");
      expect(fe.hint ?? "").toContain("DevCert");
      expect(fe.hint ?? "").toContain("resolves");
      expect(fe.hint ?? "").not.toContain("FBRAIN_APP_IDENTITY_ENFORCE=off");
    }
  });

  // Pins the mapNodeError dispatch table itself — each tuple exercises one
  // arm (or the generic fallthrough), so a future restructure that drops or
  // reorders an arm fails here before it can ship.
  test("mapNodeError dispatch table covers each arm + generic fallthrough", () => {
    const cases: Array<{ name: string; status: number; body: unknown; expectedCode: string }> = [
      {
        name: "403 with reason → capability_403_<reason>",
        status: 403,
        body: { reason: "consent_required" },
        expectedCode: "capability_403_consent_required",
      },
      {
        name: "401 MISSING_USER_CONTEXT (discriminator in `code`)",
        status: 401,
        body: { code: "MISSING_USER_CONTEXT", error: "Authentication required." },
        expectedCode: "missing_user_context",
      },
      {
        name: "503 node_not_provisioned",
        status: 503,
        body: { error: "node_not_provisioned" },
        expectedCode: "node_not_provisioned",
      },
      {
        name: "409 ambiguous_schema_name",
        status: 409,
        body: { error: "ambiguous_schema_name", ambiguous_schemas: ["a", "b"] },
        expectedCode: "ambiguous_schema_name",
      },
      {
        name: "400 unknown_fields",
        status: 400,
        body: { error: "unknown_fields", message: "no field foo" },
        expectedCode: "unknown_fields",
      },
      {
        name: "400 model.onnx (error-field shape)",
        status: 400,
        body: {
          error:
            "Bad request: Schema error: Invalid data: Failed to init embedding model: Failed to retrieve model.onnx",
        },
        expectedCode: "embedding_model_unavailable",
      },
      {
        name: "unmatched 500 → generic node_http_500",
        status: 500,
        body: { error: "boom" },
        expectedCode: "node_http_500",
      },
      {
        name: "403 without `reason` → generic node_http_403 (not capability)",
        status: 403,
        body: {},
        expectedCode: "node_http_403",
      },
      {
        name: "403 transport_not_attested (error-field shape) → attestation arm",
        status: 403,
        body: { error: "transport_not_attested" },
        expectedCode: "transport_not_attested",
      },
    ];
    for (const c of cases) {
      const err = mapNodeError(c.status, c.body, "/api/test");
      expect(err.code, c.name).toBe(c.expectedCode);
    }
  });

  // The owner-verb attestation 403 (fold#739) bites the documented contributor
  // path: a from-source `./run.sh` node keeps its control socket off the default
  // `~/.folddb/data/` path, so `fbrain init` step 4/6 (`/api/schemas/load`) 403s.
  // Before the dedicated arm this surfaced as an opaque `node_http_403` with no
  // hint. Pin that the user now gets the env-var remedy + the resolved socket
  // path, on both the CLI (`hint`) and agent (`agentHint`) channels.
  test("mapNodeError transport_not_attested → actionable socket remedy on both channels", () => {
    const err = mapNodeError(403, { error: "transport_not_attested" }, "/api/schemas/load");
    expect(err.code).toBe("transport_not_attested");
    expect(err.message).toContain("attested transport");
    expect(err.message).toContain("/api/schemas/load");
    // Both channels must name the one env var that fixes it.
    expect(err.hint).toContain("FBRAIN_FOLDDB_SOCKET");
    expect(err.agentHint).toContain("FBRAIN_FOLDDB_SOCKET");
    // …and reference folddb.sock so the user knows what to point at.
    expect(err.hint).toContain("folddb.sock");
  });

  test("schema service POST without schema.name throws schema_register_no_hash", async () => {
    installMock([{ status: 201, body: { something: "weird" } }]);
    const c = newSchemaServiceClient("http://127.0.0.1:9102");
    try {
      await c.registerSchema({
        schema: {
          name: "x",
          owner_app_id: "fbrain",
          descriptive_name: "x",
          schema_type: "Hash",
          key: { hash_field: "slug" },
          fields: ["slug"],
          field_types: { slug: "String" },
          field_descriptions: { slug: "x" },
          field_data_classifications: {
            slug: { sensitivity_level: 0, data_domain: "general" },
          },
        },
        mutation_mappers: {},
      });
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("schema_register_no_hash");
    }
  });
});
