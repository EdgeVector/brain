// Integration test for the polluted-daemon read-flake retry —
// docs/phase-7-search-latency-spike.md (H2). Pins that `fbrain get`,
// `fbrain delete`, and `fbrain status` no longer surface "No record"
// for a row that was just written: the per-type query loop in each
// command retries (5×, 250 ms — match scripts/parity-smoketest.sh) so
// users don't see the same flake the smoketest already rides out.
//
// Without the retry, a tight put → get loop against a polluted daemon
// observes ~80 / 100 successes (the dogfooding repro from 2026-05-25).
// With the retry, it should be 100 / 100. We run 25 iterations here so
// the test stays under the per-test budget while still being enough to
// flush a single-digit flake rate.
//
// Skipped when FBRAIN_SKIP_INTEGRATION=1 or no fold_db harness is
// reachable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { main as cliMain } from "../../src/cli.ts";
import { putCmd } from "../../src/commands/put.ts";
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
  harness = await startHarness({ name: "fbrain-readretry-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-readretry-cfg-"));
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
    "fbrain-readretry",
  ]);
  if (initRes.code !== 0) {
    throw new Error(`read-retry setup init failed:\nstdout=${initRes.stdout}\nstderr=${initRes.stderr}`);
  }
}, 240_000);

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

describeIntegration("read-flake retry — put → get tight loop", () => {
  test("25 put → get round-trips all succeed (no flake leak through CLI)", async () => {
    const cfg = readConfig(configPath);
    const iterations = 25;
    const failures: Array<{ i: number; stderr: string }> = [];
    for (let i = 0; i < iterations; i++) {
      const slug = `read-retry-loop-${Date.now().toString(36)}-${i}`;
      const r = await putCmd({
        cfg,
        slug,
        input: `---\ntype: concept\ntitle: read-retry probe ${i}\n---\nbody for iteration ${i}`,
      });
      expect(r.action).toBe("created");
      const got = await runCli(["get", slug, "--type", "concept"]);
      if (got.code !== 0) {
        failures.push({ i, stderr: got.stderr });
      }
    }
    if (failures.length > 0) {
      const detail = failures.map((f) => `  i=${f.i}: ${f.stderr}`).join("\n");
      throw new Error(`${failures.length}/${iterations} get attempts failed:\n${detail}`);
    }
  }, 240_000);

  test("real miss (record never written) still surfaces 'No record' cleanly", async () => {
    const slug = `read-retry-ghost-${Date.now().toString(36)}`;
    const got = await runCli(["get", slug]);
    expect(got.code).toBe(1);
    expect(got.stderr).toContain(`No record with slug "${slug}"`);
  }, 30_000);

  test("status flake retry: put → status returns the record (no false miss)", async () => {
    const cfg = readConfig(configPath);
    const slug = `read-retry-status-${Date.now().toString(36)}`;
    await putCmd({
      cfg,
      slug,
      input: "---\ntype: concept\ntitle: status probe\n---\nstatus probe body",
    });
    const got = await runCli(["status", slug, "--type", "concept"]);
    expect(got.code).toBe(0);
    expect(got.stdout.trim()).toBe("active");
  }, 60_000);
});
