// `fbrain list [--type T] [--status S] [--tag T] [-n N]` — newest-first list with filters.

import { newNodeClient, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  isTombstoned,
  listRecords,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";

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

  const types: RecordType[] = opts.type ? [opts.type] : ["design", "task"];
  const all: Array<{ type: RecordType; record: FbrainRecord }> = [];
  for (const t of types) {
    const rs = await listRecords(node, t, schemaHashFor(t, opts.cfg));
    for (const r of rs) all.push({ type: t, record: r });
  }

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
    print(`${type.padEnd(6)} ${record.slug.padEnd(28)} ${record.status.padEnd(12)} ${record.title}${tags}`);
  }
}
