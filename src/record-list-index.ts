// Per-type record list helpers. Product list/BM25 paths use one HashRange row
// per fbrain record, addressed by (record type, slug), so puts and deletes only
// patch one small row.

import type { NodeClient, QueryRow } from "./client.ts";
import {
  RECORD_LIST_ENTRY_FIELDS,
  RECORD_LIST_ENTRY_LAYOUT,
  RECORD_LIST_ENTRY_MARKER,
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";
import type { FbrainRecord } from "./record.ts";

type SchemaCfg = { schemaHashes: Record<string, string> };

/** Hash of the product HashRange schema, or null before schema registration. */
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
 * All rows in one type's partition. Returns null when the schema is unavailable.
 *
 * `{ HashKey: type }` is a keyed partition read, so it never trips the product
 * full-scan guard in `queryAllGuarded`.
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
    // The completeness marker rides the same partition read; no extra round trip.
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
 * Records of one type from the HashRange partition. Empty unmarked partitions
 * return null so callers can cold-seed from the authoritative product schema and
 * then stamp the marker.
 */
export async function readTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<FbrainRecord[] | null> {
  const entries = await readTypeListEntries(node, cfg, type);
  if (entries === null) return null;
  if (!entries.migrated && entries.records.length === 0) return null;
  return entries.records;
}

/**
 * Replace the whole list for one type. Cold-seed and admin repair path only;
 * `patchTypeListIndex` is what the hot put/delete path uses.
 */
export async function writeTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  records: FbrainRecord[],
): Promise<void> {
  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) return;
  for (const record of records) {
    await upsertTypeListEntry(node, cfg, type, record);
  }
  await markTypePartitionMigrated(node, cfg, type);
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
 * Stamp "this partition holds the whole type". Idempotent; the marker is a
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
 * Reflect one put/delete into the list partition. The hot path patches only the
 * addressed row; completeness markers are written by full cold-seed/admin
 * repair, not by a single put.
 */
export async function patchTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  record: FbrainRecord | null,
  slug: string,
  isTombstoned: (r: FbrainRecord) => boolean,
): Promise<void> {
  if (!recordListEntryHash(cfg)) return;
  if (record && !isTombstoned(record)) {
    await upsertTypeListEntry(node, cfg, type, record);
  } else {
    await deleteTypeListEntry(node, cfg, type, slug);
  }
}

function isFbrainRecordLike(value: unknown): value is FbrainRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string" && typeof v.title === "string";
}
