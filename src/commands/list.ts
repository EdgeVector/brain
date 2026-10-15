// `fbrain list [--type T] [--status S] [--tag T] [-n N]` — newest-first list with filters.

import {
  FbrainError,
  newReadClientFromCfg,
  type NodeClient,
  type Verbose,
} from "../client.ts";
import type { Config } from "../config.ts";
import { printFieldProjection } from "../field-projection.ts";
import { formatTable, resolvePrintSinks } from "../format.ts";
import { HEAD_RANGE } from "../list-page.ts";
import {
  completeKeyTags,
  findBySlug,
  isSchemaNotFoundReadError,
  isTombstoned,
  listRecordKeys,
  listRecords,
  missingSchemaHashReadNote,
  resolveTypeFilter,
  schemaHashFor,
  type FbrainRecord,
  type RecordKey,
} from "../record.ts";
import {
  BRAIN_LIST_COUNT_SCHEMA_KEY,
  BRAIN_LIST_PAGE_SCHEMA_KEY,
  isRecordType,
  type RecordType,
} from "../schemas.ts";
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
  // Optional explicit cap. When omitted, `listCmd` shows
  // DEFAULT_LIST_LIMIT cards from the one page. A positive integer.
  // Values above LIST_LIMIT_CAP are cut to that cap.
  limit?: number;
  // Page id. Default `__head__`. `p` plus eight digits names one older page.
  page?: string;
  // Keep cards on this page whose updated_at is at or after this instant.
  // Does not read the older page.
  updatedSinceMs?: number;
  // Read BrainListCount for `all` or `--type`. Not a page read.
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
// `--json` stdout serializer and the MCP `onResult` sink.
//
// Row mode is an honesty envelope (`items`/`total`/`truncated`), not a bare
// array: `brain list` is a sample, never a census (Tom 2026-08-06). Callers
// that need completeness-dependent sweeps must use search / point reads.
// `--count` mode still returns the match count only.
export type ListPageResult = {
  items: RecordSummary[];
  /** Cards on this page after the page filter, before the limit. */
  total: number;
  /**
   * True when the print cut the page, the atom names an older page, or the
   * page atom is absent. Not a census.
   */
  truncated: boolean;
};
export type ListResult = ListPageResult | { count: number } | { miss: true };

export type ListEntry = { type: RecordType; record: FbrainRecord };

const LIST_LIMIT_CAP = 100;
const PAGE_ID = /^p\d{8}$/;

type PageCard = {
  type?: string;
  slug: string;
  status: string;
  updatedAt: string;
  title: string;
};

type PageAtom = { cards: PageCard[]; older: string };

function listRange(page: string | undefined): string {
  if (page === undefined || page.length === 0) return HEAD_RANGE;
  if (page === HEAD_RANGE || PAGE_ID.test(page)) return page;
  throw new FbrainError({
    code: "invalid_page",
    message: `page id ${page} is not a list page id`,
    hint: "Use __head__ or a page id of p plus eight digits.",
  });
}

function listHash(opts: Pick<ListOptions, "type" | "status" | "tag">): string {
  if (opts.tag && opts.tag.length > 0) return `tag#${opts.tag}`;
  if (opts.status && opts.status.length > 0) {
    if (!opts.type) {
      throw new FbrainError({
        code: "status_needs_type",
        message: "a status list needs --type",
        hint: "Pass --type with --status.",
      });
    }
    return `${opts.type}#${opts.status}`;
  }
  return opts.type ?? "all";
}

function backfillLine(hash: string, type: RecordType | undefined): string {
  const source = type ?? "<type>";
  return `brain reindex --target ${hash} --source-hash ${source} --slug <slug>`;
}

function textField(
  row: { fields: Record<string, unknown> } | null | undefined,
  name: string,
): string | null {
  if (!row) return null;
  const value = row.fields[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsePageAtom(raw: string): PageAtom | null {
  try {
    const value = JSON.parse(raw) as { cards?: unknown; older?: unknown };
    if (!value || typeof value !== "object") return null;
    const cards: PageCard[] = [];
    if (Array.isArray(value.cards)) {
      for (const item of value.cards) {
        if (!item || typeof item !== "object") continue;
        const card = item as Record<string, unknown>;
        if (typeof card.slug !== "string" || card.slug.length === 0) continue;
        const named = typeof card.type === "string" ? card.type : undefined;
        cards.push({
          ...(named !== undefined ? { type: named } : {}),
          slug: card.slug,
          status: typeof card.status === "string" ? card.status : "",
          updatedAt: typeof card.updated_at === "string" ? card.updated_at : "",
          title: typeof card.title === "string" ? card.title : "",
        });
      }
    }
    return {
      cards,
      older: typeof value.older === "string" ? value.older : "",
    };
  } catch {
    return null;
  }
}

function cardType(card: PageCard, fallback: RecordType | undefined): RecordType | null {
  if (card.type && isRecordType(card.type)) return card.type;
  return fallback ?? null;
}

function atOrAfter(updatedAt: string, since: number | undefined): boolean {
  if (since === undefined) return true;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) && parsed >= since;
}

function keepCard(
  card: PageCard,
  opts: Pick<ListOptions, "type" | "status" | "updatedSinceMs">,
): RecordType | null {
  const type = cardType(card, opts.type);
  if (!type) return null;
  if (opts.type && type !== opts.type) return null;
  if (opts.status && card.status !== opts.status) return null;
  if (!atOrAfter(card.updatedAt, opts.updatedSinceMs)) return null;
  return type;
}

function cardSummary(type: RecordType, card: PageCard): RecordSummary {
  return {
    type,
    slug: card.slug,
    title: card.title,
    status: card.status,
    tags: [],
    created_at: "",
    updated_at: card.updatedAt,
  };
}

function emitLines(
  opts: Pick<ListOptions, "json" | "fields">,
  print: (line: string) => void,
  printErr: (line: string) => void,
  lines: readonly string[],
  jsonBody: string | null,
): void {
  const advisory =
    opts.json === true || (opts.fields !== undefined && opts.fields.length > 0);
  if (jsonBody !== null && opts.json === true) print(jsonBody);
  for (const line of lines) {
    if (advisory) printErr(line);
    else print(line);
  }
}

export async function listCmd(opts: ListOptions): Promise<void> {
  const { print, printErr } = resolvePrintSinks(opts);
  if (opts.count) {
    await printListCount(opts, print, printErr);
    return;
  }
  await printListPage(opts, print, printErr);
}

async function printListCount(
  opts: ListOptions,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<void> {
  if (opts.updatedSinceMs !== undefined) {
    opts.onResult?.({ miss: true });
    emitLines(
      opts,
      print,
      printErr,
      ["miss", "the counter is the whole list, not a time window"],
      JSON.stringify({ miss: true }),
    );
    return;
  }
  if ((opts.status && opts.status.length > 0) || (opts.tag && opts.tag.length > 0)) {
    opts.onResult?.({ miss: true });
    emitLines(
      opts,
      print,
      printErr,
      ["miss", "a status count and a tag count have no counter"],
      JSON.stringify({ miss: true }),
    );
    return;
  }
  const hash = opts.type ?? "all";
  const schemaHash = opts.cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY] ?? "";
  if (schemaHash.length === 0) {
    missCount(opts, print, printErr, hash);
    return;
  }
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const raw = await readCountAtom(node, schemaHash, hash);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    missCount(opts, print, printErr, hash);
    return;
  }
  const count = Number(raw);
  opts.onResult?.({ count });
  if (opts.json) {
    print(JSON.stringify({ count }));
    printErr("counter");
    return;
  }
  print(`${count} counter`);
}

function missCount(
  opts: ListOptions,
  print: (line: string) => void,
  printErr: (line: string) => void,
  hash: string,
): void {
  opts.onResult?.({ miss: true });
  emitLines(
    opts,
    print,
    printErr,
    ["miss", "index record absent", backfillLine(hash, opts.type)],
    JSON.stringify({ miss: true }),
  );
}

async function readCountAtom(
  node: NodeClient,
  schemaHash: string,
  hash: string,
): Promise<string | null> {
  if (node.queryByKey) {
    const row = await node.queryByKey({
      schemaHash,
      fields: ["bln_n"],
      keyHash: hash,
    });
    return textField(row, "bln_n");
  }
  const res = await node.queryAll({
    schemaHash,
    fields: ["bln_n"],
    filter: { HashKey: hash },
  });
  return textField(res.results[0], "bln_n");
}

async function printListPage(
  opts: ListOptions,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<void> {
  const hash = listHash(opts);
  const range = listRange(opts.page);
  const schemaHash = opts.cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
  if (schemaHash.length === 0) {
    emitAbsent(opts, print, printErr, hash);
    return;
  }
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const res = await node.queryAll({
    schemaHash,
    fields: ["blp_page"],
    filter: { HashRangeKey: { hash, range } },
  });
  const raw = textField(res.results[0], "blp_page");
  if (raw === null) {
    emitAbsent(opts, print, printErr, hash);
    return;
  }
  const page = parsePageAtom(raw);
  if (!page) {
    const partial: ListPageResult = { items: [], total: 0, truncated: true };
    opts.onResult?.(partial);
    emitLines(
      opts,
      print,
      printErr,
      ["sample", "index partial"],
      opts.json ? JSON.stringify(partial) : null,
    );
    return;
  }
  const cap =
    opts.limit === undefined ? DEFAULT_LIST_LIMIT : Math.min(opts.limit, LIST_LIMIT_CAP);
  const matched: Array<{ type: RecordType; card: PageCard }> = [];
  for (const card of page.cards) {
    const type = keepCard(card, opts);
    if (type) matched.push({ type, card });
  }
  const last = page.cards[page.cards.length - 1];
  const showOlder =
    page.older.length > 0 &&
    (opts.updatedSinceMs === undefined ||
      (last !== undefined && atOrAfter(last.updatedAt, opts.updatedSinceMs)));
  const shown = matched.slice(0, cap);
  const clipped = matched.length > shown.length;
  const items = shown.map(({ type, card }) => cardSummary(type, card));
  const pageResult: ListPageResult = {
    items,
    total: matched.length,
    truncated: clipped || showOlder,
  };
  opts.onResult?.(pageResult);
  const sample = showOlder ? `sample ${page.older}` : clipped ? "sample" : "";
  if (opts.fields !== undefined && opts.fields.length > 0) {
    printFieldProjection(items, opts.fields, print);
    if (sample.length > 0) printErr(sample);
    return;
  }
  if (opts.json) {
    print(JSON.stringify(pageResult));
    if (sample.length > 0) printErr(sample);
    return;
  }
  if (items.length === 0) print("no records");
  const lines = formatTable(
    shown.map(({ type, card }) => [type, card.slug, card.status, card.title]),
  );
  for (const line of lines) print(line);
  if (sample.length > 0) print(sample);
}

function emitAbsent(
  opts: ListOptions,
  print: (line: string) => void,
  printErr: (line: string) => void,
  hash: string,
): void {
  const pageResult: ListPageResult = { items: [], total: 0, truncated: true };
  opts.onResult?.(pageResult);
  emitLines(
    opts,
    print,
    printErr,
    ["sample", "index record absent", backfillLine(hash, opts.type)],
    opts.json ? JSON.stringify(pageResult) : null,
  );
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

export async function resolveListEntries(
  node: NodeClient,
  opts: Pick<
    ListOptions,
    "cfg" | "type" | "tag" | "printErr" | "onSkippedTypes"
  >,
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
        findBySlug(node, type, hash, slug, opts.cfg, { hydrate: false }),
      schemaHashFor: (type) => schemaHashFor(type, opts.cfg),
    });
    if (indexed !== null) {
      return indexed.filter((entry) => types.includes(entry.type));
    }
  }

  const acc: ListEntry[] = [];
  for (const t of types) {
    let rs: FbrainRecord[];
    try {
      // A display path: a stale list row with no record behind it is skipped
      // (one warning), the other rows are listed.
      rs = await listRecords(node, t, opts.cfg, { onMissing: "skip" });
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
  opts: Pick<
    ListOptions,
    "cfg" | "type" | "status" | "tag" | "printErr" | "onSkippedTypes"
  >,
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
    // The dedicated papercut ledger (and explicit `list --type papercut`)
    // must be status-keyed. A global multi-type list keeps its existing
    // per-type key walk so a newly deployed, not-yet-initialized internal
    // index cannot make every unrelated record type unreadable.
    if (t === "papercut" && opts.type === "papercut") {
      const { readPapercutsByStatus } = await import(
        "../papercut-status-index.ts"
      );
      const records = await readPapercutsByStatus(node, opts.cfg, opts.status);
      for (const record of records) {
        acc.push({
          type: t,
          key: {
            type: t,
            slug: record.slug,
            status: record.status,
            tags: record.tags,
            updatedAt: record.updated_at,
          },
        });
      }
      continue;
    }
    let keys: RecordKey[];
    try {
      keys = await listRecordKeys(
        node,
        t,
        schemaHashFor(t, opts.cfg),
        opts.cfg,
      );
    } catch (err) {
      if (isSchemaNotFoundReadError(err)) {
        opts.onSkippedTypes?.([t]);
        opts.printErr?.(missingSchemaHashReadNote([t], "listing the rest"));
        continue;
      }
      throw err;
    }
    // A `--tag` filter or count over keys needs each record's WHOLE tags, and a
    // keys-only list row keeps only a bounded subset. Complete those keys first
    // (one batched product read), so a count never excludes such a record.
    if (opts.tag) keys = await completeKeyTags(node, t, opts.cfg, keys);
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
  if (opts.tag) {
    if (key.tagsCut === true) {
      // Never answer from a bounded subset of the tags: that would undercount.
      throw new FbrainError({
        code: "list_tags_incomplete",
        message: `the list row of ${key.type} ${key.slug} keeps only part of its tags, so it cannot be matched against --tag ${opts.tag}.`,
        hint: "Complete the key first (completeKeyTags in record.ts); the list command does.",
      });
    }
    if (!key.tags.includes(opts.tag)) return false;
  }
  if (
    opts.updatedSinceMs !== undefined &&
    !(Date.parse(key.updatedAt) >= opts.updatedSinceMs)
  ) {
    return false;
  }
  return true;
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
