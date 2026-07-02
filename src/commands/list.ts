// `fbrain list [--type T] [--status S] [--tag T] [-n N]` — newest-first list with filters.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { formatTable, resolvePrintSinks } from "../format.ts";
import {
  compareByUpdatedThenSlug,
  findBySlugPointRead,
  hasAnyLiveRecord,
  isTombstoned,
  listRecords,
  schemaHashFor,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";
import { resolveRecordsByTag, tagIndexAvailable } from "../tag-index.ts";

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
  // Machine-readable mode. Emits a single JSON array document via
  // `print` (one call) and routes any advisory "K more" hint to
  // `printErr` so stdout remains pure JSON parseable by `jq`.
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  // Agent-channel signal. Set by the MCP `fbrain_list` wrapper (NOT the human
  // CLI). When true, the empty/filter-no-match recovery hint is rendered in
  // MCP-tool terms (`fbrain_put` / `fbrain_list`) instead of the CLI verbs the
  // agent has no tools for (`fbrain <type> new`, `fbrain list`). Mirrors
  // `FbrainError.agentHint` for the ERROR path. Default (undefined) keeps the
  // human CLI output byte-identical.
  agent?: boolean;
  // Structured-result sink. When set, receives the SAME array of
  // `RecordSummary` objects that `--json` mode serializes to stdout —
  // one source of truth for both the JSON CLI surface and the MCP
  // `structuredContent`. Fires once per call (with `[]` on no records)
  // regardless of the `json` flag, so the MCP handler can run the
  // command in human mode for `content` text AND capture the typed
  // payload without re-parsing the printed line.
  onResult?: (payload: RecordSummary[]) => void;
};

export async function listCmd(opts: ListOptions): Promise<void> {
  const { print, printErr } = resolvePrintSinks(opts);
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

  // Tag-filtered fast path: resolve the tag's members THROUGH the secondary
  // index so cost scales with the tag's cardinality, not the size of the
  // scanned type(s) (see src/tag-index.ts + papercut-fbrain-tag-query-no-index).
  // `resolveRecordsByTag` returns the LIVE records carrying the tag (each
  // re-checked, so a stale index entry is dropped), or null on an index MISS —
  // in which case we fall through to the legacy scan below, so correctness never
  // depends on the index being present or current. `--type`/`--status` are
  // applied on top of the index hit exactly as they are on the scan.
  let all: Array<{ type: RecordType; record: FbrainRecord }> | null = null;
  if (opts.tag !== undefined && tagIndexAvailable(opts.cfg)) {
    const viaIndex = await resolveRecordsByTag(node, opts.cfg, opts.tag, {
      findBySlug: (t, hash, slug) => findBySlugPointRead(node, t, hash, slug),
      schemaHashFor: (t) => schemaHashFor(t, opts.cfg),
    });
    if (viaIndex !== null) {
      all = opts.type ? viaIndex.filter(({ type }) => type === opts.type) : viaIndex;
    }
  }

  // Legacy scan path — used when there's no tag filter, or on an index miss.
  // The dogfood read-flake repro (2026-05-26): a status write lands, but
  // the immediately-following filtered list returns empty for ~1s. Retry
  // the sweep only when --status/--tag are present — without them, empty
  // is a legitimate signal and burning the budget every invocation slows
  // down genuinely-empty lists. The isHit predicate fires when the sweep
  // sees any non-tombstoned row; the user filter is applied after, so a
  // sweep that surfaces a row but the row doesn't match the filter still
  // stops retrying (we're riding out the empty-sweep flake, not searching
  // for a matching row). See withReadRetry in ../record.ts.
  if (all === null) {
    const wantsRetry = opts.status !== undefined || opts.tag !== undefined;
    all = wantsRetry
      ? await withReadRetry(sweep, (acc) =>
          acc.some(({ record }) => !isTombstoned(record)),
        )
      : await sweep();
  }

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
  //
  // The (updated_at desc, slug asc) edges are shared with `fbrain get`'s
  // child-task sort and live in `compareByUpdatedThenSlug`; the type
  // tie-break is unique to `list` (get only ever sorts a single type) so
  // it's injected between the date and slug edges here.
  filtered.sort((a, b) => {
    if (a.type !== b.type) {
      const d =
        Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at);
      if (d !== 0) return d;
      return a.type < b.type ? -1 : 1;
    }
    return compareByUpdatedThenSlug(a.record, b.record);
  });

  // Genuinely-empty result wins over the truncation path — print
  // `no records` even when the implicit default cap would have taken
  // effect. (Iron: the cap is a UX guard against floods, not a signal.)
  if (filtered.length === 0) {
    opts.onResult?.([]);
    // Context-aware no-result hint, completing the empty-node-hint trilogy
    // (list/search/ask). `list` is step 2 of init's own Next-steps — the
    // FIRST content command a brand-new dev runs — so a bare `no records`
    // dead-ends them. Probe whether the brain holds ANY live record (a cheap
    // extra round-trip, paid only on the no-result path, like search/ask) and:
    //   - genuinely-empty brain → the same calm "create your first record"
    //     guidance search (#276) / ask (#279) already give the new dev.
    //   - records exist but a --type/--status/--tag filter matched none → a
    //     filter-specific nudge instead; "create your first" would be wrong
    //     (mirrors search.ts's "populated brain that matched nothing keeps a
    //     different hint" split).
    // `!filteredQuery && non-empty` is impossible (no filter on a non-empty
    // brain can't yield zero), so it falls through to the empty-brain hint.
    const filteredQuery =
      opts.type !== undefined || opts.status !== undefined || opts.tag !== undefined;
    const empty = !(await hasAnyLiveRecord(node, opts.cfg));
    // Filter hint only when a filter is active AND the brain has records;
    // every other shape (empty brain; or the impossible no-filter-yet-zero
    // case) falls through to the new-dev create-your-first guidance.
    // On the MCP agent channel the hint must name TOOLS the agent can call:
    // its create tool is `fbrain_put` (not `fbrain <type> new`) and re-listing
    // unfiltered is the `fbrain_list` tool (not the `fbrain list` CLI verb).
    // Render the agent-voiced variant only when `opts.agent` is set; the human
    // CLI path is unchanged.
    const hint = opts.agent
      ? !empty && filteredQuery
        ? "hint:  no records match that filter — call `fbrain_list` with no type/status/tag filter"
        : "hint:  no records yet — create your first with the `fbrain_put` tool, then try again"
      : !empty && filteredQuery
        ? "hint:  no records match that filter — try `fbrain list` with no --type/--status/--tag"
        : "hint:  no records yet — create your first with `fbrain <type> new <slug>` (design/concept/project/…), then list again";
    if (opts.json) {
      // Stdout stays the parseable empty array `[]` so jq pipelines see a
      // clean empty array, never the hint text; the hint goes to stderr.
      print("[]");
      printErr(hint);
    } else {
      print("no records");
      print(hint);
    }
    return;
  }

  // Explicit `-n N` overrides the default. Non-positive values are
  // rejected upstream in cli.ts, so any `opts.limit` reaching here is
  // a positive integer.
  const effectiveLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const trimmed = filtered.slice(0, effectiveLimit);
  const truncated = filtered.length - trimmed.length;

  // One JSON document — exact same field set the human table surfaces,
  // plus created_at/updated_at and the optional design_slug parent link.
  // Body intentionally omitted to keep list payloads compact; consumers
  // can `fbrain get <slug> --json` for the full record.
  //
  // Built unconditionally (not just under --json) so the `onResult`
  // structured sink and the `--json` stdout document are the SAME value
  // — the MCP `structuredContent` can't drift from the CLI JSON shape.
  const payload = trimmed.map(({ type, record }) => recordSummary(type, record));
  opts.onResult?.(payload);

  if (opts.json) {
    print(JSON.stringify(payload));
    // Truncation advisory still useful for `jq` users — they may
    // wonder why the array is shorter than expected — but it must
    // never appear on stdout under --json. Route to stderr instead.
    if (opts.limit === undefined && truncated > 0) {
      printErr(
        `note:  ${truncated} more (use -n N to widen, or filter with --type/--tag)`,
      );
    }
    return;
  }

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

export type RecordSummary = {
  type: RecordType;
  slug: string;
  title: string;
  status: string;
  tags: string[];
  design_slug?: string;
  created_at: string;
  updated_at: string;
};

function recordSummary(type: RecordType, r: FbrainRecord): RecordSummary {
  const out: RecordSummary = {
    type,
    slug: r.slug,
    title: r.title,
    status: r.status,
    tags: r.tags,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (r.design_slug !== undefined) out.design_slug = r.design_slug;
  return out;
}
