// Shared record helpers used by the design/task/put/get/list/status/link commands.

import type { NodeClient, QueryRow } from "./client.ts";
import { FbrainError } from "./client.ts";
import type { Config } from "./config.ts";
import {
  LEGACY_NOTE_QUERY_FIELDS,
  LEGACY_NOTE_SCHEMA_KEY,
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
  // For Phase 6 records that live in the shared noteSchema, `kind` tells
  // us which logical type the row belongs to (concept, preference, etc.).
  // Absent for Design/Task records.
  kind?: string;
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

// Hash of the legacy FbrainKindNote schema, where pre-Phase-E Phase 6
// records (concept/preference/reference/agent/project/spike) still live.
// Returns null when:
//   - `type` is design or task (no legacy backing)
//   - the legacy hash is missing from config — e.g. a config written
//     pre-Phase-E that hasn't been re-init'd yet. In that case the
//     legacy fallback in list/get is silently skipped; the user sees
//     only per-kind hits and should re-run `fbrain init` (doctor will
//     surface the missing key).
export function legacySchemaHashFor(
  type: RecordType,
  cfg: { schemaHashes: Record<string, string> },
): string | null {
  if (RECORDS[type].legacyKind === null) return null;
  const hash = cfg.schemaHashes[LEGACY_NOTE_SCHEMA_KEY];
  return hash && hash.length > 0 ? hash : null;
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

// Shape a legacy FbrainKindNote row into the same FbrainRecord envelope.
// Pulls `kind` out so callers can filter by it; v1_marker_a/b are dropped
// (never user-visible).
export function legacyRowToRecord(row: QueryRow): FbrainRecord & { kind: string } {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    status: stringField(f, "status"),
    tags: arrayStringField(f, "tags"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
    kind: stringField(f, "kind"),
  };
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
  if (typeof v === "string" && v.length > 0) return v.split(",").map((s) => s.trim());
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

// Read-only fallback over the legacy FbrainKindNote schema. For Phase 6
// types whose pre-Phase-E records still live in noteSchema, this surfaces
// them filtered by their `kind` discriminator. design/task have no legacy
// backing and never call this. Returns an empty array if `legacyHash` is
// null (no legacy hash registered in config — typical for pre-Phase-E
// configs that haven't been re-init'd).
export async function listLegacyKindRecords(
  node: NodeClient,
  type: RecordType,
  legacyHash: string | null,
): Promise<FbrainRecord[]> {
  const wantKind = RECORDS[type].legacyKind;
  if (wantKind === null || legacyHash === null) return [];
  const res = await node.queryAll({
    schemaHash: legacyHash,
    fields: [...LEGACY_NOTE_QUERY_FIELDS],
  });
  const records = res.results.map(legacyRowToRecord);
  // Pre-Phase-E rows of this kind also need their `kind` field stripped
  // off before being returned — FbrainRecord doesn't include it.
  return records
    .filter((r) => r.kind === wantKind)
    .map(({ kind: _kind, ...rest }) => rest);
}

// Per-kind canonical + legacy fallback, deduped by slug (per-kind wins).
// Always the right call for Phase 6 types; for design/task it short-
// circuits to the per-kind path because `legacySchemaHashFor` returns null.
export async function listRecordsWithLegacy(
  node: NodeClient,
  type: RecordType,
  cfg: Config,
): Promise<FbrainRecord[]> {
  const perKind = await listRecords(node, type, schemaHashFor(type, cfg));
  const legacy = await listLegacyKindRecords(node, type, legacySchemaHashFor(type, cfg));
  if (legacy.length === 0) return perKind;
  const seen = new Set(perKind.map((r) => r.slug));
  return perKind.concat(legacy.filter((r) => !seen.has(r.slug)));
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

// findBySlug-equivalent for the legacy FbrainKindNote schema. Mirrors
// findBySlug's tombstone filter so pre-Phase-E deleted rows stay hidden.
export async function findBySlugLegacy(
  node: NodeClient,
  type: RecordType,
  legacyHash: string | null,
  slug: string,
): Promise<FbrainRecord | null> {
  const hit = await findBySlugLegacyRaw(node, type, legacyHash, slug);
  if (hit === null) return null;
  return isTombstoned(hit) ? null : hit;
}

// Unfiltered legacy variant — returns tombstoned rows. Same contract as
// `findBySlugRaw`, only the `fbrain delete` path needs it.
export async function findBySlugLegacyRaw(
  node: NodeClient,
  type: RecordType,
  legacyHash: string | null,
  slug: string,
): Promise<FbrainRecord | null> {
  const rows = await listLegacyKindRecords(node, type, legacyHash);
  return rows.find((r) => r.slug === slug) ?? null;
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

// Re-run `fn` up to `maxAttempts` times, sleeping `backoffMs` between tries,
// until `isHit(result)` returns true. Returns the last result either way —
// callers handle the genuine-miss case (surfaces the existing "No record"
// error after the retry budget is spent, same UX as today on a real miss).
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
  const backoffMs = options?.backoffMs ?? READ_RETRY_BACKOFF_MS;
  const sleep = options?.sleep ?? defaultSleep;
  let result = await fn();
  let attempts = 1;
  while (!isHit(result) && attempts < maxAttempts) {
    if (backoffMs > 0) await sleep(backoffMs);
    result = await fn();
    attempts++;
  }
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ResolvedRecord = {
  type: RecordType;
  record: FbrainRecord;
  // True when the row came from the legacy FbrainKindNote schema, not the
  // per-kind canonical. Mutations (status, delete) must write back to the
  // same schema the record currently lives in, so callers branch on this.
  legacy: boolean;
};

// Resolve the schema hash to write a record back to. For new per-kind
// records this is the per-kind canonical; for legacy FbrainKindNote
// records (resolved.legacy === true) this is the legacy hash. Throws if
// the legacy hash is somehow missing — should never happen because the
// record was already read from that hash.
export function writeSchemaHashFor(
  type: RecordType,
  legacy: boolean,
  cfg: { schemaHashes: Record<string, string> },
): string {
  if (legacy) {
    const hash = legacySchemaHashFor(type, cfg);
    if (hash === null) {
      throw new FbrainError({
        code: "missing_schema_hash",
        message: `Legacy FbrainKindNote hash missing from config — cannot write back legacy ${type}.`,
        hint: "Re-run `fbrain init` so the config picks up the legacy hash.",
      });
    }
    return hash;
  }
  return schemaHashFor(type, cfg);
}

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
  // the row. Used by `delete` to drop Phase-6 rows whose `kind` doesn't match
  // the type slot being probed.
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
//
// For Phase 6 types this also probes the legacy FbrainKindNote schema
// (pre-Phase-E records). A per-kind hit wins over a legacy hit of the
// same slug — necessary because consolidation may re-write a slug into
// the per-kind canonical without first removing it from the legacy one.
export async function resolveBySlug(opts: ResolveBySlugOpts): Promise<ResolvedRecord> {
  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  const matches = await withReadRetry(
    async () => {
      const hits: ResolvedRecord[] = [];
      const seen = new Set<RecordType>();
      for (const t of types) {
        const hash = schemaHashFor(t, opts.cfg);
        const row = opts.raw
          ? await findBySlugRaw(opts.node, t, hash, opts.slug)
          : await findBySlug(opts.node, t, hash, opts.slug);
        if (row !== null) {
          if (opts.raw && isTombstoned(row)) continue;
          if (opts.filter && !opts.filter(row, t)) continue;
          hits.push({ type: t, record: row, legacy: false });
          seen.add(t);
        }
      }
      // Legacy fallback for Phase 6 types — only fires when the per-kind
      // probe didn't already surface a row at this slug for this type, so
      // a slug consolidated into the new schema wins over its legacy twin.
      for (const t of types) {
        if (seen.has(t)) continue;
        const legacyHash = legacySchemaHashFor(t, opts.cfg);
        if (legacyHash === null) continue;
        const legacyRow = opts.raw
          ? await findBySlugLegacyRaw(opts.node, t, legacyHash, opts.slug)
          : await findBySlugLegacy(opts.node, t, legacyHash, opts.slug);
        if (legacyRow === null) continue;
        if (opts.raw && isTombstoned(legacyRow)) continue;
        if (opts.filter && !opts.filter(legacyRow, t)) continue;
        hits.push({ type: t, record: legacyRow, legacy: true });
      }
      return hits;
    },
    (hits) => hits.length > 0,
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
      message: `Slug "${opts.slug}" exists in multiple schemas (${matchedTypes}). Specify --type.`,
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
