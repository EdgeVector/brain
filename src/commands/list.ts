// `fbrain list [--type T] [--status S] [--tag T] [-n N]` — newest-first list with filters.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { formatTable } from "../format.ts";
import {
  isTombstoned,
  listRecords,
  schemaHashFor,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";

// Default cap for an unfiltered `fbrain list`. Without it an
// unfiltered list dumps every record in the index — 80+ already, and
// growing. A `-n N` flag overrides this; the truncation hint tells the
// user what they're missing.
export const DEFAULT_LIST_LIMIT = 20;

export type ListOptions = {
  cfg: Config;
  type?: RecordType;
  status?: string;
  tag?: string;
  // Optional explicit cap. When omitted, `listCmd` applies
  // DEFAULT_LIST_LIMIT and prints a "K more" hint on truncation.
  // Must be a positive integer when set — non-positive values are
  // rejected by the CLI before they reach here.
  limit?: number;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function listCmd(opts: ListOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

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

  // Primary: newest updated_at first. Tie-breakers: type then slug, both
  // ascending — needed because the node's `/api/query` row order is
  // unstable (see queryAll in ../client.ts), so a tie on updated_at would
  // otherwise resolve in whatever order the daemon happened to serve the
  // rows. With `-n N` truncation that lets `fbrain list` swap WHICH rows
  // it shows across invocations. Ties are realistic: `migrate` / `init`
  // seed batches stamp identical timestamps, and `nowIso()` is
  // millisecond-resolution so any two `put` / `status` / `link` calls in
  // the same ms collide. (type, slug) is globally unique — slugs aren't
  // unique across types but type+slug is — so the order is fully pinned.
  filtered.sort((a, b) => {
    const d = Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at);
    if (d !== 0) return d;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.record.slug < b.record.slug
      ? -1
      : a.record.slug > b.record.slug
        ? 1
        : 0;
  });

  // Genuinely-empty result wins over the truncation path — print
  // `no records` even when the implicit default cap would have taken
  // effect. (Iron: the cap is a UX guard against floods, not a signal.)
  if (filtered.length === 0) {
    print("no records");
    return;
  }

  // Explicit `-n N` overrides the default. Non-positive values are
  // rejected upstream in cli.ts, so any `opts.limit` reaching here is
  // a positive integer.
  const effectiveLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const trimmed = filtered.slice(0, effectiveLimit);
  const truncated = filtered.length - trimmed.length;

  const lines = formatTable(
    trimmed.map(({ type, record }) => {
      const tags = record.tags.length === 0 ? "" : ` [${record.tags.join(",")}]`;
      return [type, record.slug, record.status, `${record.title}${tags}`];
    }),
  );
  for (const line of lines) print(line);

  // Only hint when the default cap (not an explicit `-n N`) clipped
  // the output. With an explicit limit the user asked for N — they
  // already know they're seeing a slice.
  if (opts.limit === undefined && truncated > 0) {
    print(
      `… ${truncated} more (use -n N to widen, or filter with --type/--tag)`,
    );
  }
}
