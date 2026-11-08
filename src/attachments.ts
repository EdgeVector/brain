import { canonicalProfilesForHashes } from "./canonical-vocabulary.ts";
// File attachments for brain knowledge records.
//
// Model (additive by construction — no existing schema changes, no record
// migration):
//
//   - `BrainAttachmentIndex` — one internal record per (record_type,
//     record_slug) that has attachments, keyed `__attidx__<sha256(type:slug)>`
//     Carries the attachment entries as JSON plus a `filenames` array — the
//     only word-indexed (searchable) surface.
//   - `BrainAttachmentFile` — one record per unique content hash (SHA-256 of
//     the raw file). The bytes are the record's own LastDB file: one
//     `POST /api/db/put-blob` stores the record and its file together, and
//     `POST /api/db/fetch-blob` reads them by schema and key. Reads are
//     sha256-verified here before any byte is handed back.

import { basename } from "node:path";
import { createHash } from "node:crypto";

import { BrainError, type NodeClient, type QueryRow, type Verbose } from "./client.ts";
import { fileOperation, readCompleteRecord } from "./complete-record.ts";
import { writeConfig, type Config } from "./config.ts";
import { nowIso } from "./record.ts";
import { RECORD_BUDGET_BYTES, recordBudgetMessage, recordBytes } from "./record-cap.ts";
import {
  ATTACHMENT_FILE_SCHEMA_KEY,
  ATTACHMENT_INDEX_SCHEMA_KEY,
  attachmentFileSchema,
  attachmentIndexSchema,
  OWNER_APP_ID,
  type RecordType,
} from "./schemas.ts";

export const ATTACHMENT_INDEX_SLUG_PREFIX = "__attidx__";

// Raw-file cap. The UDS transport caps request bodies at 64 MiB; base64
// inflates 4/3 and the file-blob JSON body adds overhead, so 32 MiB raw keeps
// a comfortable margin while covering the PDFs/images this is for.
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const INDEX_FIELDS = [
  "slug",
  "record_type",
  "record_slug",
  "filenames",
  "attachments_json",
  "created_at",
  "updated_at",
];

export type AttachmentEntry = {
  name: string;
  /** Brain's plaintext content identity, distinct from Mini's encrypted blob reference. */
  blob_ref: string;
  size: number;
  media_type: string;
  added_at: string;
};

export type AttachmentIndexRecord = {
  slug: string;
  record_type: string;
  record_slug: string;
  entries: AttachmentEntry[];
  created_at: string;
  updated_at: string;
};

export function attachmentIndexSlug(type: RecordType, slug: string): string {
  const digest = createHash("sha256").update(`${type}:${slug}`).digest("hex");
  return `${ATTACHMENT_INDEX_SLUG_PREFIX}${digest}`;
}

export function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function blobRefFor(bytes: Uint8Array): string {
  return `sha256:${sha256HexOf(bytes)}`;
}

// Small extension→MIME map for the formats that actually show up as brain
// attachments. Everything else is application/octet-stream — the media_type
// is display metadata, not a correctness surface.
const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

export function mediaTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

// Lazy schema declare: installs that ran `brain init` before attachments
// existed get the index and file schemas minted on first use, without a
// re-init. Persists the canonical hashes to config.
export async function ensureAttachmentSchemas(
  node: NodeClient,
  cfg: Config,
  opts: { persist: boolean; configPath?: string },
): Promise<{ indexHash: string; fileHash: string }> {
  const haveIndex = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
  const haveFile = cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
  if (haveIndex && haveFile) return { indexHash: haveIndex, fileHash: haveFile };
  if (!node.declareAppSchema) {
    throw new BrainError({
      code: "attachment_schema_unavailable",
      message: "This node cannot declare the brain attachment schemas.",
      hint: "Run `brain init` against a current Mini node, then retry.",
    });
  }
  const declaredIndex =
    haveIndex ??
    (await node.declareAppSchema(OWNER_APP_ID, attachmentIndexSchema.schema)).canonical;
  const declaredFile =
    haveFile ??
    (await node.declareAppSchema(OWNER_APP_ID, attachmentFileSchema.schema)).canonical;
  cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY] = declaredIndex;
  cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY] = declaredFile;
  if (cfg.schemaFieldAliases) cfg.schemaFieldAliases = {...cfg.schemaFieldAliases,...canonicalProfilesForHashes(cfg.schemaHashes)};
  if (opts.persist) {
    if (opts.configPath !== undefined) writeConfig(cfg, opts.configPath);
    else writeConfig(cfg);
  }
  return { indexHash: declaredIndex, fileHash: declaredFile };
}

function stringOf(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === "string" ? v : "";
}

export function parseAttachmentsJson(raw: string): AttachmentEntry[] {
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AttachmentEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) continue;
    if (typeof o.blob_ref !== "string" || !o.blob_ref.startsWith("sha256:")) continue;
    out.push({
      name: o.name,
      blob_ref: o.blob_ref,
      size: typeof o.size === "number" ? o.size : Number(o.size ?? 0) || 0,
      media_type: typeof o.media_type === "string" ? o.media_type : "application/octet-stream",
      added_at: typeof o.added_at === "string" ? o.added_at : "",
    });
  }
  return out;
}

// Keyed point-read with the queryAll fallback for mock/legacy clients that
// don't implement queryByKey.
async function queryRowByKey(
  node: NodeClient,
  schemaHash: string,
  fields: string[],
  keyHash: string,
): Promise<QueryRow | null> {
  if (node.queryByKey) {
    return node.queryByKey({ schemaHash, fields, keyHash });
  }
  return (
    (await node.queryAll({ schemaHash, fields })).results.find(
      (r) => r.key?.hash === keyHash || r.fields?.slug === keyHash,
    ) ?? null
  );
}

export async function readAttachmentIndex(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
): Promise<AttachmentIndexRecord | null> {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
  if (!schemaHash) return null;
  const key = attachmentIndexSlug(type, slug);
  const row = await queryRowByKey(node, schemaHash, INDEX_FIELDS, key);
  if (row === null) return null;
  return indexRowToRecord(row, key);
}

function indexRowToRecord(row: QueryRow, fallbackKey: string): AttachmentIndexRecord {
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringOf(fields, "slug") || fallbackKey,
    record_type: stringOf(fields, "record_type"),
    record_slug: stringOf(fields, "record_slug"),
    entries: parseAttachmentsJson(stringOf(fields, "attachments_json")),
    created_at: stringOf(fields, "created_at"),
    updated_at: stringOf(fields, "updated_at"),
  };
}

async function writeAttachmentIndex(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
  entries: AttachmentEntry[],
  existing: AttachmentIndexRecord | null,
): Promise<void> {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
  if (!schemaHash) {
    throw new BrainError({
      code: "attachment_schema_unavailable",
      message: "Attachment index schema hash missing from config.",
      hint: "Run `brain init`, then retry.",
    });
  }
  const key = attachmentIndexSlug(type, slug);
  const fields = attachmentIndexFields(type, slug, entries, existing, nowIso());
  if (existing) {
    await node.updateRecord({ schemaHash, fields, keyHash: key });
  } else {
    await node.createRecord({ schemaHash, fields, keyHash: key });
  }
}

function attachmentIndexFields(
  type: RecordType,
  slug: string,
  entries: readonly AttachmentEntry[],
  existing: AttachmentIndexRecord | null,
  now: string,
): Record<string, unknown> {
  return {
    slug: attachmentIndexSlug(type, slug),
    record_type: type,
    record_slug: slug,
    filenames: entries.map((e) => e.name),
    attachments_json: JSON.stringify(entries),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

// One index record holds every entry of one knowledge record, and a format 7
// home caps a whole record (src/record-cap.ts). Check before the file is
// stored, so a refused attach leaves no new file behind.
function assertIndexFitsRecordBudget(
  type: RecordType,
  slug: string,
  entries: readonly AttachmentEntry[],
  existing: AttachmentIndexRecord | null,
): void {
  const bytes = recordBytes(attachmentIndexFields(type, slug, entries, existing, nowIso()));
  if (bytes <= RECORD_BUDGET_BYTES) return;
  throw new BrainError({
    code: "attachment_index_full",
    message:
      recordBudgetMessage(`${type} ${slug} attachment index (${entries.length} entries)`, bytes) +
      " Nothing was written.",
    hint:
      "Detach files this record no longer needs, use shorter file names, or attach the files " +
      "to a successor record.",
  });
}

type BlobRecord = {
  content_hash: string;
  size: number;
  media_type: string;
  bytes: Uint8Array;
};

function requireFileSchemaHash(cfg: Config): string {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
  if (!schemaHash) {
    throw new BrainError({
      code: "attachment_schema_unavailable",
      message: "Attachment file schema hash missing from config.",
      hint: "Run `brain init` (or any `brain attach`), then retry.",
    });
  }
  return schemaHash;
}

// Map file-route failures.
function filePlaneError(path: string, status: number, body: string): BrainError {
  const excerpt = body.slice(0, 300);
  if (status === 404 || status === 405) {
    return new BrainError({
      code: "attachment_file_plane_unavailable",
      message: `Node ${path} answered ${status}: this node keeps no record files.`,
      hint: "Attachments need a LastDB Mini that serves POST /api/db/put-blob (API 23). Upgrade the node.",
    });
  }
  if (status === 409) {
    return new BrainError({code:"attachment_local_file_write_paused",message:"LastDB paused local file writes.",hint:"Read the node status before the next attempt."});
  }
  return new BrainError({
    code: "attachment_file_plane_error",
    message: `Node ${path} failed (${status}): ${excerpt}`,
    hint: "Retry; if it persists, inspect the node logs for the record file failure.",
  });
}

// The `file` object of a put-blob or fetch-blob reply. Accept a bare reply or a data envelope.
function replyFile(json: unknown): Record<string, unknown> | undefined {
  const root = (json ?? {}) as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | undefined;
  const file = root.file ?? data?.file;
  return file && typeof file === "object" ? (file as Record<string, unknown>) : undefined;
}

// Store file bytes as the file of a BrainAttachmentFile record keyed by the
// content hash, with its fields, in one put-blob write. Identical hash ⇒
// identical bytes, so an existing record is left untouched (metadata-only
// attach); the probe is a keyed point-read.
export async function putAttachmentBlob(
  node: NodeClient,
  cfg: Config,
  bytes: Uint8Array,
  mediaType: string,
  opts?: { name?: string },
): Promise<{ blobRef: string; deduplicated: boolean }> {
  const schemaHash = requireFileSchemaHash(cfg);
  const hash = sha256HexOf(bytes);
  const existing = await queryRowByKey(node, schemaHash, ["content_hash", "size"], hash);
  if (existing !== null) {
    return { blobRef: `sha256:${hash}`, deduplicated: true };
  }
  const path = "/api/db/put-blob";
  const stored = await node.rawCall("POST", path, {
    mutation: fileOperation(schemaHash, hash, { content_hash: hash, size: String(bytes.length), media_type: mediaType, created_at: nowIso() }),
    bytes_b64: Buffer.from(bytes).toString("base64"),
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    media_type: mediaType,
  });
  if (stored.status !== 200) throw filePlaneError(path, stored.status, stored.body);
  const file = replyFile(stored.json);
  if (file?.sha256 !== hash || file?.size_bytes !== bytes.length) {
    throw new BrainError({
      code: "attachment_file_plane_error",
      message: "The node stored an attachment file that differs from the sent bytes.",
      hint: "Re-attach the file. If it persists, inspect the node logs.",
    });
  }
  return { blobRef: `sha256:${hash}`, deduplicated: false };
}

// Fetch and integrity-verify file bytes for a `sha256:<hex>` ref. Hash
// mismatch or a missing file is a hard error.
export async function getAttachmentBlob(
  node: NodeClient,
  cfg: Config,
  blobRef: string,
): Promise<BlobRecord> {
  const hash = blobRef.startsWith("sha256:") ? blobRef.slice("sha256:".length) : blobRef;

  const fileSchemaHash = cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
  if (fileSchemaHash) {
    const row = await readCompleteRecord(node, fileSchemaHash, hash);
    if (row !== null) {
      const path = "/api/db/fetch-blob";
      const res = await node.rawCall("POST", path, { schema: fileSchemaHash, key: { hash }, expected_revision: row.revision });
      if (res.status === 404) {
        throw new BrainError({
          code: "attachment_blob_missing",
          message: `Attachment blob sha256:${hash} has a record but no file on this node.`,
          hint: "Re-attach the file from the original source.",
        });
      }
      if (res.status !== 200) {
        throw filePlaneError(path, res.status, res.body);
      }
      const file = replyFile(res.json);
      const b64 = file && typeof file.bytes_b64 === "string" ? file.bytes_b64 : "";
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const fields = (row.fields ?? {}) as Record<string, unknown>;
      return verifiedBlob(hash, bytes, stringOf(fields, "media_type"));
    }
  }

  throw new BrainError({
    code: "attachment_blob_missing",
    message: `Attachment blob sha256:${hash} is referenced but not present on this node.`,
    hint: "The blob record may not have synced yet; retry, or re-attach the file.",
  });
}

function verifiedBlob(hash: string, bytes: Uint8Array, mediaType: string): BlobRecord {
  const got = sha256HexOf(bytes);
  if (got !== hash) {
    throw new BrainError({
      code: "attachment_integrity_error",
      message: `Attachment blob sha256:${hash} decoded to bytes hashing ${got}.`,
      hint: "The stored blob is corrupt. Re-attach the file from the original source.",
    });
  }
  return {
    content_hash: hash,
    size: bytes.length,
    media_type: mediaType || "application/octet-stream",
    bytes,
  };
}

export type AttachResult = {
  entry: AttachmentEntry;
  blobDeduplicated: boolean;
  replaced: boolean;
};

// Attach `bytes` as `name` on (type, slug). Idempotent for identical content;
// same name + different content requires `force` (then the entry is replaced —
// the old blob stays in the CAS, which is append-only anyway).
export async function attachToRecord(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  slug: string;
  name: string;
  bytes: Uint8Array;
  force?: boolean;
  verbose?: Verbose;
}): Promise<AttachResult> {
  const { node, cfg, type, slug, bytes } = opts;
  const name = basename(opts.name);
  if (name.length === 0) {
    throw new BrainError({
      code: "attachment_bad_name",
      message: "Attachment name is empty.",
    });
  }
  if (bytes.length === 0) {
    throw new BrainError({
      code: "attachment_empty_file",
      message: `Refusing to attach zero-byte file "${name}".`,
    });
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new BrainError({
      code: "attachment_too_large",
      message: `"${name}" is ${bytes.length} bytes; the attachment cap is ${MAX_ATTACHMENT_BYTES} (32 MiB).`,
      hint: "Store the file elsewhere and attach a smaller pointer document, or split it.",
    });
  }

  const blobRef = blobRefFor(bytes);
  const existingIndex = await readAttachmentIndex(node, cfg, type, slug);
  const entries = existingIndex?.entries ?? [];
  const prior = entries.find((e) => e.name === name);
  if (prior && prior.blob_ref === blobRef) {
    return { entry: prior, blobDeduplicated: true, replaced: false };
  }
  if (prior && opts.force !== true) {
    throw new BrainError({
      code: "attachment_name_conflict",
      message: `"${name}" is already attached to ${type} ${slug} with different content (${prior.blob_ref}).`,
      hint: "Pass --force to replace it, or attach under a different name.",
    });
  }

  const mediaType = mediaTypeFor(name);
  const entry: AttachmentEntry = {
    name,
    blob_ref: blobRef,
    size: bytes.length,
    media_type: mediaType,
    added_at: nowIso(),
  };
  const next = prior ? entries.map((e) => (e.name === name ? entry : e)) : [...entries, entry];
  assertIndexFitsRecordBudget(type, slug, next, existingIndex);
  const put = await putAttachmentBlob(node, cfg, bytes, mediaType, { name });
  await writeAttachmentIndex(node, cfg, type, slug, next, existingIndex);
  return { entry, blobDeduplicated: put.deduplicated, replaced: prior !== undefined };
}

export type DetachResult = { removed: AttachmentEntry };

// Remove one attachment entry by filename or blob ref. The blob stays in the
// CAS (fold_db is append-only; identical content may also back other records'
// attachments).
export async function detachFromRecord(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  slug: string;
  nameOrRef: string;
}): Promise<DetachResult> {
  const { node, cfg, type, slug, nameOrRef } = opts;
  const index = await readAttachmentIndex(node, cfg, type, slug);
  const entries = index?.entries ?? [];
  const match = findEntry(entries, nameOrRef);
  if (match === null) {
    throw new BrainError({
      code: "attachment_not_found",
      message: `No attachment "${nameOrRef}" on ${type} ${slug}.`,
      hint: `Run \`brain attachments ${slug}\` to list what is attached.`,
    });
  }
  const next = entries.filter((e) => e !== match);
  await writeAttachmentIndex(node, cfg, type, slug, next, index);
  return { removed: match };
}

export function findEntry(
  entries: readonly AttachmentEntry[],
  nameOrRef: string,
): AttachmentEntry | null {
  const byName = entries.find((e) => e.name === nameOrRef);
  if (byName) return byName;
  const ref = nameOrRef.startsWith("sha256:") ? nameOrRef : `sha256:${nameOrRef}`;
  return entries.find((e) => e.blob_ref === ref) ?? null;
}
