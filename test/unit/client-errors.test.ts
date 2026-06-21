// Unit tests for client.ts's Error Registry — mock fetch, assert that
// every Error Registry row maps to a recognisable FbrainError.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FbrainError,
  isDefaultNodeUrl,
  isNodeReachableButErroring,
  mapNodeError,
  newNodeClient,
  newSchemaServiceClient,
  nodeDownHint,
  nodeHttpErrorHint,
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
      await c.queryAll({ schemaHash: "Design", fields: ["slug"] });
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
      await c.queryAll({ schemaHash: "h", fields: ["foo"] });
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

  // DX: a downloaded user who simply forgot to start their daemon must be
  // told to `brew services start lastdb`, NOT to compile Rust from source.
  test("node-down hint leads with `brew services` for the default :9001 daemon", () => {
    expect(isDefaultNodeUrl("http://127.0.0.1:9001")).toBe(true);
    expect(isDefaultNodeUrl("http://localhost:9001")).toBe(true);
    // :9001 is always brew-first, regardless of whether the prebuilt binary
    // is detected — pin the binary probe to `false` so the assertion holds
    // even on hosts that don't have `folddb` on PATH.
    const hint = nodeDownHint(
      "http://127.0.0.1:9001",
      () => false,
      () => false,
    );
    // The hint must lead with a combined, copy-pasteable install+start line so
    // a brand-new dev who never ran `brew install` (the common case) doesn't
    // dead-end on `Error: Formula 'folddb' is not installed.`.
    expect(hint).toContain("brew install edgevector/lastdb/lastdb");
    expect(hint).toContain("brew services start lastdb");
    // The from-source path is still mentioned, but only as the secondary
    // contributor note — it must not lead.
    expect(hint.indexOf("brew services")).toBeLessThan(hint.indexOf("run.sh"));
    expect(hint).not.toContain("compiling Rust");
  });

  test("node-down hint keeps the from-source/compile framing for a non-default node URL when no prebuilt binary is installed", () => {
    expect(isDefaultNodeUrl("http://127.0.0.1:9101")).toBe(false);
    const hint = nodeDownHint(
      "http://127.0.0.1:9101",
      () => false,
      () => false,
    );
    expect(hint).toContain("run.sh");
    expect(hint).toContain("compiles Rust");
    expect(hint).not.toContain("brew services");
  });

  // DX regression: a downloaded user whose `folddb` is on a non-9001 port
  // (port conflict, two nodes, custom `--node-url` at init) must STILL be
  // sent to `brew services start lastdb` — not asked to clone the fold
  // monorepo and compile Rust. The prebuilt binary on PATH is the signal.
  test("node-down hint leads with `brew services` for a non-9001 port when the prebuilt binary is on PATH", () => {
    expect(isDefaultNodeUrl("http://127.0.0.1:9050")).toBe(false);
    const hint = nodeDownHint(
      "http://127.0.0.1:9050",
      () => true,
      () => false,
    );
    expect(hint).toContain("brew install edgevector/lastdb/lastdb");
    expect(hint).toContain("brew services start lastdb");
    expect(hint.indexOf("brew services")).toBeLessThan(hint.indexOf("run.sh"));
    expect(hint).not.toContain("compiles Rust");
  });

  // DX (init-node-process-alive-not-serving-hint): a node PROCESS that is alive
  // but not answering on its port (wedged, hung mid-boot, or still starting) is
  // the most misdiagnosed failure — it looks identical to "not started" to a
  // naive reachability check, so the old hint told the dev to re-install /
  // `brew services restart`, which just re-hangs a wedged node. When the process
  // probe reports a live folddb/lastdb process, the hint must instead name that
  // a process IS running but isn't responding, and tell the dev to STOP it
  // before restarting — NOT the bare install/restart line.
  test("node-down hint names 'running but not responding' + stop-before-restart when a folddb process is alive", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9711",
      () => true, // binary installed
      () => true, // process IS running
    );
    expect(hint).toContain("process is running but isn't responding");
    expect(hint).toContain("http://127.0.0.1:9711");
    expect(hint).toContain("brew services list");
    expect(hint).toContain("stop it before restarting");
    expect(hint).toContain("brew services stop lastdb");
    // It must NOT lead the dev back into the install/`brew services restart`
    // reflex that re-hangs a wedged node.
    expect(hint).not.toContain("brew install edgevector/lastdb/lastdb");
    expect(hint).not.toContain("brew services restart lastdb");
  });

  // The running-but-not-serving branch wins regardless of the node URL or
  // whether the prebuilt binary is detected — a live process is a stronger
  // signal than either.
  test("node-down hint prefers the 'running but not responding' branch over the install/start branch", () => {
    // Default :9001 daemon, binary NOT on PATH, but a process IS alive.
    const hint = nodeDownHint(
      "http://127.0.0.1:9001",
      () => false,
      () => true,
    );
    expect(hint).toContain("process is running but isn't responding");
    expect(hint).not.toContain("brew install edgevector/lastdb/lastdb");
  });

  // The genuine not-running case (no live process) must be UNCHANGED — still
  // the install/start line for a default/installed node.
  test("node-down hint keeps the install/start line when no folddb process is alive", () => {
    const hint = nodeDownHint(
      "http://127.0.0.1:9001",
      () => true,
      () => false,
    );
    expect(hint).toContain("brew install edgevector/lastdb/lastdb");
    expect(hint).toContain("brew services start lastdb");
    expect(hint).not.toContain("process is running but isn't responding");
  });

  test("connectionError node hint mentions `brew services` for the default daemon", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.autoIdentity();
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).hint ?? "").toContain("brew services start lastdb");
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
