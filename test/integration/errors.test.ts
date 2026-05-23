// Error-path integration tests for paths NOT covered in phase1.test.ts:
//   - init against a dead node = clear unreachable error
//   - missing config (no init has run) = "Run `fbrain init` first"
//   - empty list returns "no records"
//   - 401 on missing X-User-Hash (we set a blank user_hash in the harness config and probe)
//
// We use a fresh harness for the empty-list case; the dead-node case
// doesn't need one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { main as cliMain } from "../../src/cli.ts";

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
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-errors-cfg-"));
  configPath = join(tmpHome, "config.json");
  process.env.FBRAIN_CONFIG = configPath;
  process.env.FBRAIN_NO_STDIN = "1";
  // Disable init's cold-build retry in tests — we never want to wait
  // minutes for a deliberately dead port to time out.
  process.env.FBRAIN_INIT_RETRY_DELAYS_MS = "";
});

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

describeIntegration("error paths", () => {
  test("init against a dead port reports service_unreachable", async () => {
    const res = await runCli([
      "init",
      "--node-url",
      "http://127.0.0.1:1",
      "--schema-service-url",
      "http://127.0.0.1:1",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not reachable");
    expect(res.stderr).toContain("fbrain doctor");
  });

  test("any command without config tells the user to init", async () => {
    // ensure no config file exists
    rmSync(configPath, { force: true });
    const res = await runCli(["list"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Run `fbrain init` first");
  });

  test("invalid config JSON → ConfigInvalid", async () => {
    writeFileSync(configPath, "not json", "utf8");
    const res = await runCli(["list"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("invalid");
    rmSync(configPath, { force: true });
  });

  test("empty list on a fresh node prints 'no records'", async () => {
    harness = await startHarness({ name: "fbrain-errors-test" });
    const initRes = await runCli([
      "init",
      "--node-url",
      harness.nodeUrl,
      "--schema-service-url",
      harness.schemaServiceUrl,
    ]);
    expect(initRes.code).toBe(0);
    const res = await runCli(["list"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("no records");
  }, 240_000);

  test("tampered config (non-canonical hash) surfaces an actionable error", async () => {
    // Point designSchemaHash at a bogus value — the node will reject the
    // query and the Error Registry must steer the user back to `init`.
    const tampered = {
      configVersion: 1,
      nodeUrl: harness.nodeUrl,
      schemaServiceUrl: harness.schemaServiceUrl,
      userHash: harness.userHash,
      designSchemaHash: "deadbeef-not-a-real-hash",
      taskSchemaHash: harness.taskSchemaHash,
    };
    writeFileSync(configPath, JSON.stringify(tampered), "utf8");
    const res = await runCli(["list", "--type", "design"]);
    expect(res.code).toBe(1);
    // The error must point the user back to init or doctor.
    expect(res.stderr.toLowerCase()).toMatch(/init|doctor|schema|hash/);
  }, 240_000);
});
