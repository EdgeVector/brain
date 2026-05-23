// `fbrain delete <slug> [--type design|task]` — soft-delete a record.
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
  schemaHashFor,
  TOMBSTONE_TAG,
  type FbrainRecord,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";

export type DeleteOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  verbose?: Verbose;
  print?: (line: string) => void;
};

// Status fields are validated client-side against the per-type enum (see
// `ensureStatus` in record.ts). "archived" is the only design status that
// fits a tombstoned record; "cancelled" is the task equivalent.
export const TOMBSTONE_STATUS: Record<RecordType, string> = {
  design: "archived",
  task: "cancelled",
};

export function buildTombstoneFields(
  type: RecordType,
  slug: string,
  createdAt: string,
  now: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    slug,
    title: "(deleted)",
    body: "",
    status: TOMBSTONE_STATUS[type],
    tags: [TOMBSTONE_TAG],
    created_at: createdAt,
    updated_at: now,
  };
  if (type === "task") fields.design_slug = "";
  return fields;
}

export async function deleteRecord(opts: DeleteOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const probeTypes: RecordType[] = opts.type ? [opts.type] : ["design", "task"];
  const live: Array<{ type: RecordType; record: FbrainRecord }> = [];
  for (const t of probeTypes) {
    const r = await findBySlugRaw(node, t, schemaHashFor(t, opts.cfg), opts.slug);
    if (r === null) continue;
    if (isTombstoned(r)) continue;
    live.push({ type: t, record: r });
  }

  if (live.length === 0) {
    if (opts.type) {
      throw new FbrainError({
        code: "not_found",
        message: `No ${opts.type}: ${opts.slug}`,
      });
    }
    throw new FbrainError({
      code: "not_found",
      message: `No design or task with slug "${opts.slug}".`,
    });
  }

  if (live.length > 1) {
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists as both a design and a task. Specify --type.`,
    });
  }

  const { type, record } = live[0]!;
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
