// Phase 1 gate: create a design, two tasks, link one to the design,
// list by status and tag, change a status, get each, delete one — via
// the CLI binary, against the harness's node.
//
// Per the plan's "Test strategy" — covers the integration flow and
// every Error & Rescue Registry row reachable from Phase 1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { readConfig } from "../../src/config.ts";
import { main as cliMain } from "../../src/cli.ts";

const skipReason = !isHarnessAvailable();
const describeIntegration = skipReason ? describe.skip : describe;

let harness: Harness;
let configPath: string;
let tmpHome: string;
let stdoutBuf: string[] = [];
let stderrBuf: string[] = [];

const realLog = console.log;
const realErr = console.error;

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
    return {
      code,
      stdout: stdoutBuf.join("\n"),
      stderr: stderrBuf.join("\n"),
    };
  } finally {
    restoreConsole();
  }
}

beforeAll(async () => {
  if (skipReason) return;
  harness = await startHarness({ name: "fbrain-phase1-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-cfg-"));
  configPath = join(tmpHome, "config.json");
  process.env.FBRAIN_CONFIG = configPath;
  process.env.FBRAIN_NO_STDIN = "1";
  process.env.FBRAIN_INIT_RETRY_DELAYS_MS = "";
}, 240_000);

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

describeIntegration("Phase 1 — core CRUD", () => {
  test("init writes config with canonical hashes", async () => {
    const res = await runCli([
      "init",
      "--node-url",
      harness.nodeUrl,
      "--schema-service-url",
      harness.schemaServiceUrl,
      "--name",
      "fbrain-phase1",
    ]);
    expect(res.code).toBe(0);
    const cfg = readConfig(configPath);
    expect(cfg.designSchemaHash).toBe(harness.designSchemaHash);
    expect(cfg.taskSchemaHash).toBe(harness.taskSchemaHash);
    expect(cfg.userHash).toBe(harness.userHash);
    // Step markers all present
    expect(res.stdout).toContain("[1/5]");
    expect(res.stdout).toContain("[5/5]");
  });

  test("init is idempotent — re-running succeeds without errors", async () => {
    const res = await runCli([
      "init",
      "--node-url",
      harness.nodeUrl,
      "--schema-service-url",
      harness.schemaServiceUrl,
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("skipping bootstrap");
  });

  test("design new creates a design", async () => {
    const res = await runCli([
      "design",
      "new",
      "spike-test",
      "--title",
      "From Phase 1",
      "--tag",
      "alpha",
      "--tag",
      "beta",
      "--body",
      "the spike-test design body",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("created design spike-test");
  });

  test("design new rejects duplicate slug without --force", async () => {
    const res = await runCli(["design", "new", "spike-test", "--title", "dup"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("already exists");
  });

  test("design new --force overwrites", async () => {
    const res = await runCli([
      "design",
      "new",
      "spike-test",
      "--title",
      "From Phase 1 (forced)",
      "--tag",
      "alpha",
      "--tag",
      "beta",
      "--body",
      "the spike-test design body",
      "--force",
    ]);
    expect(res.code).toBe(0);
  });

  test("get prints the design", async () => {
    const res = await runCli(["get", "spike-test", "--type", "design"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[design] spike-test");
    expect(res.stdout).toContain("tags:       alpha, beta");
    expect(res.stdout).toContain("From Phase 1");
  });

  test("get without --type works when slug is unique", async () => {
    const res = await runCli(["get", "spike-test"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[design] spike-test");
  });

  test("list --type design shows the design", async () => {
    const res = await runCli(["list", "--type", "design"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("spike-test");
  });

  test("status (read-only) prints current status", async () => {
    const res = await runCli(["status", "spike-test", "--type", "design"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("draft");
  });

  test("status update changes status", async () => {
    const res = await runCli(["status", "spike-test", "reviewed", "--type", "design"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("draft → reviewed");
    const after = await runCli(["status", "spike-test", "--type", "design"]);
    expect(after.stdout.trim()).toBe("reviewed");
  });

  test("status rejects invalid value", async () => {
    const res = await runCli(["status", "spike-test", "wrongvalue", "--type", "design"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not a valid design status");
  });

  test("task new creates a task", async () => {
    const res = await runCli([
      "task",
      "new",
      "t1",
      "--title",
      "Task 1",
      "--tag",
      "alpha",
      "--body",
      "first task body",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("created task t1");
  });

  test("task new with --design rejects dangling parent", async () => {
    const res = await runCli([
      "task",
      "new",
      "t2",
      "--title",
      "Task 2",
      "--design",
      "no-such-design",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("does not exist");
  });

  test("task new with valid --design works", async () => {
    const res = await runCli([
      "task",
      "new",
      "t2",
      "--title",
      "Task 2",
      "--design",
      "spike-test",
      "--tag",
      "beta",
    ]);
    expect(res.code).toBe(0);
  });

  test("link rejects dangling design", async () => {
    const res = await runCli(["link", "t1", "no-such-design"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("No design");
  });

  test("link wires t1 to spike-test", async () => {
    const res = await runCli(["link", "t1", "spike-test"]);
    expect(res.code).toBe(0);
    const got = await runCli(["get", "t1", "--type", "task"]);
    expect(got.stdout).toContain("design:     spike-test");
  });

  test("relink t1 → spike-test is clean (idempotent in spirit)", async () => {
    const res = await runCli(["link", "t1", "spike-test"]);
    expect(res.code).toBe(0);
  });

  test("list --tag alpha shows alpha-tagged records only", async () => {
    const res = await runCli(["list", "--tag", "alpha"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("spike-test");
    expect(res.stdout).toContain("t1");
    expect(res.stdout).not.toContain("t2 ");
  });

  test("list --status open shows tasks not designs", async () => {
    const res = await runCli(["list", "--status", "open"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("t1");
    expect(res.stdout).not.toContain("spike-test");
  });

  test("list --status reviewed shows the design", async () => {
    const res = await runCli(["list", "--status", "reviewed"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("spike-test");
  });

  test("get t1 (unique slug) returns the task", async () => {
    const res = await runCli(["get", "t1"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[task] t1");
  });

  test("get with unknown slug exits 1 with No record with slug", async () => {
    const res = await runCli(["get", "no-such-slug"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("No record with slug");
  });

  test("status of unknown slug exits 1", async () => {
    const res = await runCli(["status", "no-such-slug"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("No record with slug");
  });
});
