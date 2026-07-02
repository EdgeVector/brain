// Integration tests for the read/write-asymmetry fixes against the real
// fold_db_node harness: `fbrain append` (grow a body, cross a process boundary
// via the CLI get), `fbrain status` (status-only patch preserves the body),
// and `fbrain put`'s body-shrink guard (refuse a truncating re-put; honor
// --allow-shrink). Skipped when no harness is available.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { main as cliMain } from "../../src/cli.ts";
import { putCmd } from "../../src/commands/put.ts";
import { appendCmd } from "../../src/commands/append.ts";
import { statusCmd } from "../../src/commands/status.ts";
import { readConfig } from "../../src/config.ts";
import { FbrainError } from "../../src/client.ts";

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
  harness = await startHarness({ name: "fbrain-rwa-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-rwa-cfg-"));
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
    "fbrain-rwa",
  ]);
  if (initRes.code !== 0) {
    throw new Error(`rwa setup init failed:\nstdout=${initRes.stdout}\nstderr=${initRes.stderr}`);
  }
}, 240_000);

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

describeIntegration("read/write asymmetry — append", () => {
  test("append grows the body without a rewrite; a subsequent CLI get shows the full grown body", async () => {
    const slug = `rwa-append-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    await putCmd({
      cfg,
      slug,
      input: "---\ntype: concept\ntitle: Growable\ntags: [t]\n---\nhead paragraph",
    });
    await appendCmd({ cfg, slug, chunk: "tail paragraph", type: "concept" });

    // Cross the process boundary: read it back via the CLI get path.
    const got = await runCli(["get", slug, "--type", "concept"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain("head paragraph");
    expect(got.stdout).toContain("tail paragraph");
    // Non-body fields preserved through the append's read-modify-write.
    expect(got.stdout).toContain("Growable");
    expect(got.stdout).toContain("tags:       t");
  }, 60_000);
});

describeIntegration("read/write asymmetry — status patch preserves body", () => {
  test("fbrain status changes only the status; the body survives (unlike a status-only re-put)", async () => {
    const slug = `rwa-status-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    await putCmd({
      cfg,
      slug,
      input: "---\ntype: concept\ntitle: Keep Body\n---\nimportant body that must survive",
    });
    await statusCmd({ cfg, slug, newStatus: "archived", type: "concept" });

    const got = await runCli(["get", slug, "--type", "concept"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain("important body that must survive");
    const st = await runCli(["status", slug, "--type", "concept"]);
    expect(st.stdout.trim()).toBe("archived");
  }, 60_000);
});

describeIntegration("read/write asymmetry — put shrink guard", () => {
  test("a status-only re-put that would wipe the body is refused; --allow-shrink truncates on purpose", async () => {
    const slug = `rwa-shrink-${Date.now().toString(36)}`;
    const cfg = readConfig(configPath);
    const bigBody = "x".repeat(400);
    await putCmd({
      cfg,
      slug,
      input: `---\ntype: concept\ntitle: Big\n---\n${bigBody}`,
    });

    // Empty-body re-put (the status-only-touch-up footgun) is refused.
    await expect(
      putCmd({ cfg, slug, input: "---\ntype: concept\ntitle: Big\nstatus: archived\n---\n" }),
    ).rejects.toThrow(FbrainError);

    // Body is intact after the refused write.
    const got1 = await runCli(["get", slug, "--type", "concept"]);
    expect(got1.stdout).toContain(bigBody);

    // Deliberate truncation with allow-shrink is honored.
    const r = await putCmd({
      cfg,
      slug,
      input: "---\ntype: concept\ntitle: Big\n---\ntiny",
      allowShrink: true,
    });
    expect(r.action).toBe("updated");
    const got2 = await runCli(["get", slug, "--type", "concept"]);
    expect(got2.stdout).toContain("tiny");
    expect(got2.stdout).not.toContain(bigBody);
  }, 60_000);
});
