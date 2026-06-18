// `fbrain status <slug>` — read (getter, respects read-verb instinct).
// `fbrain status <slug> <new-status>` — update.

import { type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  ensureStatus,
  normalizeSlug,
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
  // Machine-readable show mode: when set (and no `newStatus` is given),
  // print a single `{slug, type, status}` JSON object instead of the bare
  // status word — read-surface parity with `get --json`. Ignored in update
  // mode, which keeps its human transition line.
  json?: boolean;
  print?: (line: string) => void;
};

export async function statusCmd(opts: StatusOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  // Reads through this client never touch the capability provider; the bare
  // `status <slug>` getter therefore stays read-only and does NOT trigger
  // consent. Only the update path below (node.updateRecord) acquires.
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  const only = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    recoveryVerb: "status",
  });

  if (opts.newStatus === undefined) {
    // Show mode. `--json` emits a single object whose field names mirror
    // `get --json` ({slug, type, status}); otherwise the historical bare
    // status word, so existing human/script callers are unaffected.
    if (opts.json) {
      print(
        JSON.stringify({
          slug: only.record.slug,
          type: only.type,
          status: only.record.status,
        }),
      );
      return;
    }
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
