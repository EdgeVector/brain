import { describe, expect, test } from "bun:test";

import {
  attachmentIndexSlug,
  attachToRecord,
  blobRefFor,
  detachFromRecord,
  ensureAttachmentSchemas,
  findEntry,
  getAttachmentBlob,
  MAX_ATTACHMENT_BYTES,
  mediaTypeFor,
  migrateAttachmentsToFilePlane,
  parseAttachmentsJson,
  putAttachmentBlob,
  readAttachmentIndex,
  sha256HexOf,
} from "../../src/attachments.ts";
import {
  FbrainError,
  type NodeClient,
  type QueryResponse,
  type QueryRow,
} from "../../src/client.ts";
import type { Config } from "../../src/config.ts";
import {
  ATTACHMENT_BLOB_SCHEMA_KEY,
  ATTACHMENT_FILE_SCHEMA_KEY,
  ATTACHMENT_INDEX_SCHEMA_KEY,
  attachmentBlobSchema,
  attachmentFileSchema,
  attachmentIndexSchema,
} from "../../src/schemas.ts";
import { buildTestCfg } from "../util.ts";

const INDEX_HASH = "attidx-hash";
const FILE_HASH_SCHEMA = "attfile-hash";
const LEGACY_BLOB_HASH_SCHEMA = "attblob-hash";

function attachCfg(): Config {
  const c = buildTestCfg({ userHash: "uh" });
  c.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY] = INDEX_HASH;
  c.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY] = FILE_HASH_SCHEMA;
  c.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY] = LEGACY_BLOB_HASH_SCHEMA;
  return c;
}

type RowFields = Record<string, unknown>;

type MockState = {
  store: Map<string, Map<string, RowFields>>;
  declared: string[];
  // The mock file plane: blob_ref → base64 ciphertext-stand-in. Written by
  // POST /api/db/file-blob, read by POST /api/db/fetch-file-blob.
  cas: Map<string, string>;
  filePlaneCalls: { path: string; body: unknown }[];
};

function newState(): MockState {
  return { store: new Map(), declared: [], cas: new Map(), filePlaneCalls: [] };
}

function seed(state: MockState, schemaHash: string, key: string, fields: RowFields): void {
  let rows = state.store.get(schemaHash);
  if (!rows) {
    rows = new Map();
    state.store.set(schemaHash, rows);
  }
  rows.set(key, fields);
}

function seedLegacyBlob(state: MockState, bytes: Uint8Array, mediaType: string): string {
  const hash = sha256HexOf(bytes);
  seed(state, LEGACY_BLOB_HASH_SCHEMA, hash, {
    content_hash: hash,
    size: String(bytes.length),
    media_type: mediaType,
    data: Buffer.from(bytes).toString("base64"),
    created_at: "t",
  });
  return hash;
}

function mockNode(state: MockState): NodeClient {
  return {
    baseUrl: "mock",
    userHash: "uh",
    async autoIdentity() {
      return { provisioned: true, userHash: "uh" };
    },
    async health() {
      return { ok: true, uptime_s: 1 };
    },
    async bootstrap() {
      return { userHash: "uh" };
    },
    async requestConsent() {
      return { status: 202, body: { request_id: "r" } };
    },
    async consentStatus() {
      return { status: 200, body: { status: "granted" } };
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async listLoadedSchemas() {
      return [];
    },
    async declareAppSchema(_appId, schema) {
      state.declared.push(schema.name);
      return {
        app_id: "fbrain",
        schema: schema.name,
        canonical: `declared:${schema.name}`,
        resolution: "mint",
      };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      if (state.store.get(schemaHash)?.has(keyHash)) {
        throw new FbrainError({
          code: "node_http_409",
          message: `Record already exists: ${keyHash}`,
        });
      }
      seed(state, schemaHash, keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      seed(state, schemaHash, keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      state.store.get(schemaHash)?.delete(keyHash);
    },
    async queryAll({ schemaHash }): Promise<QueryResponse> {
      const rows = state.store.get(schemaHash);
      if (!rows) return { ok: true, results: [], total_count: 0, returned_count: 0 };
      const results: QueryRow[] = [...rows.entries()].map(([hash, fields]) => ({
        fields,
        key: { hash, range: null },
      }));
      return { ok: true, results, total_count: results.length, returned_count: results.length };
    },
    async queryByKey({ schemaHash, keyHash }): Promise<QueryRow | null> {
      const fields = state.store.get(schemaHash)?.get(keyHash);
      return fields ? { fields, key: { hash: keyHash, range: null } } : null;
    },
    async search() {
      return [];
    },
    // The mock file-blob plane, mirroring the Mini's owner-socket routes:
    // POST /api/db/file-blob uploads bytes to the CAS and persists a
    // `$lastdb_file` pointer into the requested schema field; POST
    // /api/db/fetch-file-blob resolves a pointer back to bytes.
    async rawCall(_method, path, body) {
      state.filePlaneCalls.push({ path, body });
      const b = (body ?? {}) as Record<string, unknown>;
      if (path === "/api/db/file-blob") {
        const schema = String(b.schema ?? "");
        const field = String(b.field ?? "");
        const key = (b.key ?? {}) as { hash?: string };
        const bytesB64 = String(b.bytes_b64 ?? "");
        const additional = (b.additional_fields ?? {}) as RowFields;
        const fileHash = sha256HexOf(new Uint8Array(Buffer.from(bytesB64, "base64")));
        const blobRef = `b2:${fileHash}`;
        state.cas.set(blobRef, bytesB64);
        const pointer = {
          $lastdb_file: {
            blob_ref: blobRef,
            file_hash: fileHash,
            cipher_suite: "test",
            dek: "test-dek",
            ...(typeof b.name === "string" ? { name: b.name } : {}),
            ...(typeof b.media_type === "string" ? { media_type: b.media_type } : {}),
          },
        };
        seed(state, schema, key.hash ?? "", { ...additional, [field]: pointer });
        const json = {
          ok: true,
          file_blob: { pointer, blob_ref: blobRef, file_hash: fileHash, mutation_ids: ["m1"] },
        };
        return { status: 200, headers: new Headers(), body: JSON.stringify(json), json };
      }
      if (path === "/api/db/fetch-file-blob") {
        const pointer = (b.pointer ?? {}) as Record<string, unknown>;
        const inner = (pointer.$lastdb_file ?? {}) as Record<string, unknown>;
        const blobRef = typeof inner.blob_ref === "string" ? inner.blob_ref : "";
        const stored = state.cas.get(blobRef);
        if (stored === undefined) {
          return { status: 404, headers: new Headers(), body: "Not Found", json: null };
        }
        const json = {
          ok: true,
          file_blob: { blob_ref: blobRef, bytes_b64: stored, cached: true },
        };
        return { status: 200, headers: new Headers(), body: JSON.stringify(json), json };
      }
      return { status: 404, headers: new Headers(), body: "Not Found", json: null };
    },
  };
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 fake pdf body for tests");

describe("attachment schemas", () => {
  test("index schema word-indexes ONLY filenames; everything else is no_index", () => {
    const cls = attachmentIndexSchema.schema.field_classifications!;
    for (const field of attachmentIndexSchema.schema.fields) {
      expect(cls[field]).toBeDefined();
      if (field === "filenames") {
        expect(cls[field]).toEqual(["word"]);
      } else {
        expect(cls[field]).toContain("no_index");
      }
    }
  });

  test("file schema classifies every field no_index; pointer field is typed Any", () => {
    const cls = attachmentFileSchema.schema.field_classifications!;
    for (const field of attachmentFileSchema.schema.fields) {
      expect(cls[field]).toContain("no_index");
    }
    expect(attachmentFileSchema.schema.field_types.file).toBe("Any");
    expect(attachmentFileSchema.schema.key).toEqual({ hash_field: "content_hash" });
  });

  test("legacy blob schema still classifies every field no_index; data is binary", () => {
    const cls = attachmentBlobSchema.schema.field_classifications!;
    for (const field of attachmentBlobSchema.schema.fields) {
      expect(cls[field]).toContain("no_index");
    }
    expect(cls.data).toEqual(["no_index", "binary"]);
  });

  test("index slugs are reserved, stable, and type-scoped", () => {
    expect(attachmentIndexSlug("project", "p")).toMatch(/^__attidx__[0-9a-f]{64}$/);
    expect(attachmentIndexSlug("project", "p")).toBe(attachmentIndexSlug("project", "p"));
    expect(attachmentIndexSlug("project", "p")).not.toBe(attachmentIndexSlug("concept", "p"));
  });
});

describe("ensureAttachmentSchemas", () => {
  test("declares index + file schemas lazily and stores hashes in config", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = buildTestCfg({ userHash: "uh" });
    delete cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
    delete cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY];
    const { indexHash, fileHash } = await ensureAttachmentSchemas(node, cfg, { persist: false });
    expect(state.declared).toEqual(["BrainAttachmentIndex", "BrainAttachmentFile"]);
    expect(indexHash).toBe("declared:BrainAttachmentIndex");
    expect(fileHash).toBe("declared:BrainAttachmentFile");
    expect(cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY]).toBe(indexHash);
    expect(cfg.schemaHashes[ATTACHMENT_FILE_SCHEMA_KEY]).toBe(fileHash);
  });

  test("no-op when hashes already present", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const out = await ensureAttachmentSchemas(node, cfg, { persist: false });
    expect(out).toEqual({ indexHash: INDEX_HASH, fileHash: FILE_HASH_SCHEMA });
    expect(state.declared).toEqual([]);
  });
});

describe("attach / list / detach / get round-trip (file plane)", () => {
  test("attach uploads through /api/db/file-blob and stores a pointer record; get round-trips byte-identical", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();

    const result = await attachToRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      name: "agreement.pdf",
      bytes: PDF_BYTES,
    });
    expect(result.entry.blob_ref).toBe(blobRefFor(PDF_BYTES));
    expect(result.entry.media_type).toBe("application/pdf");
    expect(result.entry.size).toBe(PDF_BYTES.length);
    expect(result.blobDeduplicated).toBe(false);
    expect(result.replaced).toBe(false);

    // Bytes live in the file plane, not in any record.
    expect(state.filePlaneCalls.map((c) => c.path)).toContain("/api/db/file-blob");
    expect(state.cas.size).toBe(1);
    const hash = sha256HexOf(PDF_BYTES);
    const pointerRow = state.store.get(FILE_HASH_SCHEMA)!.get(hash)!;
    expect(pointerRow.content_hash).toBe(hash);
    expect((pointerRow.file as Record<string, unknown>).$lastdb_file).toBeDefined();
    expect(JSON.stringify(pointerRow)).not.toContain(Buffer.from(PDF_BYTES).toString("base64"));
    // Nothing was written to the legacy v1 blob schema.
    expect(state.store.get(LEGACY_BLOB_HASH_SCHEMA)).toBeUndefined();

    const index = await readAttachmentIndex(node, cfg, "project", "labs");
    expect(index).not.toBeNull();
    expect(index!.entries.map((e) => e.name)).toEqual(["agreement.pdf"]);
    expect(index!.record_type).toBe("project");
    expect(index!.record_slug).toBe("labs");

    const blob = await getAttachmentBlob(node, cfg, result.entry.blob_ref);
    expect(sha256HexOf(blob.bytes)).toBe(sha256HexOf(PDF_BYTES));
    expect([...blob.bytes]).toEqual([...PDF_BYTES]);
  });

  test("re-attaching identical content is an idempotent no-op", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const a = await attachToRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      name: "a.pdf",
      bytes: PDF_BYTES,
    });
    const b = await attachToRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      name: "a.pdf",
      bytes: PDF_BYTES,
    });
    expect(b.blobDeduplicated).toBe(true);
    expect(b.replaced).toBe(false);
    expect(b.entry.blob_ref).toBe(a.entry.blob_ref);
    const index = await readAttachmentIndex(node, cfg, "project", "labs");
    expect(index!.entries.length).toBe(1);
    // Only one upload hit the file plane.
    expect(state.filePlaneCalls.filter((c) => c.path === "/api/db/file-blob").length).toBe(1);
  });

  test("identical content under two names dedupes the blob (CAS)", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    await attachToRecord({ node, cfg, type: "project", slug: "labs", name: "a.pdf", bytes: PDF_BYTES });
    const b = await attachToRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      name: "b.pdf",
      bytes: PDF_BYTES,
    });
    expect(b.blobDeduplicated).toBe(true);
    expect(state.store.get(FILE_HASH_SCHEMA)!.size).toBe(1);
    expect(state.cas.size).toBe(1);
    const index = await readAttachmentIndex(node, cfg, "project", "labs");
    expect(index!.entries.length).toBe(2);
  });

  test("same name + different content errors without force, replaces with force", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    await attachToRecord({ node, cfg, type: "project", slug: "labs", name: "a.pdf", bytes: PDF_BYTES });
    const other = new TextEncoder().encode("%PDF-1.7 different body");
    await expect(
      attachToRecord({ node, cfg, type: "project", slug: "labs", name: "a.pdf", bytes: other }),
    ).rejects.toThrow(/already attached/);
    const replaced = await attachToRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      name: "a.pdf",
      bytes: other,
      force: true,
    });
    expect(replaced.replaced).toBe(true);
    const index = await readAttachmentIndex(node, cfg, "project", "labs");
    expect(index!.entries.length).toBe(1);
    expect(index!.entries[0]!.blob_ref).toBe(blobRefFor(other));
  });

  test("detach removes the entry by name or ref; the CAS blob remains", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const a = await attachToRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      name: "a.pdf",
      bytes: PDF_BYTES,
    });
    const removed = await detachFromRecord({
      node,
      cfg,
      type: "project",
      slug: "labs",
      nameOrRef: a.entry.blob_ref,
    });
    expect(removed.removed.name).toBe("a.pdf");
    const index = await readAttachmentIndex(node, cfg, "project", "labs");
    expect(index!.entries).toEqual([]);
    // Pointer record + CAS blob are intentionally left in place.
    expect(state.store.get(FILE_HASH_SCHEMA)!.size).toBe(1);
    expect(state.cas.size).toBe(1);
    await expect(
      detachFromRecord({ node, cfg, type: "project", slug: "labs", nameOrRef: "a.pdf" }),
    ).rejects.toThrow(/No attachment/);
  });

  test("get verifies content hash and hard-fails on corruption", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const put = await putAttachmentBlob(node, cfg, PDF_BYTES, "application/pdf");
    // Corrupt the stored CAS bytes in place.
    const [blobRef] = [...state.cas.keys()];
    state.cas.set(blobRef!, Buffer.from("corrupted bytes").toString("base64"));
    await expect(getAttachmentBlob(node, cfg, put.blobRef)).rejects.toThrow(
      /attachment_integrity_error|hashing/,
    );
  });

  test("missing pointer record is a hard error, not empty bytes", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    await expect(
      getAttachmentBlob(node, cfg, `sha256:${"0".repeat(64)}`),
    ).rejects.toThrow(/not present/);
  });

  test("pointer record whose CAS bytes are gone maps 404 to attachment_blob_missing", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const put = await putAttachmentBlob(node, cfg, PDF_BYTES, "application/pdf");
    state.cas.clear();
    await expect(getAttachmentBlob(node, cfg, put.blobRef)).rejects.toThrow(
      /not found locally or in remote CAS/,
    );
  });

  test("size cap and empty file are rejected", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    await expect(
      attachToRecord({
        node,
        cfg,
        type: "project",
        slug: "labs",
        name: "empty.bin",
        bytes: new Uint8Array(0),
      }),
    ).rejects.toThrow(/zero-byte/);
    const big = { length: MAX_ATTACHMENT_BYTES + 1 } as unknown as Uint8Array;
    await expect(
      attachToRecord({ node, cfg, type: "project", slug: "labs", name: "big.bin", bytes: big }),
    ).rejects.toThrow(/cap/);
  });
});

describe("legacy v1 fallback + migration", () => {
  test("get falls back to a legacy v1 base64 blob record", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const hash = seedLegacyBlob(state, PDF_BYTES, "application/pdf");
    const blob = await getAttachmentBlob(node, cfg, `sha256:${hash}`);
    expect([...blob.bytes]).toEqual([...PDF_BYTES]);
    expect(blob.media_type).toBe("application/pdf");
  });

  test("migrate moves legacy blobs to the file plane, deletes stand-ins, and stays readable", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();

    // v1 world: index entries + legacy base64 blob records, no pointer records.
    const other = new TextEncoder().encode("%PDF-1.7 second labs pdf");
    const hashA = seedLegacyBlob(state, PDF_BYTES, "application/pdf");
    const hashB = seedLegacyBlob(state, other, "application/pdf");
    const indexKey = attachmentIndexSlug("project", "labs");
    seed(state, INDEX_HASH, indexKey, {
      slug: indexKey,
      record_type: "project",
      record_slug: "labs",
      filenames: ["a.pdf", "b.pdf"],
      attachments_json: JSON.stringify([
        { name: "a.pdf", blob_ref: `sha256:${hashA}`, size: PDF_BYTES.length, media_type: "application/pdf", added_at: "t" },
        { name: "b.pdf", blob_ref: `sha256:${hashB}`, size: other.length, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });

    const report = await migrateAttachmentsToFilePlane({ node, cfg });
    expect(report.indexes).toBe(1);
    expect(report.items.length).toBe(2);
    for (const item of report.items) {
      expect(item.action).toBe("migrated");
      expect(item.legacyDeleted).toBe(true);
    }
    // Legacy records gone; pointer records + CAS bytes present.
    expect(state.store.get(LEGACY_BLOB_HASH_SCHEMA)!.size).toBe(0);
    expect(state.store.get(FILE_HASH_SCHEMA)!.size).toBe(2);
    expect(state.cas.size).toBe(2);

    // Round-trip both through the file plane.
    const a = await getAttachmentBlob(node, cfg, `sha256:${hashA}`);
    expect([...a.bytes]).toEqual([...PDF_BYTES]);
    const bBlob = await getAttachmentBlob(node, cfg, `sha256:${hashB}`);
    expect([...bBlob.bytes]).toEqual([...other]);

    // Idempotent: second run migrates nothing.
    const again = await migrateAttachmentsToFilePlane({ node, cfg });
    expect(again.items.every((i) => i.action === "already-file-plane")).toBe(true);
    expect(again.items.every((i) => i.legacyDeleted === false)).toBe(true);
  });

  test("migrate cleans up a leftover legacy record when the blob is already in the file plane", async () => {
    // Simulates a prior run that crashed between upload and delete.
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    await putAttachmentBlob(node, cfg, PDF_BYTES, "application/pdf", { name: "a.pdf" });
    const hash = seedLegacyBlob(state, PDF_BYTES, "application/pdf");
    const indexKey = attachmentIndexSlug("project", "labs");
    seed(state, INDEX_HASH, indexKey, {
      slug: indexKey,
      record_type: "project",
      record_slug: "labs",
      filenames: ["a.pdf"],
      attachments_json: JSON.stringify([
        { name: "a.pdf", blob_ref: `sha256:${hash}`, size: PDF_BYTES.length, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });
    const report = await migrateAttachmentsToFilePlane({ node, cfg });
    expect(report.items.length).toBe(1);
    expect(report.items[0]!.action).toBe("already-file-plane");
    expect(report.items[0]!.legacyDeleted).toBe(true);
    expect(state.store.get(LEGACY_BLOB_HASH_SCHEMA)!.size).toBe(0);
  });

  test("migrate does NOT delete the legacy record when the file-plane fetch-back fails", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const hash = seedLegacyBlob(state, PDF_BYTES, "application/pdf");
    const indexKey = attachmentIndexSlug("project", "labs");
    seed(state, INDEX_HASH, indexKey, {
      slug: indexKey,
      record_type: "project",
      record_slug: "labs",
      filenames: ["a.pdf"],
      attachments_json: JSON.stringify([
        { name: "a.pdf", blob_ref: `sha256:${hash}`, size: PDF_BYTES.length, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });
    // Break the fetch path: uploads succeed but the CAS "loses" the bytes.
    const realRawCall = node.rawCall.bind(node);
    (node as { rawCall: NodeClient["rawCall"] }).rawCall = async (method, path, body) => {
      const res = await realRawCall(method, path, body);
      if (path === "/api/db/file-blob") state.cas.clear();
      return res;
    };
    await expect(migrateAttachmentsToFilePlane({ node, cfg })).rejects.toThrow(
      /not found locally or in remote CAS/,
    );
    // The destructive step never ran.
    expect(state.store.get(LEGACY_BLOB_HASH_SCHEMA)!.has(hash)).toBe(true);
  });

  test("migrate scoped to one record only touches that record's blobs", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const hashA = seedLegacyBlob(state, PDF_BYTES, "application/pdf");
    const otherBytes = new TextEncoder().encode("unrelated record blob");
    const hashB = seedLegacyBlob(state, otherBytes, "application/pdf");
    const keyLabs = attachmentIndexSlug("project", "labs");
    const keyOther = attachmentIndexSlug("concept", "other");
    seed(state, INDEX_HASH, keyLabs, {
      slug: keyLabs,
      record_type: "project",
      record_slug: "labs",
      filenames: ["a.pdf"],
      attachments_json: JSON.stringify([
        { name: "a.pdf", blob_ref: `sha256:${hashA}`, size: PDF_BYTES.length, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });
    seed(state, INDEX_HASH, keyOther, {
      slug: keyOther,
      record_type: "concept",
      record_slug: "other",
      filenames: ["b.pdf"],
      attachments_json: JSON.stringify([
        { name: "b.pdf", blob_ref: `sha256:${hashB}`, size: otherBytes.length, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });

    const report = await migrateAttachmentsToFilePlane({
      node,
      cfg,
      type: "project",
      slug: "labs",
    });
    expect(report.items.length).toBe(1);
    expect(report.items[0]!.blob_ref).toBe(`sha256:${hashA}`);
    // The other record's legacy blob is untouched.
    expect(state.store.get(LEGACY_BLOB_HASH_SCHEMA)!.has(hashB)).toBe(true);
  });

  test("migrate hard-fails on a corrupt legacy blob instead of laundering it", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const hash = seedLegacyBlob(state, PDF_BYTES, "application/pdf");
    state.store.get(LEGACY_BLOB_HASH_SCHEMA)!.get(hash)!.data =
      Buffer.from("corrupted").toString("base64");
    const indexKey = attachmentIndexSlug("project", "labs");
    seed(state, INDEX_HASH, indexKey, {
      slug: indexKey,
      record_type: "project",
      record_slug: "labs",
      filenames: ["a.pdf"],
      attachments_json: JSON.stringify([
        { name: "a.pdf", blob_ref: `sha256:${hash}`, size: PDF_BYTES.length, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });
    await expect(migrateAttachmentsToFilePlane({ node, cfg })).rejects.toThrow(
      /attachment_integrity_error|hashing/,
    );
    // Legacy record survives for forensics.
    expect(state.store.get(LEGACY_BLOB_HASH_SCHEMA)!.has(hash)).toBe(true);
  });

  test("migrate reports a referenced-but-absent blob as missing", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const indexKey = attachmentIndexSlug("project", "labs");
    const ghost = "f".repeat(64);
    seed(state, INDEX_HASH, indexKey, {
      slug: indexKey,
      record_type: "project",
      record_slug: "labs",
      filenames: ["ghost.pdf"],
      attachments_json: JSON.stringify([
        { name: "ghost.pdf", blob_ref: `sha256:${ghost}`, size: 1, media_type: "application/pdf", added_at: "t" },
      ]),
      created_at: "t",
      updated_at: "t",
    });
    const report = await migrateAttachmentsToFilePlane({ node, cfg });
    expect(report.items.length).toBe(1);
    expect(report.items[0]!.action).toBe("missing");
    expect(report.items[0]!.legacyDeleted).toBe(false);
  });
});

describe("helpers", () => {
  test("mediaTypeFor maps common extensions and defaults to octet-stream", () => {
    expect(mediaTypeFor("a.pdf")).toBe("application/pdf");
    expect(mediaTypeFor("a.PNG")).toBe("image/png");
    expect(mediaTypeFor("noext")).toBe("application/octet-stream");
    expect(mediaTypeFor("weird.xyz")).toBe("application/octet-stream");
  });

  test("parseAttachmentsJson tolerates junk and keeps valid entries", () => {
    expect(parseAttachmentsJson("")).toEqual([]);
    expect(parseAttachmentsJson("not json")).toEqual([]);
    expect(parseAttachmentsJson('{"a":1}')).toEqual([]);
    const entries = parseAttachmentsJson(
      JSON.stringify([
        { name: "ok.pdf", blob_ref: `sha256:${"a".repeat(64)}`, size: 3, media_type: "application/pdf", added_at: "t" },
        { name: "", blob_ref: `sha256:${"b".repeat(64)}` },
        { name: "bad-ref.pdf", blob_ref: "md5:zzz" },
      ]),
    );
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("ok.pdf");
  });

  test("findEntry matches by name, full ref, and bare hex", () => {
    const entry = {
      name: "a.pdf",
      blob_ref: `sha256:${"a".repeat(64)}`,
      size: 1,
      media_type: "application/pdf",
      added_at: "t",
    };
    expect(findEntry([entry], "a.pdf")).toBe(entry);
    expect(findEntry([entry], entry.blob_ref)).toBe(entry);
    expect(findEntry([entry], "a".repeat(64))).toBe(entry);
    expect(findEntry([entry], "missing.pdf")).toBeNull();
  });
});
