// The one rule for an index row's record snapshot (atom contract P3): an index
// payload carries keys and summary fields, never a large field.
//
// Several indexes keep a JSON snapshot of the record beside their key:
// RecordListEntry (`rle_payload`), LiveIndex and its siblings (`liv_payload`,
// `clu_payload`, `prk_payload`, `eph_payload`), ChildTaskIndex (`ctd_payload`),
// PapercutStatusIndex (`psi_payload`). Each used to copy the WHOLE record, body
// included. A body can now reach the 256 KiB atom ceiling, and a body that big
// made the index payload exceed the ceiling too: the index write failed and the
// record write half-committed (measured 2026-10-12: a 57 KB body gave a 68 KB
// RecordListEntry atom, refused with HTTP 413).
//
// The rule. The payload is the whole record when its atom is at most
// `INDEX_PAYLOAD_MAX_BYTES` (8 KiB), which is almost every record and changes
// nothing for them. Otherwise, in this order, until it fits:
//   1. the long text fields (`INDEX_LONG_TEXT_FIELDS`, the body) are cut to a
//      head of at most 2 KiB, then smaller;
//   2. every other text field above 2 KiB is cut to 2 KiB, then 512 bytes;
//   3. only the keys and summary fields: slug, status, timestamps, a short
//      title, and a bounded list of short tags (the tombstone tag is always
//      kept).
// A truncation key names the cut fields (`*` for step 3). The payload is always
// bounded. Titles, ids and tags that are short are never cut.
//
// A CUT SNAPSHOT IS NOT A RECORD. The types enforce it: a reader gets an
// `IndexSnapshot`, which is either a whole record or a `SnapshotSummary` with no
// `body`. A summary is not assignable to `BrainRecord`, so a function that
// needs the body cannot be handed one by mistake. To get the record, complete it
// with a keyed read of the product schema (`completeSnapshots` in record.ts),
// which retries and then THROWS when the record cannot be read. It never
// returns the cut snapshot as if it were whole.

import { TOMBSTONE_TAG, type BrainRecord } from "./record.ts";

/** Largest index payload atom, in bytes as the node measures it (the JSON-quoted string). */
export const INDEX_PAYLOAD_MAX_BYTES = 8 * 1024;
/** Longest head of one long text field kept in a cut payload. */
export const INDEX_TEXT_HEAD_BYTES = 2 * 1024;
/** Key a cut payload carries, naming the fields cut to a head. */
export const INDEX_TRUNCATED_KEY = "idx_truncated";
/** The long free-text fields an index cuts first. */
export const INDEX_LONG_TEXT_FIELDS: readonly string[] = ["body"];
/** Fields that identify the row or place it in a partition. Never cut. */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "slug",
  "status",
  "created_at",
  "updated_at",
  "design_slug",
  "type",
]);
/** Cut every other text field above this to this. */
const OTHER_FIELD_HEAD_BYTES = 2 * 1024;
/** Longest title kept in the keys-only form. */
const MINIMAL_TITLE_BYTES = 256;
/** Total bytes of tags kept in the keys-only form, and the longest single tag. */
const MINIMAL_TAGS_BYTES = 2 * 1024;
const MINIMAL_TAG_MAX_BYTES = 512;

/** Bytes of `value` as one atom: the length of its JSON-quoted form. */
export function atomBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The first `maxBytes` bytes of `text`, cut on a code point boundary. */
export function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const next = used + Buffer.byteLength(ch);
    if (next > maxBytes) break;
    used = next;
    end += ch.length;
  }
  return text.slice(0, end);
}

export type IndexPayloadOptions = {
  /** Key naming the cut fields. Default `INDEX_TRUNCATED_KEY`. */
  truncatedKey?: string;
  /**
   * What to return when steps 1 and 2 cannot make the record fit. `"empty"`
   * returns `""`, for an index whose readers point-hydrate an unreadable row
   * (the papercut status index). `"keys"` (default) returns the keys-only form,
   * for an index whose readers need a parsable row.
   */
  overflow?: "empty" | "keys";
};

function cutOtherFields(
  record: BrainRecord,
  out: Record<string, unknown>,
  head: number,
): string[] {
  const cut: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (IDENTITY_FIELDS.has(key) || INDEX_LONG_TEXT_FIELDS.includes(key)) continue;
    if (typeof value !== "string" || Buffer.byteLength(value) <= head) continue;
    out[key] = utf8Head(value, head);
    cut.push(key);
  }
  return cut;
}

/** Slug, status, timestamps, a short title and a bounded list of short tags. */
function keysOnly(record: BrainRecord, truncatedKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    slug: record.slug,
    title: utf8Head(typeof record.title === "string" ? record.title : "", MINIMAL_TITLE_BYTES),
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (typeof record.design_slug === "string") out.design_slug = record.design_slug;
  if (typeof record.type === "string") out.type = record.type;
  const tags: string[] = [];
  let used = 0;
  for (const tag of Array.isArray(record.tags) ? record.tags : []) {
    const size = Buffer.byteLength(tag);
    if (tag === TOMBSTONE_TAG) {
      tags.push(tag);
      continue;
    }
    if (size > MINIMAL_TAG_MAX_BYTES || used + size > MINIMAL_TAGS_BYTES) continue;
    tags.push(tag);
    used += size;
  }
  out.tags = tags;
  out[truncatedKey] = ["*"];
  return out;
}

/** The JSON payload for one record under the rule above. Always bounded. */
export function indexPayload(
  record: BrainRecord,
  opts: IndexPayloadOptions = {},
): string {
  const truncatedKey = opts.truncatedKey ?? INDEX_TRUNCATED_KEY;
  const full = JSON.stringify(record);
  if (atomBytes(full) <= INDEX_PAYLOAD_MAX_BYTES) return full;

  const longFields = INDEX_LONG_TEXT_FIELDS.filter(
    (key) => typeof record[key] === "string",
  );
  const attempt = (bodyHead: number, otherHead: number | null): string | null => {
    const out: Record<string, unknown> = { ...record };
    const cut: string[] = [];
    for (const key of longFields) {
      const value = record[key] as string;
      if (Buffer.byteLength(value) <= bodyHead) continue;
      out[key] = utf8Head(value, bodyHead);
      cut.push(key);
    }
    if (otherHead !== null) cut.push(...cutOtherFields(record, out, otherHead));
    if (cut.length === 0) return null;
    out[truncatedKey] = cut;
    const text = JSON.stringify(out);
    return atomBytes(text) <= INDEX_PAYLOAD_MAX_BYTES ? text : null;
  };

  // 1. Cut the body, other fields whole.
  for (const head of [INDEX_TEXT_HEAD_BYTES, 1024, 512, 256, 128, 0]) {
    const text = attempt(head, null);
    if (text !== null) return text;
  }
  // 2. Body gone, and the other long text fields cut as well.
  for (const head of [OTHER_FIELD_HEAD_BYTES, 512]) {
    const text = attempt(0, head);
    if (text !== null) return text;
  }
  // 3. Keys only.
  if (opts.overflow === "empty") return "";
  return JSON.stringify(keysOnly(record, truncatedKey));
}

/** Names of the fields a payload snapshot carries only as a head (`*` = keys only). */
export function truncatedFieldsOf(
  record: { [key: string]: unknown },
  truncatedKey: string = INDEX_TRUNCATED_KEY,
): string[] {
  const cut = record[truncatedKey];
  return Array.isArray(cut) ? cut.filter((f): f is string => typeof f === "string") : [];
}

/** True when the snapshot carries only a head of some field. */
export function isPayloadTruncated(
  record: { [key: string]: unknown },
  truncatedKey: string = INDEX_TRUNCATED_KEY,
): boolean {
  return truncatedFieldsOf(record, truncatedKey).length > 0;
}

/**
 * The fields every index snapshot carries and a reader may use without reading
 * the record. There is no `body` field: `body` is typed as maybe-missing, so a
 * summary cannot be passed where a `BrainRecord` is required.
 */
export type SnapshotSummary = {
  slug: string;
  title: string;
  status: string;
  tags: string[];
  design_slug?: string;
  created_at: string;
  updated_at: string;
  [extraField: string]: string | string[] | undefined;
};

/** One parsed index payload: the whole record, or a cut summary that needs completing. */
export type IndexSnapshot =
  | { cut: false; record: BrainRecord }
  | { cut: true; summary: SnapshotSummary; cutFields: string[] };

/** The summary fields of a snapshot, whether it was cut or not. */
export function snapshotSummary(snapshot: IndexSnapshot): SnapshotSummary {
  return snapshot.cut ? snapshot.summary : snapshot.record;
}

/** The snapshot of an already-parsed payload object. Null when it is not a record row. */
export function snapshotFromParsed(
  parsed: unknown,
  truncatedKey: string = INDEX_TRUNCATED_KEY,
): IndexSnapshot | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as { [key: string]: unknown };
  if (typeof obj.slug !== "string" || obj.slug.length === 0) return null;
  const cutFields = truncatedFieldsOf(obj, truncatedKey);
  if (cutFields.length === 0) {
    return { cut: false, record: parsed as BrainRecord };
  }
  const summary: { [key: string]: unknown } = { ...obj };
  delete summary.body;
  delete summary[truncatedKey];
  return { cut: true, summary: summary as SnapshotSummary, cutFields };
}
