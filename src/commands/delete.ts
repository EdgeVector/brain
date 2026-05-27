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

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlugRaw,
  isTombstoned,
  nowIso,
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
  verbose?: Verbose;
  print?: (line: string) => void;
};

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
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  // raw mode bypasses tombstone filtering at the lookup layer; resolveBySlug
  // drops tombstones inside the helper afterward.
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug: opts.slug,
    type: opts.type,
    raw: true,
    notFoundMessage: { typed: (t, s) => `No ${t}: ${s}` },
  });
  const { type, record } = resolved;
  const schemaHash = schemaHashFor(type, opts.cfg);

  const fields = buildTombstoneFields(type, opts.slug, record.created_at, nowIso());

  await node.updateRecord({ schemaHash, fields, keyHash: opts.slug });
  // Fire fold_db's own delete mutation so the sync-log marker + per-field
  // tombstone (current fold_db) are written. When the spike was authored
  // this was a no-op at the storage layer (Probe B); current fold_db
  // repurposes it as a per-field tombstone write that hides the row from
  // default queries — which the verify below tolerates.
  await node.deleteRecord({ schemaHash, keyHash: opts.slug });

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
    () => findBySlugRaw(node, type, schemaHash, opts.slug),
    (r) => r === null || isTombstoned(r),
  );
  if (verify !== null && !isTombstoned(verify)) {
    throw new FbrainError({
      code: "delete_not_applied",
      message: `Soft-delete did not stick for ${type} ${opts.slug}.`,
      hint:
        "Re-run with --verbose; inspect the node log; the update mutation reported success but a subsequent read still shows the record without the tombstone tag.",
    });
  }

  print(
    `deleted ${type} ${opts.slug} (soft — fold_db is append-only; see docs/phase-5-delete-spike.md)`,
  );
}
