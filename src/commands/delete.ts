// `fbrain delete <slug> [--type T]` — soft-delete a record.
//
// fold_db's mutation pipeline is append-only — see docs/phase-5-delete-spike.md.
// A real "hard delete" cannot be implemented today, so this command:
//   1. Overwrites every user field with sentinel values and stamps the
//      tombstone tag (TOMBSTONE_TAG from record.ts).
//   2. Fires the fold_db `mutation_type=delete` for symbolic intent and
//      forward-compat with a future hard-delete path. The minimal
//      `fields_and_values: {}` body is used per the spike.
//   3. Verifies the soft-delete by reading the record back (raw — bypassing
//      the tombstone filter) and asserting the tombstone tag is present.
//
// Every other fbrain read path (`get`, `list`, `status`, `link`, `search`)
// filters tombstoned records out via `findBySlug` / `list`'s explicit check,
// so the user-visible behavior matches a hard delete.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlugRaw,
  isTombstoned,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  TOMBSTONE_TAG,
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
  if (def.kind !== null) {
    // Phase 6 records on the shared noteSchema carry a `kind` discriminator
    // plus two fixed-value markers; an update must include them or the
    // schema rejects the mutation.
    fields.kind = def.kind;
    fields.v1_marker_a = "fbrain";
    fields.v1_marker_b = "v1";
  }
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
  // drops tombstones inside the helper afterward. The post-delete verify
  // below is intentionally NOT retried — it's testing that the mutation we
  // just fired landed, not that an existing row is findable.
  const { type, record } = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug: opts.slug,
    type: opts.type,
    raw: true,
    // For Phase 6 types that share noteSchema, findBySlugRaw returns rows
    // regardless of kind. Skip rows whose kind doesn't match this type so we
    // don't try to "delete" a preference as a concept.
    filter: (r, t) => {
      const def = RECORDS[t];
      return def.kind === null || r.kind === def.kind;
    },
    notFoundMessage: { typed: (t, s) => `No ${t}: ${s}` },
  });
  const schemaHash = schemaHashFor(type, opts.cfg);

  const fields = buildTombstoneFields(type, opts.slug, record.created_at, nowIso());

  await node.updateRecord({ schemaHash, fields, keyHash: opts.slug });
  // Forward-compat: fire fold_db's own delete so any future hard-delete or
  // sync-log consumer sees the explicit intent. No-op at the storage layer
  // today (see spike doc, Probe B).
  await node.deleteRecord({ schemaHash, keyHash: opts.slug });

  const verify = await findBySlugRaw(node, type, schemaHash, opts.slug);
  if (verify === null || !isTombstoned(verify)) {
    throw new FbrainError({
      code: "delete_not_applied",
      message: `Soft-delete did not stick for ${type} ${opts.slug}.`,
      hint:
        "Re-run with --verbose; inspect the node log; the update mutation reported success but a subsequent read does not show the tombstone tag.",
    });
  }

  print(
    `deleted ${type} ${opts.slug} (soft — fold_db is append-only; see docs/phase-5-delete-spike.md)`,
  );
}
