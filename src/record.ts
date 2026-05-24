// Shared record helpers used by the design/task/put/get/list/status/link commands.

import type { NodeClient, QueryRow } from "./client.ts";
import { FbrainError } from "./client.ts";
import {
  RECORDS,
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
  if (RECORDS[type].kind !== null) {
    const k = stringField(f, "kind");
    if (k.length > 0) base.kind = k;
  }
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
  if (typeof v === "string" && v.length > 0) return v.split(",").map((s) => s.trim());
  return [];
}

export async function listRecords(
  node: NodeClient,
  type: RecordType,
  schemaHash: string,
): Promise<FbrainRecord[]> {
  const res = await node.queryAll({ schemaHash, fields: fieldsFor(type) });
  const records = res.results.map((row) => rowToRecord(row, type));
  const kind = RECORDS[type].kind;
  // Phase 6 types share noteSchema — filter by `kind` so a concept query
  // doesn't return every Phase 6 record across all kinds.
  if (kind !== null) return records.filter((r) => r.kind === kind);
  return records;
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
