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
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  // Mirror put.ts's inline-list parser (`.filter(s => s.length > 0)`): the
  // write path treats empty strings as non-tags, so the read fallback must
  // too — otherwise a trailing/empty-middle comma or whitespace-only field
  // leaks phantom empty tags that surface as stray `,` separators in
  // `fbrain get` / `fbrain list` and inflate tag counts.
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
      const row = await withReadRetry(
        () =>
          opts.raw
            ? findBySlugRaw(opts.node, t, hash, opts.slug)
            : findBySlug(opts.node, t, hash, opts.slug),
        (r) => r !== null,
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
    throw new FbrainError({
      code: "invalid_slug",
      message: `Slug "${slug}" is invalid.`,
      hint: "Slugs are lowercase, start with a letter or digit, and use [a-z0-9-_].",
    });
  }
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
