// `fbrain delete <slug> [--type T]` — soft-delete a record.
//
// fold_db's mutation pipeline is append-only — see docs/phase-5-delete-spike.md.
// A real "hard delete" cannot be implemented today, so this command:
//   1. Overwrites every user field with sentinel values and stamps the
//      tombstone tag (TOMBSTONE_TAG from record.ts).
//   2. Fires the fold_db `mutation_type=delete` for symbolic intent and
//      forward-compat with a future hard-delete path. The minimal
//      `fields_and_values: {}` body is used per the spike.
//   3. Verifies the soft-delete by reading the record back and asserting
//      it is no longer user-visible — either filtered out (per-field
//      fold_db tombstone) or carrying our tombstone tag.
//
// Every other fbrain read path (`get`, `list`, `status`, `link`, `search`)
// filters tombstoned records out via `findBySlug` / `list`'s explicit check,
// so the user-visible behavior matches a hard delete.
//
// Verify semantics evolved with fold_db: when the spike was written,
// `MutationType::Delete` was a no-op so the verify checked that our
// tombstone tag had landed on the still-present row. Current fold_db
// repurposes `MutationType::Delete` as a per-field tombstone write that
// the default query filter hides (see
// `fold_db/crates/core/src/fold_db_core/mutation_manager.rs` —
// "MutationType::Delete is repurposed as the tombstone write"), so the
// post-delete read may legitimately return null. Both null and "row with
// our tombstone tag" are success; only "row visible with no tombstone
// tag" raises delete_not_applied.

import { FbrainError, type NodeClient, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  type FbrainRecord,
  findBySlugRaw,
  isTombstoned,
  listRecords,
  normalizeSlug,
  nowIso,
  NOT_FOUND_TYPED,
  resolveBySlug,
  schemaHashFor,
  TOMBSTONE_TAG,
  withReadRetry,
} from "../record.ts";
import { RECORDS, type RecordType } from "../schemas.ts";

export type DeleteOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  // Override the referential-integrity guard that blocks deleting a design
  // still referenced by live tasks. With --force the design is deleted and
  // those tasks' design_slug references are left dangling (a warning lists
  // them). Mirrors the --force escape hatch on `task new` / `put`.
  force?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Structured-output sink, mirroring the read commands' `onResult`: fires
  // once on the success path with the SAME resolved `type`/`slug` the printed
  // `deleted <type> <slug>` line uses, so the MCP `structuredContent` can't
  // drift from the human text. `soft` is always `true` — fold_db is
  // append-only, so every delete is a tombstone, never a hard delete.
  onResult?: (payload: DeleteResult) => void;
};

// The structured payload the MCP `fbrain_delete` tool returns in
// `structuredContent` (mirrors the printed `deleted <type> <slug> (soft …)`
// line). `soft` is invariant `true`.
export type DeleteResult = {
  action: "deleted";
  type: RecordType;
  slug: string;
  soft: true;
};

// Live (non-tombstoned) tasks whose design_slug points at `designSlug`.
// fold_db has no server-side field filter (see client.ts queryAll), so we
// list every task and match in-memory. Retry-hedged for the same transient
// empty-page flake task-new's parent lookup guards against: without the
// hedge a flake hides a linked task, the design deletes, and we re-introduce
// exactly the orphaning this guard exists to prevent. `isHit` fires as soon
// as one match surfaces; a design with genuinely zero linked tasks spends
// the full retry budget before proceeding — the same negative-case cost the
// create-side guards accept to stay correct under flake.
async function findLinkedTaskSlugs(
  node: NodeClient,
  cfg: Config,
  designSlug: string,
): Promise<string[]> {
  const taskHash = schemaHashFor("task", cfg);
  const isLinked = (r: FbrainRecord): boolean =>
    !isTombstoned(r) && r.design_slug === designSlug;
  const tasks = await withReadRetry(
    () => listRecords(node, "task", taskHash),
    (rows) => rows.some(isLinked),
  );
  return tasks
    .filter(isLinked)
    .map((r) => r.slug)
    .sort();
}

// Tombstone status per type — pick a value from each type's status enum
// that semantically fits "this is gone". Validated on write by the
// record's schema (statuses are free-form strings in fold_db itself, but
// fbrain ensures the value is in the enum via ensureStatus elsewhere).
export const TOMBSTONE_STATUS: Record<RecordType, string> = {
  design: "archived",
  task: "cancelled",
  concept: "archived",
  preference: "superseded",
  reference: "archived",
  agent: "archived",
  project: "archived",
  spike: "concluded",
};

export function buildTombstoneFields(
  type: RecordType,
  slug: string,
  createdAt: string,
  now: string,
): Record<string, unknown> {
  const def = RECORDS[type];
  const fields: Record<string, unknown> = {
    slug,
    title: "(deleted)",
    body: "",
    status: TOMBSTONE_STATUS[type],
    tags: [TOMBSTONE_TAG],
    created_at: createdAt,
    updated_at: now,
  };
  if (def.hasDesignSlug) fields.design_slug = "";
  return fields;
}

export async function deleteRecord(opts: DeleteOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  // raw mode bypasses tombstone filtering at the lookup layer; resolveBySlug
  // drops tombstones inside the helper afterward.
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    raw: true,
    notFoundMessage: NOT_FOUND_TYPED,
  });
  const { type, record } = resolved;

  // Referential-integrity guard, symmetric with the create-time rejection in
  // `task new --design` / `link`: those refuse to point a task at a missing
  // design, so deleting a design out from under live tasks must not silently
  // orphan them. Only Task carries design_slug (RECORDS[*].hasDesignSlug), so
  // this is a design-only concern. Runs before any mutation: a blocked delete
  // leaves the design untouched.
  if (type === "design") {
    const linked = await findLinkedTaskSlugs(node, opts.cfg, slug);
    if (linked.length > 0) {
      const n = linked.length;
      const noun = n === 1 ? "task" : "tasks";
      const verb = n === 1 ? "links" : "link";
      if (!opts.force) {
        throw new FbrainError({
          code: "design_has_linked_tasks",
          message: `Cannot delete design "${slug}" — ${n} ${noun} still ${verb} to it: ${linked.join(", ")}.`,
          hint: "Re-link those tasks to another design (`fbrain link <task> <design>`) or delete them first (`fbrain delete <task> --type task`), or pass --force to delete anyway (their design references will dangle).",
        });
      }
      print(
        `warning: ${n} ${noun} still ${verb} to design "${slug}" (${linked.join(", ")}); after this delete their design references will dangle.`,
      );
    }
  }

  const schemaHash = schemaHashFor(type, opts.cfg);

  const fields = buildTombstoneFields(type, slug, record.created_at, nowIso());

  await node.updateRecord({ schemaHash, fields, keyHash: slug });
  // Fire fold_db's own delete mutation so the sync-log marker + per-field
  // tombstone (current fold_db) are written. When the spike was authored
  // this was a no-op at the storage layer (Probe B); current fold_db
  // repurposes it as a per-field tombstone write that hides the row from
  // default queries — which the verify below tolerates.
  await node.deleteRecord({ schemaHash, keyHash: slug });

  // Verify the soft-delete landed. A successful delete leaves the row in
  // one of two states:
  //   (a) row absent from the raw read — current fold_db's
  //       `MutationType::Delete` writes a per-field tombstone that the
  //       default query filter hides;
  //   (b) row present but carrying our TOMBSTONE_TAG — older fold_db
  //       (pre-tombstone repurposing) where `MutationType::Delete` is a
  //       no-op and only the prior `update` mutation matters.
  // Only "row visible AND not tombstoned" is a real failure: the update
  // mutation reported success but the tag did not land.
  //
  // Retry on the worst-case signal (row visible AND not tombstoned), so
  // the page-flake hedge from PR #53 still absorbs a transient
  // un-tombstoned read on a saturated daemon.
  const verify = await withReadRetry(
    () => findBySlugRaw(node, type, schemaHash, slug),
    (r) => r === null || isTombstoned(r),
  );
  if (verify !== null && !isTombstoned(verify)) {
    throw new FbrainError({
      code: "delete_not_applied",
      message: `Soft-delete did not stick for ${type} ${slug}.`,
      hint:
        "Re-run with --verbose; inspect the node log; the update mutation reported success but a subsequent read still shows the record without the tombstone tag.",
    });
  }

  print(
    `deleted ${type} ${slug} (soft — fold_db is append-only; see docs/phase-5-delete-spike.md)`,
  );
  // Emit the structured payload from the SAME resolved `type`/`slug` the
  // printed line uses (one source of truth — see the read commands).
  opts.onResult?.({ action: "deleted", type, slug, soft: true });
}
