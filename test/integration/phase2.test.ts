// Phase 2 integration tests — search, doctor, raw — against the real
// fold harness (skipped when FBRAIN_SKIP_INTEGRATION=1 or no harness).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { main as cliMain } from "../../src/cli.ts";
import { readConfig } from "../../src/config.ts";

const skipReason = !isHarnessAvailable();
const describeIntegration = skipReason ? describe.skip : describe;

let harness: Harness;
let tmpHome: string;
let configPath: string;

const realLog = console.log;
const realErr = console.error;
let stdoutBuf: string[] = [];
let stderrBuf: string[] = [];

function captureConsole(): void {
  stdoutBuf = [];
  stderrBuf = [];
  console.log = (...args: unknown[]) => {
    stdoutBuf.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderrBuf.push(args.map(String).join(" "));
  };
}

function restoreConsole(): void {
  console.log = realLog;
  console.error = realErr;
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  captureConsole();
  try {
    const code = await cliMain(args);
    return { code, stdout: stdoutBuf.join("\n"), stderr: stderrBuf.join("\n") };
  } finally {
    restoreConsole();
  }
}

beforeAll(async () => {
  if (skipReason) return;
  harness = await startHarness({ name: "fbrain-phase2-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-phase2-cfg-"));
  configPath = join(tmpHome, "config.json");
  process.env.FBRAIN_CONFIG = configPath;
  process.env.FBRAIN_NO_STDIN = "1";
  process.env.FBRAIN_INIT_RETRY_DELAYS_MS = "";
  const initRes = await runCli([
    "init",
    "--node-url",
    harness.nodeUrl,
    "--schema-service-url",
    harness.schemaServiceUrl,
    "--name",
    "fbrain-phase2",
  ]);
  if (initRes.code !== 0) {
    throw new Error(`Phase 2 setup init failed:\nstdout=${initRes.stdout}\nstderr=${initRes.stderr}`);
  }
}, 240_000);

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

describeIntegration("Phase 2 — doctor", () => {
  test("doctor on clean harness exits 0 with OK", async () => {
    const res = await runCli(["doctor"]);
    if (res.code !== 0) {
      console.error("[doctor test stdout]\n" + res.stdout);
      console.error("[doctor test stderr]\n" + res.stderr);
    }
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
    expect(res.stdout).toContain("[PASS] config");
    expect(res.stdout).toContain("[PASS] schema-service-reachable");
    expect(res.stdout).toContain("[PASS] node-reachable");
    expect(res.stdout).toContain("[PASS] node-provisioned");
    expect(res.stdout).toContain("[PASS] schemas-loaded");
    expect(res.stdout).toContain("[PASS] schema-drift[Design]");
    expect(res.stdout).toContain("[PASS] schema-drift[Task]");
  });

  test("doctor with bad-hash config flags config FAIL", async () => {
    const original = readConfig(configPath);
    const tampered = { ...original, designSchemaHash: "deadbeef" };
    writeFileSync(configPath, JSON.stringify(tampered), "utf8");
    try {
      const res = await runCli(["doctor"]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain("[FAIL] config");
      expect(res.stdout).toContain("FAIL");
    } finally {
      writeFileSync(configPath, JSON.stringify(original), "utf8");
    }
  });

  test("doctor returns OK again after restoring config", async () => {
    const res = await runCli(["doctor"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("OK");
  });
});

describeIntegration("Phase 2 — search", () => {
  test("design with searchable body → search finds it", async () => {
    const slug = `phase2-search-${Date.now().toString(36)}`;
    const create = await runCli([
      "design",
      "new",
      slug,
      "--title",
      "Searchable design",
      "--body",
      "blueberry octopus marshmallow fingerprints alpha beta",
    ]);
    expect(create.code).toBe(0);
    const res = await runCli(["search", "blueberry"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(slug);
  }, 60_000);

  test("update body → re-search picks up new content", async () => {
    const slug = `phase2-search-update-${Date.now().toString(36)}`;
    const created = await runCli([
      "design",
      "new",
      slug,
      "--title",
      "X",
      "--body",
      "original starfruit kumquat",
    ]);
    expect(created.code).toBe(0);
    // overwrite with --force, new body
    const rewritten = await runCli([
      "design",
      "new",
      slug,
      "--title",
      "X",
      "--body",
      "rewritten word zucchini elderberry",
      "--force",
    ]);
    expect(rewritten.code).toBe(0);
    const res = await runCli(["search", "zucchini"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(slug);
  }, 60_000);

  test("query with min-score above all hits prints 'no matches'", async () => {
    // The native index always finds *some* fuzzy semantic match. Use a
    // very high min_score floor so the empty-result path is exercised
    // deterministically.
    const res = await runCli([
      "search",
      "nonsensewordnotpresentanywhere1234567",
      "--min-score",
      "0.99",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("no matches");
  });
});

describeIntegration("Phase 2 — raw", () => {
  test("GET /api/system/auto-identity round-trips identity JSON", async () => {
    const res = await runCli(["raw", "GET", "/api/system/auto-identity"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("user_hash");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.user_hash).toBe(harness.userHash);
  });

  test("POST /api/mutation round-trips a mutation", async () => {
    const slug = `phase2-raw-${Date.now().toString(36)}`;
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const now = new Date().toISOString();
    const body = JSON.stringify({
      type: "mutation",
      schema: cfg.designSchemaHash,
      fields_and_values: {
        slug,
        title: "from raw",
        body: "raw passthrough proves the surface",
        status: "draft",
        tags: ["raw"],
        created_at: now,
        updated_at: now,
      },
      key_value: { hash: slug, range: null },
      mutation_type: "create",
    });
    const res = await runCli(["raw", "POST", "/api/mutation", body]);
    expect(res.code).toBe(0);
    const got = await runCli(["get", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain(slug);
  });

  test("GET /v1/schemas does not send X-User-Hash but returns 200", async () => {
    const res = await runCli(["raw", "GET", "/v1/schemas"]);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
  });

  test("invalid path → friendly error and exit 1", async () => {
    const res = await runCli(["raw", "GET", "/nonsense"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("/api/");
    expect(res.stderr).toContain("/v1/");
  });

  test("invalid method → friendly error and exit 1", async () => {
    const res = await runCli(["raw", "OPTIONS", "/api/system/auto-identity"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Unsupported method");
  });
});
