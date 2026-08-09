// Design -> child-task keyed index. One HashRange row per live task that
// carries a non-empty `design_slug`, addressed by (design_slug, task slug).
// Lets `findChildTasksByDesign` (record.ts) and the delete cascade guard
// (`findLinkedTaskSlugs`, commands/delete.ts) point-read one design's
// children instead of reading the WHOLE task partition and filtering by
// `design_slug` in the client. Shape mirrors `record-list-index.ts`
// (RecordListEntry) — read its header comment first; this file follows the
// same self-healing, non-fatal-write / loud-read contract.

import { FbrainError, type NodeClient, type QueryRow } from "./client.ts";
import {
  CHILD_TASK_INDEX_FIELDS,
  CHILD_TASK_INDEX_GLOBAL_HASH,
  CHILD_TASK_INDEX_MARKER,
  CHILD_TASK_INDEX_MIGRATED_RANGE,
  CHILD_TASK_INDEX_SCHEMA_KEY,
} from "./schemas.ts";
import type { FbrainRecord } from "./record.ts";

type SchemaCfg = { schemaHashes: Record<string, string> };

/**
 * Error code for "the index is registered but was never marked complete".
 *
 * Exported so callers can branch on the CONDITION rather than string-matching
 * the message. A read whose correctness depends on seeing every child (the
 * delete cascade guard) must still fail on it; a read that only DISPLAYS
 * children can degrade to "unavailable" instead of refusing the whole record.
 *
 * That distinction is the whole point: on 2026-08-08 registration shipped
 * without its migration and every `fbrain get <design>` failed for ~17 hours,
 * because a body read — a point get on the primary key — was gated on this
 * projection. Brain:
 * `papercut-brain-get-fails-for-every-design-record-child-task-index-not-marked-complete`.
 */
export const CHILD_TASK_INDEX_INCOMPLETE_CODE = "child_task_index_incomplete";

/** Whether `err` is the registered-but-unmigrated condition above. */
export function isChildTaskIndexIncomplete(err: unknown): boolean {
  return (
    err instanceof FbrainError && err.code === CHILD_TASK_INDEX_INCOMPLETE_CODE
  );
}

/** Hash of the ChildTaskIndex HashRange schema, or null before registration. */
export function childTaskIndexHash(cfg: SchemaCfg): string | null {
  const h = cfg.schemaHashes[CHILD_TASK_INDEX_SCHEMA_KEY];
  return h && h.length > 0 ? h : null;
}

function entryKeyFor(designSlug: string, taskSlug: string): { hash: string; range: string } {
  return { hash: designSlug, range: taskSlug };
}

function entryFieldsFor(designSlug: string, task: FbrainRecord): Record<string, string> {
  return {
    ctd_h: designSlug,
    ctd_r: task.slug,
    ctd_payload: JSON.stringify(task),
    ctd_marker: CHILD_TASK_INDEX_MARKER,
  };
}

/** Resolve the child task slug from one HashRange index row. */
function taskSlugFromEntryRow(row: QueryRow): string | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const slug = row.key?.range ?? fields.ctd_r;
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
    fields: ["ctd_h", "ctd_r"],
    filter: { HashRangeKey: { hash, range } },
  });
  return res.results.length > 0;
}

/** Write ONE task's row under its design partition. False when schema absent. */
export async function upsertChildTaskEntry(
  node: NodeClient,
  cfg: SchemaCfg,
  designSlug: string,
  task: FbrainRecord,
): Promise<boolean> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash || designSlug.length === 0) return false;
  const { hash, range } = entryKeyFor(designSlug, task.slug);
  const fields = entryFieldsFor(designSlug, task);
  const exists = await entryRowExists(node, entryHash, hash, range);
  if (exists) {
    await node.updateRecord({ schemaHash: entryHash, fields, keyHash: hash, keyRange: range });
  } else {
    await node.createRecord({ schemaHash: entryHash, fields, keyHash: hash, keyRange: range });
  }
  return true;
}

/** Drop ONE task's row from its design partition. False when schema absent. */
export async function deleteChildTaskEntry(
  node: NodeClient,
  cfg: SchemaCfg,
  designSlug: string,
  taskSlug: string,
): Promise<boolean> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash || designSlug.length === 0) return false;
  const { hash, range } = entryKeyFor(designSlug, taskSlug);
  if (!(await entryRowExists(node, entryHash, hash, range))) return true;
  await node.deleteRecord({ schemaHash: entryHash, keyHash: hash, keyRange: range });
  return true;
}

/**
 * Stamp "this index reflects every live task's design_slug". Written ONLY by
 * the bulk admin rebuild (`writeChildTaskIndex` / `fbrain reindex
 * --child-task-index`) — an ordinary create/put/delete/link patches its own
 * row but never claims the whole index is complete.
 */
export async function markChildTaskIndexMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
): Promise<boolean> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash) return false;
  const fields = {
    ctd_h: CHILD_TASK_INDEX_GLOBAL_HASH,
    ctd_r: CHILD_TASK_INDEX_MIGRATED_RANGE,
    ctd_payload: "",
    ctd_marker: CHILD_TASK_INDEX_MARKER,
  };
  const exists = await entryRowExists(
    node,
    entryHash,
    CHILD_TASK_INDEX_GLOBAL_HASH,
    CHILD_TASK_INDEX_MIGRATED_RANGE,
  );
  if (exists) {
    await node.updateRecord({
      schemaHash: entryHash,
      fields,
      keyHash: CHILD_TASK_INDEX_GLOBAL_HASH,
      keyRange: CHILD_TASK_INDEX_MIGRATED_RANGE,
    });
  } else {
    await node.createRecord({
      schemaHash: entryHash,
      fields,
      keyHash: CHILD_TASK_INDEX_GLOBAL_HASH,
      keyRange: CHILD_TASK_INDEX_MIGRATED_RANGE,
    });
  }
  return true;
}

/**
 * Self-heal: drop the global marker so the next read errors loudly (naming
 * the repair) instead of silently trusting a partial index forever.
 */
export async function unmarkChildTaskIndexMigrated(
  node: NodeClient,
  cfg: SchemaCfg,
): Promise<boolean> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash) return false;
  if (
    !(await entryRowExists(
      node,
      entryHash,
      CHILD_TASK_INDEX_GLOBAL_HASH,
      CHILD_TASK_INDEX_MIGRATED_RANGE,
    ))
  ) {
    return true;
  }
  await node.deleteRecord({
    schemaHash: entryHash,
    keyHash: CHILD_TASK_INDEX_GLOBAL_HASH,
    keyRange: CHILD_TASK_INDEX_MIGRATED_RANGE,
  });
  return true;
}

/**
 * One design's live children from the keyed partition.
 *
 * `null` means "the schema is not registered yet" (`cfg.schemaHashes` has no
 * `__childtaskindex__` key — the same INERT-ON-DEPLOY state
 * `recordListEntryHash` returns before `fbrain init` registers
 * RecordListEntry). Callers fall back to the pre-existing
 * listRecords()-and-filter path, unchanged, until registration is a
 * deliberate later step.
 *
 * Once the schema IS registered, a missing completeness marker is a hard
 * ERROR rather than a silent fallback to enumeration — same contract as
 * `listRecords` (record.ts) for the same reason: a short read that says "not
 * ready" beats one that quietly returns a subset and calls it complete.
 */
export async function readChildTasksByDesign(
  node: NodeClient,
  cfg: SchemaCfg,
  designSlug: string,
): Promise<FbrainRecord[] | null> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash) return null;
  const migrated = await entryRowExists(
    node,
    entryHash,
    CHILD_TASK_INDEX_GLOBAL_HASH,
    CHILD_TASK_INDEX_MIGRATED_RANGE,
  );
  if (!migrated) {
    throw new FbrainError({
      code: CHILD_TASK_INDEX_INCOMPLETE_CODE,
      message:
        "the design->child-task keyed index is registered but not marked complete, so child tasks " +
        "cannot be resolved from it without a full task-partition scan — which product read paths " +
        "must not do.",
      hint:
        "Run `fbrain reindex --child-task-index` (admin/offline) to rebuild the index from source of truth, then retry.",
    });
  }
  // The index is the relationship projection, not the task source of truth.
  // Hydrate each indexed slug by exact HashKey point read so append/status/tag
  // writes cannot leave `brain get <design>` serving a stale cached payload.
  // This still scales with this design's child count, never the task corpus.
  const { findBySlug, schemaHashFor } = await import("./record.ts");
  const taskHash = schemaHashFor("task", cfg);
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: [...CHILD_TASK_INDEX_FIELDS],
    filter: { HashKey: designSlug },
  });
  const out: FbrainRecord[] = [];
  for (const row of res.results) {
    const taskSlug = taskSlugFromEntryRow(row);
    if (!taskSlug) continue;
    const task = await findBySlug(node, "task", taskHash, taskSlug);
    // Defend against a stale old-parent row even if a process died in the
    // narrow primary-write -> projection-write window before it could clear
    // the marker. Never return a child under the wrong design.
    if (task?.design_slug === designSlug) out.push(task);
  }
  return out;
}

/**
 * Reflect one task write into the index. `task` is the post-write record (or
 * `null`/tombstoned for a delete); `previousDesignSlug` is the design_slug
 * the SAME task slug carried before this write (`undefined` on create — the
 * task never had a prior row to clean up).
 *
 * Covers every way a task's design_slug can change: create (`task new
 * --design`), update (`put`, direct `design_slug` frontmatter edit), delete
 * (tombstone), and reparent (`fbrain link <task> <design>`) — the same
 * "every write path, not just the obvious ones" lesson `maintainTypeListIndex`
 * documents (a partially maintained index is worse than none).
 */
export async function patchChildTaskIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  taskSlug: string,
  task: FbrainRecord | null,
  previousDesignSlug: string | undefined,
): Promise<void> {
  if (!childTaskIndexHash(cfg)) return;
  const { isTombstoned } = await import("./record.ts");
  const nextDesignSlug = task && !isTombstoned(task) ? (task.design_slug ?? "") : "";
  if (
    previousDesignSlug !== undefined &&
    previousDesignSlug.length > 0 &&
    previousDesignSlug !== nextDesignSlug
  ) {
    await deleteChildTaskEntry(node, cfg, previousDesignSlug, taskSlug);
  }
  if (nextDesignSlug.length > 0 && task) {
    await upsertChildTaskEntry(node, cfg, nextDesignSlug, task);
  }
}

/**
 * Non-fatal wrapper for write-path callers, matching `maintainTypeListIndex`'s
 * contract: the task write has ALREADY landed, so a patch failure must not
 * throw and lose that. It self-heals by clearing the completeness marker —
 * the next design lookup errors loudly (per `readChildTasksByDesign`) naming
 * the repair, instead of quietly serving a partial index forever.
 */
export async function maintainChildTaskIndex(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  taskSlug: string;
  task: FbrainRecord | null;
  previousDesignSlug: string | undefined;
  verbose?: (msg: string) => void;
}): Promise<{ childTaskIndexFailed: boolean }> {
  try {
    await patchChildTaskIndex(
      opts.node,
      opts.cfg,
      opts.taskSlug,
      opts.task,
      opts.previousDesignSlug,
    );
    return { childTaskIndexFailed: false };
  } catch (err) {
    try {
      await unmarkChildTaskIndexMigrated(opts.node, opts.cfg);
      opts.verbose?.(
        `child-task index patch FAILED for task/${opts.taskSlug}: ` +
          `${err instanceof Error ? err.message : String(err)}; record persisted — cleared the ` +
          "completeness marker so the next design lookup errors loudly (or run `fbrain reindex --child-task-index`).",
      );
    } catch (unmarkErr) {
      opts.verbose?.(
        `child-task index patch FAILED for task/${opts.taskSlug}: ` +
          `${err instanceof Error ? err.message : String(err)}; unmark also failed: ` +
          `${unmarkErr instanceof Error ? unmarkErr.message : String(unmarkErr)} — run \`fbrain reindex --child-task-index\` to repair.`,
      );
    }
    return { childTaskIndexFailed: true };
  }
}

/**
 * Bulk rebuild: given every live task record (admin SOT scan), replace the
 * whole keyed index — delete rows for tasks that no longer point at that
 * design (or were deleted), upsert current rows, stamp the completeness
 * marker. Admin/offline only (`fbrain reindex --child-task-index`); never
 * called from a product read/write path. The `allowFullScan` read here is of
 * the INDEX's own schema, not a product table — the same distinction
 * `writeTypeListIndex` draws for its existing-partition read.
 */
export async function writeChildTaskIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  liveTasks: readonly FbrainRecord[],
): Promise<void> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash) return;
  // Rebuild is multi-write. Clear the authoritative marker before touching
  // rows so an interrupted repair can never leave a partial projection marked
  // complete. The marker is restored only after every delete/upsert succeeds.
  await unmarkChildTaskIndexMigrated(node, cfg);
  const existing = await node.queryAll({
    schemaHash: entryHash,
    fields: [...CHILD_TASK_INDEX_FIELDS],
    allowFullScan: true,
  });
  const want = new Set<string>();
  for (const t of liveTasks) {
    const d = t.design_slug ?? "";
    if (d.length > 0) want.add(`${d} ${t.slug}`);
  }
  for (const row of existing.results) {
    const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
    const h = row.key?.hash ?? fields.ctd_h;
    const r = row.key?.range ?? fields.ctd_r;
    if (typeof h !== "string" || typeof r !== "string") continue;
    if (h === CHILD_TASK_INDEX_GLOBAL_HASH && r === CHILD_TASK_INDEX_MIGRATED_RANGE) continue;
    if (!want.has(`${h} ${r}`)) {
      await node.deleteRecord({ schemaHash: entryHash, keyHash: h, keyRange: r });
    }
  }
  for (const t of liveTasks) {
    const d = t.design_slug ?? "";
    if (d.length > 0) await upsertChildTaskEntry(node, cfg, d, t);
  }
  await markChildTaskIndexMigrated(node, cfg);
}

/** Census of the index vs an authoritative live (designSlug, taskSlug) set. */
export type ChildTaskIndexCensus = {
  indexed: number;
  sot: number;
  missingFromIndex: string[];
  extraInIndex: string[];
  migrated: boolean;
  complete: boolean;
};

/**
 * Compare the keyed index against an authoritative live set of
 * `design_slug task_slug` pairs. Used by `fbrain reindex
 * --child-task-index` (repair) so "the index is complete" is proven, not
 * assumed.
 */
export async function censusChildTaskIndex(
  node: NodeClient,
  cfg: SchemaCfg,
  sotPairs: readonly string[],
): Promise<ChildTaskIndexCensus | null> {
  const entryHash = childTaskIndexHash(cfg);
  if (!entryHash) return null;
  const migrated = await entryRowExists(
    node,
    entryHash,
    CHILD_TASK_INDEX_GLOBAL_HASH,
    CHILD_TASK_INDEX_MIGRATED_RANGE,
  );
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: [...CHILD_TASK_INDEX_FIELDS],
    allowFullScan: true,
  });
  const indexedKeys = new Set<string>();
  for (const row of res.results) {
    const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
    const h = row.key?.hash ?? fields.ctd_h;
    const r = row.key?.range ?? fields.ctd_r;
    if (typeof h !== "string" || typeof r !== "string") continue;
    if (h === CHILD_TASK_INDEX_GLOBAL_HASH && r === CHILD_TASK_INDEX_MIGRATED_RANGE) continue;
    indexedKeys.add(`${h} ${r}`);
  }
  const sotSet = new Set(sotPairs);
  const missingFromIndex = [...sotSet].filter((k) => !indexedKeys.has(k)).sort();
  const extraInIndex = [...indexedKeys].filter((k) => !sotSet.has(k)).sort();
  return {
    indexed: indexedKeys.size,
    sot: sotSet.size,
    missingFromIndex,
    extraInIndex,
    migrated,
    complete: migrated && missingFromIndex.length === 0 && extraInIndex.length === 0,
  };
}
