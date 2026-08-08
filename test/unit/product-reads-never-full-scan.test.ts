// Guard: no product read path may issue a full schema scan.
//
// `design-lastdb-scan-deprecation-path` (approved 2026-07-18):
//
//     Need a list view?  -> thin INDEX schema written on write + point-get bodies
//     Admin rebuild?     -> offline bulk only, bulk QoS, NEVER request-path
//
// The node enforces it — an unfiltered `/api/query` is a 400
// `full_schema_scan_not_allowed` unless the caller sends
// `X-LastDB-Allow-Full-Scan: 1`. brain used to send exactly that header from
// `listRecords`, the product list path, to cold-seed the record-list index on a
// miss. The seed was a 2026-07-28 migration artifact: every writer has
// maintained the index on write ever since, so it was only reachable for a
// partition that had never been seeded — a brand-new record type. It stayed
// dormant for months and fired the first time one was added.
//
// These tests pin the two halves of the rule: product paths never opt in, and
// the admin paths that legitimately do are named explicitly.

import { describe, expect, test } from "bun:test";

const SRC = new URL("../../src/", import.meta.url).pathname;

// The ONLY modules allowed to reach for the admin full scan. Each is an
// offline/bulk repair, not a request path. Adding to this list is a deliberate
// act that shows up in review.
const ADMIN_SCAN_MODULES = [
  "record.ts", // defines listRecordsAdminScan itself
  "commands/reindex.ts", // --list-index / --tags / --backlinks rebuilds
  "commands/migrate.ts", // schema evolution
  "retrieval/bm25.ts", // corpus build; falls back when the index is cold
] as const;

async function readSource(rel: string): Promise<string> {
  return Bun.file(`${SRC}${rel}`).text();
}

describe("product read paths never full-scan", () => {
  test("listRecords does not seed the index and does not scan", async () => {
    const source = await readSource("record.ts");
    const fn = source.slice(
      source.indexOf("export async function listRecords("),
      source.indexOf("export async function listRecordsAdminScan("),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(
      fn.includes("listRecordsAdminScan"),
      "listRecords must not call the admin scan — a cold partition is an error, not a scan",
    ).toBe(false);
    expect(
      fn.includes("writeTypeListIndex"),
      "listRecords must not seed the index; seeding belongs to `reindex --list-index`",
    ).toBe(false);
    expect(
      fn.includes("list_index_incomplete"),
      "a cold partition must raise list_index_incomplete naming the offline repair",
    ).toBe(true);
  });

  test("listRecords does not accept a product schema hash", async () => {
    // Structural, not advisory: a path that must never read the product schema
    // has no business being handed its hash.
    const source = await readSource("record.ts");
    const sig = source.slice(
      source.indexOf("export async function listRecords("),
      source.indexOf(
        "): Promise<FbrainRecord[]> {",
        source.indexOf("export async function listRecords("),
      ),
    );
    expect(sig.includes("schemaHash")).toBe(false);
  });

  test("only the named admin modules reference the full scan", async () => {
    const glob = new Bun.Glob("**/*.ts");
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: SRC })) {
      const source = await readSource(file);
      if (!source.includes("listRecordsAdminScan")) continue;
      if (!(ADMIN_SCAN_MODULES as readonly string[]).includes(file))
        offenders.push(file);
    }
    expect(
      offenders,
      "these modules reach for the admin full scan but are not on the allow-list — " +
        "if the caller is a product read path, use the record-list index instead",
    ).toEqual([]);
  });

  test("no product module sets allowFullScan", async () => {
    // Modules allowed to set the flag DIRECTLY rather than going through
    // listRecordsAdminScan. `usage.ts` needs raw QueryRows across every schema
    // including the internal index ones, which the typed-record drain cannot
    // express, and it is reachable only from the explicit `doctor --usage`
    // diagnostic flag — never from an ordinary read.
    const DIRECT_FLAG_MODULES = [
      "client.ts", // implements the flag
      "record.ts", // listRecordsAdminScan, the sanctioned drain
      "commands/usage.ts", // doctor --usage, opt-in diagnostics
      // ChildTaskIndex is keyed by design_slug (an unbounded, unenumerable
      // set), unlike RecordListEntry's small fixed RecordType key set — so its
      // admin rebuild (`fbrain reindex --child-task-index`, never a product
      // path) must scan the INDEX's own schema to find stale rows instead of
      // iterating a known key list.
      "child-task-index.ts",
      "papercut-status-index.ts",
    ];
    const glob = new Bun.Glob("**/*.ts");
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: SRC })) {
      if (DIRECT_FLAG_MODULES.includes(file)) continue;
      const source = await readSource(file);
      if (source.includes("allowFullScan")) offenders.push(file);
    }
    expect(
      offenders,
      "allowFullScan is the admin opt-out; product modules must go through " +
        "listRecordsAdminScan (allow-listed) rather than setting it directly",
    ).toEqual([]);
  });
});
