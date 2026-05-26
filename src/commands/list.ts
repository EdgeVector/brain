// `fbrain list [--type T] [--status S] [--tag T] [-n N]` — newest-first list with filters.

import { newNodeClient, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  isTombstoned,
  listRecords,
  schemaHashFor,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";

export type ListOptions = {
  cfg: Config;
  type?: RecordType;
  status?: string;
  tag?: string;
  limit?: number;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function listCmd(opts: ListOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  const sweep = async () => {
    const acc: Array<{ type: RecordType; record: FbrainRecord }> = [];
    for (const t of types) {
      const rs = await listRecords(node, t, schemaHashFor(t, opts.cfg));
      for (const r of rs) acc.push({ type: t, record: r });
    }
    return acc;
  };
  // The dogfood read-flake repro (2026-05-26): a status write lands, but
  // the immediately-following filtered list returns empty for ~1s. Retry
  // the sweep only when --status/--tag are present — without them, empty
  // is a legitimate signal and burning the budget every invocation slows
  // down genuinely-empty lists. The isHit predicate fires when the sweep
  // sees any non-tombstoned row; the user filter is applied after, so a
  // sweep that surfaces a row but the row doesn't match the filter still
  // stops retrying (we're riding out the empty-sweep flake, not searching
  // for a matching row). See withReadRetry in ../record.ts.
  const wantsRetry = opts.status !== undefined || opts.tag !== undefined;
  const all = wantsRetry
    ? await withReadRetry(sweep, (acc) =>
        acc.some(({ record }) => !isTombstoned(record)),
      )
    : await sweep();

  const filtered = all.filter(({ record }) => {
    if (isTombstoned(record)) return false;
    if (opts.status && record.status !== opts.status) return false;
    if (opts.tag && !record.tags.includes(opts.tag)) return false;
    return true;
  });

  filtered.sort(
    (a, b) => Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at),
  );

  const trimmed = opts.limit && opts.limit > 0 ? filtered.slice(0, opts.limit) : filtered;

  if (trimmed.length === 0) {
    print("no records");
    return;
  }

  for (const { type, record } of trimmed) {
    const tags = record.tags.length === 0 ? "" : ` [${record.tags.join(",")}]`;
    print(`${type.padEnd(10)} ${record.slug.padEnd(28)} ${record.status.padEnd(12)} ${record.title}${tags}`);
  }
}
