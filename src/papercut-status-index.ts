// Status -> papercut keyed index. One HashRange row per live papercut,
// addressed by (status, slug), so ledger/list reads touch one named status
// partition (or the fixed set of status partitions) instead of the whole
// papercut type-list partition.

import {
  FbrainError,
  type BatchMutationOp,
  type BatchMutationResult,
  type NodeClient,
  type QueryRow,
} from "./client.ts";
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

export async function papercutStatusEntryExists(
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
  const exists = await papercutStatusEntryExists(
    node,
    entryHash,
    status,
    record.slug,
  );
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
  if (!(await papercutStatusEntryExists(node, entryHash, status, slug)))
    return true;
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
  const exists = await papercutStatusEntryExists(
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
    !(await papercutStatusEntryExists(
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

/** Slugs hydrated per keyed `HashKeys` query. `N/8 + 2` node reads at N=400. */
export const PAPERCUT_HYDRATE_BATCH_SIZE = 8;
/** Parallel point-read width when the node rejects `HashKeys`. */
export const PAPERCUT_HYDRATE_CONCURRENCY = 16;

function chunkSlugs(slugs: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < slugs.length; i += size) {
    out.push(slugs.slice(i, i + size));
  }
  return out;
}

function isUnsupportedHashKeysFilter(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /hashkeys|unknown filter|unrecognized filter|invalid filter|bad request/i.test(
    text,
  );
}

async function hydratePapercutsBySlug(opts: {
  node: NodeClient;
  papercutHash: string;
  slugs: readonly string[];
  findBySlug: (
    node: NodeClient,
    type: "papercut",
    schemaHash: string,
    slug: string,
  ) => Promise<FbrainRecord | null>;
  fieldsFor: (type: "papercut") => string[];
  rowToRecord: (row: QueryRow, type: "papercut") => FbrainRecord;
}): Promise<Map<string, FbrainRecord>> {
  const bySlug = new Map<string, FbrainRecord>();
  if (opts.slugs.length === 0) return bySlug;
  const fields = opts.fieldsFor("papercut");
  const batches = chunkSlugs(opts.slugs, PAPERCUT_HYDRATE_BATCH_SIZE);
  try {
    for (const batch of batches) {
      const res = await opts.node.queryAll({
        schemaHash: opts.papercutHash,
        fields,
        filter: { HashKeys: batch },
      });
      for (const row of res.results) {
        const record = opts.rowToRecord(row, "papercut");
        if (record.slug.length > 0) bySlug.set(record.slug, record);
      }
    }
    return bySlug;
  } catch (error) {
    if (!isUnsupportedHashKeysFilter(error)) throw error;
  }
  // Live Mini without HashKeys: bounded-parallel point reads, not a serial loop.
  const pending = [...opts.slugs];
  const width = Math.min(PAPERCUT_HYDRATE_CONCURRENCY, pending.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= pending.length) return;
        const slug = pending[i]!;
        const record = await opts.findBySlug(
          opts.node,
          "papercut",
          opts.papercutHash,
          slug,
        );
        if (record) bySlug.set(slug, record);
      }
    }),
  );
  return bySlug;
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
      hint: "Run `brain init`, then `brain reindex --papercut-status-index` (admin/offline), and retry.",
    });
  }
  const migrated = await papercutStatusEntryExists(
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
      hint: "Run `brain reindex --papercut-status-index` (admin/offline) to rebuild the index from source of truth, then retry.",
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
  const { findBySlug, isTombstoned, schemaHashFor, fieldsFor, rowToRecord } =
    await import("./record.ts");
  const papercutHash = schemaHashFor("papercut", cfg);
  const out: FbrainRecord[] = [];
  for (const partition of statuses) {
    const res = await node.queryAll({
      schemaHash: entryHash,
      fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
      filter: { HashKey: partition },
    });
    const slugs: string[] = [];
    for (const row of res.results) {
      const slug = slugFromEntryRow(row);
      if (slug) slugs.push(slug);
    }
    const hydrated = await hydratePapercutsBySlug({
      node,
      papercutHash,
      slugs,
      findBySlug,
      fieldsFor,
      rowToRecord,
    });
    for (const slug of slugs) {
      const record = hydrated.get(slug);
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

/**
 * Legacy projection patch for delete paths that are not resident-batched yet.
 *
 * Never clear the global marker here. A failed removal can leave only a stale
 * row, and every ledger read point-hydrates the primary before it returns that
 * row. The primary tombstone therefore makes the stale row invisible. The
 * caller receives a hard error, so the failed cleanup stays observable.
 */
export async function maintainPapercutStatusIndex(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  slug: string;
  record: FbrainRecord | null;
  previousStatus: string | undefined;
  verbose?: (msg: string) => void;
}): Promise<{ papercutStatusIndexFailed: false }> {
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
    const detail = err instanceof Error ? err.message : String(err);
    throw new FbrainError({
      code: "papercut_status_index_patch_failed",
      message:
        `papercut status-index cleanup failed for ${opts.slug}: ${detail}. ` +
        "The primary mutation completed, but the command did not report success.",
      hint:
        "Retry the exact command. If the keyed census still differs from source of truth, run `brain reindex --papercut-status-index`.",
      agentHint:
        "Retry the exact command. A stale membership is filtered through the primary record and cannot appear as a live papercut.",
      cause: err,
    });
  }
}

export const PAPERCUT_STATUS_REINDEX_BATCH_SIZE = 64;
export const PAPERCUT_STATUS_REINDEX_DRAIN_MS = 500;

type ReindexWriteOptions = {
  batchSize?: number;
  drainMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

function isPersistQueueFull(error: unknown): boolean {
  return (
    error instanceof FbrainError &&
    error.code === "node_http_503" &&
    error.message.includes("persist_queue_full")
  );
}

async function commitReindexBatch(
  node: NodeClient,
  ops: BatchMutationOp[],
  opts: ReindexWriteOptions,
): Promise<BatchMutationResult> {
  if (!node.mutateBatch) {
    throw new FbrainError({
      code: "resident_commit_unavailable",
      message: "this node client cannot send a Fold resident batch",
      hint: "Upgrade brain so NodeClient.mutateBatch is present.",
    });
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? [0, 1000, 2000, 4000, 8000];
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      return await node.mutateBatch(ops);
    } catch (error) {
      lastError = error;
      if (!isPersistQueueFull(error)) throw error;
    }
  }
  throw lastError;
}

/**
 * Offline/admin repair from the authoritative live papercut set.
 *
 * Only the membership delta is written. A small repair plus its completeness
 * marker lands in one resident batch. A cold rebuild uses bounded batches,
 * keeps the marker absent between batches, and pauses while persistence drains.
 */
export async function writePapercutStatusIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  livePapercuts: readonly FbrainRecord[],
  writeOpts: ReindexWriteOptions = {},
): Promise<void> {
  const entryHash = papercutStatusIndexHash(cfg);
  if (!entryHash) return;
  const existing = await node.queryAll({
    schemaHash: entryHash,
    fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
    allowFullScan: true,
  });
  const wanted = new Map(
    livePapercuts.map((record) => [`${record.status} ${record.slug}`, record]),
  );
  const present = new Set<string>();
  const delta: BatchMutationOp[] = [];
  let markerExists = false;
  for (const row of existing.results) {
    const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
    const hash = row.key?.hash ?? fields.psi_h;
    const range = row.key?.range ?? fields.psi_r;
    if (typeof hash !== "string" || typeof range !== "string") continue;
    if (
      hash === PAPERCUT_STATUS_INDEX_GLOBAL_HASH &&
      range === PAPERCUT_STATUS_INDEX_MIGRATED_RANGE
    ) {
      markerExists = true;
      continue;
    }
    const pair = `${hash} ${range}`;
    present.add(pair);
    if (!wanted.has(pair)) {
      delta.push({
        mutationType: "delete",
        schemaHash: entryHash,
        keyHash: hash,
        keyRange: range,
        fields: {},
      });
    }
  }
  for (const [pair, record] of wanted) {
    if (present.has(pair)) continue;
    delta.push({
      mutationType: "create",
      schemaHash: entryHash,
      keyHash: record.status,
      keyRange: record.slug,
      fields: entryFieldsFor(record.status, record),
    });
  }

  const markerFields = {
    psi_h: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
    psi_r: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
    psi_payload: "",
    psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
  };
  if (delta.length === 0 && markerExists) return;

  const batchSize = Math.max(
    2,
    writeOpts.batchSize ?? PAPERCUT_STATUS_REINDEX_BATCH_SIZE,
  );
  if (delta.length + 1 <= batchSize) {
    await commitReindexBatch(
      node,
      [
        ...delta,
        {
          mutationType: markerExists ? "update" : "create",
          schemaHash: entryHash,
          keyHash: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
          keyRange: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
          fields: markerFields,
        },
      ],
      writeOpts,
    );
    return;
  }

  if (markerExists) {
    await commitReindexBatch(
      node,
      [
        {
          mutationType: "delete",
          schemaHash: entryHash,
          keyHash: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
          keyRange: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
          fields: {},
        },
      ],
      writeOpts,
    );
  }

  const sleep =
    writeOpts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pending = [...delta];
  while (pending.length > batchSize - 1) {
    const receipt = await commitReindexBatch(
      node,
      pending.splice(0, batchSize),
      writeOpts,
    );
    if (receipt.convergencePending || !receipt.backgroundTasksDrained) {
      await sleep(writeOpts.drainMs ?? PAPERCUT_STATUS_REINDEX_DRAIN_MS);
    }
  }
  await commitReindexBatch(
    node,
    [
      ...pending,
      {
        mutationType: "create",
        schemaHash: entryHash,
        keyHash: PAPERCUT_STATUS_INDEX_GLOBAL_HASH,
        keyRange: PAPERCUT_STATUS_INDEX_MIGRATED_RANGE,
        fields: markerFields,
      },
    ],
    writeOpts,
  );
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
  const migrated = await papercutStatusEntryExists(
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
