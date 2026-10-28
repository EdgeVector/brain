// Experimental adapter over the existing Brain client. No default config,
// schema registration, primary discovery, or existing-command activation.
import { createHash, randomUUID } from "node:crypto";
import { FbrainError, type NodeClient, type BatchMutationOp, type QueryRow } from "../client.ts";
import { ensureStatus, validateSlug, type FbrainRecord } from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";
import { V2_RECORD_FIELDS, V2_SUMMARY_FIELDS, type V2SchemaMap } from "./schemas.ts";

export type V2Record = FbrainRecord & {
  br2_id: string; br2_type: RecordType; br2_scope: string; br2_status: string;
  br2_order: string; br2_revision: string;
};

export function recordKey(type: RecordType, slug: string): string {
  return `v2:${Buffer.from(JSON.stringify([type, slug])).toString("base64url")}`;
}
export function statusKey(type: RecordType, status: string): string {
  return JSON.stringify([type, status]);
}
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

function recordOf(row: QueryRow | undefined): V2Record | null {
  if (!row) return null;
  const fields = row.fields;
  if (typeof fields.br2_id !== "string" || typeof fields.br2_revision !== "string") throw new Error("Incomplete Brain v2 record");
  return fields as V2Record;
}

export class BrainV2Store {
  constructor(readonly node: NodeClient, readonly schemas: V2SchemaMap) {}

  async get(type: RecordType, slug: string): Promise<V2Record | null> {
    const rows = await this.readKeys([recordKey(type, slug)], V2_RECORD_FIELDS);
    return recordOf(rows[0]);
  }

  async getUntyped(slug: string): Promise<V2Record | null> {
    const rows = await this.readKeys(RECORD_TYPES.map(type => recordKey(type, slug)), V2_RECORD_FIELDS);
    if (rows.length > 1) throw new FbrainError({ code: "ambiguous_slug", message: `Specify a type for ${slug}.` });
    return recordOf(rows[0]);
  }

  private async readKeys(keys: string[], fields: string[]): Promise<QueryRow[]> {
    if (!this.node.queryByKeys) throw new Error("Brain v2 requires batched keyed reads");
    return this.node.queryByKeys({ schemaHash: this.schemas.record, fields, keys: keys.map(hash => ({ hash })) });
  }

  async put(type: RecordType, record: FbrainRecord, knownPrevious?: V2Record | null): Promise<V2Record> {
    validateSlug(record.slug);
    ensureStatus(type, record.status);
    // File bodies are deliberately outside this storage spike. Refuse instead
    // of introducing an unproved file format or a truncation path.
    if (Buffer.byteLength(JSON.stringify(record.body)) > 48 * 1024) throw new Error("Brain v2 spike body exceeds 48 KiB; file adapter is not enabled");
    const previous = knownPrevious === undefined ? await this.get(type, record.slug) : knownPrevious;
    const id = recordKey(type, record.slug);
    const next: V2Record = {
      ...record, tags: [...new Set(record.tags)], created_at: previous?.created_at ?? record.created_at,
      br2_id: id, br2_type: type, br2_scope: "brain", br2_status: statusKey(type, record.status),
      br2_order: orderKey(id, record.updated_at), br2_revision: randomUUID(),
    };
    const expected = previous
      ? { type: "value" as const, field: "br2_revision", value: previous.br2_revision }
      : { type: "absent" as const, field: "br2_revision" };
    const ops: BatchMutationOp[] = [{ mutationType: previous ? "update" : "create",
      schemaHash: this.schemas.record, keyHash: id, fields: next, expected }];
    if (previous) ops.push(...this.tagDeletes(previous));
    ops.push(...next.tags.map(tag => ({ mutationType: "create" as const,
      schemaHash: this.schemas.tag, keyHash: tag, keyRange: next.br2_order,
      fields: { bt2_tag: tag, bt2_order: next.br2_order, bt2_id: id } })));
    await this.commit(ops);
    return next;
  }

  async delete(type: RecordType, slug: string): Promise<void> {
    const previous = await this.get(type, slug);
    if (!previous) throw new Error("Brain v2 delete target is absent");
    const ops: BatchMutationOp[] = [{ mutationType: "delete", schemaHash: this.schemas.record,
      keyHash: previous.br2_id, fields: {},
      expected: { type: "value", field: "br2_revision", value: previous.br2_revision } }];
    for (const [layout, hash] of [["recent", previous.br2_scope], ["type", previous.br2_type], ["status", previous.br2_status]] as const) {
      ops.push({ mutationType: "delete", schemaHash: this.schemas[layout], keyHash: hash, keyRange: previous.br2_order, fields: {} });
    }
    ops.push(...this.tagDeletes(previous));
    await this.commit(ops);
  }

  private tagDeletes(previous: V2Record): BatchMutationOp[] {
    return previous.tags.map(tag => ({ mutationType: "delete", schemaHash: this.schemas.tag,
      keyHash: tag, keyRange: previous.br2_order, fields: {} }));
  }

  private async commit(ops: BatchMutationOp[]): Promise<void> {
    if (ops.length > 128) throw new Error(`Brain v2 change exceeds the 128-mutation cap (${ops.length})`);
    if (!this.node.mutateBatch) throw new Error("Brain v2 requires the native mutation batch");
    const result = await this.node.mutateBatch(ops, { durability: "durable" });
    if (result.durability !== "durable") throw new Error("Brain v2 did not receive a durable batch result");
  }

  async list(options: { type?: RecordType; status?: string; tag?: string; cursor?: unknown; limit?: number } = {}): Promise<{ items: Record<string, unknown>[]; cursor: unknown; hasMore: boolean }> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Brain v2 list limit must be 1..100");
    if (options.status && !options.type) throw new Error("A status list requires a type");
    const layout = options.tag ? "tag" : options.status ? "status" : options.type ? "type" : "recent";
    const hash = options.tag ?? (options.type ? options.status ? statusKey(options.type, options.status) : options.type : "brain");
    const result = await rawData(this.node, "POST", "/api/query", {
      schema: this.schemas[layout], fields: [layout === "tag" ? "bt2_id" : "br2_id"],
      filter: { HashKey: hash }, limit, ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const rows = (result.results ?? result.rows) as Array<Record<string, unknown> & { fields?: Record<string, unknown> }>;
    if (!Array.isArray(rows)) throw new Error("Brain v2 list response has no rows");
    const ids = rows.map(row => (row.fields ?? row)[layout === "tag" ? "bt2_id" : "br2_id"]);
    if (!ids.every((id): id is string => typeof id === "string")) throw new Error("Brain v2 lookup has an invalid identity");
    const records = await this.readKeys(ids, V2_SUMMARY_FIELDS);
    const byId = new Map(records.map(row => [row.fields.br2_id, row.fields]));
    const items = ids.flatMap(id => {
      const record = byId.get(id);
      if (!record || (options.type && record.br2_type !== options.type) || (options.status && record.status !== options.status)
        || (options.tag && !(record.tags as string[]).includes(options.tag))) throw new Error("Brain v2 lookup convergence is incomplete");
      return [record];
    });
    return { items, cursor: result.next_cursor ?? null, hasMore: result.has_more === true };
  }
}
