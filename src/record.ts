// Shared record helpers used by the design/task/put/get/list/status/link commands.

import type { NodeClient, QueryRow } from "./client.ts";
import { FbrainError } from "./client.ts";
import type { Config } from "./config.ts";
import {
  RECORDS,
  RECORD_TYPES,
  isValidStatus,
  statusValuesFor,
  type RecordType,
} from "./schemas.ts";



export type FbrainRecord = {
  slug: string;
  title: string;
  body: string;
  status: string;
  tags: string[];
  design_slug?: string;
  created_at: string;
  updated_at: string;
};

// Soft-delete sentinel — see docs/phase-5-delete-spike.md. fold_db is
// append-only, so `fbrain delete` overwrites the record's user fields and
// stamps this tag; every fbrain read path filters records carrying it.
export const TOMBSTONE_TAG = "__fbrain_deleted__";

export function isTombstoned(r: FbrainRecord): boolean {
  return r.tags.includes(TOMBSTONE_TAG);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fieldsFor(type: RecordType): string[] {
  return RECORDS[type].schema.schema.fields.slice();
}

export function schemaHashFor(
  type: RecordType,
  cfg: { schemaHashes: Record<string, string> },
): string {
  const hash = cfg.schemaHashes[type];
  if (!hash || hash.length === 0) {
    throw new FbrainError({
      code: "missing_schema_hash",
      message: `No canonical hash registered for type "${type}" in config.`,
      hint: "Re-run `fbrain init` so the config picks up all 8 schema hashes.",
    });
  }
  return hash;
}

// Deduped list of canonical schema hashes for the given record types. Used
// by `search` and `ask` to scope native-index queries to fbrain's schemas
// (the `schemas` filter on /api/native-index/search). Phase 6 types
// concept/preference/reference/agent/project/spike all map to the same
// unified MEMO schema, so the per-type lookups return the same hash six
// times — the Set collapses them so the URL stays compact and the verbose
// count is meaningful ("N unique schemas" vs N record types). Missing or
// empty entries are filtered out so a partially-initialised config doesn't
// inject an empty filter element.
export function uniqueSchemaHashes(
  cfg: { schemaHashes: Record<string, string> },
  types: readonly RecordType[],
): string[] {
  return Array.from(
    new Set(
      types
        .map((t) => cfg.schemaHashes[t])
        .filter((h): h is string => typeof h === "string" && h.length > 0),
    ),
  );
}

export function rowToRecord(row: QueryRow, type: RecordType): FbrainRecord {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  const base: FbrainRecord = {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    status: stringField(f, "status"),
    tags: arrayStringField(f, "tags"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
  };
  if (RECORDS[type].hasDesignSlug) base.design_slug = stringField(f, "design_slug");
  return base;
}

function stringField(f: Record<string, unknown>, key: string): string {
  const v = f[key];
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function arrayStringField(f: Record<string, unknown>, key: string): string[] {
  const v = f[key];
  // Mirror put.ts's inline-list parser (`.filter(s => s.length > 0)`): the
  // write path treats empty strings as non-tags, so the read path must too —
  // otherwise a phantom empty tag from the server (legacy data, the block-list
  // parser's unfiltered branch, or a non-fbrain client) surfaces as a stray
  // `,` separator in `fbrain get` / `fbrain list`, inflates `r.tags.length`,
  // and — worst — propagates back to the server on the next `put` / `link`
  // / `migrate`, since those write paths preserve `existing.tags` verbatim
  // (`put.ts:buildFields` `tags: tags ?? existing?.tags ?? []`).
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (typeof v === "string" && v.length > 0) {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

export async function listRecords(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
): Promise<FbrainRecord[]> {
  const res = await node.queryAll({ schemaHash, fields: fieldsFor(type) });
  return res.results.map((row) => rowToRecord(row, type));
}

export async function findBySlug(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
): Promise<FbrainRecord | null> {
  const r = await findBySlugRaw(node, type, schemaHash, slug);
  if (r === null) return null;
  return isTombstoned(r) ? null : r;
}

// Unfiltered variant — returns tombstoned records too. Only `fbrain delete`
// needs this (to verify its own soft-delete landed). All other read paths
// MUST use `findBySlug` so they treat tombstones as gone.
export async function findBySlugRaw(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
): Promise<FbrainRecord | null> {
  const list = await listRecords(node, type, schemaHash);
  return list.find((r) => r.slug === slug) ?? null;
}

// Read-flake retry — docs/phase-7-search-latency-spike.md (H2 polluted-daemon
// case). The same /api/query intermittently returns 0 results on a daemon
// whose top-50 budget is saturated by phantom embeddings + orphan schemas:
// `fbrain put` lands and `fbrain search` returns the row, but `fbrain get`
// flakes ~1/5 of the time. scripts/parity-smoketest.sh rides this out by
// retrying each `fbrain get` 5× at 250 ms; the user-facing CLI now does the
// same so users don't see "No record" for a row they just wrote.
//
// 5 × 250 ms is the smoketest's empirical setting — adjust together, not
// independently, if the upstream G3d/G3e fix changes the flake rate.
export const READ_RETRY_ATTEMPTS = 5;
export const READ_RETRY_BACKOFF_MS = 250;

export type ReadRetryOptions = {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

// Pure schedule: how long to wait *before* attempt N (1-based). Constant
// `ceilingMs` today — first attempt skips the wait, subsequent attempts pause
// for the ceiling. Splitting this out lets tests pin the schedule's contract
// (monotonic, capped) independently of the retry driver, and lets the schedule
// grow later (linear/exponential/jittered) without touching `withReadRetry`.
export function computeBackoffMs(
  attempt: number,
  ceilingMs: number = READ_RETRY_BACKOFF_MS,
): number {
  if (attempt <= 1) return 0;
  return ceilingMs;
}

// Re-run `fn` up to `maxAttempts` times, sleeping per `computeBackoffMs`
// between tries, until `isHit(result)` returns true. Returns the last result
// either way — callers handle the genuine-miss case (surfaces the existing
// "No record" error after the retry budget is spent, same UX as today on a
// real miss).
//
// The retry wraps the full per-type query loop, not each HTTP call: a hit
// in one type cancels further retries, and a real miss across all types
// retries the whole sweep. Mirrors what the smoketest does in bash.
export async function withReadRetry<T>(
  fn: () => Promise<T>,
  isHit: (result: T) => boolean,
  options?: ReadRetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? READ_RETRY_ATTEMPTS;
  const ceilingMs = options?.backoffMs ?? READ_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  let result!: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = computeBackoffMs(attempt, ceilingMs);
    if (wait > 0) await sleep(wait);
    result = await fn();
    if (isHit(result)) return result;
  }
  return result;
}

// Shared per-type lookup loop with fast-miss on a populated-but-missing page.
// Used by both the write existence check (`findExistingForWrite`) and the
// read sweep (`resolveBySlug`). See `findExistingForWrite` below for the
// motivating analysis — the same logic applies to `fbrain get` / `status` /
// `delete` of a typo'd slug, which otherwise burns the full 5×250 ms retry
// budget before surfacing "No record".
//
// Behavior: a NON-EMPTY page that lacks the slug is authoritative (server-side
// pagination is fixed; the only remaining read flake is empty-result on a
// saturated daemon), so return null immediately without retrying. Only an
// EMPTY page is ambiguous (flake vs. legitimately-empty schema) and spends
// the retry budget.
//
// The `raw` flag mirrors `findBySlug` vs `findBySlugRaw`. When false,
// tombstoned matches count as ABSENT (same as `findBySlug`) but still
// populate the page for the authoritative-miss test, so re-creating /
// re-fetching a soft-deleted slug short-circuits at one query and surfaces
// not-found fast. When true, a tombstoned match is returned (the caller —
// only `resolveBySlug` in `delete`'s raw path — applies its own
// tombstone-handling on top); this preserves the existing contract that
// `findBySlugRaw` does not strip tombstones at the lookup layer.
async function findBySlugWithFastMiss(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
  raw: boolean,
  options?: ReadRetryOptions,
): Promise<FbrainRecord | null> {
  const maxAttempts = options?.maxAttempts ?? READ_RETRY_ATTEMPTS;
  const ceilingMs = options?.backoffMs ?? READ_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = computeBackoffMs(attempt, ceilingMs);
    if (wait > 0) await sleep(wait);
    const list = await listRecords(node, type, schemaHash);
    const match = list.find((r) => r.slug === slug);
    if (match && (raw || !isTombstoned(match))) return match;
    // Populated page without our (live) slug ⇒ authoritative miss: stop early.
    if (list.length > 0) return null;
    // Empty page ⇒ ambiguous; loop to ride out the saturated-daemon flake.
  }
  return null;
}

// Existence check for the WRITE path (`fbrain put`, `<type> new`). The write
// must decide create-vs-update by asking "does this slug already exist?" — but
// unlike a read (`get`/`status`/`delete`), where the user asserts the row
// exists and a `withReadRetry(findBySlug, r => r !== null)` rides out the
// daemon's read flake before surfacing not-found, the write has no such
// assertion: a brand-new slug is *expected* to be absent. Wrapping the write's
// existence check in the same retry made the `r !== null` predicate unreachable
// for every new slug, so each create burned the FULL retry budget (~1.1s of
// pure backoff sleep) before falling through to `createRecord`. Measured
// 2026-06-05: create ~1200 ms vs. update ~95 ms, purely from this.
//
// `resolveBySlug` (read sweep) shares the same fix via the same helper —
// `fbrain get <typo>` had the symmetric problem (~1.1s before "No record")
// for the same reason. See `findBySlugWithFastMiss` above for the shared
// loop's contract. Tombstoned rows count as absent, mirroring `findBySlug`,
// so re-creating a soft-deleted slug still lands a fresh record.
export async function findExistingForWrite(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
  options?: ReadRetryOptions,
): Promise<FbrainRecord | null> {
  return findBySlugWithFastMiss(node, type, schemaHash, slug, false, options);
}

// Read-context alias for the same fast-miss helper. The dangling-reference /
// liveness validators in `new`, `link`, `get`, and `search` previously wrapped
// `findBySlug` in `withReadRetry(fn, r => r !== null)` to ride out the daemon's
// empty-result flake — but on a slug that genuinely does not exist (a typo'd
// `--design`, a stale search hit, a deleted parent), the `r !== null` predicate
// is unreachable and every miss burns the full 5×250 ms retry budget. The
// fast-miss loop short-circuits on a populated-but-missing page (authoritative
// miss) while still spending the budget on an empty page (saturated-daemon
// flake), so it is strictly better than the old pattern: same flake recovery,
// no wasted budget on a real miss, identical behavior on a hit. The `*ForWrite`
// name reads wrong in a validator, so this alias names the read-context
// callers — semantics are identical.
export async function findBySlugFast(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
  slug: string,
  options?: ReadRetryOptions,
): Promise<FbrainRecord | null> {
  return findBySlugWithFastMiss(node, type, schemaHash, slug, false, options);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ResolvedRecord = {
  type: RecordType;
  record: FbrainRecord;
};

export interface ResolveBySlugOpts {
  node: NodeClient;
  cfg: Config;
  slug: string;
  // Narrow the sweep to one type. Omit to scan every registered type.
  type?: RecordType;
  // Raw mode bypasses the tombstone filter at the lookup layer (findBySlugRaw)
  // so callers like `fbrain delete` can apply their own row-level logic. The
  // helper still drops tombstones afterward — there is no current caller that
  // wants to see them. Default false (uses tombstone-aware findBySlug).
  raw?: boolean;
  // Extra per-row filter applied after tombstone drop. Returning false skips
  // the row.
  filter?: (r: FbrainRecord, t: RecordType) => boolean;
  // Override the not_found error message. `typed` fires when opts.type is set;
  // `untyped` fires otherwise. Defaults match the pre-refactor strings.
  notFoundMessage?: {
    typed?: (t: RecordType, slug: string) => string;
    untyped?: (slug: string) => string;
  };
  // Side-effect that runs with the matches just before an ambiguous_slug
  // throw — used by `fbrain get` to print each match before erroring.
  onAmbiguous?: (matches: ResolvedRecord[]) => void;
  // Forwarded to the per-type lookup loop so tests can mock sleep / shrink
  // the budget without paying the real backoff schedule. Production callers
  // leave it unset and inherit the smoketest-tuned defaults.
  retryOptions?: ReadRetryOptions;
}

// Centralized "find a record by slug across record types, retry on
// read-flake, error on not-found / ambiguous" sweep. Three commands (get,
// status, delete) carried near-identical 25–35 line variants of this block
// before consolidation — see commit history for refactor/resolve-by-slug.
export async function resolveBySlug(opts: ResolveBySlugOpts): Promise<ResolvedRecord> {
  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  // Per-type retry, run in parallel. The previous shape wrapped one
  // outer withReadRetry around a sequential sweep that returned the
  // FIRST attempt with any hit — but the `/api/query` top-100 page
  // flake nulls a real row out of one schema's slice on the same
  // attempt another schema catches its row. With the outer-retry
  // shape, an untyped lookup of an ambiguous slug then surfaced as a
  // single match: `fbrain get` / `status` / `delete` would silently
  // operate on the one type that caught it and skip the sibling.
  // Giving each type its own retry budget lets the flaked type
  // recover within its own loop, so ambiguity is detected before the
  // helper returns.
  const perType = await Promise.all(
    types.map(async (t): Promise<ResolvedRecord | null> => {
      const hash = schemaHashFor(t, opts.cfg);
      // Same fast-miss + empty-page-retry loop as the write existence check.
      // Pre-fix this was `withReadRetry(findBySlug, r => r !== null)`, which
      // made the `r !== null` predicate unreachable for a typo'd slug —
      // every miss burned the full 5×250 ms retry budget. The shared helper
      // short-circuits on a populated-but-missing page (authoritative) and
      // only retries on an empty page (saturated-daemon flake).
      const row = await findBySlugWithFastMiss(
        opts.node,
        t,
        hash,
        opts.slug,
        opts.raw === true,
        opts.retryOptions,
      );
      if (row === null) return null;
      if (opts.raw && isTombstoned(row)) return null;
      if (opts.filter && !opts.filter(row, t)) return null;
      return { type: t, record: row };
    }),
  );
  const matches: ResolvedRecord[] = perType.filter(
    (m): m is ResolvedRecord => m !== null,
  );

  if (matches.length === 0) {
    const fallback = `No record with slug "${opts.slug}".`;
    const message =
      opts.type !== undefined
        ? (opts.notFoundMessage?.typed?.(opts.type, opts.slug) ?? fallback)
        : (opts.notFoundMessage?.untyped?.(opts.slug) ?? fallback);
    throw new FbrainError({ code: "not_found", message });
  }

  if (matches.length > 1) {
    opts.onAmbiguous?.(matches);
    const matchedTypes = matches.map((m) => m.type).join(", ");
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists in multiple schemas (${matchedTypes}). Specify a \`type\`.`,
    });
  }

  return matches[0]!;
}

export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new FbrainError({
      code: "invalid_slug",
      message: "Slug must be non-empty.",
    });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(slug)) {
    // First-time-user trap: `fbrain design new "My Title"` lands the title
    // in the slug positional. Spotting spaces or uppercase in an otherwise-
    // free-form input is a strong hint they meant `--title`; surface the
    // exact slug we'd suggest so they can copy-paste.
    const looksLikeTitle = /\s/.test(slug) || /[A-Z]/.test(slug);
    const hint = looksLikeTitle
      ? `the first argument is a slug (identifier); pass your title with --title and use a slug like "${suggestSlug(slug)}".`
      : "Slugs are lowercase, start with a letter or digit, and use [a-z0-9-_].";
    throw new FbrainError({
      code: "invalid_slug",
      message: `Slug "${slug}" is invalid.`,
      hint,
    });
  }
}

// Best-effort conversion of a free-form title to a valid slug for the hint.
// Lowercase, collapse non-slug chars to `-`, trim leading/trailing `-`.
// Falls back to "my-record" if nothing usable survives so the user never
// sees `"".`
function suggestSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "my-record";
}

export function ensureStatus(type: RecordType, status: string): void {
  if (!isValidStatus(type, status)) {
    const valid = statusValuesFor(type).join(" | ");
    throw new FbrainError({
      code: "invalid_status",
      message: `"${status}" is not a valid ${type} status.`,
      hint: `Valid: ${valid}`,
    });
  }
}
