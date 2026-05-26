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
  resolveUrls,
  runInit,
} from "../../src/commands/init.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";
import { FbrainError } from "../../src/client.ts";
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
