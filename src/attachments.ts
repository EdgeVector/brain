// File attachments for fbrain knowledge records.
//
// Model (additive by construction — no existing schema changes, no record
// migration):
//
//   - `BrainAttachmentIndex` — one internal record per (record_type,
//     record_slug) that has attachments, keyed `__attidx__<sha256(type:slug)>`
//     (the TagIndex pattern). Carries the attachment entries as JSON plus a
//     `filenames` array — the only word-indexed (searchable) surface.
//   - `BrainAttachmentBlob` — content-addressed file bytes keyed by SHA-256 of
//     the raw file. Base64 `data` is classified no_index/binary, so file
//     content never enters BM25/vector search. Identical bytes attach once
//     (CAS): re-attaching the same content is metadata-only.
//
// The blob plane is deliberately isolated in this module: Mini/lastdbd has no
// `/api/app/blob/cas/sha256/*` routes yet (they 404; see fold
// docs/designs/cloud-file-blobs-on-demand-sync.md), so v1 stores bytes in the
// blob record — the same stand-in lastgit uses for pack bytes. When the node
// grows real CAS routes + `$lastdb_file` pointers, swap the storage here and
// the CLI verbs stay put.

import { basename } from "node:path";
import { createHash } from "node:crypto";

import { FbrainError, type NodeClient, type Verbose } from "./client.ts";
import { writeConfig, type Config } from "./config.ts";
import { nowIso } from "./record.ts";
import {
  ATTACHMENT_BLOB_SCHEMA_KEY,
  ATTACHMENT_INDEX_SCHEMA_KEY,
  attachmentBlobSchema,
  attachmentIndexSchema,
  OWNER_APP_ID,
  type RecordType,
} from "./schemas.ts";

export const ATTACHMENT_INDEX_SLUG_PREFIX = "__attidx__";

// Raw-file cap. The UDS transport caps request bodies at 64 MiB; base64
// inflates 4/3 and the mutation JSON adds overhead, so 32 MiB raw keeps a
// comfortable margin while covering the PDFs/images this is for.
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

const BLOB_FIELDS = ["content_hash", "size", "media_type", "data", "created_at"];

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
    (cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY] ?? "").length > 0
  );
}

// Lazy schema declare (the admin-snapshot pattern): installs that ran
// `fbrain init` before attachments existed get the two schemas minted on
// first use, without a re-init. Persists the canonical hashes to config.
export async function ensureAttachmentSchemas(
  node: NodeClient,
  cfg: Config,
  opts: { persist: boolean; configPath?: string },
): Promise<{ indexHash: string; blobHash: string }> {
  const haveIndex = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
  const haveBlob = cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY];
  if (haveIndex && haveBlob) return { indexHash: haveIndex, blobHash: haveBlob };
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
  const declaredBlob =
    haveBlob ??
    (await node.declareAppSchema(OWNER_APP_ID, attachmentBlobSchema.schema)).canonical;
  cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY] = declaredIndex;
  cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY] = declaredBlob;
  if (opts.persist) {
    if (opts.configPath !== undefined) writeConfig(cfg, opts.configPath);
    else writeConfig(cfg);
  }
  return { indexHash: declaredIndex, blobHash: declaredBlob };
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

export async function readAttachmentIndex(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
): Promise<AttachmentIndexRecord | null> {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
  if (!schemaHash) return null;
  const key = attachmentIndexSlug(type, slug);
  const row = node.queryByKey
    ? await node.queryByKey({ schemaHash, fields: INDEX_FIELDS, keyHash: key })
    : ((await node.queryAll({ schemaHash, fields: INDEX_FIELDS, allowFullScan: true })).results.find(
        (r) => r.key?.hash === key || r.fields?.slug === key,
      ) ?? null);
  if (row === null) return null;
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringOf(fields, "slug") || key,
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

// CAS put: identical hash ⇒ identical bytes, so an existing blob record is
// left untouched (metadata-only attach). Probe is a keyed point-read.
export async function putAttachmentBlob(
  node: NodeClient,
  cfg: Config,
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ blobRef: string; deduplicated: boolean }> {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY];
  if (!schemaHash) {
    throw new FbrainError({
      code: "attachment_schema_unavailable",
      message: "Attachment blob schema hash missing from config.",
      hint: "Run `fbrain init`, then retry.",
    });
  }
  const hash = sha256HexOf(bytes);
  const existing = node.queryByKey
    ? await node.queryByKey({ schemaHash, fields: ["content_hash", "size"], keyHash: hash })
    : ((await node.queryAll({ schemaHash, fields: ["content_hash", "size"], allowFullScan: true })).results.find(
        (r) => r.key?.hash === hash,
      ) ?? null);
  if (existing !== null) {
    return { blobRef: `sha256:${hash}`, deduplicated: true };
  }
  await node.createRecord({
    schemaHash,
    keyHash: hash,
    fields: {
      content_hash: hash,
      size: String(bytes.length),
      media_type: mediaType,
      data: Buffer.from(bytes).toString("base64"),
      created_at: nowIso(),
    },
  });
  return { blobRef: `sha256:${hash}`, deduplicated: false };
}

// Fetch + integrity-verify blob bytes for a `sha256:<hex>` ref. Hash mismatch
// or missing blob is a hard error — never hand back unverified bytes.
export async function getAttachmentBlob(
  node: NodeClient,
  cfg: Config,
  blobRef: string,
): Promise<BlobRecord> {
  const schemaHash = cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY];
  if (!schemaHash) {
    throw new FbrainError({
      code: "attachment_schema_unavailable",
      message: "Attachment blob schema hash missing from config.",
      hint: "Run `fbrain init`, then retry.",
    });
  }
  const hash = blobRef.startsWith("sha256:") ? blobRef.slice("sha256:".length) : blobRef;
  const row = node.queryByKey
    ? await node.queryByKey({ schemaHash, fields: BLOB_FIELDS, keyHash: hash })
    : ((await node.queryAll({ schemaHash, fields: BLOB_FIELDS, allowFullScan: true })).results.find(
        (r) => r.key?.hash === hash,
      ) ?? null);
  if (row === null) {
    throw new FbrainError({
      code: "attachment_blob_missing",
      message: `Attachment blob sha256:${hash} is referenced but not present on this node.`,
      hint: "The blob record may not have synced yet; retry, or re-attach the file.",
    });
  }
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  const b64 = stringOf(fields, "data");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
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
    media_type: stringOf(fields, "media_type") || "application/octet-stream",
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
// the old blob record remains in CAS, which is append-only anyway).
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
  const put = await putAttachmentBlob(node, cfg, bytes, mediaType);
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

// Remove one attachment entry by filename or blob ref. The blob record stays
// in the CAS (fold_db is append-only; identical content may also back other
// records' attachments).
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
