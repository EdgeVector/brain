// Phase 5 integration tests — `fbrain delete` against the real fold harness.
//
// Pins the contracts from docs/phase-5-delete-spike.md:
//   * Create → delete → get returns "No <type>: <slug>".
//   * Slug in both schemas requires --type; deleting one leaves the other.
//   * Create → delete → re-create (no --force) succeeds and the new record
//     is the visible one.
//   * Raw query (escape hatch) shows the tombstone tag on the wiped record,
//     proving fold_db's append-only behavior is what's documented in the
//     spike — and that the CLI's filter is doing the work, not fold_db.
//
// Skipped when FBRAIN_SKIP_INTEGRATION=1 or no harness is reachable.
// All tests share one harness — the cost of spinning fold_db is dominated
// by the cold cargo build, ~96s for the full integration suite.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isHarnessAvailable, startHarness, type Harness } from "../harness.ts";
import { main as cliMain } from "../../src/cli.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";

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

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

beforeAll(async () => {
  if (skipReason) return;
  harness = await startHarness({ name: "fbrain-phase5-test" });
  tmpHome = mkdtempSync(join(tmpdir(), "fbrain-phase5-cfg-"));
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
    "fbrain-phase5",
  ]);
  if (initRes.code !== 0) {
    throw new Error(`Phase 5 setup init failed:\nstdout=${initRes.stdout}\nstderr=${initRes.stderr}`);
  }
}, 240_000);

afterAll(async () => {
  delete process.env.FBRAIN_CONFIG;
  delete process.env.FBRAIN_NO_STDIN;
  delete process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (harness) await harness.teardown();
}, 60_000);

describeIntegration("Phase 5 — delete (design)", () => {
  test("create → delete → get returns 'No design'", async () => {
    const slug = unique("phase5-del-design");
    const created = await runCli(["design", "new", slug, "--title", "doomed", "--body", "B"]);
    expect(created.code).toBe(0);

    const got = await runCli(["get", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain(slug);

    const del = await runCli(["delete", slug, "--type", "design"]);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain(`deleted design ${slug}`);
    expect(del.stdout).toContain("docs/phase-5-delete-spike.md");

    const afterGet = await runCli(["get", slug, "--type", "design"]);
    expect(afterGet.code).toBe(1);
    expect(afterGet.stderr).toContain(`No design: ${slug}`);
  }, 60_000);

  test("missing slug → 'No design: <slug>' before any mutation fires", async () => {
    const slug = unique("phase5-del-missing");
    const del = await runCli(["delete", slug, "--type", "design"]);
    expect(del.code).toBe(1);
    expect(del.stderr).toContain(`No design: ${slug}`);
  }, 30_000);

  test("delete-then-delete: second call says 'No design: <slug>'", async () => {
    const slug = unique("phase5-del-twice");
    await runCli(["design", "new", slug, "--title", "T", "--body", "B"]);
    const first = await runCli(["delete", slug, "--type", "design"]);
    expect(first.code).toBe(0);
    const second = await runCli(["delete", slug, "--type", "design"]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`No design: ${slug}`);
  }, 60_000);

  test("create → delete → re-create (no --force) restores a live record", async () => {
    const slug = unique("phase5-del-recreate");
    await runCli(["design", "new", slug, "--title", "v1", "--body", "first"]);
    const del = await runCli(["delete", slug, "--type", "design"]);
    expect(del.code).toBe(0);
    // re-create without --force should succeed because the tombstoned
    // record is invisible to findBySlug's duplicate-check.
    const re = await runCli(["design", "new", slug, "--title", "v2", "--body", "second"]);
    expect(re.code).toBe(0);
    const got = await runCli(["get", slug, "--type", "design"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain("v2");
    expect(got.stdout).toContain("second");
    expect(got.stdout).not.toContain("v1");
  }, 60_000);

  test("delete strips the record from `fbrain list`", async () => {
    const slug = unique("phase5-del-list");
    await runCli(["design", "new", slug, "--title", "willbe-dead", "--body", "B"]);
    const before = await runCli(["list", "--type", "design"]);
    expect(before.stdout).toContain(slug);
    await runCli(["delete", slug, "--type", "design"]);
    const after = await runCli(["list", "--type", "design"]);
    expect(after.stdout).not.toContain(slug);
  }, 60_000);
});

describeIntegration("Phase 5 — delete (task) + design-slug ambiguity", () => {
  test("slug in both schemas: without --type → error, with --type → only the named one is deleted", async () => {
    const slug = unique("phase5-del-dual");
    const dCreate = await runCli(["design", "new", slug, "--title", "d", "--body", "design-body"]);
    expect(dCreate.code).toBe(0);
    const tCreate = await runCli(["task", "new", slug, "--title", "t", "--body", "task-body"]);
    expect(tCreate.code).toBe(0);

    const ambig = await runCli(["delete", slug]);
    expect(ambig.code).toBe(1);
    expect(ambig.stderr.toLowerCase()).toContain("specify --type");

    const dDel = await runCli(["delete", slug, "--type", "design"]);
    expect(dDel.code).toBe(0);

    const dGet = await runCli(["get", slug, "--type", "design"]);
    expect(dGet.code).toBe(1);
    expect(dGet.stderr).toContain(`No design: ${slug}`);

    const tGet = await runCli(["get", slug, "--type", "task"]);
    expect(tGet.code).toBe(0);
    expect(tGet.stdout).toContain("task-body");

    // cleanup the task too so it doesn't pollute later list assertions
    const tDel = await runCli(["delete", slug, "--type", "task"]);
    expect(tDel.code).toBe(0);
  }, 90_000);

  test("delete of a task: status=cancelled and design_slug cleared at the raw layer", async () => {
    // The CLI hides tombstoned records; raw POST /api/query is the escape
    // hatch that proves the soft-delete actually wrote the documented row.
    const slug = unique("phase5-del-task-raw");
    await runCli([
      "task",
      "new",
      slug,
      "--title",
      "tt",
      "--body",
      "tt-body",
      "--design",
      "non-existent-parent-shouldnt-be-required",
    ]).catch(() => {
      // task new --design rejects when parent doesn't exist; that's fine,
      // we just want a task. Retry without --design.
    });
    // Just create plain task (no --design) for the test surface.
    const created = await runCli(["task", "new", slug, "--title", "tt", "--body", "tt-body", "--force"]);
    expect(created.code).toBe(0);

    const del = await runCli(["delete", slug, "--type", "task"]);
    expect(del.code).toBe(0);

    // Raw query the task schema — bypasses the tombstone filter.
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const body = JSON.stringify({
      schema_name: cfg.taskSchemaHash,
      fields: ["slug", "title", "body", "status", "tags", "design_slug", "created_at", "updated_at"],
    });
    const raw = await runCli(["raw", "POST", "/api/query", body]);
    expect(raw.code).toBe(0);
    const parsed = JSON.parse(raw.stdout) as {
      results: Array<{
        fields: Record<string, unknown>;
        key: { hash: string | null; range: string | null };
      }>;
    };
    const row = parsed.results.find((r) => r.key.hash === slug);
    expect(row).toBeDefined();
    expect(row!.fields.status).toBe("cancelled");
    expect(row!.fields.title).toBe("(deleted)");
    expect(row!.fields.body).toBe("");
    expect(row!.fields.design_slug).toBe("");
    expect(row!.fields.tags).toEqual([TOMBSTONE_TAG]);
  }, 90_000);
});

describeIntegration("Phase 5 — delete design referential integrity", () => {
  test("blocks deleting a design with a live linked task; --force overrides and get flags the orphan", async () => {
    const design = unique("guard-design");
    const task = unique("guard-task");

    const dCreate = await runCli(["design", "new", design, "--title", "parent", "--body", "B"]);
    expect(dCreate.code).toBe(0);
    const tCreate = await runCli(["task", "new", task, "--title", "child", "--body", "B", "--design", design]);
    expect(tCreate.code).toBe(0);

    // Block-by-default: the design cannot be deleted while the task links to it.
    const blocked = await runCli(["delete", design, "--type", "design"]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain(task);
    expect(blocked.stderr.toLowerCase()).toContain("--force");
    // The block is fail-safe: the design is untouched and still gettable.
    const stillThere = await runCli(["get", design, "--type", "design"]);
    expect(stillThere.code).toBe(0);

    // --force overrides and warns about the soon-to-dangle task.
    const forced = await runCli(["delete", design, "--type", "design", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain(`deleted design ${design}`);
    expect(forced.stdout).toContain(task);

    // The task now has a dangling design reference — get flags it.
    const orphanGet = await runCli(["get", task, "--type", "task"]);
    expect(orphanGet.code).toBe(0);
    expect(orphanGet.stdout).toContain(`design:     ${design} (deleted)`);

    // cleanup so the orphan doesn't pollute later list assertions
    await runCli(["delete", task, "--type", "task"]);
  }, 120_000);

  test("deleting a design with no linked tasks still works", async () => {
    const design = unique("guard-unlinked");
    await runCli(["design", "new", design, "--title", "lonely", "--body", "B"]);
    const del = await runCli(["delete", design, "--type", "design"]);
    expect(del.code).toBe(0);
    expect(del.stdout).toContain(`deleted design ${design}`);
  }, 60_000);
});
