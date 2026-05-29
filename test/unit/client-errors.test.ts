// Unit tests for client.ts's Error Registry — mock fetch, assert that
// every Error Registry row maps to a recognisable FbrainError.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FbrainError, newNodeClient, newSchemaServiceClient } from "../../src/client.ts";

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
      expect(fe.hint ?? "").toContain("~/.folddb/config");
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
      expect(fe.hint ?? "").toContain("folddb daemon stop && folddb daemon start");
      expect(fe.hint ?? "").toContain("fbrain doctor --freshness");
      expect(fe.hint ?? "").toContain("~/Library/Logs/Homebrew/folddb/");
      // The channel-neutral variant (shown over `hint` on the MCP boundary)
      // must carry none of that CLI/brew remediation an agent can't run.
      expect(fe.agentHint ?? "").not.toContain("folddb daemon");
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
      expect(fe.hint ?? "").toContain("folddb daemon stop && folddb daemon start");
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

  // Capability 403s: the node renders the body VERBATIM (not in fbrain's
  // {ok,error} envelope) as `{"status":403,"reason":"<reason>", ...}`. The
  // client must read `body.reason` (a new field) and carry it on the
  // FbrainError so the capability layer can apply the contract behavior.
  test("node 403 capability_revoked carries capabilityReason + capability_id detail", async () => {
    installMock([
      {
        status: 403,
        body: { status: 403, reason: "capability_revoked", capability_id: "uuid-1" },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.createRecord({ schemaHash: "h", fields: {}, keyHash: "k" });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.capabilityReason).toBe("capability_revoked");
      expect(fe.capabilityDetail?.capabilityId).toBe("uuid-1");
    }
  });

  test("node 403 capability_out_of_scope carries the schema detail", async () => {
    installMock([
      { status: 403, body: { status: 403, reason: "capability_out_of_scope", schema: "fbrain/Concept" } },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.updateRecord({ schemaHash: "h", fields: {}, keyHash: "k" });
      throw new Error("did not throw");
    } catch (err) {
      const fe = err as FbrainError;
      expect(fe.capabilityReason).toBe("capability_out_of_scope");
      expect(fe.capabilityDetail?.schema).toBe("fbrain/Concept");
    }
  });

  test("node 403 capability_replay carries the timestamp skew", async () => {
    installMock([
      { status: 403, body: { status: 403, reason: "capability_replay", timestamp_skew_secs: 90 } },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.deleteRecord({ schemaHash: "h", keyHash: "k" });
      throw new Error("did not throw");
    } catch (err) {
      const fe = err as FbrainError;
      expect(fe.capabilityReason).toBe("capability_replay");
      expect(fe.capabilityDetail?.timestampSkewSecs).toBe(90);
    }
  });

  test("node 403 consent_required carries the reason", async () => {
    installMock([{ status: 403, body: { status: 403, reason: "consent_required" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.createRecord({ schemaHash: "h", fields: {}, keyHash: "k" });
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).capabilityReason).toBe("consent_required");
    }
  });

  test("a 403 WITHOUT a reason falls through to the generic node_http_403 mapping", async () => {
    installMock([{ status: 403, body: { message: "nope" } }]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.createRecord({ schemaHash: "h", fields: {}, keyHash: "k" });
      throw new Error("did not throw");
    } catch (err) {
      const fe = err as FbrainError;
      expect(fe.code).toBe("node_http_403");
      expect(fe.capabilityReason).toBeUndefined();
    }
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
