// File attachments for fbrain knowledge records.
//
// Model (additive by construction — no existing schema changes, no record
// migration):
//
//   - `BrainAttachmentIndex` — one internal record per (record_type,
//     record_slug) that has attachments, keyed `__attidx__<sha256(type:slug)>`
//     (the TagIndex pattern). Carries the attachment entries as JSON plus a
//     `filenames` array — the only word-indexed (searchable) surface.
//   - `BrainAttachmentFile` — one record per unique content hash (SHA-256 of
//     the raw file). The bytes do NOT live in the record: `POST
//     /api/db/file-blob` uploads them as an encrypted CAS blob to B2
//     (`{scope}/cas/sha256/…`, metered as file bytes — fold
//     docs/designs/cloud-file-blobs-on-demand-sync.md) and persists the
//     returned `$lastdb_file` pointer into the record's `file` field. Reads go
//     through `POST /api/db/fetch-file-blob` with that pointer and are
//     sha256-verified here before any byte is handed back.
//   - `BrainAttachmentBlob` — LEGACY v1 stand-in (base64 bytes in a no_index
//     record field, riding cloud sync as DB bytes). Nothing writes it anymore;
//     `getAttachmentBlob` still falls back to it for unmigrated content and
//     `migrateAttachmentsToFilePlane` moves v1 blobs into the file plane and
//     deletes the stand-in records.
//
// The blob plane stays deliberately isolated in this module: CLI verbs, the
// index schema, and the attachments_json entry shape are identical to v1.

import { basename } from "node:path";
import { createHash } from "node:crypto";

import { FbrainError, type NodeClient, type QueryRow, type Verbose } from "./client.ts";
import { writeConfig, type Config } from "./config.ts";
import { nowIso } from "./record.ts";
import {
  ATTACHMENT_BLOB_SCHEMA_KEY,
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

// Legacy v1 blob record projection (base64 `data` field).
const BLOB_FIELDS = ["content_hash", "size", "media_type", "data", "created_at"];

// v2 pointer record projection (`file` carries the $lastdb_file pointer).
const FILE_FIELDS = ["content_hash", "size", "media_type", "file", "created_at"];

export type AttachmentEntry = {
  name: string;
  /** `sha256:<hex>` — matches fold's CAS blob_ref convention. */
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

export function attachmentSchemasAvailable(cfg: Config): boolean {
  return (
    (cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY] ?? "").length > 0 &&
    (cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY] ?? "").length > 0
  );
}

// Lazy schema declare (the admin-snapshot pattern): installs that ran
// `fbrain init` before attachments existed get the index + file schemas
// minted on first use, without a re-init. Persists the canonical hashes to
// config. The legacy v1 blob schema is intentionally NOT declared here — an
// install only has legacy blob records if it already declared that schema
// (its hash is then already in config), and fresh installs never write it.
export async function ensureAttachmentSchemas(
  node: NodeClient,
  cfg: Config,
  opts: { persist: boolean; configPath?: string },
): Promise<{ indexHash: string; fileHash: string }> {
  const haveIndex = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
  const haveFile = cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
  if (haveIndex && haveFile) return { indexHash: haveIndex, fileHash: haveFile };
  if (!node.declareAppSchema) {
    throw new FbrainError({
      code: "attachment_schema_unavailable",
      message: "This node cannot declare the fbrain attachment schemas.",
      hint: "Run `fbrain init` against a current Mini node, then retry.",
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
    throw new FbrainError({
      code: "attachment_schema_unavailable",
      message: "Attachment index schema hash missing from config.",
      hint: "Run `fbrain init`, then retry.",
    });
  }
  const key = attachmentIndexSlug(type, slug);
  const now = nowIso();
  const fields = {
    slug: key,
    record_type: type,
    record_slug: slug,
    filenames: entries.map((e) => e.name),
    attachments_json: JSON.stringify(entries),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  if (existing) {
    await node.updateRecord({ schemaHash, fields, keyHash: key });
  } else {
    await node.createRecord({ schemaHash, fields, keyHash: key });
  }
}

export type BlobRecord = {
  content_hash: string;
  size: number;
  media_type: string;
  bytes: Uint8Array;
};

function requireFileSchemaHash(cfg: Config): string {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
  if (!schemaHash) {
    throw new FbrainError({
      code: "attachment_schema_unavailable",
      message: "Attachment file schema hash missing from config.",
      hint: "Run `fbrain init` (or any `fbrain attach`), then retry.",
    });
  }
  return schemaHash;
}

// Map a non-200 from the node's file-blob plane to an actionable error. The
// two structural cases get their own hints: 501 = the daemon binary was built
// without cloud-sync; 409 = cloud sync is not configured on this node (the
// file plane uploads through the sync engine's B2 credentials).
function filePlaneError(path: string, status: number, body: string): FbrainError {
  const excerpt = body.slice(0, 300);
  if (status === 501) {
    return new FbrainError({
      code: "attachment_file_plane_unavailable",
      message: `Node ${path} says cloud-sync support is not compiled into this daemon.`,
      hint: "Attachments need a cloud-sync-capable lastdbd. Upgrade the node binary.",
    });
  }
  if (status === 409) {
    return new FbrainError({
      code: "attachment_file_plane_unavailable",
      message: `Node ${path} says cloud sync is not configured on this node.`,
      hint: "Attachment bytes upload through cloud sync. Configure/enable cloud sync, then retry.",
    });
  }
  return new FbrainError({
    code: "attachment_file_plane_error",
    message: `Node ${path} failed (${status}): ${excerpt}`,
    hint: "Retry; if it persists, inspect the node logs for the file-blob plane failure.",
  });
}

// Extract the `$lastdb_file` pointer from a BrainAttachmentFile row. Tolerates
// a JSON-string round-trip of the field value but requires the pointer shape.
function pointerFromFileRow(row: QueryRow, hash: string): Record<string, unknown> {
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  let pointer: unknown = fields.file;
  if (typeof pointer === "string") {
    try {
      pointer = JSON.parse(pointer);
    } catch {
      pointer = null;
    }
  }
  if (
    pointer === null ||
    typeof pointer !== "object" ||
    typeof (pointer as Record<string, unknown>).$lastdb_file !== "object"
  ) {
    throw new FbrainError({
      code: "attachment_pointer_invalid",
      message: `Attachment file record sha256:${hash} does not carry a $lastdb_file pointer.`,
      hint: "The pointer record is corrupt. Re-attach the file from the original source.",
    });
  }
  return pointer as Record<string, unknown>;
}

// CAS put through the node's file-blob plane: upload bytes as an encrypted B2
// CAS blob and persist the `$lastdb_file` pointer into a BrainAttachmentFile
// record keyed by the content hash. Identical hash ⇒ identical bytes, so an
// existing pointer record is left untouched (metadata-only attach); the probe
// is a keyed point-read.
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
  const res = await node.rawCall("POST", "/api/db/file-blob", {
    schema: schemaHash,
    field: "file",
    key: { hash, range: null },
    bytes_b64: Buffer.from(bytes).toString("base64"),
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    media_type: mediaType,
    mutation_type: "Create",
    // Seed the local CAS cache so `attachment get` on the attaching device
    // round-trips without a B2 download.
    cache_local_plaintext: true,
    additional_fields: {
      content_hash: hash,
      size: String(bytes.length),
      media_type: mediaType,
      created_at: nowIso(),
    },
  });
  if (res.status !== 200) {
    throw filePlaneError("/api/db/file-blob", res.status, res.body);
  }
  const fileBlob =
    res.json && typeof res.json === "object"
      ? ((res.json as Record<string, unknown>).file_blob as Record<string, unknown> | undefined)
      : undefined;
  if (!fileBlob || typeof fileBlob.blob_ref !== "string") {
    throw new FbrainError({
      code: "attachment_file_plane_error",
      message: `Node /api/db/file-blob returned an incomplete response: ${res.body.slice(0, 300)}.`,
      hint: "Upgrade the node or inspect the file-blob response shape.",
    });
  }
  return { blobRef: `sha256:${hash}`, deduplicated: false };
}

// Fetch + integrity-verify blob bytes for a `sha256:<hex>` ref. Prefers the
// v2 file plane (pointer record → /api/db/fetch-file-blob), falls back to a
// legacy v1 base64 blob record for unmigrated content. Hash mismatch or
// missing blob is a hard error — never hand back unverified bytes.
export async function getAttachmentBlob(
  node: NodeClient,
  cfg: Config,
  blobRef: string,
): Promise<BlobRecord> {
  const hash = blobRef.startsWith("sha256:") ? blobRef.slice("sha256:".length) : blobRef;

  const fileSchemaHash = cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
  if (fileSchemaHash) {
    const row = await queryRowByKey(node, fileSchemaHash, FILE_FIELDS, hash);
    if (row !== null) {
      const pointer = pointerFromFileRow(row, hash);
      const res = await node.rawCall("POST", "/api/db/fetch-file-blob", { pointer });
      if (res.status === 404) {
        throw new FbrainError({
          code: "attachment_blob_missing",
          message: `Attachment blob sha256:${hash} was not found locally or in remote CAS.`,
          hint: "The blob may not have synced yet; retry, or re-attach the file.",
        });
      }
      if (res.status !== 200) {
        throw filePlaneError("/api/db/fetch-file-blob", res.status, res.body);
      }
      const fileBlob =
        res.json && typeof res.json === "object"
          ? ((res.json as Record<string, unknown>).file_blob as Record<string, unknown> | undefined)
          : undefined;
      const b64 = fileBlob && typeof fileBlob.bytes_b64 === "string" ? fileBlob.bytes_b64 : "";
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const fields = (row.fields ?? {}) as Record<string, unknown>;
      return verifiedBlob(hash, bytes, stringOf(fields, "media_type"));
    }
  }

  const legacySchemaHash = cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY];
  if (legacySchemaHash) {
    const row = await queryRowByKey(node, legacySchemaHash, BLOB_FIELDS, hash);
    if (row !== null) {
      const fields = (row.fields ?? {}) as Record<string, unknown>;
      const bytes = new Uint8Array(Buffer.from(stringOf(fields, "data"), "base64"));
      return verifiedBlob(hash, bytes, stringOf(fields, "media_type"));
    }
  }

  throw new FbrainError({
    code: "attachment_blob_missing",
    message: `Attachment blob sha256:${hash} is referenced but not present on this node.`,
    hint: "The blob record may not have synced yet; retry, or re-attach the file.",
  });
}

function verifiedBlob(hash: string, bytes: Uint8Array, mediaType: string): BlobRecord {
  const got = sha256HexOf(bytes);
  if (got !== hash) {
    throw new FbrainError({
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
    throw new FbrainError({
      code: "attachment_bad_name",
      message: "Attachment name is empty.",
    });
  }
  if (bytes.length === 0) {
    throw new FbrainError({
      code: "attachment_empty_file",
      message: `Refusing to attach zero-byte file "${name}".`,
    });
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new FbrainError({
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
    throw new FbrainError({
      code: "attachment_name_conflict",
      message: `"${name}" is already attached to ${type} ${slug} with different content (${prior.blob_ref}).`,
      hint: "Pass --force to replace it, or attach under a different name.",
    });
  }

  const mediaType = mediaTypeFor(name);
  const put = await putAttachmentBlob(node, cfg, bytes, mediaType, { name });
  const entry: AttachmentEntry = {
    name,
    blob_ref: blobRef,
    size: bytes.length,
    media_type: mediaType,
    added_at: nowIso(),
  };
  const next = prior ? entries.map((e) => (e.name === name ? entry : e)) : [...entries, entry];
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
    throw new FbrainError({
      code: "attachment_not_found",
      message: `No attachment "${nameOrRef}" on ${type} ${slug}.`,
      hint: `Run \`fbrain attachments ${slug}\` to list what is attached.`,
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

// ── v1 → v2 migration ──────────────────────────────────────────────────────

export type AttachmentMigrationItem = {
  blob_ref: string;
  /** every attachment entry name that references this blob */
  names: string[];
  action: "migrated" | "already-file-plane" | "missing";
  legacyDeleted: boolean;
};

export type AttachmentMigrationReport = {
  indexes: number;
  items: AttachmentMigrationItem[];
};

// Move record-stored v1 attachment blobs into the file plane: for every blob
// referenced by an attachment index (optionally scoped to one record), read
// the legacy base64 record, sha256-verify it, upload through
// `POST /api/db/file-blob` (creating the BrainAttachmentFile pointer record),
// and DELETE the legacy stand-in record so its bytes stop riding the DB
// plane. Idempotent: blobs already in the file plane are skipped (their
// legacy records are still deleted if present); re-running is safe.
export async function migrateAttachmentsToFilePlane(opts: {
  node: NodeClient;
  cfg: Config;
  type?: RecordType;
  slug?: string;
  verbose?: Verbose;
}): Promise<AttachmentMigrationReport> {
  const { node, cfg } = opts;
  const fileSchemaHash = requireFileSchemaHash(cfg);
  const legacySchemaHash = cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY];

  let indexes: AttachmentIndexRecord[];
  if (opts.type !== undefined && opts.slug !== undefined) {
    const one = await readAttachmentIndex(node, cfg, opts.type, opts.slug);
    indexes = one === null ? [] : [one];
  } else {
    const indexSchemaHash = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
    if (!indexSchemaHash) {
      return { indexes: 0, items: [] };
    }
    const all = await node.queryAll({ schemaHash: indexSchemaHash, fields: INDEX_FIELDS });
    indexes = all.results.map((row) => indexRowToRecord(row, row.key?.hash ?? ""));
  }

  // Unique blobs across every in-scope entry (CAS: one upload per hash).
  const byHash = new Map<string, { names: string[]; media_type: string }>();
  for (const index of indexes) {
    for (const entry of index.entries) {
      const hash = entry.blob_ref.slice("sha256:".length);
      const seen = byHash.get(hash);
      if (seen) {
        if (!seen.names.includes(entry.name)) seen.names.push(entry.name);
      } else {
        byHash.set(hash, { names: [entry.name], media_type: entry.media_type });
      }
    }
  }

  const items: AttachmentMigrationItem[] = [];
  for (const [hash, meta] of byHash) {
    const inFilePlane =
      (await queryRowByKey(node, fileSchemaHash, ["content_hash"], hash)) !== null;
    let action: AttachmentMigrationItem["action"];
    let legacyRow: QueryRow | null = null;
    if (legacySchemaHash) {
      legacyRow = await queryRowByKey(node, legacySchemaHash, BLOB_FIELDS, hash);
    }
    if (inFilePlane) {
      action = "already-file-plane";
    } else if (legacyRow === null) {
      // Nothing to migrate from and nothing in the file plane — surface it
      // rather than silently dropping the reference.
      action = "missing";
    } else {
      const fields = (legacyRow.fields ?? {}) as Record<string, unknown>;
      const bytes = new Uint8Array(Buffer.from(stringOf(fields, "data"), "base64"));
      // Hard integrity gate BEFORE upload: never launder a corrupt legacy
      // blob into the file plane.
      verifiedBlob(hash, bytes, meta.media_type);
      await putAttachmentBlob(node, cfg, bytes, meta.media_type, { name: meta.names[0]! });
      action = "migrated";
    }
    let legacyDeleted = false;
    if (legacyRow !== null && legacySchemaHash && action !== "missing") {
      // Fetch-back gate BEFORE the destructive step: prove the file plane can
      // serve these exact bytes (getAttachmentBlob prefers the pointer record
      // and sha256-verifies) before the legacy copy goes away. Also covers a
      // prior run that crashed between upload and delete.
      await getAttachmentBlob(node, cfg, `sha256:${hash}`);
      await node.deleteRecord({ schemaHash: legacySchemaHash, keyHash: hash });
      legacyDeleted = true;
    }
    items.push({ blob_ref: `sha256:${hash}`, names: meta.names, action, legacyDeleted });
  }
  return { indexes: indexes.length, items };
}
