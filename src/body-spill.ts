// The node refuses an atom above 64 KiB.
// Seal runs in `buildResidentWritePlan` and in `writeRecordFields` (append, tag, link, gate).

import { createHash } from "node:crypto";

import { FbrainError, type NodeClient, type QueryRow, type Verbose } from "./client.ts";
import { writeConfig, type Config } from "./config.ts";
import type { FbrainRecord } from "./record.ts";
import {
  BODY_FILE_SCHEMA_KEY,
  OWNER_APP_ID,
  bodyFileSchema,
  type RecordType,
} from "./schemas.ts";

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

const FILE_FIELDS = [
  "file_key",
  "record_type",
  "record_slug",
  "record_field",
  "content_hash",
  "size",
  "file",
  "created_at",
  "updated_at",
];

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

/** Serialized size of one field value, the way the node measures an atom. */
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

type SidecarRow = {
  contentHash: string;
  size: number;
  createdAt: string;
  /** Null when the row exists but its `file` field is not a `$lastdb_file` pointer. */
  pointer: Record<string, unknown> | null;
};

function stringOf(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : "";
}

function pointerOf(raw: unknown): Record<string, unknown> | null {
  let pointer = raw;
  if (typeof pointer === "string") {
    try {
      pointer = JSON.parse(pointer);
    } catch {
      return null;
    }
  }
  if (
    pointer === null ||
    typeof pointer !== "object" ||
    typeof (pointer as Record<string, unknown>).$lastdb_file !== "object" ||
    (pointer as Record<string, unknown>).$lastdb_file === null
  ) {
    return null;
  }
  return pointer as Record<string, unknown>;
}

async function queryRowByKey(
  node: NodeClient,
  schemaHash: string,
  fields: string[],
  keyHash: string,
): Promise<QueryRow | null> {
  if (node.queryByKey) return node.queryByKey({ schemaHash, fields, keyHash });
  const all = await node.queryAll({ schemaHash, fields, filter: { HashKey: keyHash } });
  return all.results.find((r) => r.key?.hash === keyHash || r.fields?.file_key === keyHash) ?? null;
}

async function readSidecar(
  node: NodeClient,
  schemaHash: string,
  key: string,
): Promise<SidecarRow | null> {
  const row = await queryRowByKey(node, schemaHash, FILE_FIELDS, key);
  return sidecarFromRow(row);
}

function sidecarFromRow(row: QueryRow | null): SidecarRow | null {
  if (row === null) return null;
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    contentHash: stringOf(f, "content_hash"),
    size: Number(stringOf(f, "size")) || 0,
    createdAt: stringOf(f, "created_at"),
    pointer: pointerOf(f.file),
  };
}

async function readMarkerSidecar(
  node: NodeClient,
  schemaHash: string,
  type: RecordType,
  slug: string,
  field: string,
  contentHash: string,
): Promise<SidecarRow | null> {
  const versioned = bodyFileKey(type, slug, field, contentHash);
  const legacy = bodyFileKey(type, slug, field);
  // Read both known keys together for compatibility with the original layout.
  // New writes never overwrite the legacy key.
  if (node.queryByKeys) {
    const rows = await node.queryByKeys({
      schemaHash,
      fields: FILE_FIELDS,
      keys: [{ hash: versioned }, { hash: legacy }],
    });
    const byKey = new Map(rows.map((row) => [row.key?.hash ?? stringOf(row.fields ?? {}, "file_key"), row]));
    return sidecarFromRow(byKey.get(versioned) ?? byKey.get(legacy) ?? null);
  }
  const [current, previous] = await Promise.all([
    readSidecar(node, schemaHash, versioned),
    readSidecar(node, schemaHash, legacy),
  ]);
  return current ?? previous;
}

// Lazy schema declare, the same pattern as `ensureAttachmentSchemas`: an
// install that ran `brain init` before body spill existed gets the schema
// minted on first use. Persists the canonical hash to config.
export async function ensureBodyFileSchema(
  node: NodeClient,
  cfg: Config,
  opts: { persist: boolean; configPath?: string } = { persist: true },
): Promise<string> {
  const have = cfg.schemaHashes[BODY_FILE_SCHEMA_KEY];
  if (have) return have;
  if (!node.declareAppSchema) {
    throw new FbrainError({
      code: "body_spill_schema_unavailable",
      message: "This node cannot declare the brain body-file schema.",
      hint: "Run `brain init` against a current Mini node, then retry.",
    });
  }
  const declared = await node.declareAppSchema(OWNER_APP_ID, bodyFileSchema.schema);
  cfg.schemaHashes[BODY_FILE_SCHEMA_KEY] = declared.canonical;
  if (opts.persist) {
    if (opts.configPath !== undefined) writeConfig(cfg, opts.configPath);
    else writeConfig(cfg);
  }
  return declared.canonical;
}

// ── blob plane ──────────────────────────────────────────────────────────────

function blobPlaneError(path: string, status: number, body: string): FbrainError {
  const excerpt = body.slice(0, 300);
  if (status === 413) {
    return new FbrainError({
      code: "body_spill_too_large",
      message: `Node ${path} refused the text as too large (413): ${excerpt}`,
      hint: "A local blob is at most 16 MiB. Split the text across records.",
    });
  }
  if (status === 404 || status === 405) {
    return new FbrainError({
      code: "body_spill_unavailable",
      message: `Node ${path} answered ${status}: this node has no local blob route.`,
      hint: "Long bodies need a LastDB Mini that serves POST /api/db/put-blob-local. Upgrade the node.",
    });
  }
  return new FbrainError({
    code: "body_spill_blob_error",
    message: `Node ${path} failed (${status}): ${excerpt}`,
    hint: "Retry. If it persists, read the node log for the file-blob plane failure.",
  });
}

async function putBlobLocal(node: NodeClient, bytes: Uint8Array): Promise<Record<string, unknown>> {
  const path = "/api/db/put-blob-local";
  // No `name` and no `media_type`: identical bytes then give an identical pointer.
  const res = await node.rawCall("POST", path, {
    bytes_b64: Buffer.from(bytes).toString("base64"),
  });
  if (res.status !== 200) throw blobPlaneError(path, res.status, res.body);
  const root = (res.json ?? {}) as Record<string, unknown>;
  const fileBlob = (root.file_blob ?? (root.data as Record<string, unknown> | undefined)?.file_blob) as
    | Record<string, unknown>
    | undefined;
  const pointer = pointerOf(fileBlob?.pointer);
  if (pointer === null) {
    throw new FbrainError({
      code: "body_spill_blob_error",
      message: `Node ${path} returned no $lastdb_file pointer: ${res.body.slice(0, 300)}`,
      hint: "The node and brain disagree on the put-blob-local response. Upgrade both.",
    });
  }
  return pointer;
}

async function fetchBlob(node: NodeClient, pointer: Record<string, unknown>): Promise<Uint8Array> {
  const path = "/api/db/fetch-file-blob";
  const res = await node.rawCall("POST", path, { pointer });
  if (res.status === 404) {
    throw new FbrainError({
      code: "body_spill_blob_missing",
      message: "The long text blob is not on this node.",
      hint:
        "Brain keeps long text in this node's local blob plane. It does not sync to the cloud. " +
        "Read the record on the node that wrote it.",
    });
  }
  if (res.status !== 200) throw blobPlaneError(path, res.status, res.body);
  const root = (res.json ?? {}) as Record<string, unknown>;
  const fileBlob = (root.file_blob ?? (root.data as Record<string, unknown> | undefined)?.file_blob) as
    | Record<string, unknown>
    | undefined;
  const b64 = typeof fileBlob?.bytes_b64 === "string" ? fileBlob.bytes_b64 : "";
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function verifyBytes(bytes: Uint8Array, sha256: string, size: number, what: string): void {
  const got = sha256Hex(bytes);
  if (got !== sha256 || bytes.length !== size) {
    throw new FbrainError({
      code: "body_spill_integrity_error",
      message: `${what}: blob hashes ${got} (${bytes.length} bytes), expected ${sha256} (${size} bytes).`,
      hint: "The stored blob is corrupt. Restore the text from another copy and write the record again.",
    });
  }
}

// ── hydrate (READ funnel) ───────────────────────────────────────────────────

/** The stored (marker) form of each hydrated field. Not enumerable, never serialized. */
export const STORED_FORM = Symbol("brain.storedForm");

type HydratedRecord = FbrainRecord & { [STORED_FORM]?: Record<string, string> };

// The sidecar schema hash. A caller that holds the config passes it (no extra
// call). A caller that does not (a read helper called without `cfg`) falls
// back to ONE `GET /api/schemas` per node client, looked up only when a marker
// is actually met, so a record with no spilled text pays nothing.
const nodeBodyFileHash = new WeakMap<NodeClient, Promise<string | null>>();

async function bodyFileSchemaHash(node: NodeClient, cfg: SpillCfg | null): Promise<string> {
  const fromCfg = cfg?.schemaHashes[BODY_FILE_SCHEMA_KEY];
  if (fromCfg) return fromCfg;
  let lookup = nodeBodyFileHash.get(node);
  if (lookup === undefined) {
    lookup = node.listLoadedSchemas().then((loaded) => {
      const hit = loaded.find(
        (s) => s.descriptive_name === bodyFileSchema.schema.descriptive_name && s.owner_app_id === OWNER_APP_ID,
      );
      return hit?.name ?? hit?.identity_hash ?? null;
    });
    nodeBodyFileHash.set(node, lookup);
  }
  const hash = await lookup;
  if (!hash) {
    nodeBodyFileHash.delete(node);
    throw new FbrainError({
      code: "body_spill_schema_missing",
      message: "This record keeps its long text in a body file, but the node has no BrainBodyFile schema loaded.",
      hint: "Run `brain init` so the BrainBodyFile schema registers, then retry.",
    });
  }
  return hash;
}

export type HydrateOptions = {
  // Load only these spilled fields. Omitted loads every spilled field.
  fields?: readonly string[];
};

async function resolveSpilledField(
  node: NodeClient,
  cfg: SpillCfg | null,
  type: RecordType,
  slug: string,
  field: string,
  marker: SpillMarker,
): Promise<string> {
  const schemaHash = await bodyFileSchemaHash(node, cfg);
  const key = bodyFileKey(type, slug, marker.field || field, marker.sha256);
  const sidecar = await readMarkerSidecar(node, schemaHash, type, slug, marker.field || field, marker.sha256);
  if (sidecar === null) {
    throw new FbrainError({
      code: "body_spill_sidecar_missing",
      message: `${type} ${slug}: field ${field} points at a body file record that does not exist (${key}).`,
      hint: "The record may have synced before its sidecar. Retry; if it stays, write the record again with its full text.",
    });
  }
  if (sidecar.contentHash !== marker.sha256 || sidecar.size !== marker.bytes) {
    const message =
      `${type} ${slug}: field ${field} names text ${marker.sha256.slice(0, 12)}, ` +
      `but the body file record holds ${sidecar.contentHash.slice(0, 12)}.`;
    throw new FbrainError({
      code: "body_spill_sidecar_mismatch",
      message,
      hint: "The stored text reference does not match this record revision. Read the record again or restore its full text.",
    });
  }
  if (sidecar.pointer === null) {
    throw new FbrainError({
      code: "body_spill_pointer_invalid",
      message: `${type} ${slug}: body file record ${key} does not carry a $lastdb_file pointer.`,
      hint: "The sidecar record is corrupt. Write the record again with its full text to replace it (brain put --allow-shrink).",
    });
  }
  const bytes = await fetchBlob(node, sidecar.pointer);
  verifyBytes(bytes, marker.sha256, marker.bytes, `${type} ${slug} field ${field}`);
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Replace every spilled field of `record` with its full text. A record with no
 * marker comes back unchanged (same object, no reads). The returned copy keeps
 * the stored form under `STORED_FORM`, so the write plan can tell "unchanged"
 * from "legacy text that still needs a spill".
 */
export async function hydrateRecord(
  node: NodeClient,
  cfg: SpillCfg | null,
  type: RecordType,
  record: FbrainRecord,
  opts?: HydrateOptions,
): Promise<FbrainRecord> {
  const pending: Array<{ field: string; marker: SpillMarker; stored: string }> = [];
  const only = opts?.fields;
  for (const field of spillFieldsFor(type)) {
    if (only !== undefined && !only.includes(field)) continue;
    const value = record[field];
    if (typeof value !== "string") continue;
    const marker = parseSpillMarker(value);
    if (marker !== null) pending.push({ field, marker, stored: value });
  }
  if (pending.length === 0) return record;
  const texts = await Promise.all(
    pending.map((p) => resolveSpilledField(node, cfg, type, record.slug, p.field, p.marker)),
  );
  const out: HydratedRecord = { ...record };
  const stored: Record<string, string> = {};
  pending.forEach((p, i) => {
    out[p.field] = texts[i]!;
    stored[p.field] = p.stored;
  });
  Object.defineProperty(out, STORED_FORM, { value: stored, enumerable: false });
  return out;
}

/** The fields of `record` as the node stores them: spilled fields in marker form. */
export function storedFieldsOf(record: FbrainRecord): Record<string, unknown> {
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
function planSeal(type: RecordType, slug: string, fields: Record<string, unknown>): SealPlan {
  const entries: InlineEntry[] = [];
  const pass: SealPlan["pass"] = [];
  for (const field of spillFieldsFor(type)) {
    const value = fields[field];
    if (typeof value !== "string") continue;
    const marker = parseSpillMarker(value);
    if (marker !== null) {
      if (marker.field !== field || headHashOf(marker.head) !== marker.headHash) {
        throw new FbrainError({
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
      throw new FbrainError({
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
  // Spill the next-largest field, then shrink the heads, until the copy fits.
  for (;;) {
    if (derivedPayloadBytes(built.stored) <= DERIVED_PAYLOAD_MAX_BYTES) break;
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

async function commitSidecar(opts: {
  node: NodeClient;
  schemaHash: string;
  type: RecordType;
  slug: string;
  field: string;
  full: { buf: Buffer; sha256: string };
}): Promise<{ reused: boolean }> {
  const { node, schemaHash, type, slug, field, full } = opts;
  if (full.buf.length > SPILL_BLOB_MAX_BYTES) {
    throw new FbrainError({
      code: "body_spill_too_large",
      message: `${type} ${slug}: field ${field} is ${full.buf.length} bytes; the limit is ${SPILL_BLOB_MAX_BYTES} (16 MiB).`,
      hint: "Split the text across records.",
    });
  }
  const key = bodyFileKey(type, slug, field, full.sha256);
  const existing = await readSidecar(node, schemaHash, key);
  if (
    existing !== null &&
    existing.pointer !== null &&
    existing.contentHash === full.sha256 &&
    existing.size === full.buf.length
  ) {
    return { reused: true };
  }
  // 1. blob, 2. verify it reads back, 3. sidecar. The record is written after.
  const pointer = await putBlobLocal(node, full.buf);
  verifyBytes(await fetchBlob(node, pointer), full.sha256, full.buf.length, `${type} ${slug} field ${field}`);
  const now = new Date().toISOString();
  const fields = {
    file_key: key,
    record_type: type,
    record_slug: slug,
    record_field: field,
    content_hash: full.sha256,
    size: String(full.buf.length),
    file: pointer,
    created_at: existing?.createdAt || now,
    updated_at: now,
  };
  if (existing !== null) await node.updateRecord({ schemaHash, fields, keyHash: key });
  else await node.createRecord({ schemaHash, fields, keyHash: key });
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
  verbose?: Verbose;
}): Promise<SealResult> {
  const { node, cfg, type, slug } = opts;
  const plan = planSeal(type, slug, opts.fields);
  // Reject invalid fields before schema declarations or blob/sidecar writes.
  assertFieldBudget(type, slug, plan.stored);
  const spilled: SpilledField[] = [];

  if (plan.spill.length > 0 || plan.pass.length > 0) {
    const schemaHash = await ensureBodyFileSchema(node, cfg, { persist: true });
    const results = await Promise.all(
      plan.spill.map(async (s) => {
        const { reused } = await commitSidecar({ node, schemaHash, type, slug, field: s.field, full: s.full });
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
    // A pass-through marker must still point at a real sidecar with that text.
    await Promise.all(
      plan.pass.map(async ({ field, marker }) => {
        const sidecar = await readMarkerSidecar(node, schemaHash, type, slug, field, marker.sha256);
        if (sidecar === null || sidecar.pointer === null || sidecar.contentHash !== marker.sha256 || sidecar.size !== marker.bytes) {
          throw new FbrainError({
            code: "body_spill_sidecar_mismatch",
            message: `${type} ${slug}: field ${field} carries a marker with no matching body file record.`,
            hint: "Read the record again with `brain get` and write the full text.",
          });
        }
      }),
    );
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

/** Throw a clear error when one field value is above the 48 KiB atom budget. */
export function assertFieldBudget(
  type: RecordType,
  slug: string,
  fields: Record<string, unknown>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    const size = serializedBytes(value);
    if (size > FIELD_MAX_BYTES) {
      throw new FbrainError({
        code: "record_field_too_large",
        message:
          `${type} ${slug}: field ${name} is ${size} bytes serialized; ` +
          `the atom budget is ${FIELD_MAX_BYTES} bytes (the node refuses 65536).`,
        hint:
          spillFieldsFor(type).includes(name)
            ? "Long text should have spilled to a body file."
            : "Shorten the field. Only body text spills to a file.",
      });
    }
  }
}

/** Projections that copy the whole record into an index row. Guarded by the plan. */
export function assertOpsFitAtomBudget(
  type: RecordType,
  slug: string,
  ops: ReadonlyArray<{ projection: string; keyHash: string; fields: Record<string, unknown> }>,
): void {
  for (const op of ops) {
    // Tag and backlink membership rows hold a growing list in one field. A
    // separate change moves them to one row per member, so they are not
    // guarded here: a guard would block a write that works today.
    if (op.projection === "tag" || op.projection === "backlink") continue;
    for (const [name, value] of Object.entries(op.fields)) {
      const size = serializedBytes(value);
      if (size > FIELD_MAX_BYTES) {
        throw new FbrainError({
          code: "record_field_too_large",
          message:
            `${type} ${slug}: ${op.projection} row ${op.keyHash} field ${name} is ${size} bytes serialized; ` +
            `the atom budget is ${FIELD_MAX_BYTES} bytes (the node refuses 65536).`,
          hint: "An index row copied a record that is too large. Shorten the record fields.",
        });
      }
    }
  }
}
