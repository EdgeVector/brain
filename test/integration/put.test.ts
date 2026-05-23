// Phase 4 integration tests — `fbrain put <slug>` from stdin against
// the real fold_db_node harness. Skipped when no harness available
// (FBRAIN_SKIP_INTEGRATION=1 or FOLD_NODE_DIR unreachable).

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
  harness = await startHarness({ name: "fbrain-phase4-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-phase4-cfg-"));
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
    "fbrain-phase4",
  ]);
  if (initRes.code !== 0) {
    throw new Error(`Phase 4 setup init failed:\nstdout=${initRes.stdout}\nstderr=${initRes.stderr}`);
  }
}, 240_000);

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

// We bypass the CLI's stdin reader (which intentionally returns "" under
// FBRAIN_NO_STDIN=1) and call putCmd directly with the input string.
// CLI dispatch + arg parsing is exercised by the unit tests and by other
// commands here.

describeIntegration("Phase 4 — fbrain put (design)", () => {
  test("frontmatter-aware design create roundtrips through get", async () => {
    const slug = `phase4-design-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    const r = await putCmd({
      cfg,
      slug,
      input:
        "---\ntype: design\ntitle: End-to-end put test\ntags: [e2e, dogfood]\n---\nbody text indexed for search",
    });
    expect(r.action).toBe("created");
    expect(r.type).toBe("design");
    const got = await runCli(["get", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain(`[design] ${slug}`);
    expect(got.stdout).toContain("End-to-end put test");
    expect(got.stdout).toContain("tags:       e2e, dogfood");
    expect(got.stdout).toContain("body text indexed for search");
    expect(got.stdout).toContain("status:     draft");
  }, 60_000);

  test("re-put with new body updates in place (no 409, no duplicate)", async () => {
    const slug = `phase4-upsert-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    const first = await putCmd({
      cfg,
      slug,
      input: "---\ntype: design\ntitle: First\ntags: [a]\n---\nfirst body",
    });
    expect(first.action).toBe("created");
    const second = await putCmd({
      cfg,
      slug,
      input: "---\ntype: design\ntitle: Second\ntags: [b]\n---\nsecond body, rewritten",
    });
    expect(second.action).toBe("updated");
    const got = await runCli(["get", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain("Second");
    expect(got.stdout).toContain("tags:       b");
    expect(got.stdout).toContain("second body, rewritten");
    expect(got.stdout).not.toContain("first body");
  }, 60_000);

  test("re-put preserves status if user moved it past default", async () => {
    const slug = `phase4-status-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    await putCmd({
      cfg,
      slug,
      input: "---\ntype: design\ntitle: T\n---\nbody",
    });
    const statusRes = await runCli(["status", slug, "reviewed", "--type", "design"]);
    expect(statusRes.code).toBe(0);
    await putCmd({
      cfg,
      slug,
      input: "---\ntype: design\ntitle: T2\n---\nbody2",
    });
    const got = await runCli(["status", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout.trim()).toBe("reviewed");
  }, 60_000);

  test("title falls back to first H1 when frontmatter has no title", async () => {
    const slug = `phase4-h1-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    await putCmd({
      cfg,
      slug,
      input: "---\ntype: design\n---\n# H1 Title\n\nbody text",
    });
    const got = await runCli(["get", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain("title:      H1 Title");
  }, 60_000);
});

describeIntegration("Phase 4 — fbrain put (task)", () => {
  test("frontmatter type: task creates a Task", async () => {
    const slug = `phase4-task-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    const r = await putCmd({
      cfg,
      slug,
      input: "---\ntype: task\ntitle: A task via put\ntags: [t]\n---\nthe task body",
    });
    expect(r.action).toBe("created");
    expect(r.type).toBe("task");
    const got = await runCli(["get", slug, "--type", "task"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain(`[task] ${slug}`);
    expect(got.stdout).toContain("status:     open");
    expect(got.stdout).toContain("the task body");
  }, 60_000);
});

describeIntegration("Phase 4 — fbrain put (errors)", () => {
  test("unsupported type errors with Phase 6 pointer (no write occurs)", async () => {
    const slug = `phase4-concept-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    let err: unknown = null;
    try {
      await putCmd({
        cfg,
        slug,
        input: "---\ntype: concept\ntitle: nope\n---\nbody",
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as { code: string }).code).toBe("unsupported_type");
    expect((err as { hint: string }).hint).toContain("Phase 6");
    const got = await runCli(["get", slug]);
    expect(got.code).toBe(1);
    expect(got.stderr).toContain("No design or task");
  }, 60_000);
});
