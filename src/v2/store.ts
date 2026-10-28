// Opt-in storage adapter. The packed layout requires fresh schema declarations;
// normal Brain initialization and existing V2 homes are not changed here.
import { createHash, randomUUID } from "node:crypto";
import { FbrainError, type NodeClient, type BatchMutationOp, type QueryRow } from "../client.ts";
import { ensureStatus, validateSlug, type FbrainRecord } from "../record.ts";
import { RECORD_TYPES, isRecordType, type RecordType } from "../schemas.ts";
import { V2_RECORD_FIELDS, V2_STORED_FIELDS, V2_SUMMARY_FIELDS, type V2SchemaMap } from "./schemas.ts";

export type V2Record = FbrainRecord & {
  br2_id: string; br2_type: RecordType; br2_scope: string; br2_status: string;
  br2_order: string; br2_revision: string;
};
type ListOptions = { type?: RecordType; status?: string; tag?: string; cursor?: unknown; limit?: number };
type ListResult = { items: Record<string, unknown>[]; cursor: unknown; hasMore: boolean };
const CARD_FIELDS = ["br2_type", "slug", "title", "status", "tags", "updated_at"];
const CONTENT_FIELDS = ["body", "created_at", "design_slug", "program", "gate_slug", "decided_by", "decided_on"];
const ROUTING_FIELDS = ["br2_id", "br2_type", "br2_scope", "br2_status", "br2_order", "br2_revision"];

export function recordKey(type: RecordType, slug: string): string {
  return `v2:${Buffer.from(JSON.stringify([type, slug])).toString("base64url")}`;
}
export function statusKey(type: RecordType, status: string): string { return JSON.stringify([type, status]); }
export function orderKey(id: string, time: string): string {
  const millis = Date.parse(time);
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8_640_000_000_000_000) throw new Error("Invalid v2 update time");
  return `${(8_640_000_000_000_000 - millis).toString(16).padStart(14, "0")}.${createHash("sha256").update(id).digest("base64url")}`;
}
export async function rawData(node: NodeClient, method: string, path: string, body?: unknown): Promise<Record<string, any>> {
  const reply = await node.rawCall(method, path, body);
  const value = reply.json as Record<string, any> | null;
  if (reply.status < 200 || reply.status >= 300 || !value || value.ok === false) {
    throw new Error(`${method} ${path}: HTTP ${reply.status}: ${reply.body.slice(0, 700)}`);
  }
  return value.data ?? value;
}
function packed(record: V2Record, fields: string[]): string {
  const value = JSON.stringify(Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]])));
  if (Buffer.byteLength(JSON.stringify(value)) > 60 * 1024) throw new Error("Brain v2 packed atom exceeds 60 KiB");
  return value;
}
export function encodeV2Record(record: V2Record): Record<string, unknown> {
  return { ...Object.fromEntries(ROUTING_FIELDS.map(field => [field, record[field]])),
    br2_card: packed(record, CARD_FIELDS), br2_content: packed(record, CONTENT_FIELDS) };
}
function document(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Brain v2 packed document is absent");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Brain v2 packed document");
  return parsed as Record<string, unknown>;
}
export function decodeV2Record(fields: Record<string, unknown>, requireContent = false): V2Record {
  const card = document(fields.br2_card);
  if (typeof card.br2_type !== "string" || !isRecordType(card.br2_type) || typeof card.slug !== "string"
      || typeof card.updated_at !== "string" || !Array.isArray(card.tags)) throw new Error("Invalid Brain v2 summary");
  const id = recordKey(card.br2_type, card.slug);
  if (fields.br2_id !== undefined && fields.br2_id !== id) throw new Error("Brain v2 document identity differs");
  return { ...(requireContent || fields.br2_content !== undefined ? document(fields.br2_content) : {}), ...card,
    ...Object.fromEntries(ROUTING_FIELDS.filter(field => fields[field] !== undefined).map(field => [field, fields[field]])),
    br2_id: id } as V2Record;
}
function project(record: V2Record, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]]));
}
function physicalFields(fields: string[]): string[] {
  const result = new Set<string>(["br2_card"]);
  if (fields.some(field => V2_SUMMARY_FIELDS.includes(field))) result.add("br2_card");
  if (fields.some(field => CONTENT_FIELDS.includes(field))) { result.add("br2_card"); result.add("br2_content"); }
  for (const field of fields) if (ROUTING_FIELDS.includes(field) && !["br2_id", "br2_type"].includes(field)) result.add(field);
  return [...result];
}

export class BrainV2Store {
  constructor(readonly node: NodeClient, readonly schemas: V2SchemaMap) {}

  async get(type: RecordType, slug: string): Promise<V2Record | null> {
    return (await this.getMany([{ type, slug }]))[0] ?? null;
  }
  async getMany(keys: Array<{ type: RecordType; slug: string }>): Promise<V2Record[]> {
    const rows = await this.readKeys(keys.map(key => recordKey(key.type, key.slug)), V2_STORED_FIELDS);
    return rows.map(row => {
      if (ROUTING_FIELDS.some(field => typeof row.fields[field] !== "string")) throw new Error("Brain v2 record routing fields are incomplete");
      return decodeV2Record(row.fields, true);
    });
  }
  async getUntyped(slug: string): Promise<V2Record | null> {
    const rows = await this.getMany(RECORD_TYPES.map(type => ({ type, slug })));
    if (rows.length > 1) throw new FbrainError({ code: "ambiguous_slug", message: `Specify a type for ${slug}.` });
    return rows[0] ?? null;
  }
  async patch(type: RecordType, slug: string, patch: Partial<FbrainRecord>): Promise<V2Record> {
    const previous = await this.get(type, slug);
    if (!previous) throw new Error("Brain v2 patch target is absent");
    return this.put(type, { ...previous, ...patch, slug, updated_at: patch.updated_at ?? new Date().toISOString() }, previous);
  }
  private async readKeys(keys: string[], fields: string[]): Promise<QueryRow[]> {
    if (!this.node.queryByKeys) throw new Error("Brain v2 requires batched keyed reads");
    return this.node.queryByKeys({ schemaHash: this.schemas.record, fields, keys: keys.map(hash => ({ hash })) });
  }
  async put(type: RecordType, record: FbrainRecord, knownPrevious?: V2Record | null): Promise<V2Record> {
    validateSlug(record.slug); ensureStatus(type, record.status);
    if (Buffer.byteLength(JSON.stringify(record.body)) > 48 * 1024) throw new Error("Brain v2 spike body exceeds 48 KiB; file adapter is not enabled");
    const previous = knownPrevious === undefined ? await this.get(type, record.slug) : knownPrevious;
    const id = recordKey(type, record.slug);
    const next: V2Record = { ...record, tags: [...new Set(record.tags)], created_at: previous?.created_at ?? record.created_at,
      br2_id: id, br2_type: type, br2_scope: "brain", br2_status: statusKey(type, record.status),
      br2_order: orderKey(id, record.updated_at), br2_revision: randomUUID() };
    const encoded = encodeV2Record(next), old = previous ? encodeV2Record(previous) : {};
    const fields = Object.fromEntries(Object.entries(encoded).filter(([name, value]) => old[name] !== value));
    const expected = previous ? { type: "value" as const, field: "br2_revision", value: previous.br2_revision }
      : { type: "absent" as const, field: "br2_revision" };
    const ops: BatchMutationOp[] = [{ mutationType: previous ? "update" : "create", schemaHash: this.schemas.record, keyHash: id, fields, expected }];
    // When the order key and membership stay fixed, retain the tag tips too.
    const oldTags = new Set(previous?.tags ?? []), nextTags = new Set(next.tags);
    if (previous) for (const tag of oldTags) if (previous.br2_order !== next.br2_order || !nextTags.has(tag)) ops.push(this.tagDelete(tag, previous));
    for (const tag of nextTags) if (!previous || previous.br2_order !== next.br2_order || !oldTags.has(tag)) {
      ops.push({ mutationType: "create", schemaHash: this.schemas.tag, keyHash: tag, keyRange: next.br2_order,
        fields: { bt2_tag: tag, bt2_order: next.br2_order, bt2_id: id } });
    }
    await this.commit(ops);
    return next;
  }
  async delete(type: RecordType, slug: string): Promise<void> {
    const previous = await this.get(type, slug);
    if (!previous) throw new Error("Brain v2 delete target is absent");
    const ops: BatchMutationOp[] = [{ mutationType: "delete", schemaHash: this.schemas.record, keyHash: previous.br2_id,
      fields: {}, expected: { type: "value", field: "br2_revision", value: previous.br2_revision } }];
    for (const [layout, hash] of [["recent", previous.br2_scope], ["type", previous.br2_type], ["status", previous.br2_status]] as const) {
      ops.push({ mutationType: "delete", schemaHash: this.schemas[layout], keyHash: hash, keyRange: previous.br2_order, fields: {} });
    }
    for (const tag of previous.tags) ops.push(this.tagDelete(tag, previous));
    await this.commit(ops);
  }
  private tagDelete(tag: string, previous: V2Record): BatchMutationOp {
    return { mutationType: "delete", schemaHash: this.schemas.tag, keyHash: tag, keyRange: previous.br2_order, fields: {} };
  }
  private async commit(ops: BatchMutationOp[]): Promise<void> {
    if (ops.length > 128) throw new Error(`Brain v2 change exceeds the 128-mutation cap (${ops.length})`);
    if (!this.node.mutateBatch) throw new Error("Brain v2 requires the native mutation batch");
    const result = await this.node.mutateBatch(ops, { durability: "durable" });
    if (result.durability !== "durable") throw new Error("Brain v2 did not receive a durable batch result");
  }
  async list(options: ListOptions = {}): Promise<ListResult> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Brain v2 list limit must be 1..100");
    return this.readPage(options, limit, V2_SUMMARY_FIELDS);
  }
  async *pages(options: Omit<ListOptions, "cursor" | "limit"> & { fields?: string[]; pageSize?: number } = {}): AsyncGenerator<ListResult> {
    const fields = options.fields ?? V2_SUMMARY_FIELDS, requested = options.pageSize ?? 500;
    if (!Number.isInteger(requested) || requested < 1 || requested > 500) throw new Error("Brain v2 bulk page size must be 1..500");
    if (fields.some(field => !V2_RECORD_FIELDS.includes(field))) throw new Error("Unknown Brain v2 field");
    // Bound field work, not just the number of record identities. A content
    // page reads two documents; a summary page reads only one.
    const limit = Math.min(requested, Math.max(1, Math.floor(500 / physicalFields(fields).length)));
    let cursor: unknown;
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const result = await this.readPage({ ...options, cursor }, limit, fields);
      yield result;
      if (!result.hasMore) return;
      const token = JSON.stringify(result.cursor);
      if (!result.cursor || seen.has(token)) throw new Error("Brain v2 continuation stalled");
      seen.add(token); cursor = result.cursor;
    }
    throw new Error("Brain v2 traversal exceeded 1000 pages");
  }
  private async readPage(options: ListOptions, limit: number, fields: string[]): Promise<ListResult> {
    if (options.status && !options.type) throw new Error("A status list requires a type");
    const layout = options.tag ? "tag" : options.status ? "status" : options.type ? "type" : "recent";
    const hash = options.tag ?? (options.type ? options.status ? statusKey(options.type, options.status) : options.type : "brain");
    const wanted = [...new Set([...fields, ...(options.type ? ["br2_type"] : []), ...(options.status ? ["status"] : []), ...(options.tag ? ["tags"] : [])])];
    const selected = physicalFields(wanted), requireContent = wanted.some(field => CONTENT_FIELDS.includes(field));
    const needsMetadata = selected.some(field => field !== "br2_card" && field !== "br2_content");
    const result = await rawData(this.node, "POST", "/api/query", {
      schema_name: this.schemas[layout], fields: layout === "tag" ? ["bt2_id"] : needsMetadata ? ["br2_card"] : selected,
      filter: { HashKey: hash }, limit, ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    if (!Array.isArray(result.results)) throw new Error("Brain v2 list response has no rows");
    if (result.unresolved_rows !== 0 || result.tombstoned_rows !== 0) throw new Error("Brain v2 page contains unresolved records");
    const rows = result.results as Array<{ key: { hash: string; range: string }; fields: Record<string, unknown> }>;
    let decoded: V2Record[];
    if (layout === "tag") {
      const ids = rows.map(row => row.fields.bt2_id);
      if (!ids.every((id): id is string => typeof id === "string")) throw new Error("Brain v2 tag lookup has an invalid identity");
      const records = await this.readKeys(ids, selected);
      const byId = new Map(records.map(row => { const record = decodeV2Record(row.fields, requireContent); return [record.br2_id, record]; }));
      decoded = ids.map((id, index) => {
        const record = byId.get(id);
        if (!record || !record.tags.includes(options.tag!) || orderKey(id, record.updated_at) !== rows[index]?.key.range) throw new Error("Brain v2 tag lookup convergence is incomplete");
        return record;
      });
    } else {
      decoded = rows.map(row => {
        const record = decodeV2Record(row.fields, !needsMetadata && requireContent);
        if (row.key.hash !== hash || orderKey(record.br2_id, record.updated_at) !== row.key.range) throw new Error("Brain v2 lookup coordinate differs from its document");
        return record;
      });
      if (needsMetadata) {
        const canonical = await this.readKeys(decoded.map(record => record.br2_id), selected);
        const byId = new Map(canonical.map(row => { const record = decodeV2Record(row.fields, requireContent); return [record.br2_id, record]; }));
        decoded = decoded.map(prior => {
          const record = byId.get(prior.br2_id);
          if (!record || record.updated_at !== prior.updated_at) throw new Error("Brain v2 metadata lookup convergence is incomplete");
          return record;
        });
      }
    }
    const items = decoded.filter(record => (!options.type || record.br2_type === options.type) && (!options.status || record.status === options.status)).map(record => project(record, fields));
    return { items, cursor: result.next_cursor ?? null, hasMore: result.has_more === true };
  }
  async counts(): Promise<{ total: number; types: Record<RecordType, number> }> {
    // A descending keyed page asks the node for its exact native membership
    // count. Only one probe row is materialized; the rest are key metadata.
    const types = {} as Record<RecordType, number>;
    for (let offset = 0; offset < RECORD_TYPES.length; offset += 4) {
      await Promise.all(RECORD_TYPES.slice(offset, offset + 4).map(async type => {
        const result = await rawData(this.node, "POST", "/api/query", { schema_name: this.schemas.type,
          fields: ["br2_id"], filter: { HashKey: type }, sort_order: "Desc", limit: 1 });
        if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 || result.unresolved_rows !== 0 || result.tombstoned_rows !== 0) throw new Error(`Brain v2 native count is unavailable for ${type}`);
        types[type] = result.total_count;
      }));
    }
    return { total: Object.values(types).reduce((sum, value) => sum + value, 0), types };
  }
}
