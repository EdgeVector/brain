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
  ATTACHMENT_INDEX_SCHEMA_KEY,
  attachmentBlobSchema,
  attachmentIndexSchema,
} from "../../src/schemas.ts";
import { buildTestCfg } from "../util.ts";

const INDEX_HASH = "attidx-hash";
const BLOB_HASH_SCHEMA = "attblob-hash";

function attachCfg(): Config {
  const c = buildTestCfg({ userHash: "uh" });
  c.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY] = INDEX_HASH;
  c.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY] = BLOB_HASH_SCHEMA;
  return c;
}

type RowFields = Record<string, unknown>;

type MockState = {
  store: Map<string, Map<string, RowFields>>;
  declared: string[];
};

function newState(): MockState {
  return { store: new Map(), declared: [] };
}

function seed(state: MockState, schemaHash: string, key: string, fields: RowFields): void {
  let rows = state.store.get(schemaHash);
  if (!rows) {
    rows = new Map();
    state.store.set(schemaHash, rows);
  }
  rows.set(key, fields);
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
    async deleteRecord() {},
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
    async rawCall() {
      return { status: 200, headers: new Headers(), body: "", json: null };
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

  test("blob schema classifies every field no_index; data is binary", () => {
    const cls = attachmentBlobSchema.schema.field_classifications!;
    for (const field of attachmentBlobSchema.schema.fields) {
      expect(cls[field]).toContain("no_index");
    }
    expect(cls.data).toEqual(["no_index", "binary"]);
    expect(attachmentBlobSchema.schema.field_data_classifications.data!.data_domain).toBe(
      "binary",
    );
  });

  test("index slugs are reserved, stable, and type-scoped", () => {
    expect(attachmentIndexSlug("project", "p")).toMatch(/^__attidx__[0-9a-f]{64}$/);
    expect(attachmentIndexSlug("project", "p")).toBe(attachmentIndexSlug("project", "p"));
    expect(attachmentIndexSlug("project", "p")).not.toBe(attachmentIndexSlug("concept", "p"));
  });
});

describe("ensureAttachmentSchemas", () => {
  test("declares both schemas lazily and stores hashes in config", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = buildTestCfg({ userHash: "uh" });
    delete cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY];
    delete cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY];
    const { indexHash, blobHash } = await ensureAttachmentSchemas(node, cfg, { persist: false });
    expect(state.declared).toEqual(["BrainAttachmentIndex", "BrainAttachmentBlob"]);
    expect(indexHash).toBe("declared:BrainAttachmentIndex");
    expect(blobHash).toBe("declared:BrainAttachmentBlob");
    expect(cfg.schemaHashes[ATTACHMENT_INDEX_SCHEMA_KEY]).toBe(indexHash);
    expect(cfg.schemaHashes[ATTACHMENT_BLOB_SCHEMA_KEY]).toBe(blobHash);
  });

  test("no-op when hashes already present", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const out = await ensureAttachmentSchemas(node, cfg, { persist: false });
    expect(out).toEqual({ indexHash: INDEX_HASH, blobHash: BLOB_HASH_SCHEMA });
    expect(state.declared).toEqual([]);
  });
});

describe("attach / list / detach / get round-trip", () => {
  test("attach stores CAS blob + index entry; get round-trips byte-identical", async () => {
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
    expect(state.store.get(BLOB_HASH_SCHEMA)!.size).toBe(1);
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

  test("detach removes the entry by name or ref; blob record remains", async () => {
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
    // CAS blob is intentionally left in place.
    expect(state.store.get(BLOB_HASH_SCHEMA)!.size).toBe(1);
    await expect(
      detachFromRecord({ node, cfg, type: "project", slug: "labs", nameOrRef: "a.pdf" }),
    ).rejects.toThrow(/No attachment/);
  });

  test("get verifies content hash and hard-fails on corruption", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    const put = await putAttachmentBlob(node, cfg, PDF_BYTES, "application/pdf");
    // Corrupt the stored base64 in place.
    const hash = put.blobRef.slice("sha256:".length);
    const row = state.store.get(BLOB_HASH_SCHEMA)!.get(hash)!;
    row.data = Buffer.from("corrupted bytes").toString("base64");
    await expect(getAttachmentBlob(node, cfg, put.blobRef)).rejects.toThrow(
      /attachment_integrity_error|hashing/,
    );
  });

  test("missing blob is a hard error, not empty bytes", async () => {
    const state = newState();
    const node = mockNode(state);
    const cfg = attachCfg();
    await expect(
      getAttachmentBlob(node, cfg, `sha256:${"0".repeat(64)}`),
    ).rejects.toThrow(/not present/);
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
