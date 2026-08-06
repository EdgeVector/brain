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
 * Records of one type from the HashRange partition.
 *
 * Only a partition that carries the completeness marker is trusted. Unmarked
 * partitions (including non-empty partial dual-write residue) return null so
 * callers cold-seed from the authoritative product schema and re-stamp the
 * marker. This is what stops a failed put dual-write from permanently hiding
 * rows once the marker had already been set: put clears the marker, and the
 * next list rebuilds from SOT.
 */
export async function readTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<FbrainRecord[] | null> {
  const entries = await readTypeListEntries(node, cfg, type);
  if (entries === null) return null;
  if (!entries.migrated) return null;
  return entries.records;
}

/**
 * Replace the whole list for one type. Cold-seed and admin repair path only;
 * `patchTypeListIndex` is what the hot put/delete path uses.
 *
 * Upserts every live SOT record, deletes partition rows not in SOT (stale
 * dual-write residue), then stamps the completeness marker.
 */
export async function writeTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  records: FbrainRecord[],
): Promise<void> {
  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) return;
  const want = new Set(records.map((r) => r.slug));
  const existing = await readTypeListEntries(node, cfg, type);
  if (existing) {
    for (const row of existing.records) {
      if (!want.has(row.slug)) {
        await deleteTypeListEntry(node, cfg, type, row.slug);
      }
    }
  }
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

/**
 * Drop the completeness marker so the next product `listRecords` cold-seeds
 * from the authoritative product schema.
 *
 * Without this, a failed dual-write (`listIndexFailed` on put) leaves the
 * partition marked migrated while missing the just-written row — and
 * `readTypeListIndex` trusts that incomplete set forever. Clearing the marker
 * is the self-heal path: the next list pays one admin scan and re-stamps.
 */
export async function unmarkTypePartitionMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
): Promise<boolean> {
  const entryHash = recordListEntryHash(cfg);
  if (!entryHash) return false;
  const range = RECORD_LIST_ENTRY_MIGRATED_RANGE;
  if (!(await entryRowExists(node, entryHash, type, range))) return true;
  await node.deleteRecord({ schemaHash: entryHash, keyHash: type, keyRange: range });
  return true;
}

/** Census of one type's list partition vs an authoritative set of live slugs. */
export type TypeListIndexCensus = {
  type: RecordType;
  /** Rows in the list partition (excluding the completeness marker). */
  indexed: number;
  /** Live slugs from the SOT product schema (caller-provided). */
  sot: number;
  /** Slugs present in SOT but missing from the list partition. */
  missingFromIndex: string[];
  /** Slugs present in the list partition but absent from the live SOT set. */
  extraInIndex: string[];
  /** Completeness marker is present. */
  migrated: boolean;
  /** True when listed set == SOT set (order-independent). */
  complete: boolean;
};

/**
 * Compare the keyed list partition against an authoritative live-slug set.
 * Used by `fbrain reindex --list-index` (repair) and doctor/census guards so
 * "list is a sample" can never silently return when the projection lags SOT.
 */
export async function censusTypeListIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  sotLiveSlugs: readonly string[],
): Promise<TypeListIndexCensus | null> {
  const entries = await readTypeListEntries(node, cfg, type);
  if (entries === null) return null;
  const indexedSlugs = new Set(entries.records.map((r) => r.slug));
  const sotSet = new Set(sotLiveSlugs);
  const missingFromIndex: string[] = [];
  for (const s of sotSet) {
    if (!indexedSlugs.has(s)) missingFromIndex.push(s);
  }
  missingFromIndex.sort();
  const extraInIndex: string[] = [];
  for (const s of indexedSlugs) {
    if (!sotSet.has(s)) extraInIndex.push(s);
  }
  extraInIndex.sort();
  return {
    type,
    indexed: indexedSlugs.size,
    sot: sotSet.size,
    missingFromIndex,
    extraInIndex,
    migrated: entries.migrated,
    complete: missingFromIndex.length === 0 && extraInIndex.length === 0,
  };
}

function isFbrainRecordLike(value: unknown): value is FbrainRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string" && typeof v.title === "string";
}

// Maintain the type-list index after a product write OR delete. EVERY path that
// creates, updates, or soft-deletes a record must call this — `put`,
// `papercut file` / `papercut close`, and `delete`.
//
// It exists because it was skipped. `papercut file` shipped calling
// `node.createRecord` directly, so the first papercut ever filed landed in SOT
// and was invisible to `brain list --type papercut` and to `papercut census`,
// which reported "no papercuts" while `brain get` returned the record. That is
// the same failure `papercut-brain-list-under-reports…` records — 68
// `papercut-lastgit-*` rows invisible to every list/search while `brain get`
// still resolved them — reproduced inside the ledger built to end it.
//
// Delete had the inverse bug: `delete.ts` tombstoned the product row but never
// patched the list partition, so a pre-tombstone `rle_payload` snapshot
// survived. `list`/`--count`/BM25 still ranked the slug while `get` exit-1'd
// (`papercut-brain-list-count-overreports-tombstoned-recordlistentry-rows`).
// Pass `record: null` (or a tombstoned record) so `patchTypeListIndex` drops
// the HashRange row.
//
// Non-fatal by design: the record has already persisted (or been tombstoned)
// and throwing here would report a lost write that is not lost. But NOT
// silent — this index is patched read-modify-write, so a dropped entry never
// comes back on its own, and swallowing the error is how the primary's rollup
// drifted 760 live records behind `brain list` for days with no symptom
// (2026-07-28). The boolean rides out to the caller so an operator finds out
// at the write, not at an audit.
export async function maintainTypeListIndex(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  type: RecordType;
  /** Live record to upsert, or `null` / tombstoned record to drop the row. */
  record: FbrainRecord | null;
  slug: string;
  verbose?: (msg: string) => void;
}): Promise<{ listIndexFailed: boolean }> {
  const { isTombstoned } = await import("./record.ts");
  try {
    await patchTypeListIndex(opts.node, opts.cfg, opts.type, opts.record, opts.slug, isTombstoned);
    return { listIndexFailed: false };
  } catch (err) {
    // Self-heal: clear the completeness marker so the next product list cold-
    // seeds from SOT instead of trusting a permanently incomplete partition.
    try {
      await unmarkTypePartitionMigrated(opts.node, opts.cfg, opts.type);
      opts.verbose?.(
        `record-list index patch FAILED for ${opts.type}/${opts.slug}: ` +
          `${err instanceof Error ? err.message : String(err)} — record persisted; ` +
          `cleared the ${opts.type} list-index completeness marker so the next \`brain list\` ` +
          `cold-seeds from SOT (or run \`fbrain reindex --list-index\`).`,
      );
    } catch (unmarkErr) {
      opts.verbose?.(
        `record-list index patch FAILED for ${opts.type}/${opts.slug}: ` +
          `${err instanceof Error ? err.message : String(err)}; unmark also failed: ` +
          `${unmarkErr instanceof Error ? unmarkErr.message : String(unmarkErr)} — ` +
          "run `fbrain reindex --list-index` to repair.",
      );
    }
    return { listIndexFailed: true };
  }
}
