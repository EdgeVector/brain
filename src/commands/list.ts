// `fbrain list [--type T] [--status S] [--tag T] [-n N]` — newest-first list with filters.

import { newReadClientFromCfg, type NodeClient, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { printFieldProjection } from "../field-projection.ts";
import { formatTable, resolvePrintSinks } from "../format.ts";
import {
  hasAnyLiveRecord,
  findBySlug,
  isSchemaNotFoundReadError,
  isTombstoned,
  listRecordKeys,
  listRecords,
  missingSchemaHashReadNote,
  resolveTypeFilter,
  schemaHashFor,
  withReadRetry,
  type FbrainRecord,
  type RecordKey,
} from "../record.ts";
import { type RecordType } from "../schemas.ts";
import { resolveRecordsByTag } from "../tag-index.ts";

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
  // Skip the first N matches after filter+sort, before `limit` is
  // applied — the paging companion to `limit` (records N+1 … N+limit).
  // A non-negative integer when set; validated by the CLI. Applies to
  // the sorted, filtered set, so `--offset 50 -n 50` yields records
  // 51–100 in the same newest-first order a bare list would show.
  offset?: number;
  // Lower-bound filter on `updated_at`: keep only records whose
  // updated_at is >= this instant. Parsed by the CLI (ISO-8601 or a
  // relative token like `7d`/`24h`) into epoch-millis so this module
  // stays clock-free and testable. Applied alongside the status/tag
  // filters, BEFORE sort/offset/limit.
  updatedSinceMs?: number;
  // Count-only mode. When true, emit just the number of records that
  // match the filters (updated-since/status/tag) — no bodies, no
  // per-row summaries. `offset`/`limit` do NOT clip a count (a count is
  // of the whole matching set); the truncation/paging window only shapes
  // the row output. Keeps token/wire cost flat for "how many …" queries.
  count?: boolean;
  fields?: readonly string[];
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
  // Structured-result sink. When set, receives the SAME payload that
  // `--json` mode serializes to stdout — one source of truth for both the
  // JSON CLI surface and the MCP `structuredContent`. Fires once per call
  // regardless of the `json` flag, so the MCP handler can run the command
  // in human mode for `content` text AND capture the typed payload without
  // re-parsing the printed line. In row mode the payload is the array of
  // `RecordSummary` (`[]` on no records); in `count` mode it is a
  // `{ count: number }` object.
  onResult?: (payload: ListResult) => void;
  // Structured advisory sink for read-degraded configs. The human/CLI surface
  // still receives the existing note via printErr; MCP uses this to expose
  // skipped record types in structuredContent.
  onSkippedTypes?: (skipped: readonly RecordType[]) => void;
};

// The single-sourced result of a `listCmd` invocation, handed to both the
// `--json` stdout serializer and the MCP `onResult` sink. Row mode returns the
// same summary array the CLI has always emitted; `--count` mode returns the
// match count only.
export type ListResult = RecordSummary[] | { count: number };

export type ListEntry = { type: RecordType; record: FbrainRecord };

export async function listCmd(opts: ListOptions): Promise<void> {
  const { print, printErr } = resolvePrintSinks(opts);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

  // `--count` fast path: a count never renders a row, so it never needs
  // title/body — only slug + tombstone + updated_at to filter, exactly what
  // `listRecordKeys` projects (vs. `listRecords`' full-field fetch). Kept to
  // `--status`/`--tag`-less counts: `--status` needs a field the key
  // projection doesn't carry, and `--tag` already has its own index-first
  // path in `resolveListEntries`. This is what stops `fbrain list --count`
  // from paying for a full-corpus body drain just to answer "how many".
  if (opts.count && opts.status === undefined && !opts.tag) {
    const keyEntries = await resolveListKeyEntries(node, opts);
    const count = keyEntries.filter(({ key }) =>
      matchesListKeyFilters(key, opts),
    ).length;
    opts.onResult?.({ count });
    if (opts.json) {
      print(JSON.stringify({ count }));
    } else {
      print(String(count));
    }
    return;
  }

  // Body-less sweep: for the common --tag-less path this is a KEYS-ONLY
  // listing (title/body are never fetched for the whole type — the fix this
  // card lands); for --tag it's the tag-index sweep, already point-get-
  // bounded by tag cardinality rather than corpus size, so a hydrated
  // record is available immediately and is cached in `hydratedByKey` for
  // reuse at hydrate time below (no re-fetch of a body we already have).
  const hydratedByKey = new Map<string, FbrainRecord>();
  let light: RecordKey[];

  if (opts.tag) {
    const sweep = () => resolveListEntries(node, opts);
    // The dogfood read-flake repro (2026-05-26): a status write lands, but
    // the immediately-following filtered list returns empty for ~1s. Retry
    // the sweep — --tag always retries (mirrors the pre-existing contract).
    // See withReadRetry in ../record.ts.
    const all = await withReadRetry(sweep, (acc) =>
      acc.some(({ record }) => !isTombstoned(record)),
    );
    light = all.map(({ type, record }) => {
      hydratedByKey.set(recordKeyId(type, record.slug), record);
      return {
        type,
        slug: record.slug,
        status: record.status,
        tags: record.tags,
        updatedAt: record.updated_at,
      };
    });
  } else {
    const sweep = () => resolveListKeyEntries(node, opts);
    // Retry only when --status is present — without it, empty is a
    // legitimate signal and burning the budget every invocation slows down
    // genuinely-empty lists. The isHit predicate fires when the sweep sees
    // any (already tombstone-filtered) key; the user filter is applied
    // after, so a sweep that surfaces a key that doesn't match the filter
    // still stops retrying (we're riding out the empty-sweep flake, not
    // searching for a matching row).
    const wantsRetry = opts.status !== undefined;
    const keyEntries = wantsRetry
      ? await withReadRetry(sweep, (acc) => acc.length > 0)
      : await sweep();
    light = keyEntries.map(({ type, key }) => ({
      type,
      slug: key.slug,
      status: key.status,
      tags: key.tags,
      updatedAt: key.updatedAt,
    }));
  }

  const filtered = light.filter((key) => matchesListKeyFilters(key, opts));

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
  filtered.sort(compareRecordKeysByUpdatedThenSlug);

  // `--count` short-circuit: emit only how many records match the
  // filters, before the row-shaping (offset/limit) and the empty-node
  // hint path. A count is of the WHOLE matching set — `offset`/`limit`
  // shape row output, not a count — so it reports `filtered.length`
  // regardless of those flags. Count 0 prints a bare `0` (or `{count: 0}`
  // JSON), never the create-your-first hint: a caller asking "how many
  // match" wants a number, not new-dev guidance. This keeps token/wire
  // cost flat for "how many open papercuts" style queries.
  if (opts.count) {
    const count = filtered.length;
    opts.onResult?.({ count });
    if (opts.json) {
      print(JSON.stringify({ count }));
    } else {
      print(String(count));
    }
    return;
  }

  // Genuinely-empty result wins over the truncation path — print
  // `no records` even when the implicit default cap would have taken
  // effect. (Iron: the cap is a UX guard against floods, not a signal.)
  if (filtered.length === 0) {
    opts.onResult?.([]);
    if (opts.fields !== undefined && opts.fields.length > 0) return;
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
      opts.type !== undefined ||
      opts.status !== undefined ||
      opts.tag !== undefined ||
      opts.updatedSinceMs !== undefined;
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

  // Paging window: drop the first `--offset` rows, then apply the limit.
  // Offset is a non-negative integer (validated upstream in cli.ts); it
  // slices the sorted, filtered set, so `--offset 50 -n 50` yields records
  // 51–100 in the same newest-first order. A huge offset simply produces
  // `paged.length === 0` and the row loop prints nothing (the empty-brain
  // hint path is not re-entered — that only guards a genuinely empty match
  // set, which already returned above).
  const offset = opts.offset ?? 0;
  const paged = offset > 0 ? filtered.slice(offset) : filtered;

  // Explicit `-n N` overrides the default. Non-positive values are
  // rejected upstream in cli.ts, so any `opts.limit` reaching here is
  // a positive integer.
  const effectiveLimit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const trimmed = paged.slice(0, effectiveLimit);
  // Rows remaining AFTER this offset+limit window — what a follow-up page
  // (advance `--offset` by `effectiveLimit`) would surface. Measured from
  // the post-offset `paged` set so the "K more" hint counts only rows the
  // caller hasn't seen yet, not rows already skipped by `--offset`.
  const truncated = paged.length - trimmed.length;
  if (trimmed.length === 0) {
    opts.onResult?.([]);
    if (opts.fields !== undefined && opts.fields.length > 0) return;
    const note = `offset ${offset} is past the ${filtered.length} matching record(s)`;
    if (opts.json) {
      print("[]");
      printErr(`note:  ${note}`);
    } else {
      print("no records");
      print(`hint:  ${note}`);
    }
    return;
  }

  // Hydrate ONLY the final page — a point-get per entry not already fetched
  // by the --tag sweep. This is the crux of the fix: no matter how large the
  // corpus, a bounded `-n N` (or the default cap) pays for at most N body
  // fetches, never one full-type body fetch regardless of page size. A null
  // point-get means the record was deleted between the sweep and this fetch
  // (a stale race, not an error) — skip it, same as any other stale hit.
  const hydrated: ListEntry[] = (
    await Promise.all(
      trimmed.map(async (e): Promise<ListEntry | null> => {
        const cached = hydratedByKey.get(recordKeyId(e.type, e.slug));
        if (cached) return { type: e.type, record: cached };
        const record = await findBySlug(
          node,
          e.type,
          schemaHashFor(e.type, opts.cfg),
          e.slug,
        );
        return record ? { type: e.type, record } : null;
      }),
    )
  ).filter((e): e is ListEntry => e !== null);

  // One JSON document — exact same field set the human table surfaces,
  // plus created_at/updated_at and the optional design_slug parent link.
  // Body intentionally omitted to keep list payloads compact; consumers
  // can `fbrain get <slug> --json` for the full record.
  //
  // Built unconditionally (not just under --json) so the `onResult`
  // structured sink and the `--json` stdout document are the SAME value
  // — the MCP `structuredContent` can't drift from the CLI JSON shape.
  const payload = hydrated.map(({ type, record }) => recordSummary(type, record));
  opts.onResult?.(payload);

  if (opts.fields !== undefined && opts.fields.length > 0) {
    printFieldProjection(payload, opts.fields, print);
    return;
  }

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
    hydrated.map(({ type, record }) => {
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

export async function resolveListEntries(
  node: NodeClient,
  opts: Pick<ListOptions, "cfg" | "type" | "tag" | "printErr" | "onSkippedTypes">,
): Promise<ListEntry[]> {
  const { activeTypes: types } = resolveTypeFilter(
    opts.type ? [opts.type] : undefined,
    opts.cfg,
    (skipped) => {
      opts.onSkippedTypes?.(skipped);
      opts.printErr?.(missingSchemaHashReadNote(skipped, "listing the rest"));
    },
  );
  if (opts.tag) {
    const indexed = await resolveRecordsByTag(node, opts.cfg, opts.tag, {
      findBySlug: (type, hash, slug) =>
        findBySlug(node, type, hash, slug),
      schemaHashFor: (type) => schemaHashFor(type, opts.cfg),
    });
    if (indexed !== null) {
      return indexed
        .filter((entry) => types.includes(entry.type));
    }
  }

  const acc: ListEntry[] = [];
  for (const t of types) {
    let rs: FbrainRecord[];
    try {
      rs = await listRecords(node, t, schemaHashFor(t, opts.cfg), opts.cfg);
    } catch (err) {
      if (isSchemaNotFoundReadError(err)) {
        opts.onSkippedTypes?.([t]);
        opts.printErr?.(missingSchemaHashReadNote([t], "listing the rest"));
        continue;
      }
      throw err;
    }
    for (const r of rs) acc.push({ type: t, record: r });
  }
  return acc;
}

export function matchesListFilters(
  record: FbrainRecord,
  opts: Pick<ListOptions, "status" | "tag" | "updatedSinceMs">,
): boolean {
  if (isTombstoned(record)) return false;
  if (opts.status && record.status !== opts.status) return false;
  if (opts.tag && !record.tags.includes(opts.tag)) return false;
  if (
    opts.updatedSinceMs !== undefined &&
    !(Date.parse(record.updated_at) >= opts.updatedSinceMs)
  ) {
    return false;
  }
  return true;
}

// Key-only counterpart to `resolveListEntries`, for the `--count` fast path
// in `listCmd`. Fetches slug + tombstone + updated_at per candidate
// type via `listRecordKeys` (a skinny `/api/query` projection, no
// title/body) instead of `listRecords`' full-field fetch — the fix for the
// default `fbrain list` full-corpus body drain. Tombstones are already
// dropped by `listRecordKeys`, mirroring `resolveListEntries`'s reliance on
// `matchesListFilters`' `isTombstoned` check.
export async function resolveListKeyEntries(
  node: NodeClient,
  opts: Pick<ListOptions, "cfg" | "type" | "printErr" | "onSkippedTypes">,
): Promise<Array<{ type: RecordType; key: RecordKey }>> {
  const { activeTypes: types } = resolveTypeFilter(
    opts.type ? [opts.type] : undefined,
    opts.cfg,
    (skipped) => {
      opts.onSkippedTypes?.(skipped);
      opts.printErr?.(missingSchemaHashReadNote(skipped, "listing the rest"));
    },
  );

  const acc: Array<{ type: RecordType; key: RecordKey }> = [];
  for (const t of types) {
    let keys: RecordKey[];
    try {
      keys = await listRecordKeys(node, t, schemaHashFor(t, opts.cfg), opts.cfg);
    } catch (err) {
      if (isSchemaNotFoundReadError(err)) {
        opts.onSkippedTypes?.([t]);
        opts.printErr?.(missingSchemaHashReadNote([t], "listing the rest"));
        continue;
      }
      throw err;
    }
    for (const k of keys) acc.push({ type: t, key: k });
  }
  return acc;
}

// Key-based counterpart to `matchesListFilters` — same status/tag/
// updatedSinceMs semantics, minus the `isTombstoned` check (tombstones are
// already dropped by `listRecordKeys`). Used by both the `--count` fast path
// (status/tag always undefined there) and the default row-listing sweep
// (any combination), now that `RecordKey` carries status/tags alongside
// updatedAt — no body fetch is needed to answer either filter.
export function matchesListKeyFilters(
  key: RecordKey,
  opts: Pick<ListOptions, "status" | "tag" | "updatedSinceMs">,
): boolean {
  if (opts.status && key.status !== opts.status) return false;
  if (opts.tag && !key.tags.includes(opts.tag)) return false;
  if (
    opts.updatedSinceMs !== undefined &&
    !(Date.parse(key.updatedAt) >= opts.updatedSinceMs)
  ) {
    return false;
  }
  return true;
}

// Stable identity for the hydration cache (`hydratedByKey` in `listCmd`) —
// (type, slug) is globally unique, matching the sort tie-break below.
function recordKeyId(type: RecordType, slug: string): string {
  return `${type}::${slug}`;
}

// Same (updated_at desc, then type asc, then slug asc) ordering the old
// record-based sort used, now over `RecordKey` so `listCmd` can sort before
// ever fetching a body. Shares its (updated_at desc, slug asc) edges with
// `compareByUpdatedThenSlug`; the type tie-break is unique to `list` (a
// global sweep across types) so it's injected first here.
export function compareRecordKeysByUpdatedThenSlug(
  a: RecordKey,
  b: RecordKey,
): number {
  if (a.type !== b.type) {
    const d = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (d !== 0) return d;
    return a.type < b.type ? -1 : 1;
  }
  const ts = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return ts !== 0 ? ts : a.slug.localeCompare(b.slug);
}
