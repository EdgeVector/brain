// ChildTaskIndex helpers. Product paths no longer write ctd_payload.

import { pageBackfill } from "./backlink-index.ts";
import { FbrainError, type NodeClient, type QueryRow } from "./client.ts";
import {
  CHILD_TASK_INDEX_FIELDS,
  CHILD_TASK_INDEX_GLOBAL_HASH,
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
      hint: `The old payload write stopped. ${pageBackfill(`child#${designSlug}`, "task")}`,
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
    // The print uses slug and status. The body stays in the file.
    const task = await findBySlug(node, "task", taskHash, taskSlug, undefined, {
      hydrate: false,
    });
    // Defend against a stale old-parent row even if a process died in the
    // narrow primary-write -> projection-write window before it could clear
    // the marker. Never return a child under the wrong design.
    if (task?.design_slug === designSlug) out.push(task);
  }
  return out;
}
