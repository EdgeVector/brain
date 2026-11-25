import { canonicalProfilesForHashes } from "./canonical-vocabulary.ts";
// The node refuses a field value above 64 KiB.
// Seal runs in `buildResidentWritePlan` and in `writeRecordFields` (append, tag, link, gate).

import { createHash } from "node:crypto";

import {
  BrainError,
  type BatchMutationOp,
  type BatchRangeRead,
  type NodeClient,
  type QueryRow,
  type Verbose,
} from "./client.ts";
import { writeConfig, type Config } from "./config.ts";
import type { BrainRecord } from "./record.ts";
import { RECORD_BUDGET_BYTES, recordBudgetMessage, recordBytes } from "./record-cap.ts";
import {
  BODY_CHUNK_FIELDS,
  BODY_CHUNK_SCHEMA_KEY,
  RECORDS,
  type RecordType,
} from "./schemas.ts";

const BODY_CHUNK_NAME = "brain/BrainBodyChunk";

/** Raw UTF-8 bytes per chunk. Escapes can grow a chunk; see CHUNK_SERIALIZED_MAX. */
export const CHUNK_BYTES = 32 * 1024;
/** A chunk's text, serialized, stays under this, so the chunk record fits the record budget. */
const CHUNK_SERIALIZED_MAX = 44 * 1024;
/** Chunk records per write request, and per range page. */
const CHUNK_WRITE_BATCH = 24;
const CHUNK_PAGE = 32;

/** Spill a field when its serialized size is above this. Matches the contract (32 KiB). */
export const SPILL_THRESHOLD_BYTES = 32 * 1024;
/** The inline head is at most this many UTF-8 bytes (cut on a line boundary). */
export const SPILL_HEAD_BYTES = 24 * 1024;
/** No stored field value may be larger than this, serialized. The node limit is 64 KiB. */
export const FIELD_MAX_BYTES = 48 * 1024;
/**
 * Index rows copy the whole record as a JSON string (record list, lifecycle,
 * child-task, papercut status). That string is serialized twice, so escapes
 * grow it. Keep the copy under this size so no index row passes the budget.
 */
export const DERIVED_PAYLOAD_MAX_BYTES = 44 * 1024;
/** Largest blob the local plane accepts by default (`LASTDB_LOCAL_FILE_BLOB_MAX_BYTES`). */
export const SPILL_BLOB_MAX_BYTES = 16 * 1024 * 1024;

const SPILL_FILE_KEY_PREFIX = "__bodyfile__";
const MIN_FORCE_SPILL_BYTES = 8 * 1024;
const MIN_HEAD_BYTES = 2 * 1024;

/** Which text fields of a record type can spill. Everything else is size-guarded only. */
export function spillFieldsFor(_type: RecordType): readonly string[] {
  return ["body"];
}

// ── marker ──────────────────────────────────────────────────────────────────

const MARKER_BODY =
  "<!-- brain-body-file v1 field=([a-z_]+) sha256=([0-9a-f]{64}) bytes=(\\d+) head=([0-9a-f]{16}) -->";
// The marker is ALWAYS the last line, so the match is anchored to the end.
const TRAILING_MARKER_RE = new RegExp(`\\n\\n${MARKER_BODY}$`);
const ANY_MARKER_LINE_RE = new RegExp(`^${MARKER_BODY}$`, "m");

export type SpillMarker = {
  field: string;
  sha256: string;
  bytes: number;
  /** First 16 hex chars of sha256(head). Detects an edited head. */
  headHash: string;
  /** The inline head: the value minus the separator and the marker line. */
  head: string;
};

export function parseSpillMarker(value: string): SpillMarker | null {
  const m = TRAILING_MARKER_RE.exec(value);
  if (m === null) return null;
  return {
    field: m[1]!,
    sha256: m[2]!,
    bytes: Number(m[3]),
    headHash: m[4]!,
    head: value.slice(0, m.index),
  };
}

export function hasSpillMarker(value: unknown): boolean {
  return typeof value === "string" && parseSpillMarker(value) !== null;
}

function markerLine(field: string, sha256: string, bytes: number, headHash: string): string {
  return `<!-- brain-body-file v1 field=${field} sha256=${sha256} bytes=${bytes} head=${headHash} -->`;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function headHashOf(head: string): string {
  return sha256Hex(head).slice(0, 16);
}

/** Serialized size of one field value, the way the node measures it. */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** Size of the record as an index row copies it: JSON text inside a JSON string. */
function derivedPayloadBytes(fields: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(fields)), "utf8");
}

/**
 * The longest prefix of `text` that fits `maxBytes` of UTF-8, cut on a
 * character boundary and, when a newline sits in the back half, on a line
 * boundary. The result is always an exact prefix of `text`.
 */
export function cutHead(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  let slice = buf.subarray(0, end);
  const nl = slice.lastIndexOf(0x0a);
  if (nl >= end * 0.5) slice = slice.subarray(0, nl + 1);
  return slice.toString("utf8");
}

// ── sidecar ─────────────────────────────────────────────────────────────────

export function bodyFileKey(type: RecordType, slug: string, field: string, contentHash?: string): string {
  const identity = `${type}:${slug}:${field}`;
  // New sidecars are immutable versions. A failed primary write must not
  // replace the sidecar still named by the old primary marker.
  return `${SPILL_FILE_KEY_PREFIX}${sha256Hex(contentHash ? `${identity}:${contentHash}` : identity)}`;
}

type SpillCfg = Pick<Config, "schemaHashes">;

function stringOf(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : "";
}

// Pin the body-chunk schema to its exact name, like the body-file schema.
export function ensureBodyChunkSchema(
  cfg: Config,
  opts: { persist: boolean; configPath?: string } = { persist: true },
): string {
  if (cfg.schemaHashes[BODY_CHUNK_SCHEMA_KEY] === BODY_CHUNK_NAME) return BODY_CHUNK_NAME;
  cfg.schemaHashes[BODY_CHUNK_SCHEMA_KEY] = BODY_CHUNK_NAME;
  cfg.schemaFieldAliases = { ...cfg.schemaFieldAliases, ...canonicalProfilesForHashes(cfg.schemaHashes) };
  if (opts.persist) {
    if (opts.configPath !== undefined) writeConfig(cfg, opts.configPath);
    else writeConfig(cfg);
  }
  return BODY_CHUNK_NAME;
}

function bodyChunkSchemaHash(cfg: SpillCfg | null): string {
  const pin = cfg?.schemaHashes[BODY_CHUNK_SCHEMA_KEY];
  if (typeof pin === "string" && pin.length > 0 && !/^[a-f0-9]{64}$/.test(pin)) {
    return pin.startsWith("brain/") ? pin : `brain/${pin}`;
  }
  return BODY_CHUNK_NAME;
}

export function chunkRange(index: number): string {
  return String(index).padStart(6, "0");
}

/**
 * Split text into consecutive parts of at most CHUNK_BYTES UTF-8 bytes, cut on
 * a character boundary. A part whose serialized form is too large (many
 * escapes) is cut smaller. The parts join to exactly `text`.
 */
export function splitChunks(text: string): string[] {
  const buf = Buffer.from(text, "utf8");
  const parts: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let size = Math.min(CHUNK_BYTES, buf.length - start);
    for (;;) {
      let end = start + size;
      while (end < buf.length && end > start && (buf[end]! & 0xc0) === 0x80) end--;
      const part = buf.subarray(start, end).toString("utf8");
      if (serializedBytes(part) <= CHUNK_SERIALIZED_MAX || size <= 1024) {
        parts.push(part);
        start = end;
        break;
      }
      size = Math.floor(size / 2);
    }
  }
  return parts;
}

/** The chunk records of one text, in position order. */
export function chunkOps(schemaHash: string, key: string, full: { buf: Buffer; sha256: string }): BatchMutationOp[] {
  const parts = splitChunks(full.buf.toString("utf8"));
  return parts.map((part, index) => ({
    mutationType: "create" as const,
    // A failed earlier attempt may have left some chunks. Their text is the
    // same, because the key names the content hash.
    replaceIfPresent: true as const,
    schemaHash,
    keyHash: key,
    keyRange: chunkRange(index),
    fields: {
      file_key: key,
      chunk_index: chunkRange(index),
      chunk_text: part,
      content_hash: full.sha256,
      size: String(full.buf.length),
    },
  }));
}

/** Write chunk records in requests of CHUNK_WRITE_BATCH. */
export async function writeChunkOps(node: NodeClient, ops: BatchMutationOp[]): Promise<void> {
  if (!node.mutateBatch) {
    throw new BrainError({
      code: "app_api_route_unavailable",
      message: "Brain cannot store long text without the batch write route.",
    });
  }
  for (let start = 0; start < ops.length; start += CHUNK_WRITE_BATCH) {
    await node.mutateBatch(ops.slice(start, start + CHUNK_WRITE_BATCH), { durability: "durable" });
  }
}

type ChunkText = { bytes: Uint8Array; contentHash: string; size: number };

/**
 * Read the chunks of every key: one batched read per round of pages. A key
 * with no chunk records is absent from the result.
 */
export async function readChunkTexts(
  node: NodeClient,
  cfg: SpillCfg | null,
  keys: readonly string[],
): Promise<Map<string, ChunkText>> {
  const out = new Map<string, ChunkText>();
  if (keys.length === 0) return out;
  const readBatch = node.readBatch;
  if (!readBatch) {
    throw new BrainError({ code: "keyed_read_required", message: "The long text read needs a batched client." });
  }
  const schemaHash = bodyChunkSchemaHash(cfg);
  const rows = new Map<string, QueryRow[]>();
  let pending: Array<{ key: string; cursor?: string }> = [...new Set(keys)].map((key) => ({ key }));
  while (pending.length > 0) {
    const reads: BatchRangeRead[] = pending.map(({ key, cursor }) => ({
      kind: "range",
      schemaHash,
      fields: [...BODY_CHUNK_FIELDS],
      range: { hash: key },
      limit: CHUNK_PAGE,
      ...(cursor ? { cursor } : {}),
    }));
    const hits = await readBatch(reads);
    const next: typeof pending = [];
    hits.forEach((hit, index) => {
      const key = pending[index]!.key;
      if (hit.kind !== "range") {
        throw new BrainError({ code: "record_read_incomplete", message: "LastDB returned an unexpected read." });
      }
      if (hit.error) throw hit.error;
      const list = rows.get(key) ?? [];
      list.push(...hit.rows);
      rows.set(key, list);
      if (hit.nextCursor) next.push({ key, cursor: hit.nextCursor });
    });
    pending = next;
  }
  for (const [key, list] of rows) {
    if (list.length === 0) continue;
    const ordered = list
      .map((row) => ({ range: row.key?.range ?? stringOf(row.fields ?? {}, "chunk_index"), fields: row.fields ?? {} }))
      .sort((a, b) => (a.range < b.range ? -1 : a.range > b.range ? 1 : 0));
    ordered.forEach((row, index) => {
      if (row.range !== chunkRange(index)) {
        throw new BrainError({
          code: "body_spill_chunk_missing",
          message: `The long text ${key} is missing part ${chunkRange(index)}.`,
          hint: "Write the record again with its full text.",
        });
      }
    });
    const first = ordered[0]!.fields as Record<string, unknown>;
    out.set(key, {
      bytes: new Uint8Array(Buffer.from(ordered.map((row) => stringOf(row.fields as Record<string, unknown>, "chunk_text")).join(""), "utf8")),
      contentHash: stringOf(first, "content_hash"),
      size: Number(stringOf(first, "size")) || 0,
    });
  }
  return out;
}

function verifyBytes(bytes: Uint8Array, sha256: string, size: number, what: string): void {
  const got = sha256Hex(bytes);
  if (got !== sha256 || bytes.length !== size) {
    throw new BrainError({
      code: "body_spill_integrity_error",
      message: `${what}: blob hashes ${got} (${bytes.length} bytes), expected ${sha256} (${size} bytes).`,
      hint: "The stored blob is corrupt. Restore the text from another copy and write the record again.",
    });
  }
}

// ── hydrate (READ funnel) ───────────────────────────────────────────────────

/** The stored (marker) form of each hydrated field. Not enumerable, never serialized. */
export const STORED_FORM = Symbol("brain.storedForm");

type HydratedRecord = BrainRecord & { [STORED_FORM]?: Record<string, string> };

export type HydrateOptions = {
  // Load only these spilled fields. Omitted loads every spilled field.
  fields?: readonly string[];
};

function bodyFileMissing(what: string, key: string): BrainError {
  return new BrainError({
    code: "body_spill_chunk_missing",
    message: `${what}: the long text has no stored parts (${key}).`,
    hint: "The record may have synced before its long text. Retry; if it stays, write the record again with its full text.",
  });
}

type PendingSpill = {
  itemIndex: number;
  field: string;
  marker: SpillMarker;
  stored: string;
  key: string;
};

/**
 * Replace every spilled field with its full text. The chunks of every key
 * share one batched read per page round. The first failure in input order is
 * the error. A record with no marker is the same object, and no read is sent
 * for it. The returned copy keeps the stored form under `STORED_FORM`, so the
 * write plan can tell "unchanged" from "text that still needs a spill".
 */
export async function hydrateRecords(
  node: NodeClient,
  cfg: SpillCfg | null,
  items: readonly { type: RecordType; record: BrainRecord; opts?: HydrateOptions }[],
): Promise<BrainRecord[]> {
  const pending: PendingSpill[] = [];
  items.forEach((item, itemIndex) => {
    const only = item.opts?.fields;
    for (const field of spillFieldsFor(item.type)) {
      if (only !== undefined && !only.includes(field)) continue;
      const value = item.record[field];
      if (typeof value !== "string") continue;
      const marker = parseSpillMarker(value);
      if (marker === null) continue;
      const name = marker.field || field;
      pending.push({
        itemIndex,
        field,
        marker,
        stored: value,
        key: bodyFileKey(item.type, item.record.slug, name, marker.sha256),
      });
    }
  });
  if (pending.length === 0) return items.map((item) => item.record);
  const texts = await readChunkTexts(node, cfg, pending.map((item) => item.key));
  const copies = new Map<number, HydratedRecord>();
  const storedForms = new Map<number, Record<string, string>>();
  for (const item of pending) {
    const source = items[item.itemIndex]!;
    const what = `${source.type} ${source.record.slug} field ${item.field}`;
    const text = texts.get(item.key);
    if (!text) throw bodyFileMissing(what, item.key);
    verifyBytes(text.bytes, item.marker.sha256, item.marker.bytes, what);
    let copy = copies.get(item.itemIndex);
    if (!copy) {
      copy = { ...source.record };
      copies.set(item.itemIndex, copy);
    }
    copy[item.field] = Buffer.from(text.bytes).toString("utf8");
    const stored = storedForms.get(item.itemIndex) ?? {};
    stored[item.field] = item.stored;
    storedForms.set(item.itemIndex, stored);
  }
  for (const [index, stored] of storedForms) {
    Object.defineProperty(copies.get(index)!, STORED_FORM, { value: stored, enumerable: false });
  }
  return items.map((item, index) => copies.get(index) ?? item.record);
}

export async function hydrateRecord(
  node: NodeClient,
  cfg: SpillCfg | null,
  type: RecordType,
  record: BrainRecord,
  opts?: HydrateOptions,
): Promise<BrainRecord> {
  const [out] = await hydrateRecords(node, cfg, [{ type, record, ...(opts ? { opts } : {}) }]);
  return out!;
}

/** The fields of `record` as the node stores them: spilled fields in marker form. */
export function storedFieldsOf(record: BrainRecord): Record<string, unknown> {
  const stored = (record as HydratedRecord)[STORED_FORM];
  return stored === undefined ? { ...record } : { ...record, ...stored };
}

// ── seal (WRITE funnel) ─────────────────────────────────────────────────────

export type SpilledField = {
  field: string;
  /** Byte length of the full text. */
  bytes: number;
  /** Byte length of the inline head that stays in the record. */
  headBytes: number;
  sha256: string;
  /** True when an identical sidecar already existed, so nothing was written. */
  reused: boolean;
};

export type SealResult = {
  /** The fields to write: spilled fields hold head + marker. */
  fields: Record<string, unknown>;
  spilled: SpilledField[];
};

type InlineEntry = {
  field: string;
  value: string;
  serialized: number;
  full?: { buf: Buffer; sha256: string };
};

type SealPlan = {
  stored: Record<string, unknown>;
  spill: Array<{ field: string; full: { buf: Buffer; sha256: string }; headBytes: number }>;
  pass: Array<{ field: string; marker: SpillMarker }>;
};

function fullOf(entry: InlineEntry): { buf: Buffer; sha256: string } {
  if (entry.full === undefined) {
    const buf = Buffer.from(entry.value, "utf8");
    entry.full = { buf, sha256: sha256Hex(buf) };
  }
  return entry.full;
}

/** Pure planning step: decide which fields spill and what the stored form is. */
function planSeal(
  type: RecordType,
  slug: string,
  fields: Record<string, unknown>,
  existing?: Record<string, unknown>,
): SealPlan {
  const entries: InlineEntry[] = [];
  const pass: SealPlan["pass"] = [];
  for (const field of spillFieldsFor(type)) {
    const value = fields[field];
    if (typeof value !== "string") continue;
    const marker = parseSpillMarker(value);
    if (marker !== null) {
      if (marker.field !== field || headHashOf(marker.head) !== marker.headHash) {
        throw new BrainError({
          code: "body_spill_marker_conflict",
          message:
            `${type} ${slug}: field ${field} ends with a brain-body-file marker, ` +
            "but the text above the marker no longer matches it.",
          hint:
            "The marker stands for text stored in a body file. Read the full record " +
            "(`brain get`, which returns the full text) and write that, not the raw inline head.",
        });
      }
      pass.push({ field, marker });
      continue;
    }
    if (ANY_MARKER_LINE_RE.test(value)) {
      throw new BrainError({
        code: "body_spill_marker_misplaced",
        message:
          `${type} ${slug}: field ${field} holds a brain-body-file marker line that is not the last line.`,
        hint:
          "This usually means text was added to a record read without its full text. " +
          "Read the record with `brain get` (full text) and write again. " +
          "A marker line is reserved for the body-file layout.",
      });
    }
    entries.push({ field, value, serialized: serializedBytes(value) });
  }

  const spillSet = new Set(
    entries.filter((e) => e.serialized > SPILL_THRESHOLD_BYTES).map((e) => e.field),
  );
  let headBudget = SPILL_HEAD_BYTES;
  const build = (): { stored: Record<string, unknown>; heads: Map<string, number> } => {
    const stored: Record<string, unknown> = { ...fields };
    const heads = new Map<string, number>();
    for (const e of entries) {
      if (!spillSet.has(e.field)) continue;
      const full = fullOf(e);
      const head = cutHead(e.value, headBudget);
      stored[e.field] = `${head}\n\n${markerLine(e.field, full.sha256, full.buf.length, headHashOf(head))}`;
      heads.set(e.field, Buffer.byteLength(head, "utf8"));
    }
    return { stored, heads };
  };
  let built = build();
  // Index rows copy the whole record as JSON in a JSON string, so escapes can
  // grow a record past the budget even when each field is under the threshold.
  // A format 7 home also caps the whole stored record (fields plus one stamp
  // per field). Spill the next-largest field, then shrink the heads, until
  // both fit. A record that still does not fit is refused by
  // assertRecordBudget before anything is written.
  for (;;) {
    if (
      derivedPayloadBytes(built.stored) <= DERIVED_PAYLOAD_MAX_BYTES &&
      recordBytes(wholeRecord(type, built.stored, existing)) <= RECORD_BUDGET_BYTES
    ) {
      break;
    }
    const next = entries
      .filter((e) => !spillSet.has(e.field) && e.serialized > MIN_FORCE_SPILL_BYTES)
      .sort((a, b) => b.serialized - a.serialized)[0];
    if (next !== undefined) {
      spillSet.add(next.field);
    } else if (spillSet.size > 0 && headBudget > MIN_HEAD_BYTES) {
      headBudget = Math.max(MIN_HEAD_BYTES, Math.floor(headBudget * 0.75));
    } else {
      break;
    }
    built = build();
  }

  const spill: SealPlan["spill"] = [];
  for (const e of entries) {
    if (!spillSet.has(e.field)) continue;
    spill.push({ field: e.field, full: fullOf(e), headBytes: built.heads.get(e.field) ?? 0 });
  }
  return { stored: built.stored, spill, pass };
}

/** Which fields of this record would spill if it were written now. Pure: no reads, no writes. */
export function fieldsToSpill(
  type: RecordType,
  slug: string,
  fields: Record<string, unknown>,
): string[] {
  return planSeal(type, slug, fields).spill.map((s) => s.field);
}

async function commitChunks(opts: {
  node: NodeClient;
  cfg: SpillCfg;
  schemaHash: string;
  type: RecordType;
  slug: string;
  field: string;
  full: { buf: Buffer; sha256: string };
}): Promise<{ reused: boolean }> {
  const { node, cfg, schemaHash, type, slug, field, full } = opts;
  if (full.buf.length > SPILL_BLOB_MAX_BYTES) {
    throw new BrainError({
      code: "body_spill_too_large",
      message: `${type} ${slug}: field ${field} is ${full.buf.length} bytes; the limit is ${SPILL_BLOB_MAX_BYTES} (16 MiB).`,
      hint: "Split the text across records.",
    });
  }
  const key = bodyFileKey(type, slug, field, full.sha256);
  const what = `${type} ${slug} field ${field}`;
  // Reuse only a complete set whose joined text has this hash. A set left
  // incomplete by a failed earlier write (a prefix, or a gap) is written
  // again in full; every part is a replace, so the retry completes it.
  const existing = await readChunkTexts(node, cfg, [key]).then(
    (texts) => texts.get(key),
    (error: unknown) => {
      if (error instanceof BrainError && error.code === "body_spill_chunk_missing") return undefined;
      throw error;
    },
  );
  if (existing !== undefined && existing.bytes.length === full.buf.length && sha256Hex(existing.bytes) === full.sha256) {
    return { reused: true };
  }
  // 1. the chunks, 2. read them back. The record that names them is written after.
  await writeChunkOps(node, chunkOps(schemaHash, key, full));
  const written = (await readChunkTexts(node, cfg, [key])).get(key);
  if (written === undefined) throw bodyFileMissing(what, key);
  verifyBytes(written.bytes, full.sha256, full.buf.length, what);
  return { reused: false };
}

/**
 * The one write funnel. Takes the fields a writer is about to store for one
 * record, spills any long text field to a blob + sidecar, and returns the
 * fields to write (spilled fields hold the inline head and the marker line).
 * The caller writes the record AFTER this returns. A field that already holds a
 * valid marker passes through after its sidecar is checked. Every field is then
 * checked against the 48 KiB budget, so a too-large field fails here with a
 * clear error and never reaches the node as a 413.
 */
export async function sealRecordFields(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  slug: string;
  fields: Record<string, unknown>;
  /**
   * The stored fields of the record before this write. A write that sends
   * only some fields leaves the others in the stored record, so the whole
   * record check counts them too.
   */
  existing?: Record<string, unknown>;
  verbose?: Verbose;
}): Promise<SealResult> {
  const { node, cfg, type, slug } = opts;
  const plan = planSeal(type, slug, opts.fields, opts.existing);
  // Reject invalid fields before schema declarations or blob/sidecar writes.
  assertFieldBudget(type, slug, plan.stored);
  assertRecordBudget(type, slug, plan.stored, opts.existing);
  const spilled: SpilledField[] = [];

  if (plan.spill.length > 0 || plan.pass.length > 0) {
    const schemaHash = ensureBodyChunkSchema(cfg, { persist: true });
    const results = await Promise.all(
      plan.spill.map(async (s) => {
        const { reused } = await commitChunks({ node, cfg, schemaHash, type, slug, field: s.field, full: s.full });
        const done: SpilledField = {
          field: s.field,
          bytes: s.full.buf.length,
          headBytes: s.headBytes,
          sha256: s.full.sha256,
          reused,
        };
        return done;
      }),
    );
    spilled.push(...results);
    // A pass-through marker must still name stored text with that hash.
    const passKeys = plan.pass.map(({ field, marker }) => bodyFileKey(type, slug, field, marker.sha256));
    const passTexts = await readChunkTexts(node, cfg, passKeys);
    plan.pass.forEach(({ field, marker }, index) => {
      const text = passTexts.get(passKeys[index]!);
      if (!text || text.contentHash !== marker.sha256 || text.size !== marker.bytes) {
        throw new BrainError({
          code: "body_spill_sidecar_mismatch",
          message: `${type} ${slug}: field ${field} carries a marker with no matching stored text.`,
          hint: "Read the record again with `brain get` and write the full text.",
        });
      }
    });
    for (const s of spilled) {
      opts.verbose?.(
        `body-spill: ${type} ${slug} field=${s.field} bytes=${s.bytes} head=${s.headBytes} ` +
          `sha256=${s.sha256.slice(0, 12)} ${s.reused ? "unchanged" : "written"}`,
      );
    }
  }

  return { fields: plan.stored, spilled };
}

// ── field budget guard ──────────────────────────────────────────────────────

/** Throw a clear error when one field value is above the 48 KiB field budget. */
export function assertFieldBudget(
  type: RecordType,
  slug: string,
  fields: Record<string, unknown>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const size = serializedBytes(value);
    if (size > FIELD_MAX_BYTES) {
      throw new BrainError({
        code: "record_field_too_large",
        message:
          `${type} ${slug}: field ${name} is ${size} bytes serialized; ` +
          `the field budget is ${FIELD_MAX_BYTES} bytes (the node refuses 65536).`,
        hint:
          spillFieldsFor(type).includes(name)
            ? "Long text should have spilled to a body file."
            : "Shorten the field. Only body text spills to a file.",
      });
    }
  }
}

/**
 * The record as the node stores it after this write: the schema fields of the
 * stored record that the write does not send, plus the fields it sends.
 */
function wholeRecord(
  type: RecordType,
  fields: Record<string, unknown>,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  if (existing === undefined) return fields;
  const kept: Record<string, unknown> = {};
  for (const name of RECORDS[type].schema.schema.fields) {
    if (!(name in fields) && existing[name] !== undefined) kept[name] = existing[name];
  }
  return { ...kept, ...fields };
}

/**
 * Throw a clear error when the whole record is over the format 7 record
 * budget (src/record-cap.ts). Runs after the seal plan, which already spilled
 * the body and shrank its head as far as it can, so what is left is too much
 * text in fields that do not spill.
 */
export function assertRecordBudget(
  type: RecordType,
  slug: string,
  fields: Record<string, unknown>,
  existing?: Record<string, unknown>,
): void {
  const whole = wholeRecord(type, fields, existing);
  const bytes = recordBytes(whole);
  if (bytes <= RECORD_BUDGET_BYTES) return;
  let largest = "";
  let largestBytes = -1;
  for (const [name, value] of Object.entries(whole)) {
    const size = serializedBytes(value);
    if (size > largestBytes) {
      largest = name;
      largestBytes = size;
    }
  }
  throw new BrainError({
    code: "record_too_large",
    message:
      recordBudgetMessage(`${type} ${slug}`, bytes) +
      ` The largest field is ${largest} (${largestBytes} bytes). Nothing was written.`,
    hint:
      "Only the body spills to a body file. Shorten the title, the tags, or the other short " +
      "fields, or move that text into the body.",
  });
}

/** Projections that copy the whole record into an index row. Guarded by the plan. */
export function assertOpsFitFieldBudget(
  type: RecordType,
  slug: string,
  ops: ReadonlyArray<{ projection: string; keyHash: string; fields: Record<string, unknown> }>,
): void {
  for (const op of ops) {
    for (const [name, value] of Object.entries(op.fields)) {
      const size = serializedBytes(value);
      if (size > FIELD_MAX_BYTES) {
        throw new BrainError({
          code: "record_field_too_large",
          message:
            `${type} ${slug}: ${op.projection} row ${op.keyHash} field ${name} is ${size} bytes serialized; ` +
            `the field budget is ${FIELD_MAX_BYTES} bytes (the node refuses 65536).`,
          hint: "An index row copied a record that is too large. Shorten the record fields.",
        });
      }
    }
  }
}
