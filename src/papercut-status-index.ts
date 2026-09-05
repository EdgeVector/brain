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

/**
 * The papercut record the index row already carries.
 *
 * `psi_payload` is a JSON snapshot of the whole record, written by
 * `entryFieldsFor` / `planPapercutStatusOps` in the SAME mutation that places
 * the row in its status partition. It was stored from the first version of
 * this index and, until this function existed, never read: every ledger read
 * shipped the payload over the wire and then threw it away to point-get the
 * same record back one slug at a time.
 *
 * Returns null when the field is absent, unparseable, or carries a different
 * slug than the row it came from, so the caller can point-hydrate that one row
 * instead of dropping it. A payload that parses is still subject to the
 * caller's fail-closed checks (tombstone, and status-equals-partition).
 */
export function recordFromEntryRow(row: QueryRow): FbrainRecord | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const raw = fields.psi_payload;
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const record = parsed as FbrainRecord;
  if (typeof record.slug !== "string" || record.slug.length === 0) return null;
  if (typeof record.status !== "string") return null;
  if (!Array.isArray(record.tags)) return null;
  const rowSlug = slugFromEntryRow(row);
  if (rowSlug !== null && rowSlug !== record.slug) return null;
  return record;
}

/**
 * A key-order-independent serialization, used ONLY to compare a stored
 * `psi_payload` against the record it is supposed to mirror.
 *
 * `entryFieldsFor` writes `JSON.stringify(record)`, whose key order follows
 * the record object's own insertion order. A record rebuilt from an admin
 * scan need not carry its keys in the order they had when the payload was
 * written, so comparing the raw strings would call an identical payload stale
 * and rewrite every row on every rebuild. Sorting keys compares CONTENT.
 */
function stablePayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stablePayload(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * True when the row's `psi_payload` snapshot already mirrors `record`.
 *
 * A row whose payload is absent, unparseable or slug-crossed reports FALSE, so
 * the rebuild refreshes it rather than leaving a row it cannot read. This is
 * the check that makes the rebuild a repair for payload drift and not only for
 * membership: `(status, slug)` can be correct on a row whose snapshot is
 * months stale, and every reader that trusts the snapshot then serves that.
 */
export function entryPayloadMatches(
  row: QueryRow,
  record: FbrainRecord,
): boolean {
  const stored = recordFromEntryRow(row);
  if (stored === null) return false;
  return stablePayload(stored) === stablePayload(record);
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

/**
 * Whether the node refused the `HashKeys` hydrate query because it does not
 * serve that filter. A Mini that predates `HashKeys` answers `/api/query` with
 * an HTTP 400 reject — on 0.23.3-1435 the text is
 * `a key was present with a value outside its grammar` — so any 400 on this
 * one query means "use point reads", not "the list is broken". A 5xx, a
 * timeout, or a transport error is still thrown to the caller.
 */
export function isUnsupportedHashKeysFilter(error: unknown): boolean {
  const status =
    error !== null && typeof error === "object"
      ? Number(
          (error as { status?: unknown; httpStatus?: unknown }).status ??
            (error as { httpStatus?: unknown }).httpStatus,
        )
      : Number.NaN;
  if (status === 400) return true;
  const code =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "node_http_400") return true;
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /hashkeys|unknown filter|unrecognized filter|invalid filter|bad request|http 400|outside its grammar|invalid[ _]value/i.test(
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
  // Batches that answered before the reject already sit in `bySlug`.
  const pending = opts.slugs.filter((slug) => !bySlug.has(slug));
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

/**
 * What one `readPapercutsByStatus` call actually did, so a reader can say so
 * in its method line instead of asserting it. `rows` is what the partition
 * held, `narrowedOut` is what the snapshot ruled out unread, `pointReads` is
 * what it charged the node.
 */
export type PapercutReadStats = {
  rows: number;
  pointReads: number;
  narrowedOut: number;
};

export function newPapercutReadStats(): PapercutReadStats {
  return { rows: 0, pointReads: 0, narrowedOut: 0 };
}

/**
 * Read one named status partition, or every fixed status partition.
 *
 * Default: point-read every record. One node request per row (2208 open rows
 * measured 44.8s across 2215 requests on the primary, 2026-09-03).
 *
 * `fast: true`: serve each row from the `psi_payload` snapshot the index
 * already carries, so a full-ledger read is one keyed query per status
 * partition and ZERO point reads (the same 2208 rows in 3.4s). A row whose
 * payload is missing or unparseable still falls back to a point read, so an
 * index written before the payload existed reads correctly.
 *
 * The snapshot is written by the resident write plan, so it is only as fresh
 * as the last write that went through it. Measured against the primary on
 * 2026-09-03, across all 2208 open rows: `status`, `component`, `severity`,
 * `kind`, `repo`, `title`, `fixed_by`, `verified_by` and `duplicate_of` agreed
 * on EVERY row, while `updated_at` was stale on 1028 (46.6%) and `tags` on 5.
 * `brain append` and `brain tag` were writing the record without patching this
 * index; both now patch it, so new drift stops, but rows written before that
 * fix keep their stale `updated_at` until the index is rebuilt
 * (`brain reindex --papercut-status-index`). Until then `fast` must not be
 * used for anything ordered or filtered by `updated_at` — which is what
 * `papercut list` orders by.
 *
 * Both readings apply the same fail-closed filter: a tombstoned record, or one
 * whose own `status` disagrees with the partition it sat in, is dropped rather
 * than served under the wrong status. Only the point read can catch a record
 * whose status moved without the index following; the payload cannot, because
 * a write that skipped the index also skipped the payload.
 *
 * `narrow`: a predicate over the payload snapshot that selects which rows are
 * worth point-reading at all. This is what makes a FILTERED list cost the size
 * of its answer instead of the size of the partition. `papercut list --status
 * open --severity p0` returned 22 rows and point-read all 2251 open ones
 * (2258 node requests, 715.6s of node time, measured on the primary
 * 2026-09-04); an owner-review run measuring the same read got
 * socket-not-reachable from the load it created. With `narrow`, only the rows
 * whose snapshot already matches are point-read — and they are then filtered
 * AGAIN on the point-read record, so a snapshot that wrongly includes a row
 * cannot put it in the answer.
 *
 * The cost, stated rather than implied: a row whose snapshot disagrees with
 * the record ON A FILTER FIELD is dropped without being read, so it can be
 * missed. That is why `narrow` must only ever be given fields measured stable.
 * Across all 2252 open rows on the primary, 2026-09-04: `severity`, `kind`,
 * `repo`, `component`, `status`, `title`, `fixed_by`, `verified_by`,
 * `duplicate_of`, `symptom_hash`, `created_at` and `tags` agreed with the
 * point-read record on EVERY row; only `updated_at` disagreed, on 2. A row
 * with no usable snapshot is never narrowed out — it is point-read, as before.
 */
export async function readPapercutsByStatus(
  node: NodeClient,
  cfg: SchemaCfg,
  status?: string,
  opts?: {
    fast?: boolean;
    narrow?: (record: FbrainRecord) => boolean;
    stats?: PapercutReadStats;
  },
): Promise<FbrainRecord[]> {
  const entryHash = await requireCompletePapercutStatusIndex(node, cfg);
  const statuses = status === undefined ? PAPERCUT_STATUSES : [status];
  const { findBySlug, isTombstoned, schemaHashFor, fieldsFor, rowToRecord } =
    await import("./record.ts");
  const papercutHash = schemaHashFor("papercut", cfg);
  const fast = opts?.fast === true;
  const narrow = opts?.narrow;
  const stats = opts?.stats;
  const out: FbrainRecord[] = [];
  for (const partition of statuses) {
    const res = await node.queryAll({
      schemaHash: entryHash,
      fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
      filter: { HashKey: partition },
    });
    const slugs: string[] = [];
    const fromPayload = new Map<string, FbrainRecord>();
    for (const row of res.results) {
      const slug = slugFromEntryRow(row);
      if (!slug) continue;
      if (stats) stats.rows += 1;
      // Parse the snapshot when EITHER reading needs it: `fast` serves from
      // it, `narrow` decides from it. A row it cannot parse falls through to
      // the point read in both cases.
      const record = fast || narrow ? recordFromEntryRow(row) : null;
      if (narrow && record && !narrow(record)) {
        if (stats) stats.narrowedOut += 1;
        continue;
      }
      slugs.push(slug);
      if (fast && record) fromPayload.set(slug, record);
    }
    // Point-read only what the payload could not answer: everything by
    // default, and under `fast` just the rows with no usable snapshot.
    const pending = fast
      ? slugs.filter((slug) => !fromPayload.has(slug))
      : slugs;
    if (stats) stats.pointReads += pending.length;
    const hydrated = await hydratePapercutsBySlug({
      node,
      papercutHash,
      slugs: pending,
      findBySlug,
      fieldsFor,
      rowToRecord,
    });
    for (const slug of slugs) {
      const record = hydrated.get(slug) ?? fromPayload.get(slug);
      // Fail closed against a process dying between old-row deletion and the
      // new-row upsert: never serve a stale row under the wrong status.
      if (record && !isTombstoned(record) && record.status === partition)
        out.push(record);
    }
  }
  return out;
}

/** One status-index row: the papercut slug and the partition it sits in. */
export type PapercutStatusIndexRow = { slug: string; status: string };

/**
 * Read one status partition (or every fixed partition) WITHOUT hydrating the
 * papercut records: one keyed query per partition, zero point reads.
 *
 * `readPapercutsByStatus` point-hydrates every row so it can fail closed on a
 * stale index entry. On the primary that hydrate measured 1.7-1.9s and ~250
 * group loads per row (`lastdb ops`, 2026-09-03), so the 2171-row open ledger
 * took 214s wall across 2191 node requests — 10x the papercut reconciler's 20s
 * read cap, which is why the papercut→card path was dead for 8 days
 * (papercut-lastdb-reconciler-policies-query-slow). Its two fleet consumers
 * (`last-stack-papercut-queue snapshot` and the lifecycle-close helper) only
 * use the slug and re-verify status on their own point-get, so they read this
 * projection instead.
 *
 * Contract: `status` is the partition key the row was found under, NOT
 * re-verified against the record. A consumer that needs the fail-closed row
 * must point-get it. A ledger audit that needs header fields still uses the
 * hydrating reader.
 */
export async function readPapercutSlugsByStatus(
  node: NodeClient,
  cfg: SchemaCfg,
  status?: string,
): Promise<PapercutStatusIndexRow[]> {
  const entryHash = await requireCompletePapercutStatusIndex(node, cfg);
  const statuses = status === undefined ? PAPERCUT_STATUSES : [status];
  const out: PapercutStatusIndexRow[] = [];
  for (const partition of statuses) {
    const res = await node.queryAll({
      schemaHash: entryHash,
      fields: [...PAPERCUT_STATUS_INDEX_FIELDS],
      filter: { HashKey: partition },
    });
    for (const row of res.results) {
      const slug = slugFromEntryRow(row);
      if (slug) out.push({ slug, status: partition });
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
  const present = new Map<string, QueryRow>();
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
    present.set(pair, row);
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
    const existingRow = present.get(pair);
    // A row already in the right partition is NOT necessarily current. Until
    // this branch existed the rebuild skipped it outright, so `psi_payload`
    // drift was unrepairable by the only tool that claims to repair the index:
    // membership was rebuilt, the snapshot every `--fast` read serves was not.
    // A row whose snapshot already matches still writes nothing, so a healthy
    // rebuild stays a no-op instead of rewriting the whole ledger.
    if (existingRow !== undefined) {
      if (entryPayloadMatches(existingRow, record)) continue;
      delta.push({
        mutationType: "update",
        schemaHash: entryHash,
        keyHash: record.status,
        keyRange: record.slug,
        fields: entryFieldsFor(record.status, record),
      });
      continue;
    }
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
  /**
   * Rows in the right partition whose `psi_payload` snapshot disagrees with
   * the record. Membership can be perfect while these are months stale, and
   * they are what every `--fast` reader serves.
   */
  stalePayload: string[];
  migrated: boolean;
  complete: boolean;
};

/**
 * Index health against the papercut source of truth.
 *
 * Takes the live RECORDS, not `status slug` pair strings, because a pair-only
 * census can only see membership. It answered `complete` on an index where
 * 46.6% of rows carried a stale `psi_payload` — while shipping that payload
 * over the wire to make the judgment. The signature is the guard: there is no
 * way to ask for this census and skip the snapshot check.
 */
export async function censusPapercutStatusIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  sot: readonly FbrainRecord[],
): Promise<PapercutStatusIndexCensus | null> {
  const sotPairs = sot.map((record) => `${record.status} ${record.slug}`);
  const byPair = new Map(
    sot.map((record) => [`${record.status} ${record.slug}`, record]),
  );
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
  const stalePayload: string[] = [];
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
    const pair = `${hash} ${range}`;
    indexedSet.add(pair);
    const record = byPair.get(pair);
    if (record !== undefined && !entryPayloadMatches(row, record))
      stalePayload.push(pair);
  }
  const sotSet = new Set(sotPairs);
  const missingFromIndex = [...sotSet]
    .filter((key) => !indexedSet.has(key))
    .sort();
  const extraInIndex = [...indexedSet].filter((key) => !sotSet.has(key)).sort();
  stalePayload.sort();
  return {
    indexed: indexedSet.size,
    sot: sotSet.size,
    missingFromIndex,
    extraInIndex,
    stalePayload,
    migrated,
    complete:
      migrated &&
      missingFromIndex.length === 0 &&
      extraInIndex.length === 0 &&
      stalePayload.length === 0,
  };
}
