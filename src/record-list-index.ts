// Per-type record list helpers — product list/BM25 never full-scan fbrain
// record schemas (design-lastdb-scan-deprecation-path).
//
// TWO STORAGE SHAPES live here, and the difference is the whole point:
//
//   RecordListEntry (HashRange, PRODUCT) — one row per record, addressed
//     (rle_h = record type) × (rle_r = slug). A put patches ONE row.
//
//   RecordListIndex (Hash, LEGACY) — one row per TYPE whose `payload_json`
//     holds every record of that type, bodies included, read-modify-written in
//     FULL on every put. Measured on the primary 2026-07-28 at 446,262 B —
//     6.8× the 64 KiB product default and 85% of the raised
//     LASTDB_MAX_ATOM_CONTENT_BYTES ceiling. Crossing that ceiling does not
//     fail cleanly: the record write lands and the index patch is rejected, a
//     HALF-COMMIT. That is how `situations notices` silently staled for hours
//     on 2026-07-27.
//
// The legacy shape stays READABLE (never re-inflated) so a brain that has not
// migrated yet still lists, and so the migration can drain it. Once the
// RecordListEntry schema is on the config map, writes go to the HashRange
// rows and the legacy rollup is never written again.
//
// Migration + proof: `scripts/migrate-record-list-to-hashrange.ts`.

import type { NodeClient, QueryRow } from "./client.ts";
import {
  RECORD_LIST_ENTRY_FIELDS,
  RECORD_LIST_ENTRY_LAYOUT,
  RECORD_LIST_ENTRY_MARKER,
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
  RECORD_LIST_INDEX_FIELDS,
  RECORD_LIST_INDEX_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";
import type { FbrainRecord } from "./record.ts";

type SchemaCfg = { schemaHashes: Record<string, string> };

export function recordListIndexHash(cfg: SchemaCfg): string | null {
  const h = cfg.schemaHashes[RECORD_LIST_INDEX_SCHEMA_KEY];
  return h && h.length > 0 ? h : null;
}

/** Hash of the product HashRange schema, or null on a brain that predates it. */
export function recordListEntryHash(cfg: SchemaCfg): string | null {
  const h = cfg.schemaHashes[RECORD_LIST_ENTRY_SCHEMA_KEY];
  return h && h.length > 0 ? h : null;
}

/** The (hash, range) address of one record's row. */
export function entryKeyFor(type: RecordType, slug: string): { hash: string; range: string } {
  return { hash: type, range: slug };
}

export function entryFieldsFor(
  type: RecordType,
  record: FbrainRecord,
): Record<string, string> {
  return {
    rle_h: type,
    rle_r: record.slug,
    rle_payload: JSON.stringify(record),
    rle_marker: RECORD_LIST_ENTRY_MARKER,
    layout: RECORD_LIST_ENTRY_LAYOUT,
  };
}

/** Parse one HashRange row back into a record. Null when the row is unusable. */
export function recordFromEntryRow(row: QueryRow): FbrainRecord | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const raw = fields.rle_payload;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isFbrainRecordLike(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * All rows in one type's partition. Returns null when the HashRange schema is
 * not on the map (brain not migrated) — the caller then falls back to legacy.
 *
 * `{ HashKey: type }` is a KEYED partition read, so it never trips the
 * product full-scan guard in `queryAllGuarded`.
 */
async function readTypeListEntries(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<{ records: FbrainRecord[]; migrated: boolean } | null> {
  const hash = recordListEntryHash(cfg);
  if (!hash) return null;
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [...RECORD_LIST_ENTRY_FIELDS],
    filter: { HashKey: type },
  });
  const out: FbrainRecord[] = [];
  let migrated = false;
  for (const row of res.results) {
    // The marker row rides the same partition read — no extra round trip.
    if (rangeKeyOf(row) === RECORD_LIST_ENTRY_MIGRATED_RANGE) {
      migrated = true;
      continue;
    }
    const rec = recordFromEntryRow(row);
    if (rec) out.push(rec);
  }
  return { records: out, migrated };
}

/** The `rle_r` range key of a row, or null when the row is malformed. */
function rangeKeyOf(row: QueryRow): string | null {
  const r = (row.fields as Record<string, unknown> | undefined)?.rle_r;
  return typeof r === "string" && r.length > 0 ? r : null;
}

/**
 * The legacy single-row rollup for one type. Read-only in product paths;
 * exported (as `readTypeListIndexLegacyForMigration`) so the migration script
 * can drain it without going through the HashRange-preferring reader.
 */
async function readLegacyTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<FbrainRecord[] | null> {
  const hash = recordListIndexHash(cfg);
  if (!hash || !node.queryByKey) return null;
  const row = await node.queryByKey({
    schemaHash: hash,
    keyHash: type,
    fields: [...RECORD_LIST_INDEX_FIELDS],
  });
  if (!row) return null;
  const raw = (row.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is FbrainRecord => isFbrainRecordLike(e));
  } catch {
    return [];
  }
}

/**
 * Records of one type, HashRange first.
 *
 * Dual-read rule, gated on the per-type migrated marker rather than on "is the
 * partition non-empty":
 *
 *   marker present → the partition is authoritative; legacy is not read.
 *   marker absent  → UNION legacy with the partition, partition winning per
 *                    slug (a row written since the cutover is the fresher copy).
 *
 * The marker is what makes this safe. Preferring a merely non-empty partition
 * truncates a type to just the records put since the cutover: register the
 * schema, put ONE record, and the other 300 legacy records disappear from
 * `brain list` and from the BM25 corpus behind `brain ask`. Union cannot
 * resurrect a deleted record either, because `patchTypeListIndex` seeds the
 * partition from legacy and stamps the marker BEFORE it applies a delete.
 *
 * Returns null only when NEITHER shape is readable, which is the cold-seed
 * signal `listRecords` turns into its one allowed admin full scan.
 */
export async function readTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<FbrainRecord[] | null> {
  const entries = await readTypeListEntries(node, cfg, type);
  if (entries?.migrated) return entries.records;
  const legacy = await readLegacyTypeListIndex(node, cfg, type);
  if (entries === null) return legacy;
  if (legacy === null) return entries.records;
  return unionBySlug(legacy, entries.records);
}

/** Legacy order preserved; a partition row supersedes the legacy copy. */
function unionBySlug(legacy: FbrainRecord[], entries: FbrainRecord[]): FbrainRecord[] {
  const fresh = new Map(entries.map((r) => [r.slug, r]));
  const out: FbrainRecord[] = [];
  const seen = new Set<string>();
  for (const r of legacy) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push(fresh.get(r.slug) ?? r);
  }
  for (const r of entries) {
    if (!seen.has(r.slug)) {
      seen.add(r.slug);
      out.push(r);
    }
  }
  return out;
}

/**
 * Replace the whole list for one type. Cold-seed and migration path only —
 * `patchTypeListIndex` is what the hot put path uses.
 *
 * On a migrated brain this writes one row per record and NEVER re-inflates the
 * legacy rollup. On an un-migrated brain it falls back to the legacy full
 * rewrite so cold seed still works before the schema is registered.
 */
export async function writeTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  records: FbrainRecord[],
): Promise<void> {
  const entryHash = recordListEntryHash(cfg);
  if (entryHash) {
    for (const record of records) {
      await upsertTypeListEntry(node, cfg, type, record);
    }
    // `records` is the COMPLETE set for the type (cold seed came from an admin
    // full scan; the migration passes the drained legacy list), so the
    // partition is authoritative once it lands.
    await markTypePartitionMigrated(node, cfg, type);
    return;
  }
  const hash = recordListIndexHash(cfg);
  if (!hash) return;
  const fields = {
    key: type,
    payload_json: JSON.stringify(records),
    updated_at: new Date().toISOString(),
  };
  const existing = node.queryByKey
    ? await node.queryByKey({ schemaHash: hash, keyHash: type, fields: ["key"] })
    : null;
  if (existing) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: type });
  } else {
    await node.createRecord({ schemaHash: hash, fields, keyHash: type });
  }
}

/** Point-read one HashRange row to decide create vs update. */
async function entryRowExists(
  node: NodeClient,
  entryHash: string,
  type: RecordType,
  slug: string,
): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: ["rle_h", "rle_r"],
    filter: { HashRangeKey: { hash: type, range: slug } },
  });
  return res.results.length > 0;
}

/** Write ONE record's row. Returns false when the HashRange schema is absent. */
export async function upsertTypeListEntry(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  record: FbrainRecord,
): Promise<boolean> {
  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) return false;
  const { hash, range } = entryKeyFor(type, record.slug);
  const fields = entryFieldsFor(type, record);
  const exists = await entryRowExists(node, entryHash, type, record.slug);
  if (exists) {
    await node.updateRecord({ schemaHash: entryHash, fields, keyHash: hash, keyRange: range });
  } else {
    await node.createRecord({ schemaHash: entryHash, fields, keyHash: hash, keyRange: range });
  }
  return true;
}

/**
 * Stamp "this partition holds the whole type". Idempotent — the marker is a
 * reserved range key, so re-stamping just rewrites one tiny row.
 */
export async function markTypePartitionMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<boolean> {
  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) return false;
  const range = RECORD_LIST_ENTRY_MIGRATED_RANGE;
  const fields = {
    rle_h: type,
    rle_r: range,
    rle_payload: "",
    rle_marker: RECORD_LIST_ENTRY_MARKER,
    layout: RECORD_LIST_ENTRY_LAYOUT,
  };
  const exists = await entryRowExists(node, entryHash, type, range);
  if (exists) {
    await node.updateRecord({ schemaHash: entryHash, fields, keyHash: type, keyRange: range });
  } else {
    await node.createRecord({ schemaHash: entryHash, fields, keyHash: type, keyRange: range });
  }
  return true;
}

/**
 * Drain legacy into the partition and stamp the marker, unless already stamped.
 *
 * This is what lets the cutover be self-healing: the FIRST write to a type
 * after the schema is registered migrates that type, so there is never a window
 * where the partition is authoritative but incomplete. Running the migration
 * script up front simply means this finds the marker already set and does
 * nothing. Returns false when the HashRange schema is absent.
 */
export async function ensureTypePartitionMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<boolean> {
  const entries = await readTypeListEntries(node, cfg, type);
  if (entries === null) return false;
  if (entries.migrated) return true;
  const legacy = await readLegacyTypeListIndex(node, cfg, type);
  if (legacy !== null) {
    const already = new Set(entries.records.map((r) => r.slug));
    for (const record of legacy) {
      if (already.has(record.slug)) continue;
      await upsertTypeListEntry(node, cfg, type, record);
    }
  }
  await markTypePartitionMigrated(node, cfg, type);
  return true;
}

/** Drop ONE record's row. Returns false when the HashRange schema is absent. */
export async function deleteTypeListEntry(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  slug: string,
): Promise<boolean> {
  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) return false;
  const { hash, range } = entryKeyFor(type, slug);
  if (!(await entryRowExists(node, entryHash, type, slug))) return true;
  await node.deleteRecord({ schemaHash: entryHash, keyHash: hash, keyRange: range });
  return true;
}

/**
 * Reflect one put/delete into the list index.
 *
 * On a migrated brain this is O(one row) — the whole reason this file exists.
 * On an un-migrated brain it degrades to the legacy read-modify-write of the
 * full type rollup, which is correct but is the 446 KB atom this replaces.
 */
export async function patchTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  record: FbrainRecord | null,
  slug: string,
  isTombstoned: (r: FbrainRecord) => boolean,
): Promise<void> {
  if (recordListEntryHash(cfg)) {
    // Seeding FIRST is what makes a delete safe during the cutover window: the
    // legacy copy is drained into the partition and the marker stamped, so the
    // delete below drops a row that exists instead of leaving the legacy copy
    // behind to be unioned back in on the next read.
    await ensureTypePartitionMigrated(node, cfg, type);
    if (record && !isTombstoned(record)) {
      await upsertTypeListEntry(node, cfg, type, record);
    } else {
      await deleteTypeListEntry(node, cfg, type, slug);
    }
    return;
  }
  const current = (await readTypeListIndex(node, cfg, type)) ?? [];
  const without = current.filter((r) => r.slug !== slug && !isTombstoned(r));
  if (record && !isTombstoned(record)) without.push(record);
  await writeTypeListIndex(node, cfg, type, without);
}

/** Legacy rollup reader for the migration script (never a product path). */
export { readLegacyTypeListIndex as readTypeListIndexLegacyForMigration };

function isFbrainRecordLike(value: unknown): value is FbrainRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string" && typeof v.title === "string";
}
