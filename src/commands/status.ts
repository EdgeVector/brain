// `fbrain status <slug>` — read (getter, respects read-verb instinct).
// `fbrain status <slug> <new-status>` — update.

import { type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
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
  // Trim surrounding whitespace to mirror `put`'s silent normalization
  // (put.ts: `resolveSlug` calls `.trim()` on both the positional arg and
  // the frontmatter `slug:`). Without this, a record created via
  // `fbrain put " foo "` is stored under slug "foo" but the update path
  // below built `keyHash` from the untrimmed input — so the mutation
  // landed on a different key from the one the resolver (which normalizes)
  // had just read, and the status change silently didn't stick on the
  // canonical record. Same fix delete / link / put already carry.
  const slug = opts.slug.trim();
  // Reads through this client never touch the capability provider; the bare
  // `status <slug>` getter therefore stays read-only and does NOT trigger
  // consent. Only the update path below (node.updateRecord) acquires.
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
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
  if (!def.hasDesignSlug) delete fields.design_slug;
  await node.updateRecord({
    schemaHash: hash,
    keyHash: slug,
    fields,
  });
  print(`${only.type} ${slug}: ${only.record.status} → ${opts.newStatus}`);
}
