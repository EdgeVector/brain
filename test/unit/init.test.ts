// Auto-heal coverage for `runInit`'s URL resolver. The resolver is the
// load-bearing piece behind G1+G2: anyone whose `~/.fbrain/config.json`
// still carries the dead `:9101 / :9102` local-schema defaults gets their
// URLs rewritten on the next `fbrain init`, while explicit user overrides
// (custom host, custom port) survive untouched.
//
// Plus: Option C recovery — when the homebrew daemon lands in the
// contradictory state where auto-identity says not_provisioned but
// bootstrap returns 410 already_complete, `runInit` reuses an existing
// `~/.fbrain/config.json` userHash and continues instead of crashing
// with the obsolete "should probe /api/system/auto-identity first" hint.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NODE_URL,
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_SCHEMA_SERVICE_URL,
  formatNodeTarget,
  MAX_RETRY_GAP_MS,
  NONINTERACTIVE_RETRY_DELAYS_MS,
  RETRY_TOTAL_BUDGET_MS,
  RETRY_TOTAL_BUDGET_MS_NONINTERACTIVE,
  hasUsableExistingConfig,
  localMintIdentityHash,
  printNextSteps,
  probeWithRetry,
  resolveUrls,
  runInit,
} from "../../src/commands/init.ts";
import { newNodeClient } from "../../src/client.ts";
import type { EstablishConsentResult } from "../../src/commands/init-consent.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";
import { FbrainError } from "../../src/client.ts";
import { OWNER_APP_ID, UNIQUE_SCHEMAS } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

describe("resolveUrls", () => {
  test("fresh init (no existing config) → new defaults, no heal notice", () => {
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toEqual([]);
  });

  test("explicit CLI flags always win, even over an existing healed config", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9101",
      schemaServiceUrl: "http://127.0.0.1:9102",
    });
    const r = resolveUrls(
      { nodeUrl: "http://custom:1234", schemaServiceUrl: "https://custom.example/v1" },
      existing,
    );
    expect(r.nodeUrl).toBe("http://custom:1234");
    expect(r.schemaServiceUrl).toBe("https://custom.example/v1");
    expect(r.healed).toEqual([]);
  });

  test("stale 127.0.0.1:9101 / 9102 → both swapped, both reported", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9101",
      schemaServiceUrl: "http://127.0.0.1:9102",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toHaveLength(2);
    expect(r.healed[0]).toContain("nodeUrl");
    expect(r.healed[1]).toContain("schemaServiceUrl");
  });

  test("stale localhost variants also heal", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://localhost:9101",
      schemaServiceUrl: "http://localhost:9102",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toHaveLength(2);
  });

  test("non-default user override is preserved (no heal)", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://192.168.1.5:9001",
      schemaServiceUrl: "https://my-custom-lambda.example.com",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe("http://192.168.1.5:9001");
    expect(r.schemaServiceUrl).toBe("https://my-custom-lambda.example.com");
    expect(r.healed).toEqual([]);
  });

  test("only one side stale → only that side heals", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9101", // stale
      schemaServiceUrl: "https://my-custom-lambda.example.com", // user override
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe("https://my-custom-lambda.example.com");
    expect(r.healed).toHaveLength(1);
    expect(r.healed[0]).toContain("nodeUrl");
  });

  test("config already on new defaults → no heal", () => {
    const existing = buildTestCfg({
      nodeUrl: DEFAULT_NODE_URL,
      schemaServiceUrl: DEFAULT_SCHEMA_SERVICE_URL,
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.schemaServiceUrl).toBe(DEFAULT_SCHEMA_SERVICE_URL);
    expect(r.healed).toEqual([]);
  });

  test("retired TCP :9001 loopback marker heals to socket-only default", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: DEFAULT_SCHEMA_SERVICE_URL,
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.nodeUrl).not.toContain("9001");
    expect(r.healed).toHaveLength(1);
    expect(r.healed[0]).toContain("nodeUrl");
  });
});

describe("resolveUrls — node-URL default (socket-only loopback)", () => {
  test("fresh init → DEFAULT_NODE_URL (the loopback socket marker)", () => {
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.healed).toEqual([]);
  });

  test("--node-url wins on a fresh init", () => {
    const r = resolveUrls({ nodeUrl: "http://127.0.0.1:9050" }, null);
    expect(r.nodeUrl).toBe("http://127.0.0.1:9050");
  });

  test("existing config URL is reused over the default", () => {
    const existing = buildTestCfg({
      nodeUrl: "http://192.168.1.5:9001",
      schemaServiceUrl: "https://my-custom-lambda.example.com",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe("http://192.168.1.5:9001");
  });
});

describe("formatNodeTarget", () => {
  test("loopback node URLs print the Unix socket target, not TCP as transport", () => {
    const out = formatNodeTarget(DEFAULT_NODE_URL);
    expect(out).toContain("unix:");
    // Socket-first: never echo the loopback marker / retired :9001 as transport.
    expect(out).not.toContain("9001");
    expect(out).not.toContain("http://");
    expect(out.startsWith("unix:")).toBe(true);
  });

  test("remote node URLs print unchanged", () => {
    expect(formatNodeTarget("https://node.example.test")).toBe("https://node.example.test");
  });
});

describe("localMintIdentityHash", () => {
  test("matches the node app-schema mint framing", () => {
    expect(localMintIdentityHash("kanban", "Task", ["status", "title", "title"])).toBe(
      "99545766d94eaccf9d3da1d6f98695932a1ed2e656034b5742ec4e60d55b750a",
    );
  });
});

describe("hasUsableExistingConfig", () => {
  test("null → not usable", () => {
    expect(hasUsableExistingConfig(null)).toBe(false);
  });

  test("present config with userHash + schemaHashes → usable", () => {
    expect(hasUsableExistingConfig(buildTestCfg())).toBe(true);
  });

  test("present but empty userHash → not usable", () => {
    expect(hasUsableExistingConfig(buildTestCfg({ userHash: "" }))).toBe(false);
  });

  test("present userHash but empty schemaHashes → not usable", () => {
    expect(
      hasUsableExistingConfig(buildTestCfg({ schemaHashes: {} })),
    ).toBe(false);
  });
});

describe("runInit — Option C recovery from stuck-provisioned node", () => {
  const realFetch = globalThis.fetch;
  let tmpDir: string | null = null;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Mocks the homebrew daemon's contradictory state — auto-identity returns
  // 503 not_provisioned, bootstrap returns 410 already_complete — plus the
  // schema-service register/load endpoints needed for Option C to complete.
  function installStuckProvisionedMock(): void {
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/system/auto-identity")) {
        return jsonResponse(503, { error: "node_not_provisioned" });
      }
      if (url.endsWith("/api/setup/bootstrap")) {
        return jsonResponse(410, {
          ok: false,
          error: "onboarding_already_complete",
          message:
            "This node has already been bootstrapped. POST /api/auth/restore to restore from a recovery phrase.",
        });
      }
      if (url.endsWith("/v1/schemas")) {
        // Each register returns a distinct canonical hash — caller dedupes
        // via UNIQUE_SCHEMAS, so 3 hits is enough.
        const hash = "abc123def456" + "0".repeat(52);
        return jsonResponse(201, {
          schema: { name: hash, descriptive_name: "x" },
          replaced_schema: null,
        });
      }
      if (url.endsWith("/api/schemas/load")) {
        return jsonResponse(200, {
          available_schemas_loaded: 3,
          schemas_loaded_to_db: 3,
          failed_schemas: [],
        });
      }
      return jsonResponse(404, { error: "unexpected_url", url });
    }) as unknown as typeof globalThis.fetch;
  }

  test("reuses existing userHash when bootstrap 410 + config has a saved userHash", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-test-"));
    const configPath = join(tmpDir, "config.json");
    const existingUserHash = "preserved-from-prior-init-1234567890";
    const existing: Config = {
      configVersion: CONFIG_VERSION,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      userHash: existingUserHash,
      schemaHashes: { ...TEST_HASHES },
      designSchemaHash: TEST_HASHES.design,
      taskSchemaHash: TEST_HASHES.task,
    };
    writeFileSync(configPath, JSON.stringify(existing) + "\n", "utf8");

    installStuckProvisionedMock();

    const lines: string[] = [];
    const result = await runInit({
      configPath,
      print: (l) => lines.push(l),
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.config.userHash).toBe(existingUserHash);
    // The recovery line must be visible so the user knows why init didn't
    // bootstrap — not silently masked.
    expect(lines.some((l) => l.includes("reusing existing config userHash"))).toBe(true);

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    expect(onDisk.userHash).toBe(existingUserHash);
  });

  test("no existing config + bootstrap 410 → throws actionable error with node's own /api/auth/restore message", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-test-"));
    const configPath = join(tmpDir, "config.json");
    expect(existsSync(configPath)).toBe(false);

    installStuckProvisionedMock();

    try {
      await runInit({ configPath, print: () => {} });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("onboarding_already_complete");
      expect(fe.message).toContain("/api/auth/restore");
      // The obsolete hint must not resurrect.
      expect(fe.message).not.toContain("should probe");
      expect(fe.hint ?? "").not.toContain("should probe");
    }
  });
});

describe("runInit — fresh consumer resolves cert-gated fbrain/* hashes from the node", () => {
  const realFetch = globalThis.fetch;
  // The suite preload (test/setup.ts) forces enforcement OFF; this path is
  // the enforce-ON (namespaced) one, so opt back in for these tests.
  const priorEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  let tmpDir: string | null = null;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (priorEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
    else process.env.FBRAIN_APP_IDENTITY_ENFORCE = priorEnforce;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Models a fresh consumer (no DevCert) against a node whose catalog already
  // carries the published fbrain/* schemas: every `POST /v1/schemas` is
  // rejected with 401 cert_required, but the node's GET /api/schemas exposes
  // each schema's authoritative identity_hash. init must resolve, not die.
  function installCertGatedMock(loadBodies: unknown[] = []): void {
    const loaded = UNIQUE_SCHEMAS.map((e, i) => ({
      descriptive_name: e.schema.schema.descriptive_name,
      owner_app_id: e.schema.schema.owner_app_id,
      identity_hash: `resolvedhash${i}` + "0".repeat(52 - String(i).length),
    }));
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/system/auto-identity")) {
        return jsonResponse(200, { user_hash: "fresh-consumer-userhash-0001" });
      }
      if (url.endsWith("/v1/schemas") && method === "POST") {
        return jsonResponse(401, { reason: "cert_required" });
      }
      if (url.endsWith("/api/schemas/load")) {
        loadBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return jsonResponse(200, {
          available_schemas_loaded: loaded.length,
          schemas_loaded_to_db: loaded.length,
          failed_schemas: [],
        });
      }
      if (url.endsWith("/api/schemas") && method === "GET") {
        return jsonResponse(200, { ok: true, schemas: loaded });
      }
      return jsonResponse(404, { error: "unexpected_url", url });
    }) as unknown as typeof globalThis.fetch;
  }

  test("local app-schema declare path skips schema_service publish/load", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-local-declare-"));
    const configPath = join(tmpDir, "config.json");
    const declareBodies: unknown[] = [];

    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/system/auto-identity")) {
        return jsonResponse(200, { user_hash: "local-declare-userhash-0001" });
      }
      if (url.endsWith("/api/apps/declare-schema") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        declareBodies.push(body);
        const schema = body.schema?.descriptive_name ?? "unknown";
        return jsonResponse(200, {
          app_id: body.app_id,
          schema,
          canonical: `${String(schema).toLowerCase()}${"0".repeat(64)}`.slice(0, 64),
          resolution: "mint",
          decision: "mint",
        });
      }
      if (url.endsWith("/v1/schemas") || url.endsWith("/api/schemas/load")) {
        return jsonResponse(500, { error: "schema_service_or_load_should_not_be_called", url });
      }
      return jsonResponse(404, { error: "unexpected_url", url });
    }) as unknown as typeof globalThis.fetch;

    const lines: string[] = [];
    const result = await runInit({
      configPath,
      print: (l) => lines.push(l),
      consent: { isTty: () => false },
    });

    expect(declareBodies).toHaveLength(UNIQUE_SCHEMAS.length);
    for (const body of declareBodies as Array<{ app_id?: string; schema?: { owner_app_id?: string } }>) {
      expect(body.app_id).toBe(OWNER_APP_ID);
      expect(body.schema?.owner_app_id).toBe(OWNER_APP_ID);
    }
    for (const t of ["design", "task", "concept", "preference", "reference", "agent", "project", "spike", "sop", "decision", "__tagindex__"]) {
      expect(result.config.schemaHashes[t]).toHaveLength(64);
    }
    expect(lines.some((l) => l.includes("local app-schema declarations persisted"))).toBe(true);
    expect(lines.some((l) => l.includes("schema_service load skipped"))).toBe(true);
    const targetLine = lines.find((l) => l.includes("targeting node at")) ?? "";
    expect(targetLine).toContain("unix:");
    expect(targetLine).not.toContain(`targeting node at ${DEFAULT_NODE_URL}`);
  });

  test("local app-schema declare accepts link only when canonical is the expected local mint", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-local-link-"));
    const configPath = join(tmpDir, "config.json");

    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/system/auto-identity")) {
        return jsonResponse(200, { user_hash: "local-link-userhash-0001" });
      }
      if (url.endsWith("/api/apps/declare-schema") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          app_id?: string;
          schema?: { name?: string; descriptive_name?: string; fields?: string[] };
        };
        const appId = body.app_id ?? OWNER_APP_ID;
        const schemaName = body.schema?.name ?? "unknown";
        const fields = body.schema?.fields ?? [];
        return jsonResponse(200, {
          app_id: appId,
          schema: schemaName,
          canonical: localMintIdentityHash(appId, schemaName, fields),
          resolution: "link",
          decision: "link",
        });
      }
      if (url.endsWith("/v1/schemas") || url.endsWith("/api/schemas/load")) {
        return jsonResponse(500, { error: "schema_service_or_load_should_not_be_called", url });
      }
      return jsonResponse(404, { error: "unexpected_url", url });
    }) as unknown as typeof globalThis.fetch;

    const lines: string[] = [];
    const result = await runInit({
      configPath,
      print: (l) => lines.push(l),
      consent: { isTty: () => false },
    });

    for (const t of ["design", "task", "concept", "preference", "reference", "agent", "project", "spike"]) {
      expect(result.config.schemaHashes[t]).toHaveLength(64);
    }
    expect(lines.some((l) => l.includes("accepted link; canonical matches local mint"))).toBe(true);
  });

  test("local app-schema declare still rejects arbitrary links", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-bad-link-"));
    const configPath = join(tmpDir, "config.json");

    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/system/auto-identity")) {
        return jsonResponse(200, { user_hash: "bad-link-userhash-0001" });
      }
      if (url.endsWith("/api/apps/declare-schema") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          app_id?: string;
          schema?: { name?: string };
        };
        return jsonResponse(200, {
          app_id: body.app_id,
          schema: body.schema?.name ?? "Design",
          canonical: "f".repeat(64),
          resolution: "link",
          decision: "link",
        });
      }
      return jsonResponse(404, { error: "unexpected_url", url });
    }) as unknown as typeof globalThis.fetch;

    try {
      await runInit({
        configPath,
        print: () => {},
        consent: { isTty: () => false },
      });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("app_schema_declare_not_local_mint");
    }
  });

  test("cert_required POST → resolves all 8 namespaced hashes from GET /api/schemas, no throw", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-resolve-"));
    const configPath = join(tmpDir, "config.json");
    const loadBodies: unknown[] = [];
    installCertGatedMock(loadBodies);

    const lines: string[] = [];
    const result = await runInit({
      configPath,
      print: (l) => lines.push(l),
      // skip the interactive consent step in this unit test
      consent: { isTty: () => false },
    });

    // The load was SCOPED (fold #877): with no DevCert, registration is
    // cert-gated so init has no hashes yet — it must scope the load by the 8
    // fbrain descriptive_names, NOT pull the whole global catalog (no body).
    expect(loadBodies).toHaveLength(1);
    const scoped = (loadBodies[0] as { schemas?: string[] } | null)?.schemas ?? [];
    expect([...scoped].sort()).toEqual(
      UNIQUE_SCHEMAS.map((e) => e.schema.schema.descriptive_name).sort(),
    );

    // Every record type resolved to a node-provided hash — none left blank.
    for (const t of ["design", "task", "concept", "preference", "reference", "agent", "project", "spike"]) {
      expect(result.config.schemaHashes[t]).toMatch(/^resolvedhash\d/);
    }
    expect(lines.some((l) => l.includes("resolving from node"))).toBe(true);
    expect(lines.some((l) => l.includes("no DevCert needed"))).toBe(true);

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    expect(onDisk.schemaHashes.design).toMatch(/^resolvedhash/);
  });
});

describe("runInit — recovers from a corrupt existing config", () => {
  // ConfigInvalidError messages tell the user to "Re-run `fbrain init`", but
  // pre-fix `runInit` itself called `tryReadConfig` at the top and the throw
  // propagated before any bootstrap work could run — leaving the user in a
  // dead-end loop where the documented remedy couldn't recover. `fbrain init`'s
  // whole purpose is to write a valid config; a corrupt existing file should
  // be treated as a fresh init (with a clear notice that we discarded it),
  // not as a hard failure.

  const realFetch = globalThis.fetch;
  let tmpDir: string | null = null;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Models a clean fresh-init path: auto-identity returns 200 already
  // provisioned, schemas register + load cleanly.
  function installCleanInitMock(): void {
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/system/auto-identity")) {
        return jsonResponse(200, { user_hash: "recovered-userhash-0001" });
      }
      if (url.endsWith("/v1/schemas") && method === "POST") {
        const hash = "abc123def456" + "0".repeat(52);
        return jsonResponse(201, {
          schema: { name: hash, descriptive_name: "x" },
          replaced_schema: null,
        });
      }
      if (url.endsWith("/api/schemas/load")) {
        return jsonResponse(200, {
          available_schemas_loaded: 8,
          schemas_loaded_to_db: 8,
          failed_schemas: [],
        });
      }
      return jsonResponse(404, { error: "unexpected_url", url });
    }) as unknown as typeof globalThis.fetch;
  }

  test("truncated JSON on disk → init treats as fresh and writes a valid config", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-corrupt-"));
    const configPath = join(tmpDir, "config.json");
    // A real-world failure mode: power loss / SIGKILL mid-write left the file
    // half-written. JSON.parse throws → readConfig throws ConfigInvalidError.
    writeFileSync(configPath, '{"configVersion": 4, "nodeUrl": "http', "utf8");

    installCleanInitMock();

    const lines: string[] = [];
    const result = await runInit({
      configPath,
      print: (l) => lines.push(l),
    });

    // Init reached the bootstrap path and produced a fresh config — the
    // recovery is the whole point.
    expect(result.config.userHash).toBe("recovered-userhash-0001");
    expect(result.config.configVersion).toBe(CONFIG_VERSION);
    // User must see why we discarded their on-disk file — silent overwrite of
    // user data is worse than the dead-end loop.
    expect(lines.some((l) => l.includes("corrupt") || l.includes("invalid"))).toBe(true);

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    expect(onDisk.userHash).toBe("recovered-userhash-0001");
  });

  test("fresh init prints the next-steps nudge after [init] ok", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-nudge-"));
    const configPath = join(tmpDir, "config.json");
    installCleanInitMock();

    const lines: string[] = [];
    await runInit({ configPath, print: (l) => lines.push(l) });

    const okIdx = lines.findIndex((l) => l.includes("[init] ok"));
    expect(okIdx).toBeGreaterThanOrEqual(0);
    // The nudge must come AFTER the terminal [init] ok marker so machine
    // consumers that key off `[init] ok` see it before the guidance.
    const after = lines.slice(okIdx + 1).join("\n");
    expect(after).toContain("Next steps");
    expect(after).toContain("brain design new");
    expect(after).toContain("brain list");
    expect(after).toContain("brain search");
    expect(after).toContain("brain doctor");
    // Tells the user where their data lives (socket path, not TCP).
    expect(after).toContain("unix:");
    expect(after).not.toContain(":9001");
  });

  test("config from a future fbrain (unknown configVersion) → init recovers fresh", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-future-"));
    const configPath = join(tmpDir, "config.json");
    // Models a downgrade: future fbrain wrote configVersion: 999, current
    // fbrain doesn't recognise it. assertConfigShape throws — init must still
    // be able to overwrite with a current-version config rather than dead-end.
    writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: 999,
        nodeUrl: "http://127.0.0.1:9001",
        schemaServiceUrl: "https://schema.example/v1",
        userHash: "from-future-fbrain",
        schemaHashes: { ...TEST_HASHES },
        designSchemaHash: TEST_HASHES.design,
        taskSchemaHash: TEST_HASHES.task,
      }),
      "utf8",
    );

    installCleanInitMock();

    const result = await runInit({
      configPath,
      print: () => {},
    });

    expect(result.config.configVersion).toBe(CONFIG_VERSION);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    expect(onDisk.configVersion).toBe(CONFIG_VERSION);
  });
});

describe("printNextSteps", () => {
  const GRANTED: EstablishConsentResult = { state: "already_granted" };

  test("fresh init → full walkthrough with node URL + config path", () => {
    const lines: string[] = [];
    printNextSteps((l) => lines.push(l), {
      nodeUrl: "http://127.0.0.1:9001",
      configPath: "/home/dev/.fbrain/config.json",
      consent: GRANTED,
      reinitialized: false,
    });
    const out = lines.join("\n");
    expect(out).toContain("Next steps");
    expect(out).toContain("brain design new my-first-idea");
    expect(out).toContain("brain list");
    expect(out).toContain("brain search");
    expect(out).toContain("brain ask");
    expect(out).toContain("brain doctor");
    // The headline agent-integration step: a brain meant to be used BY an
    // agent must tell the new dev how to connect it. The next-steps now LEAD
    // with the one-shot `brain mcp install` (registers + appends instructions
    // in one command), with the manual `claude mcp add` form kept as the
    // by-hand fallback. Pin both plus the `bun link` PATH caveat so this can't
    // silently regress.
    expect(out).toContain("brain mcp install");
    expect(out).toContain("claude mcp add fbrain fbrain-mcp");
    expect(out).toContain("bun link");
    expect(out).toContain("fbrain_* tools");
    // Socket-first target (never advertise retired TCP :9001).
    expect(out).toContain("unix:");
    expect(out).not.toContain(":9001");
    expect(out).toContain("/home/dev/.fbrain/config.json");
  });

  test("re-run (already initialized) → terse variant, no full walkthrough", () => {
    const lines: string[] = [];
    printNextSteps((l) => lines.push(l), {
      nodeUrl: DEFAULT_NODE_URL,
      configPath: "/home/dev/.fbrain/config.json",
      consent: GRANTED,
      reinitialized: true,
    });
    const out = lines.join("\n");
    expect(out).toContain("Already initialized");
    expect(out).toContain("brain list");
    // A dev re-running `init` to confirm "which node am I pointed at?" must get
    // the answer even on the terse already-initialized path — socket-first.
    expect(out).toContain("unix:");
    expect(out).not.toContain(":9001");
    expect(out).toContain("/home/dev/.fbrain/config.json");
    // The full first-record walkthrough is suppressed on a re-run.
    expect(out).not.toContain("Next steps");
    expect(out).not.toContain("brain design new");
  });

  test("non-interactive (non_tty skip) → points at --grant-consent", () => {
    const lines: string[] = [];
    printNextSteps((l) => lines.push(l), {
      nodeUrl: DEFAULT_NODE_URL,
      configPath: "/home/dev/.fbrain/config.json",
      consent: { state: "skipped", reason: "non_tty" },
      reinitialized: false,
    });
    const out = lines.join("\n");
    expect(out).toContain("Next steps");
    expect(out).toContain("--grant-consent");
  });

  test("no lastdb binary skip → points at installing lastdb before retrying --grant-consent", () => {
    const lines: string[] = [];
    printNextSteps((l) => lines.push(l), {
      nodeUrl: "http://127.0.0.1:9001",
      configPath: "/tmp/fbrain-config.json",
      consent: { state: "skipped", reason: "no_folddb_bin" },
      reinitialized: false,
    });

    const out = lines.join("\n");
    expect(out).toContain("lastdb");
    expect(out).toContain("Install the lastdb CLI");
    expect(out).toContain("fbrain init --grant-consent");
  });

  test("consent granted → no --grant-consent note (writes already authorized)", () => {
    const lines: string[] = [];
    printNextSteps((l) => lines.push(l), {
      nodeUrl: DEFAULT_NODE_URL,
      configPath: "/home/dev/.fbrain/config.json",
      consent: GRANTED,
      reinitialized: false,
    });
    expect(lines.join("\n")).not.toContain("--grant-consent");
  });
});

// The node-down line `probeWithRetry` prints must reuse the canonical,
// socket-first `nodeDownHint` (client.ts) rather than init's old hand-rolled
// node-URL ternary. The prebuilt binary on PATH (signalled here via
// FBRAIN_FOLDDB_BIN) only adds a conditional CLI/Homebrew note; it must not
// bring back the stale brew-services-first recovery path.
describe("probeWithRetry — node-down hint uses canonical nodeDownHint", () => {
  // A probe client whose only behaviour is to fail unreachable, so the hint
  // is printed once and then the (zero-length) retry schedule rethrows.
  function unreachableProbeClient(): ReturnType<typeof newNodeClient> {
    return {
      autoIdentity: async () => {
        throw new FbrainError({ code: "service_unreachable", message: "fetch failed" });
      },
    } as unknown as ReturnType<typeof newNodeClient>;
  }

  test("non-default URL + prebuilt binary on PATH → socket-first guidance, NOT 'compiling Rust'", async () => {
    const prior = process.env.FBRAIN_FOLDDB_BIN;
    // FBRAIN_FOLDDB_BIN makes defaultIsFolddbBinaryInstalled() return true
    // without depending on the host PATH — the "downloaded user" signal.
    process.env.FBRAIN_FOLDDB_BIN = "/opt/homebrew/bin/folddb";
    const lines: string[] = [];
    try {
      // One zero-delay retry (mocked sleep) so the hint is printed once and
      // the final attempt rethrows — exercising the real print path without
      // any wall-clock wait.
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: "http://127.0.0.1:9050",
          retryDelaysMs: [0],
          sleep: async () => {},
          // Pin the target-port probe off so the hint is deterministic
          // regardless of whether anything is listening on the test host.
          isTargetPortListening: () => false,
        },
        (l) => lines.push(l),
      );
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      expect((err as FbrainError).code).toBe("service_unreachable");
    } finally {
      if (prior === undefined) delete process.env.FBRAIN_FOLDDB_BIN;
      else process.env.FBRAIN_FOLDDB_BIN = prior;
    }
    const out = lines.join("\n");
    expect(out).toContain("node not reachable at http://127.0.0.1:9050");
    expect(out).toContain("Unix socket");
    expect(out).toContain("fbrain doctor");
    expect(out).toContain("LastDB.app");
    expect(out).toContain("lastdb daemon start");
    expect(out).not.toContain("brew services start lastdb");
    // The misleading from-source framing must be gone for this case.
    expect(out).not.toContain("compiling Rust");
    expect(out).not.toContain("compiles Rust");
  });

  test("default install URL → socket-first guidance, even with no prebuilt binary", async () => {
    const prior = process.env.FBRAIN_FOLDDB_BIN;
    // The default install URL (`:9001`) still gets a conditional CLI/Homebrew
    // note even when the prebuilt binary is not detectable — delete
    // FBRAIN_FOLDDB_BIN so the binary probe can't be the thing driving it.
    // (`:9001` is a legacy install URL, not a transport hint — the node is
    // socket-only.)
    delete process.env.FBRAIN_FOLDDB_BIN;
    const lines: string[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: DEFAULT_NODE_URL,
          retryDelaysMs: [0],
          sleep: async () => {},
          isTargetPortListening: () => false,
        },
        (l) => lines.push(l),
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    } finally {
      if (prior === undefined) delete process.env.FBRAIN_FOLDDB_BIN;
      else process.env.FBRAIN_FOLDDB_BIN = prior;
    }
    const out = lines.join("\n");
    expect(out).toContain(`node not reachable at ${DEFAULT_NODE_URL}`);
    expect(out).toContain("Unix socket");
    expect(out).toContain("fbrain doctor");
    expect(out).toContain("LastDB.app");
    expect(out).not.toContain("brew services start lastdb");
    expect(out).not.toContain("compiling Rust");
  });

  // init-node-bound-to-target-port-not-serving-hint: when SOMETHING is bound to
  // the TARGET port but not answering (wedged / hung mid-boot), the retry-loop
  // hint must name "bound ... but isn't responding" + "stop it before
  // restarting", NOT loop the dev back to re-install/restart (which re-hangs a
  // wedged node). The probe is scoped to the target port — see client-errors.
  test("something bound to the target port but not serving → 'bound but not responding' hint, NOT re-install/restart", async () => {
    const lines: string[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: "http://127.0.0.1:9711",
          retryDelaysMs: [0],
          sleep: async () => {},
          isFolddbBinaryInstalled: () => true,
          isTargetPortListening: () => true,
        },
        (l) => lines.push(l),
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    }
    const out = lines.join("\n");
    expect(out).toContain("node not reachable at http://127.0.0.1:9711");
    expect(out).toContain("isn't responding");
    expect(out).toContain("stop it before restarting");
    // Must NOT loop the dev back into the re-install/restart reflex.
    expect(out).not.toContain("brew install edgevector/lastdb/lastdb");
    expect(out).not.toContain("brew services start lastdb");
    expect(out).not.toContain("brew services restart lastdb");
  });
});

// The default retry schedule must stay RESPONSIVE: a dev who starts the node
// mid-wait should be caught within ~one cap, not sit through a 60s gap. So no
// single inter-probe gap may exceed MAX_RETRY_GAP_MS, while the TOTAL wait
// budget stays generous enough for the slow contributor-from-source (Rust
// cold build) case.
describe("DEFAULT_RETRY_DELAYS_MS — responsive cap, comparable total budget", () => {
  test("no single gap exceeds the cap", () => {
    for (const gap of DEFAULT_RETRY_DELAYS_MS) {
      expect(gap).toBeLessThanOrEqual(MAX_RETRY_GAP_MS);
    }
  });

  test("total budget is preserved (~3 min, covers the slow-build case)", () => {
    const total = DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    // Same generous budget as the old 5/10/20/30/60/60 schedule (185s); the
    // ramp + flat-cap fill makes it land at or just above the target.
    expect(total).toBeGreaterThanOrEqual(RETRY_TOTAL_BUDGET_MS);
    // Don't let the schedule balloon far past the old budget either.
    expect(total).toBeLessThan(RETRY_TOTAL_BUDGET_MS + MAX_RETRY_GAP_MS);
  });

  test("polls frequently — many short attempts, not a few long ones", () => {
    // The whole point: the fast cadence yields a lot of attempts so a
    // just-started node is re-probed within ~5s. (The old schedule had 6.)
    expect(DEFAULT_RETRY_DELAYS_MS.length).toBeGreaterThan(6);
  });

  test("a node that comes up mid-wait is caught within one capped gap", async () => {
    // Drive probeWithRetry with the real default schedule but a mocked sleep
    // (no wall clock). The probe fails for the first few attempts, then the
    // "node" comes up — assert the gap we waited through to catch it is <= cap.
    // Pin isTty=true so we exercise the long interactive default schedule
    // (bun test has no TTY, so without this the fail-fast non-interactive
    // schedule would give up before the node comes up at attempt 4).
    let attempts = 0;
    const slept: number[] = [];
    const probeClient = {
      autoIdentity: async () => {
        attempts += 1;
        if (attempts <= 3) {
          throw new FbrainError({ code: "service_unreachable", message: "fetch failed" });
        }
        return { provisioned: true, userHash: "deadbeefcafef00d" } as Awaited<
          ReturnType<ReturnType<typeof newNodeClient>["autoIdentity"]>
        >;
      },
    } as unknown as ReturnType<typeof newNodeClient>;

    const result = await probeWithRetry(
      probeClient,
      { nodeUrl: "http://127.0.0.1:9050", isTty: () => true, sleep: async (ms) => { slept.push(ms); } },
      () => {},
    );

    expect((result as { provisioned: boolean }).provisioned).toBe(true);
    // Every gap we actually waited through (using the DEFAULT schedule, since
    // retryDelaysMs was not injected) is within the cap.
    for (const ms of slept) expect(ms).toBeLessThanOrEqual(MAX_RETRY_GAP_MS);
  });
});

// init-noninteractive-fail-fast-down-node: the retry budget against a DOWN
// node must be interactivity-aware. A non-interactive run (CI / agent /
// scripted `fbrain init --grant-consent </dev/null`) can't read the hint and
// start the daemon mid-wait, so a ~3-min retry is dead time — fail fast after
// the first hint. An interactive run (a contributor watching a Rust cold
// build) keeps the long budget. The explicit env / injected override always
// wins so the escape hatch and tests still control the schedule.
describe("probeWithRetry — interactivity-aware down-node budget", () => {
  function unreachableProbeClient(): ReturnType<typeof newNodeClient> {
    return {
      autoIdentity: async () => {
        throw new FbrainError({ code: "service_unreachable", message: "fetch failed" });
      },
    } as unknown as ReturnType<typeof newNodeClient>;
  }

  test("the non-interactive schedule is SHORT (fail-fast) vs the long interactive one", () => {
    const niTotal = NONINTERACTIVE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(niTotal).toBeGreaterThanOrEqual(RETRY_TOTAL_BUDGET_MS_NONINTERACTIVE);
    expect(niTotal).toBeLessThan(RETRY_TOTAL_BUDGET_MS_NONINTERACTIVE + MAX_RETRY_GAP_MS);
    // Decisively shorter than the interactive compile-wait budget.
    const interactiveTotal = DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(niTotal).toBeLessThan(interactiveTotal);
    // No single gap exceeds the responsiveness cap.
    for (const gap of NONINTERACTIVE_RETRY_DELAYS_MS) {
      expect(gap).toBeLessThanOrEqual(MAX_RETRY_GAP_MS);
    }
  });

  test("non-interactive (isTty=()=>false) uses the SHORT schedule", async () => {
    const slept: number[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: "http://127.0.0.1:9099",
          isTty: () => false,
          sleep: async (ms) => { slept.push(ms); },
          isTargetPortListening: () => false,
        },
        () => {},
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    }
    const total = slept.reduce((a, b) => a + b, 0);
    expect(total).toBe(NONINTERACTIVE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    // It must be the fast-fail budget, not the ~3-min one.
    expect(total).toBeLessThanOrEqual(RETRY_TOTAL_BUDGET_MS_NONINTERACTIVE);
  });

  test("interactive (isTty=()=>true) uses the LONG schedule", async () => {
    const slept: number[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: "http://127.0.0.1:9099",
          isTty: () => true,
          sleep: async (ms) => { slept.push(ms); },
          isTargetPortListening: () => false,
        },
        () => {},
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    }
    const total = slept.reduce((a, b) => a + b, 0);
    expect(total).toBe(DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(total).toBeGreaterThanOrEqual(RETRY_TOTAL_BUDGET_MS);
  });

  test("explicit retryDelaysMs override wins over the TTY default", async () => {
    const slept: number[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: "http://127.0.0.1:9099",
          // Non-interactive, but the caller-injected schedule must win.
          isTty: () => false,
          retryDelaysMs: [1000, 1000, 1000],
          sleep: async (ms) => { slept.push(ms); },
          isTargetPortListening: () => false,
        },
        () => {},
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    }
    expect(slept).toEqual([1000, 1000, 1000]);
  });

  test("FBRAIN_INIT_RETRY_DELAYS_MS env override wins over the TTY default", async () => {
    const prior = process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
    process.env.FBRAIN_INIT_RETRY_DELAYS_MS = "1500,1500";
    const slept: number[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          // Non-interactive default would be short; env override must win.
          nodeUrl: "http://127.0.0.1:9099",
          isTty: () => false,
          sleep: async (ms) => { slept.push(ms); },
          isTargetPortListening: () => false,
        },
        () => {},
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    } finally {
      if (prior === undefined) delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
      else process.env.FBRAIN_INIT_RETRY_DELAYS_MS = prior;
    }
    expect(slept).toEqual([1500, 1500]);
  });

  test("the node-down hint still prints on the first probe (fast-fail keeps it actionable)", async () => {
    const lines: string[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        {
          nodeUrl: "http://127.0.0.1:9099",
          isTty: () => false,
          sleep: async () => {},
          // Pin both hint probes so the asserted text is deterministic
          // regardless of the test host's PATH / socket table (CI has no
          // lastdb binary installed; a dev box may).
          isFolddbBinaryInstalled: () => true,
          isTargetPortListening: () => false,
        },
        (l) => lines.push(l),
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    }
    const out = lines.join("\n");
    expect(out).toContain("node not reachable at http://127.0.0.1:9099");
    expect(out).toContain("Unix socket");
    expect(out).toContain("fbrain doctor");
    expect(out).toContain("LastDB.app");
    expect(out).not.toContain("brew services start lastdb");
  });
});
