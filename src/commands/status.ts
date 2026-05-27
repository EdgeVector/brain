// `fbrain status <slug>` — read (getter, respects read-verb instinct).
// `fbrain status <slug> <new-status>` — update.

import { newNodeClient, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  ensureStatus,
  nowIso,
  resolveBySlug,
  schemaHashFor,
} from "../record.ts";
import { RECORDS, type RecordType } from "../schemas.ts";

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

  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug: opts.slug,
    type: opts.type,
  });

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
