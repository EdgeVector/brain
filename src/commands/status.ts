// `fbrain status <slug>` — read (getter, respects read-verb instinct).
// `fbrain status <slug> <new-status>` — update.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  ensureStatus,
  findBySlug,
  nowIso,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { RECORDS, RECORD_TYPES, type RecordType } from "../schemas.ts";

export type StatusOptions = {
  cfg: Config;
  slug: string;
  newStatus?: string;
  type?: RecordType;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function statusCmd(opts: StatusOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  const found: Array<{ type: RecordType; record: FbrainRecord }> = [];
  for (const t of types) {
    const r = await findBySlug(node, t, schemaHashFor(t, opts.cfg), opts.slug);
    if (r) found.push({ type: t, record: r });
  }
  if (found.length === 0) {
    throw new FbrainError({
      code: "not_found",
      message: `No record with slug "${opts.slug}".`,
    });
  }
  if (found.length > 1) {
    const matchedTypes = found.map((f) => f.type).join(", ");
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists in multiple schemas (${matchedTypes}). Specify --type.`,
    });
  }
  const only = found[0]!;

  if (opts.newStatus === undefined) {
    print(only.record.status);
    return;
  }

  ensureStatus(only.type, opts.newStatus);

  const hash = schemaHashFor(only.type, opts.cfg);
  const now = nowIso();
  const def = RECORDS[only.type];
  const fields: Record<string, unknown> = {
    ...only.record,
    status: opts.newStatus,
    updated_at: now,
  };
  // Strip type-specific extras the schema doesn't declare.
  if (!def.hasDesignSlug) delete fields.design_slug;
  // Phase 6 records carry `kind` plus two fixed-value markers — set them
  // explicitly so an update doesn't drop them.
  if (def.kind !== null) {
    fields.kind = def.kind;
    fields.v1_marker_a = "fbrain";
    fields.v1_marker_b = "v1";
  } else {
    delete fields.kind;
  }
  await node.updateRecord({
    schemaHash: hash,
    keyHash: opts.slug,
    fields,
  });
  print(`${only.type} ${opts.slug}: ${only.record.status} → ${opts.newStatus}`);
}
