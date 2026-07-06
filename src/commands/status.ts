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
  // Structured-output sink, mirroring the read/write commands' `onResult`:
  // fires once per successful invocation with the SAME resolved
  // `type`/`slug`/status the printed line uses, so the MCP `fbrain_status`
  // tool's `structuredContent` can't drift from the human text. On the UPDATE
  // path it carries the `status_changed` transition; on the SHOW path (slug,
  // no new status) it carries a `status` read payload. The MCP tool declares
  // an outputSchema, so EVERY successful call must produce structured content
  // — the SDK's validateToolOutput rejects a schema'd result without it.
  onResult?: (payload: StatusResult | StatusShowResult) => void;
};

// The structured payload the MCP `fbrain_status` tool returns in
// `structuredContent` (mirrors the printed `<type> <slug>: <from> → <to>`
// transition line). `action` is always `status_changed` so an agent can key
// on the mutation kind uniformly with the other write tools' `action`.
export type StatusResult = {
  action: "status_changed";
  type: RecordType;
  slug: string;
  // The record's status BEFORE this mutation.
  from: string;
  // The record's status AFTER this mutation (the value passed in).
  to: string;
};

// The structured payload for SHOW mode (`slug` given, no new status): a plain
// read of the record's current status. `action` is `status` (not
// `status_changed`) so an agent can distinguish a read from a mutation.
export type StatusShowResult = {
  action: "status";
  type: RecordType;
  slug: string;
  status: string;
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
    // status word, so existing human/script callers are unaffected. Either
    // way the structured sink fires — the MCP tool relies on it (see
    // StatusOptions.onResult).
    if (opts.json) {
      print(
        JSON.stringify({
          slug: only.record.slug,
          type: only.type,
          status: only.record.status,
        }),
      );
    } else {
      print(only.record.status);
    }
    opts.onResult?.({
      action: "status",
      type: only.type,
      slug,
      status: only.record.status,
    });
    return;
  }

  ensureStatus(only.type, opts.newStatus);

  const hash = schemaHashFor(only.type, opts.cfg);
  const now = nowIso();
  const def = RECORDS[only.type];
  const fromStatus = only.record.status;
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
  print(`${only.type} ${slug}: ${fromStatus} → ${opts.newStatus}`);
  // Emit the structured payload from the SAME resolved type/slug/transition the
  // printed line uses (one source of truth — see the read/delete/link commands).
  opts.onResult?.({
    action: "status_changed",
    type: only.type,
    slug,
    from: fromStatus,
    to: opts.newStatus,
  });
}
