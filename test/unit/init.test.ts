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
  DEFAULT_SCHEMA_SERVICE_URL,
  hasUsableExistingConfig,
  printNextSteps,
  probeWithRetry,
  resolveUrls,
  runInit,
} from "../../src/commands/init.ts";
import { newNodeClient } from "../../src/client.ts";
import type { EstablishConsentResult } from "../../src/commands/init-consent.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";
import { FbrainError } from "../../src/client.ts";
import { UNIQUE_SCHEMAS } from "../../src/schemas.ts";
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
});

describe("resolveUrls — port-breadcrumb node-URL default", () => {
  let tmp: string;
  let priorHome: string | undefined;

  function withBreadcrumb(content: string | null): void {
    tmp = mkdtempSync(join(tmpdir(), "fbrain-breadcrumb-"));
    if (content !== null) writeFileSync(join(tmp, "port"), content);
    priorHome = process.env.FOLDDB_HOME;
    process.env.FOLDDB_HOME = tmp;
  }

  afterEach(() => {
    if (priorHome === undefined) delete process.env.FOLDDB_HOME;
    else process.env.FOLDDB_HOME = priorHome;
    priorHome = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("fresh init with a breadcrumb → targets the breadcrumb port, not :9001", () => {
    withBreadcrumb("9299");
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe("http://127.0.0.1:9299");
    expect(r.nodeUrlFromBreadcrumb).toBe(true);
    expect(r.healed).toEqual([]);
  });

  test("fresh init, breadcrumb absent → falls back to DEFAULT_NODE_URL", () => {
    withBreadcrumb(null);
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.nodeUrlFromBreadcrumb).toBe(false);
  });

  test("breadcrumb of 9001 → resolved URL is still http://127.0.0.1:9001", () => {
    withBreadcrumb("9001");
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe("http://127.0.0.1:9001");
    expect(r.nodeUrlFromBreadcrumb).toBe(true);
  });

  test("--node-url overrides the breadcrumb", () => {
    withBreadcrumb("9299");
    const r = resolveUrls({ nodeUrl: "http://127.0.0.1:9001" }, null);
    expect(r.nodeUrl).toBe("http://127.0.0.1:9001");
    expect(r.nodeUrlFromBreadcrumb).toBe(false);
  });

  test("existing config URL is reused over the breadcrumb (breadcrumb only seeds a FRESH init)", () => {
    withBreadcrumb("9299");
    const existing = buildTestCfg({
      nodeUrl: "http://192.168.1.5:9001",
      schemaServiceUrl: "https://my-custom-lambda.example.com",
    });
    const r = resolveUrls({}, existing);
    expect(r.nodeUrl).toBe("http://192.168.1.5:9001");
    expect(r.nodeUrlFromBreadcrumb).toBe(false);
  });

  test("junk breadcrumb → falls back to DEFAULT_NODE_URL", () => {
    withBreadcrumb("not-a-port");
    const r = resolveUrls({}, null);
    expect(r.nodeUrl).toBe(DEFAULT_NODE_URL);
    expect(r.nodeUrlFromBreadcrumb).toBe(false);
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
    expect(after).toContain("fbrain design new");
    expect(after).toContain("fbrain list");
    expect(after).toContain("fbrain search");
    expect(after).toContain("fbrain doctor");
    // Tells the user where their data lives.
    expect(after).toContain(DEFAULT_NODE_URL);
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
    expect(out).toContain("fbrain design new my-first-idea");
    expect(out).toContain("fbrain list");
    expect(out).toContain("fbrain search");
    expect(out).toContain("fbrain ask");
    expect(out).toContain("fbrain doctor");
    // The headline agent-integration step: a brain meant to be used BY an
    // agent must tell the new dev how to connect it. The next-steps now LEAD
    // with the one-shot `fbrain mcp install` (registers + appends instructions
    // in one command), with the manual `claude mcp add` form kept as the
    // by-hand fallback. Pin both plus the `bun link` PATH caveat so this can't
    // silently regress.
    expect(out).toContain("fbrain mcp install");
    expect(out).toContain("claude mcp add fbrain fbrain-mcp");
    expect(out).toContain("bun link");
    expect(out).toContain("fbrain_* tools");
    expect(out).toContain("http://127.0.0.1:9001");
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
    expect(out).toContain("fbrain list");
    // The full first-record walkthrough is suppressed on a re-run.
    expect(out).not.toContain("Next steps");
    expect(out).not.toContain("fbrain design new");
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
// install-aware `nodeDownHint` (client.ts) rather than init's old hand-rolled
// `isDefaultNodeUrl` ternary. The bug that ternary shipped: a dev who
// brew-installed folddb but runs a non-default-port node and forgot to start
// it was told "first run from source… compiling Rust" — useless, since they
// never built from source. With the canonical helper, the prebuilt binary on
// PATH (signalled here via FBRAIN_FOLDDB_BIN) drives brew/daemon-start
// guidance even on a custom port.
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

  test("non-default URL + prebuilt binary on PATH → brew/daemon-start guidance, NOT 'compiling Rust'", async () => {
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
        { nodeUrl: "http://127.0.0.1:9050", retryDelaysMs: [0], sleep: async () => {} },
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
    // Canonical helper sends a downloaded user (binary on PATH) to brew, even
    // on a non-default port — the whole point of the fix.
    expect(out).toContain("brew services start folddb");
    // The misleading from-source framing must be gone for this case.
    expect(out).not.toContain("compiling Rust");
    expect(out).not.toContain("compiles Rust");
  });

  test("default :9001 URL → brew/daemon-start guidance, unchanged", async () => {
    const prior = process.env.FBRAIN_FOLDDB_BIN;
    // Even with no prebuilt binary, the default daemon is always brew-first.
    delete process.env.FBRAIN_FOLDDB_BIN;
    const lines: string[] = [];
    try {
      await probeWithRetry(
        unreachableProbeClient(),
        { nodeUrl: DEFAULT_NODE_URL, retryDelaysMs: [0], sleep: async () => {} },
        (l) => lines.push(l),
      );
      throw new Error("did not throw");
    } catch (err) {
      expect((err as FbrainError).code).toBe("service_unreachable");
    } finally {
      if (prior !== undefined) process.env.FBRAIN_FOLDDB_BIN = prior;
    }
    const out = lines.join("\n");
    expect(out).toContain(`node not reachable at ${DEFAULT_NODE_URL}`);
    expect(out).toContain("brew services start folddb");
    expect(out).not.toContain("compiling Rust");
  });
});
