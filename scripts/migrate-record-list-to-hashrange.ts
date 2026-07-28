#!/usr/bin/env bun
// Migrate the legacy RecordListIndex rollup → RecordListEntry HashRange rows.
//
// WHY: `fbrain/RecordListIndex` keeps every record of a type — bodies included
// — in ONE atom, read-modify-written in full on every put. Measured on the
// primary 2026-07-28 at 446,262 B: 6.8x the 64 KiB product default and 85% of
// the raised LASTDB_MAX_ATOM_CONTENT_BYTES ceiling. Crossing the ceiling does
// not fail the oversized write cleanly — it HALF-COMMITS (the record lands,
// the index patch is rejected), which is how `situations notices` silently
// staled for hours on 2026-07-27. One row per record bounds each atom by a
// single record and makes a put O(1) bytes.
//
// Shape follows the proven LastgitPackInventory cutover (lastgit PR #96) —
// see brain `reference-lastgit-pack-inventory-hashrange-cutover`.
//
// SOURCE OF TRUTH IS THE PRODUCT RECORD TABLE, NOT THE LEGACY ROLLUP.
// Seeding from the rollup looks natural and is wrong: the rollup is itself a
// lossy cache that has already drifted badly on the primary. Measured
// 2026-07-28, live records vs rollup entries: project 416 vs 48, reference 603
// vs 247, design 102 vs 59 — 760 live records the rollup never listed. The
// rollup only ever self-heals on a COLD MISS (row absent); every other write is
// a read-modify-write of whatever it already held, so once an entry is dropped
// it is dropped forever, and `patchTypeListIndex` failures are swallowed
// best-effort by `putCmd`, which is why nobody saw it happen. Seeding the
// partition from that rollup would copy the hole, report 100% coverage, and let
// --clear-legacy cement it. So the migration drains the product record schema
// (`listRecordsAdminScan`, the sanctioned admin path) and treats the rollup as
// context only. That makes this script a REPAIR as well as a migration.
//
// SAFETY: this script is RESUME-SAFE and ADDITIVE. It only ever writes
// RecordListEntry rows; it does not touch product record schemas, and it does
// NOT clear the legacy rollup unless you pass --clear-legacy, which refuses
// unless every LIVE PRODUCT RECORD is already covered.
//
// CLI:
//   bun scripts/migrate-record-list-to-hashrange.ts --dry-run   # report only
//   bun scripts/migrate-record-list-to-hashrange.ts             # migrate
//   bun scripts/migrate-record-list-to-hashrange.ts --type concept
//   bun scripts/migrate-record-list-to-hashrange.ts --verify     # coverage only
//   bun scripts/migrate-record-list-to-hashrange.ts --clear-legacy

import { newNodeClient, FbrainError, type NodeClient } from "../src/client.ts";
import { tryReadConfig, type Config } from "../src/config.ts";
import {
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
  RECORD_LIST_INDEX_FIELDS,
  RECORD_LIST_INDEX_SCHEMA_KEY,
  RECORD_TYPES,
  isRecordType,
  type RecordType,
} from "../src/schemas.ts";
import {
  markTypePartitionMigrated,
  readTypeListIndexLegacyForMigration,
  recordListEntryHash,
  recordListIndexHash,
  upsertTypeListEntry,
} from "../src/record-list-index.ts";
import { listRecordsAdminScan, schemaHashFor } from "../src/record.ts";

type Args = {
  dryRun: boolean;
  verifyOnly: boolean;
  clearLegacy: boolean;
  types: RecordType[];
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    dryRun: argv.includes("--dry-run"),
    verifyOnly: argv.includes("--verify"),
    clearLegacy: argv.includes("--clear-legacy"),
    types: [...RECORD_TYPES],
  };
  const i = argv.indexOf("--type");
  if (i >= 0) {
    const t = argv[i + 1];
    if (!t || !isRecordType(t)) {
      console.error(`FAIL: --type needs one of: ${RECORD_TYPES.join(", ")}`);
      process.exit(2);
    }
    out.types = [t];
  }
  return out;
}

/** Rows already present in one type's HashRange partition, by slug. */
async function existingEntrySlugs(
  node: NodeClient,
  entryHash: string,
  type: RecordType,
): Promise<Set<string>> {
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: ["rle_h", "rle_r"],
    filter: { HashKey: type },
  });
  const slugs = new Set<string>();
  for (const row of res.results) {
    const r = (row.fields as Record<string, unknown> | undefined)?.rle_r;
    // The migrated marker shares the partition but is not a record.
    if (r === RECORD_LIST_ENTRY_MIGRATED_RANGE) continue;
    if (typeof r === "string" && r.length > 0) slugs.add(r);
  }
  return slugs;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const cfg: Config | null = tryReadConfig();
  if (!cfg) {
    console.error("FAIL: no fbrain config — run `fbrain init` first.");
    return 2;
  }

  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) {
    console.error(
      "FAIL: RecordListEntry is not on the schema map.\n" +
        "  Register it first: `fbrain init` (resolves + loads fbrain schemas).\n" +
        `  Expected config key: ${RECORD_LIST_ENTRY_SCHEMA_KEY}`,
    );
    return 2;
  }
  const legacyHash = recordListIndexHash(cfg);

  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash });

  console.log(`RecordListEntry  ${entryHash.slice(0, 16)}…  (HashRange rle_h x rle_r)`);
  console.log(
    `RecordListIndex  ${legacyHash ? `${legacyHash.slice(0, 16)}…  (legacy rollup)` : "absent"}`,
  );
  console.log("");

  let totalLegacy = 0;
  let totalProduct = 0;
  let totalExisting = 0;
  let totalWritten = 0;
  let totalUncovered = 0;

  console.log(
    `${"type".padEnd(11)} ${"live".padStart(5)}  ${"legacy".padStart(6)}  ` +
      `${"drift".padStart(5)}  ${"rows".padStart(5)}  ${"missing".padStart(7)}`,
  );

  for (const type of args.types) {
    // Context only — how much the rollup had already lost. Never a seed source.
    const legacy = legacyHash
      ? await readTypeListIndexLegacyForMigration(node, cfg, type)
      : null;
    const legacyCount = legacy?.length ?? 0;
    totalLegacy += legacyCount;

    // Authoritative: the live product rows for this type, tombstones dropped
    // (the same filter `listRecords` applies, so the partition inherits exactly
    // the set `brain list` is supposed to show).
    const product = await listRecordsAdminScan(node, type, schemaHashFor(type, cfg));
    totalProduct += product.length;

    const existing = await existingEntrySlugs(node, entryHash, type);
    totalExisting += existing.size;

    const missing = product.filter((r) => !existing.has(r.slug));
    const drift = product.length - legacyCount;

    if (args.verifyOnly || args.dryRun) {
      totalUncovered += missing.length;
      console.log(
        `${type.padEnd(11)} ${String(product.length).padStart(5)}  ` +
          `${String(legacyCount).padStart(6)}  ${String(drift).padStart(5)}  ` +
          `${String(existing.size).padStart(5)}  ${String(missing.length).padStart(7)}`,
      );
      continue;
    }

    let wrote = 0;
    for (const record of missing) {
      try {
        await upsertTypeListEntry(node, cfg, type, record);
        wrote++;
      } catch (err) {
        const msg = err instanceof FbrainError ? err.message : String(err);
        console.error(`  ! ${type}/${record.slug}: ${msg}`);
      }
    }
    totalWritten += wrote;
    const after = await existingEntrySlugs(node, entryHash, type);
    const stillMissing = product.filter((r) => !after.has(r.slug)).length;
    totalUncovered += stillMissing;
    // Only once every LIVE PRODUCT RECORD for this type has a row: the marker is
    // what flips reads off the legacy union and onto the partition alone, so it
    // must not be stamped while the partition is still short of the real table.
    if (stillMissing === 0) await markTypePartitionMigrated(node, cfg, type);
    console.log(
      `${type.padEnd(11)} ${String(product.length).padStart(5)}  ` +
        `${String(legacyCount).padStart(6)}  ${String(drift).padStart(5)}  ` +
        `${String(after.size).padStart(5)}  ${String(stillMissing).padStart(7)}  ` +
        `wrote=${wrote}`,
    );
  }

  console.log("");
  console.log(
    `TOTAL live=${totalProduct}  legacy=${totalLegacy}  ` +
      `drift=${totalProduct - totalLegacy}  rows_before=${totalExisting}  ` +
      `wrote=${totalWritten}  uncovered=${totalUncovered}`,
  );
  if (totalProduct > totalLegacy) {
    console.log(
      `\nNOTE: the legacy rollup was short ${totalProduct - totalLegacy} live record(s).\n` +
        "Those were invisible to `brain list` and to the BM25 corpus behind `brain ask`.\n" +
        "Seeding from the product table repairs them; seeding from the rollup would not have.",
    );
  }

  if (args.dryRun || args.verifyOnly) {
    console.log(args.dryRun ? "\n(dry run — nothing written)" : "");
    return totalUncovered === 0 ? 0 : 1;
  }

  if (args.clearLegacy) {
    if (totalUncovered !== 0) {
      console.error(
        `\nREFUSING --clear-legacy: ${totalUncovered} live product record(s) are not yet ` +
          "covered by HashRange rows. Clearing now would drop them from `brain list`. " +
          "Re-run the migration first.",
      );
      return 1;
    }
    // A scan that returns nothing while the rollup still holds entries means the
    // read failed, not that the brain is empty. Coverage would then be
    // vacuously "complete" and this would clear the only surviving list.
    if (totalProduct === 0 && totalLegacy > 0) {
      console.error(
        `\nREFUSING --clear-legacy: the product scan returned 0 records while the legacy ` +
          `rollup still holds ${totalLegacy}. That is a failed read, not an empty brain.`,
      );
      return 1;
    }
    if (args.types.length !== RECORD_TYPES.length) {
      console.error(
        "\nREFUSING --clear-legacy with --type: coverage was only proven for one type.",
      );
      return 1;
    }
    if (!legacyHash) {
      console.log("\nLegacy rollup already absent — nothing to clear.");
      return 0;
    }
    for (const type of args.types) {
      try {
        await node.deleteRecord({ schemaHash: legacyHash, keyHash: type });
        console.log(`cleared legacy rollup row: ${type}`);
      } catch (err) {
        const msg = err instanceof FbrainError ? err.message : String(err);
        console.error(`  ! clear ${type}: ${msg}`);
      }
    }
  }

  return totalUncovered === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof FbrainError ? err.message : err);
    process.exit(2);
  });

// Referenced so the unused-import guard sees the legacy field list is the
// contract this script drains.
void RECORD_LIST_INDEX_FIELDS;
void RECORD_LIST_INDEX_SCHEMA_KEY;
