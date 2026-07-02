// Unit tests for `fbrain doctor --usage` (G13 team-adoption telemetry).
// Inject a synthetic NodeClient backed by an in-memory store; verify the
// grouping, 7-day window, today subset, 8-char hash-prefix privacy, and
// the daily-summary persistence at ~/.fbrain/usage.jsonl.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultUsagePath,
  runUsageReport,
  type DailySummaryLine,
} from "../../src/commands/usage.ts";
import { doctor } from "../../src/commands/doctor.ts";
import { pubkeyToUserHash } from "../../src/client.ts";
import type {
  NativeIndexHit,
  NodeClient,
  QueryResponse,
  QueryRow,
} from "../../src/client.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

// Two synthetic ed25519-shaped base64 pubkeys. The pair must hash to
// 8-char prefixes that are visually distinct so output assertions are
// easy to read. `pubkeyToUserHash` is deterministic so we compute the
// expected prefix inline.
const PUBKEY_A = "AAAA" + "A".repeat(40) + "=";
const PUBKEY_B = "BBBB" + "B".repeat(40) + "=";
const HASH_A = pubkeyToUserHash(PUBKEY_A);
const HASH_B = pubkeyToUserHash(PUBKEY_B);
const PREFIX_A = HASH_A.slice(0, 8);
const PREFIX_B = HASH_B.slice(0, 8);

// A fixed "now" so tests are deterministic. Pick a UTC midnight + an hour
// so we can construct rows that fall on either side of today's boundary.
const NOW = new Date("2026-05-24T10:00:00.000Z");
const TODAY_AT_NOON = "2026-05-24T12:00:00.000Z"; // future-of-NOW but same UTC day
const TODAY_AT_MORNING = "2026-05-24T01:00:00.000Z";
const YESTERDAY = "2026-05-23T12:00:00.000Z";
const FIVE_DAYS_AGO = "2026-05-19T12:00:00.000Z";
const EIGHT_DAYS_AGO = "2026-05-16T12:00:00.000Z";

type FakeRow = {
  slug: string;
  type: "design" | "task" | "concept" | "preference" | "reference" | "agent" | "project" | "spike";
  pubkey: string;
  created_at: string;
};

function makeRow(r: FakeRow): { schemaHash: string; row: QueryRow } {
  const fields: Record<string, unknown> = {
    slug: r.slug,
    title: r.slug,
    body: "",
    status: "active",
    tags: [],
    created_at: r.created_at,
    updated_at: r.created_at,
  };
  if (r.type === "task") fields.design_slug = "";
  return {
    schemaHash: TEST_HASHES[r.type],
    row: {
      fields,
      key: { hash: r.slug, range: null },
      author_pub_key: r.pubkey,
    },
  };
}

function mockNodeWithRows(rows: FakeRow[]): NodeClient {
  const store = new Map<string, QueryRow[]>();
  for (const r of rows) {
    const m = makeRow(r);
    const arr = store.get(m.schemaHash) ?? [];
    arr.push(m.row);
    store.set(m.schemaHash, arr);
  }
  return {
    baseUrl: "mock",
    userHash: "uh",
    async autoIdentity() { return { provisioned: true, userHash: "uh" }; },
    async health() { return { ok: true, uptime_s: 1 }; },
    async bootstrap() { return { userHash: "uh" }; },
    async requestConsent() { return { status: 202, body: { request_id: "r" } }; },
    async consentStatus() { return { status: 200, body: { status: "granted" } }; },
    async listLoadedSchemas() {
      return [];
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async createRecord() {},
    async updateRecord() {},
    async deleteRecord() {},
    async queryAll({ schemaHash }): Promise<QueryResponse> {
      const results = store.get(schemaHash) ?? [];
      return { ok: true, results, total_count: results.length, returned_count: results.length };
    },
    async queryByKey({ schemaHash, keyHash }): Promise<QueryRow | null> {
      const rows = store.get(schemaHash) ?? [];
      return rows.find((r) => (r.fields as { slug?: unknown }).slug === keyHash) ?? null;
    },
    async search(): Promise<NativeIndexHit[]> { return []; },
    async rawCall() { return { status: 200, headers: new Headers(), body: "", json: null }; },
  };
}

describe("runUsageReport", () => {
  test("groups by userHash, breaks down by type, applies 7-day window", async () => {
    const cfg = buildTestCfg();
    const lines: string[] = [];
    const usagePath = join(mkdtempSync(join(tmpdir(), "fbrain-usage-")), "usage.jsonl");

    const node = mockNodeWithRows([
      // User A — 2 designs today, 1 concept 5d ago, 1 task today
      { slug: "d-1", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
      { slug: "d-2", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_MORNING },
      { slug: "c-1", type: "concept", pubkey: PUBKEY_A, created_at: FIVE_DAYS_AGO },
      { slug: "t-1", type: "task", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
      // User B — 1 concept yesterday
      { slug: "c-2", type: "concept", pubkey: PUBKEY_B, created_at: YESTERDAY },
      // User A — 1 record 8 days ago (outside window)
      { slug: "d-old", type: "design", pubkey: PUBKEY_A, created_at: EIGHT_DAYS_AGO },
    ]);

    const report = await runUsageReport(node, cfg, {
      now: NOW,
      print: (l) => lines.push(l),
      usagePath,
    });

    expect(report.windowDays).toBe(7);
    expect(report.totalWrites).toBe(5);
    expect(report.users.length).toBe(2);
    // User A leads with 4 writes, then User B with 1
    expect(report.users[0]!.userHashPrefix).toBe(PREFIX_A);
    expect(report.users[0]!.total).toBe(4);
    expect(report.users[0]!.today).toBe(3); // 2 designs + 1 task today
    expect(report.users[0]!.byType.design).toBe(2);
    expect(report.users[0]!.byType.task).toBe(1);
    expect(report.users[0]!.byType.concept).toBe(1);

    expect(report.users[1]!.userHashPrefix).toBe(PREFIX_B);
    expect(report.users[1]!.total).toBe(1);
    expect(report.users[1]!.today).toBe(0); // yesterday is not today
    expect(report.users[1]!.byType.concept).toBe(1);

    // Output contains the privacy-pruned prefixes and counts
    const out = lines.join("\n");
    expect(out).toContain(`fbrain usage (last 7 days, by userHash):`);
    expect(out).toContain(`${PREFIX_A}  4 writes  (3 today)`);
    expect(out).toContain(`${PREFIX_B}  1 writes  (0 today)`);
    expect(out).toContain("total: 5 writes across 2 users");
    // 8-char privacy: the full hash must never appear in output
    expect(out).not.toContain(HASH_A);
    expect(out).not.toContain(HASH_B);
    // And the full pubkeys must never appear
    expect(out).not.toContain(PUBKEY_A);
    expect(out).not.toContain(PUBKEY_B);
  });

  test("ignores rows missing author_pub_key", async () => {
    const cfg = buildTestCfg();
    const node = mockNodeWithRows([
      { slug: "d-1", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
    ]);
    // Manually slip in a row with no author_pub_key
    const orig = node.queryAll;
    node.queryAll = async (opts) => {
      const r = await orig.call(node, opts);
      if (opts.schemaHash === TEST_HASHES.design) {
        return {
          ...r,
          results: [
            ...r.results,
            { fields: { slug: "ghost", created_at: TODAY_AT_NOON }, key: { hash: "ghost", range: null } },
          ],
        };
      }
      return r;
    };
    const report = await runUsageReport(node, cfg, { now: NOW, noPersist: true, print: () => {} });
    expect(report.totalWrites).toBe(1);
    expect(report.users.length).toBe(1);
  });

  test("custom windowDays narrows / widens the window", async () => {
    const cfg = buildTestCfg();
    const node = mockNodeWithRows([
      { slug: "d-today", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
      { slug: "d-yesterday", type: "design", pubkey: PUBKEY_A, created_at: YESTERDAY },
      { slug: "d-5d", type: "design", pubkey: PUBKEY_A, created_at: FIVE_DAYS_AGO },
      { slug: "d-8d", type: "design", pubkey: PUBKEY_A, created_at: EIGHT_DAYS_AGO },
    ]);
    const r1 = await runUsageReport(node, cfg, { now: NOW, windowDays: 1, noPersist: true, print: () => {} });
    // 1-day window cutoff = NOW - 24h = 2026-05-23T10:00Z. d-today (10:00 + 2h) AND
    // d-yesterday (12:00 day-prior, which is 22h before NOW) BOTH fall inside.
    expect(r1.totalWrites).toBe(2);

    const r30 = await runUsageReport(node, cfg, { now: NOW, windowDays: 30, noPersist: true, print: () => {} });
    expect(r30.totalWrites).toBe(4);
  });

  test("empty store → 'no records' line and total 0", async () => {
    const cfg = buildTestCfg();
    const node = mockNodeWithRows([]);
    const lines: string[] = [];
    const report = await runUsageReport(node, cfg, {
      now: NOW,
      print: (l) => lines.push(l),
      noPersist: true,
    });
    expect(report.totalWrites).toBe(0);
    expect(report.users.length).toBe(0);
    expect(lines.some((l) => l.includes("(no records created in window)"))).toBe(true);
    expect(lines.some((l) => l.includes("total: 0 writes across 0 users"))).toBe(true);
  });
});

describe("daily-summary persistence", () => {
  test("appends a new line per UTC date and replaces the existing line on same-day re-run", async () => {
    const cfg = buildTestCfg();
    const dir = mkdtempSync(join(tmpdir(), "fbrain-usage-jsonl-"));
    const usagePath = join(dir, "usage.jsonl");

    const node = mockNodeWithRows([
      { slug: "d-1", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
      { slug: "d-2", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_MORNING },
      { slug: "c-1", type: "concept", pubkey: PUBKEY_B, created_at: TODAY_AT_NOON },
    ]);

    await runUsageReport(node, cfg, { now: NOW, print: () => {}, usagePath });
    const after1 = readFileSync(usagePath, "utf8").trim().split("\n");
    expect(after1.length).toBe(1);
    const line1: DailySummaryLine = JSON.parse(after1[0]!);
    expect(line1.date).toBe("2026-05-24");
    expect(line1.by_user[PREFIX_A]).toBe(2);
    expect(line1.by_user[PREFIX_B]).toBe(1);
    expect(line1.total).toBe(3);

    // Add one more row, re-run on the same day — line for that date is replaced.
    const node2 = mockNodeWithRows([
      { slug: "d-1", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
      { slug: "d-2", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_MORNING },
      { slug: "d-3", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
      { slug: "c-1", type: "concept", pubkey: PUBKEY_B, created_at: TODAY_AT_NOON },
    ]);
    await runUsageReport(node2, cfg, { now: NOW, print: () => {}, usagePath });
    const after2 = readFileSync(usagePath, "utf8").trim().split("\n");
    expect(after2.length).toBe(1);
    const line2: DailySummaryLine = JSON.parse(after2[0]!);
    expect(line2.by_user[PREFIX_A]).toBe(3);
    expect(line2.total).toBe(4);

    // Now advance one day; this appends instead of replacing.
    const tomorrow = new Date("2026-05-25T10:00:00.000Z");
    await runUsageReport(node2, cfg, { now: tomorrow, print: () => {}, usagePath });
    const after3 = readFileSync(usagePath, "utf8").trim().split("\n");
    expect(after3.length).toBe(2);
    const line3: DailySummaryLine = JSON.parse(after3[1]!);
    expect(line3.date).toBe("2026-05-25");
    // None of yesterday's rows count as "today" on 2026-05-25.
    expect(line3.total).toBe(0);
    expect(Object.keys(line3.by_user)).toEqual([]);
  });

  test("preserves unrecognised lines without dropping them", async () => {
    const cfg = buildTestCfg();
    const dir = mkdtempSync(join(tmpdir(), "fbrain-usage-jsonl-"));
    const usagePath = join(dir, "usage.jsonl");
    writeFileSync(usagePath, "not-json-but-keep-me\n", "utf8");

    const node = mockNodeWithRows([
      { slug: "d-1", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
    ]);
    await runUsageReport(node, cfg, { now: NOW, print: () => {}, usagePath });
    const content = readFileSync(usagePath, "utf8").trim().split("\n");
    expect(content[0]).toBe("not-json-but-keep-me");
    const parsed: DailySummaryLine = JSON.parse(content[1]!);
    expect(parsed.total).toBe(1);
  });

  test("defaultUsagePath points at ~/.fbrain/usage.jsonl", () => {
    const p = defaultUsagePath();
    expect(p.endsWith("/.fbrain/usage.jsonl")).toBe(true);
  });
});

describe("doctor --usage entrypoint", () => {
  test("doctor() with usage:true delegates and skips health checks", async () => {
    const cfg = buildTestCfg();
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-usage-"));
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
    const usagePath = join(dir, "usage.jsonl");

    const node = mockNodeWithRows([
      { slug: "d-1", type: "design", pubkey: PUBKEY_A, created_at: TODAY_AT_NOON },
    ]);
    const lines: string[] = [];
    const code = await doctor({
      configPath: cfgPath,
      usage: true,
      usageOptions: { now: NOW, usagePath },
      print: (l) => lines.push(l),
      schemaClientFactory: () => ({
        baseUrl: "mock",
        async registerSchema() { return { canonicalHash: "x", status: 200, replacedSchema: null }; },
        async listSchemas() { return null; },
        async getSchemaByHash() { return null; },
        async rawCall() { return { status: 200, headers: new Headers(), body: "", json: null }; },
      }),
      nodeClientFactory: () => node,
    });
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("fbrain usage (last 7 days, by userHash):");
    expect(out).toContain(`${PREFIX_A}  1 writes`);
    // No PASS lines from the standard checks
    expect(lines.some((l) => l.includes("[PASS] schema-drift"))).toBe(false);
    expect(lines.some((l) => l.includes("[PASS] schemas-loaded"))).toBe(false);
  });

  test("doctor --usage with invalid config returns the config FAIL path (no crash)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-usage-bad-"));
    const cfgPath = join(dir, "config.json");
    const bad = buildTestCfg({
      schemaHashes: { ...TEST_HASHES, design: "not-hex" },
    });
    writeFileSync(cfgPath, JSON.stringify(bad), "utf8");

    const node = mockNodeWithRows([]);
    const lines: string[] = [];
    const code = await doctor({
      configPath: cfgPath,
      usage: true,
      usageOptions: { now: NOW, noPersist: true },
      print: (l) => lines.push(l),
      schemaClientFactory: () => ({
        baseUrl: "mock",
        async registerSchema() { return { canonicalHash: "x", status: 200, replacedSchema: null }; },
        async listSchemas() { return null; },
        async getSchemaByHash() { return null; },
        async rawCall() { return { status: 200, headers: new Headers(), body: "", json: null }; },
      }),
      nodeClientFactory: () => node,
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] config"))).toBe(true);
    expect(lines.some((l) => l.includes("usage report skipped"))).toBe(true);
  });
});

describe("pubkeyToUserHash", () => {
  test("derives a stable 32-char hex from a base64 pubkey", () => {
    // Same input → same output, no salt.
    expect(pubkeyToUserHash(PUBKEY_A)).toBe(HASH_A);
    expect(pubkeyToUserHash(PUBKEY_A)).toBe(HASH_A);
    expect(/^[0-9a-f]{32}$/.test(HASH_A)).toBe(true);
  });

  test("matches the known mapping from fold_db (auto-identity output)", () => {
    // The local homebrew daemon at the time of writing reports:
    //   public_key: O7mSpReZYDuYKhM/EEHVJIyci4g+OzqH8cyN9z23R8w=
    //   user_hash:  dcf41c3a2a0a8afe33477d5422a84159
    // If this test ever breaks, fold_db has changed its derivation and
    // `fbrain doctor --usage` would silently mis-partition writes — so
    // we pin the contract here.
    const pub = "O7mSpReZYDuYKhM/EEHVJIyci4g+OzqH8cyN9z23R8w=";
    expect(pubkeyToUserHash(pub)).toBe("dcf41c3a2a0a8afe33477d5422a84159");
  });
});
