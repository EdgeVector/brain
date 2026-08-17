// Status -> papercut keyed index. One HashRange row per live papercut,
// addressed by (status, slug), so ledger/list reads touch one named status
// partition (or the fixed set of status partitions) instead of the whole
// papercut type-list partition.

import { FbrainError, type NodeClient, type QueryRow } from "./client.ts";
import {
  PAPERCUT_STATUSES,
  PAPERCUT_STATUS_INDEX_FIELDS,
  PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
  PAPERCUT_STATUS_INDEX_MARKER,
  PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  PAPERCUT_STATUS_INDEX_SCHEMA_KEY,
} from "./schemas.ts";
import type { FbrainRecord } from "./record.ts";

type SchemaCfg = { schemaHashes: Record<string, string> };

export function papercutStatusIndexHash(cfg: SchemaCfg): string | null {
  const h = cfg.schemaHashes[PAPERCUT_STATUS_INDEX_SCHEMA_KEY];
  return h && h.length > 0 ? h : null;
}

function entryFieldsFor(
  status: string,
  record: FbrainRecord,
): Record<string, string> {
  return {
    psi_h: status,
    psi_r: record.slug,
    psi_payload: JSON.stringify(record),
    psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
  };
}

function slugFromEntryRow(row: QueryRow): string | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const slug = row.key?.range ?? fields.psi_r;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

async function entryRowExists(
  node: NodeClient,
  entryHash: string,
  hash: string,
  range: string,
): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: ["psi_h", "psi_r"],
    filter: { HashRangeKey: { hash, range } },
  });
  return res.results.length > 0;
}

export async function upsertPapercutStatusEntry(
  node: NodeClient,
  cfg: SchemaCfg,
  status: string,
  record: FbrainRecord,
): Promise<boolean> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash || status.length === 0) return false;
  const fields = entryFieldsFor(status, record);
  const exists = await entryRowExists(node, entryHash, status, record.slug);
  if (exists) {
    await node.updateRecord({
      schemaHash: entryHash,
      fields,
      keyHash: status,
      keyRange: record.slug,
    });
  } else {
    await node.createRecord({
      schemaHash: entryHash,
      fields,
      keyHash: status,
      keyRange: record.slug,
    });
  }
  return true;
}

export async function deletePapercutStatusEntry(
  node: NodeClient,
  cfg: SchemaCfg,
  status: string,
  slug: string,
): Promise<boolean> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash || status.length === 0) return false;
  if (!(await entryRowExists(node, entryHash, status, slug))) return true;
  await node.deleteRecord({
    schemaHash: entryHash,
    keyHash: status,
    keyRange: slug,
  });
  return true;
}

export async function markPapercutStatusIndexMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
): Promise<boolean> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash) return false;
  const fields = {
    psi_h: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    psi_r: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
    psi_payload: "",
    psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
  };
  const exists = await entryRowExists(
    node,
    entryHash,
    PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  );
  const mutation = {
    schemaHash: entryHash,
    fields,
    keyHash: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    keyRange: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  };
  if (exists) await node.updateRecord(mutation);
  else await node.createRecord(mutation);
  return true;
}

export async function unmarkPapercutStatusIndexMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
): Promise<boolean> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash) return false;
  if (
    !(await entryRowExists(
      node,
      entryHash,
      PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
      PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
    ))
  ) {
    return true;
  }
  await node.deleteRecord({
    schemaHash: entryHash,
    keyHash: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    keyRange: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  });
  return true;
}

export async function requireCompletePapercutStatusIndex(
  node: NodeClient,
  cfg: SchemaCfg,
): Promise<string> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash) {
    throw new FbrainError({
      code: "papercut_status_index_incomplete",
      message:
        "the status-keyed papercut index is not registered, so the ledger cannot read it without enumerating the whole papercut partition.",
      hint: "Run `fbrain init`, then `fbrain reindex --papercut-status-index` (admin/offline), and retry.",
    });
  }
  const migrated = await entryRowExists(
    node,
    entryHash,
    PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  );
  if (!migrated) {
    throw new FbrainError({
      code: "papercut_status_index_incomplete",
      message:
        "the status-keyed papercut index is registered but not marked complete, so the ledger cannot trust it without enumerating the whole papercut partition.",
      hint: "Run `fbrain reindex --papercut-status-index` (admin/offline) to rebuild the index from source of truth, then retry.",
    });
  }
  return entryHash;
}

/** Read one named status partition, or every fixed status partition. */
export async function readPapercutsByStatus(
  node: NodeClient,
  cfg: SchemaCfg,
  status?: string,
): Promise<FbrainRecord[]> {
  const entryHash = await requireCompletePapercutStatusIndex(node, cfg);
  const statuses = status === undefined ? PAPERCUT_STATUSES : [status];
  const { findBySlug, isTombstoned, schemaHashFor } = await import(
    "./record.ts"
  );
  const papercutHash = schemaHashFor("papercut", cfg);
  const out: FbrainRecord[] = [];
  for (const partition of statuses) {
    const res = await node.queryAll({
      schemaHash: entryHash,
      fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
      filter: { HashKey: partition },
    });
    for (const row of res.results) {
      const slug = slugFromEntryRow(row);
      if (!slug) continue;
      const record = await findBySlug(node, "papercut", papercutHash, slug);
      // Fail closed against a process dying between old-row deletion and the
      // new-row upsert: never serve a stale row under the wrong status.
      if (record && !isTombstoned(record) && record.status === partition)
        out.push(record);
    }
  }
  return out;
}

/** Move one papercut between status partitions, or remove it on delete. */
export async function patchPapercutStatusIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  slug: string,
  record: FbrainRecord | null,
  previousStatus: string | undefined,
): Promise<void> {
  if (!papercutStatusIndexHash(cfg)) return;
  const { isTombstoned } = await import("./record.ts");
  const nextStatus = record && !isTombstoned(record) ? record.status : "";
  if (previousStatus && previousStatus !== nextStatus) {
    await deletePapercutStatusEntry(node, cfg, previousStatus, slug);
  }
  if (nextStatus && record)
    await upsertPapercutStatusEntry(node, cfg, nextStatus, record);
}

/**
 * Make one record's keyed membership exact using only point reads/writes.
 *
 * The current partition is written first. That ordering makes retries safe:
 * if a process stops while removing an old-status row, hydration rejects the
 * stale row because the primary record carries the new status, while the new
 * partition already contains the discoverable membership.
 */
export async function ensurePapercutStatusMembership(
  node: NodeClient,
  cfg: SchemaCfg,
  record: FbrainRecord,
): Promise<void> {
  await requireCompletePapercutStatusIndex(node, cfg);
  await upsertPapercutStatusEntry(node, cfg, record.status, record);
  for (const status of PAPERCUT_STATUSES) {
    if (status === record.status) continue;
    await deletePapercutStatusEntry(node, cfg, status, record.slug);
  }
}

/**
 * Persist a first-class papercut mutation as one retry-safe product operation.
 *
 * Membership is prepared before the primary mutation. A membership failure
 * therefore leaves the primary untouched. A later primary failure can leave
 * only a harmless row whose point hydration finds no matching record; retrying
 * the same operation upserts that row and completes the primary write. After
 * the primary succeeds, exact point deletes remove every stale status key.
 */
export async function persistPapercutWithStatusMembership(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  record: FbrainRecord;
  persistPrimary: () => Promise<void>;
}): Promise<void> {
  await requireCompletePapercutStatusIndex(opts.node, opts.cfg);
  await upsertPapercutStatusEntry(
    opts.node,
    opts.cfg,
    opts.record.status,
    opts.record,
  );
  await opts.persistPrimary();
  for (const status of PAPERCUT_STATUSES) {
    if (status === opts.record.status) continue;
    await deletePapercutStatusEntry(
      opts.node,
      opts.cfg,
      status,
      opts.record.slug,
    );
  }
}

/** Non-fatal write-path wrapper; a failed patch clears completeness. */
export async function maintainPapercutStatusIndex(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  slug: string;
  record: FbrainRecord | null;
  previousStatus: string | undefined;
  verbose?: (msg: string) => void;
}): Promise<{ papercutStatusIndexFailed: boolean }> {
  try {
    await patchPapercutStatusIndex(
      opts.node,
      opts.cfg,
      opts.slug,
      opts.record,
      opts.previousStatus,
    );
    return { papercutStatusIndexFailed: false };
  } catch (err) {
    try {
      await unmarkPapercutStatusIndexMigrated(opts.node, opts.cfg);
      opts.verbose?.(
        `papercut status-index patch FAILED for ${opts.slug}: ` +
          `${err instanceof Error ? err.message : String(err)}; record persisted — cleared the ` +
          "completeness marker so the next ledger read errors loudly (run `fbrain reindex --papercut-status-index`).",
      );
    } catch (unmarkErr) {
      opts.verbose?.(
        `papercut status-index patch FAILED for ${opts.slug}: ` +
          `${err instanceof Error ? err.message : String(err)}; unmark also failed: ` +
          `${unmarkErr instanceof Error ? unmarkErr.message : String(unmarkErr)} — run \`fbrain reindex --papercut-status-index\` to repair.`,
      );
    }
    return { papercutStatusIndexFailed: true };
  }
}

/** Offline/admin rebuild from the authoritative live papercut set. */
export async function writePapercutStatusIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  livePapercuts: readonly FbrainRecord[],
): Promise<void> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash) return;
  await unmarkPapercutStatusIndexMigrated(node, cfg);
  const existing = await node.queryAll({
    schemaHash: entryHash,
    fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
    allowFullScan: true,
  });
  const want = new Set(livePapercuts.map((r) => `${r.status} ${r.slug}`));
  for (const row of existing.results) {
    const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
    const hash = row.key?.hash ?? fields.psi_h;
    const range = row.key?.range ?? fields.psi_r;
    if (typeof hash !== "string" || typeof range !== "string") continue;
    if (
      hash === PAPERCUT_STATUS_INDEX_GLOBAL_HASH &&
      range === PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
    ) {
      continue;
    }
    if (!want.has(`${hash} ${range}`)) {
      await node.deleteRecord({
        schemaHash: entryHash,
        keyHash: hash,
        keyRange: range,
      });
    }
  }
  for (const record of livePapercuts) {
    await upsertPapercutStatusEntry(node, cfg, record.status, record);
  }
  await markPapercutStatusIndexMigrated(node, cfg);
}

export type PapercutStatusIndexCensus = {
  indexed: number;
  sot: number;
  missingFromIndex: string[];
  extraInIndex: string[];
  migrated: boolean;
  complete: boolean;
};

export async function censusPapercutStatusIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  sotPairs: readonly string[],
): Promise<PapercutStatusIndexCensus | null> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash) return null;
  const migrated = await entryRowExists(
    node,
    entryHash,
    PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
  );
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
    allowFullScan: true,
  });
  const indexedSet = new Set<string>();
  for (const row of res.results) {
    const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
    const hash = row.key?.hash ?? fields.psi_h;
    const range = row.key?.range ?? fields.psi_r;
    if (typeof hash !== "string" || typeof range !== "string") continue;
    if (
      hash === PAPERCUT_STATUS_INDEX_GLOBAL_HASH &&
      range === PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
    ) {
      continue;
    }
    indexedSet.add(`${hash} ${range}`);
  }
  const sotSet = new Set(sotPairs);
  const missingFromIndex = [...sotSet]
    .filter((key) => !indexedSet.has(key))
    .sort();
  const extraInIndex = [...indexedSet].filter((key) => !sotSet.has(key)).sort();
  return {
    indexed: indexedSet.size,
    sot: sotSet.size,
    missingFromIndex,
    extraInIndex,
    migrated,
    complete:
      migrated && missingFromIndex.length === 0 && extraInIndex.length === 0,
  };
}
