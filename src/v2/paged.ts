// Opt-in replacement layout: one summary copy, native shared content atoms.
import { randomUUID } from "node:crypto";
import { FbrainError, type NodeClient, type BatchMutationOp } from "../client.ts";
import { ensureStatus, validateSlug, type FbrainRecord } from "../record.ts";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";
import { V2_SUMMARY_FIELDS, V2_RECORD_FIELDS } from "./schemas.ts";
import { encodeV2Record, orderKey, recordKey, statusKey, rawData, type V2Record } from "./store.ts";
import { PageIO } from "./paged-io.ts";
import { PageWriter } from "./paged-write.ts";
import { PAGE_FIELDS, cardId, cardOrder, counter, publicCard, route, unpack, readHead, type Directory, type PageSchemas } from "./paged-model.ts";
export { PAGED_SCHEMAS, PAGE_FIELDS } from "./paged-model.ts";
type Key = { type: RecordType; slug: string };
type Options = { type?: RecordType; status?: string; tag?: string; cursor?: unknown; limit?: number };
const project = (record: V2Record, fields: string[]) => Object.fromEntries(fields.filter(f => record[f] !== undefined).map(f => [f, record[f]]));
export class PagedBrainV2Store {
  readonly paged = true;
  readonly io: PageIO;
  readonly writer: PageWriter;
  constructor(readonly node: NodeClient, readonly schemas: PageSchemas) {
    this.io = new PageIO(node, schemas); this.writer = new PageWriter(this.io);
  }
  async counts(): Promise<ReturnType<typeof counter>> { return counter((await this.io.directory()).head); }
  async summaries(): Promise<{ records: V2Record[]; directory: Directory }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const directory = await this.io.directory();
      if (!directory.raw) return { records: [], directory };
      try {
        const { rows } = await this.io.pages(directory, directory.head.leaves.map(([id]) => id));
        const pages = new Map(rows.map(row => [row.key.hash, unpack(row.fields.bsp_doc)]));
        const cards = directory.head.leaves.flatMap(([id]) => pages.get(id)!);
        const seen = new Set<string>(), counts = RECORD_TYPES.map(() => 0);
        for (const card of cards) {
          const id = cardId(card); if (seen.has(id)) throw new Error("V2 summary repeats an identity"); seen.add(id);
          counts[RECORD_TYPES.indexOf(card.br2_type)]!++;
        }
        if (counts.some((value, i) => value !== directory.head.counts[i])) throw new Error("V2 summary counts differ");
        // Bulk summaries do not request routing fields. Avoid hashing every
        // identity into an order key merely to discard that field at projection.
        return { records: cards.map(card => ({ ...card, tags: [...card.tags], br2_id: cardId(card) } as V2Record)), directory };
      } catch (error) { if (String(error).includes("summary snapshot changed") && attempt < 3) continue; throw error; }
    }
    throw new Error("V2 summary snapshot is busy");
  }
  async get(type: RecordType, slug: string): Promise<V2Record | null> { return (await this.getMany([{ type, slug }]))[0] ?? null; }
  async getUntyped(slug: string): Promise<V2Record | null> {
    const records = await this.getMany(RECORD_TYPES.map(type => ({ type, slug })));
    if (records.length > 1) throw new FbrainError({ code: "ambiguous_slug", message: `Specify a type for ${slug}.` });
    return records[0] ?? null;
  }
  async getMany(keys: Key[], full = true): Promise<V2Record[]> {
    const result: V2Record[] = [];
    for (let i = 0; i < keys.length; i += 400) {
      const batches = [];
      for (let part = i; part < Math.min(i + 400, keys.length); part += 100) batches.push(keys.slice(part, part + 100));
      result.push(...(await Promise.all(batches.map(batch => this.readRecords(batch, full)))).flat());
    }
    return result;
  }
  private async readRecords(keys: Key[], full: boolean): Promise<V2Record[]> {
    const ids = [...new Set(keys.map(key => recordKey(key.type, key.slug)))];
    const fields = full ? PAGE_FIELDS : PAGE_FIELDS.filter(f => f !== "br2_content");
    for (let attempt = 0; attempt < 4; attempt++) {
      const [root, records] = await this.io.batch([this.io.root(), { schema_name: this.schemas.record, fields, keys: ids }]);
      const directory = readHead(root?.[0]?.fields.bsd_doc);
      if (!records!.length) return [];
      if (!directory.raw) throw new Error("V2 source lacks its summary directory");
      const pages = [...new Set(records!.map(row => route(directory.head, String(row.fields.br2_order))))];
      try {
        const snapshot = await this.io.pages(directory, pages);
        const cards = new Map(snapshot.rows.flatMap(row => unpack(row.fields.bsp_doc).map(card => [cardId(card), card] as const)));
        const found = new Map(records!.map(row => {
          const card = cards.get(row.key.hash!);
          if (!card || cardOrder(card) !== row.fields.br2_order || card.br2_type !== row.fields.br2_type) throw new Error("V2 source differs from its summary");
          const content = full ? JSON.parse(String(row.fields.br2_content)) : {};
          const record = { ...content, ...publicCard(card), ...row.fields } as V2Record;
          return [record.br2_id, record] as const;
        }));
        return ids.flatMap(id => found.has(id) ? [found.get(id)!] : []);
      } catch (error) { if (String(error).includes("summary snapshot changed") && attempt < 3) continue; throw error; }
    }
    throw new Error("V2 source snapshot is busy");
  }
  async put(type: RecordType, record: FbrainRecord, previous?: V2Record | null): Promise<V2Record> {
    validateSlug(record.slug); ensureStatus(type, record.status);
    const prior = previous === undefined ? await this.get(type, record.slug) : previous;
    const next = this.next(type, { ...record, created_at: prior?.created_at ?? record.created_at });
    const encoded = encodeV2Record(next);
    const fields = Object.fromEntries(PAGE_FIELDS.filter(f => !prior || (f === "br2_content"
      ? encoded[f] !== encodeV2Record(prior)[f] : next[f] !== prior[f])).map(f => [f, f === "br2_content" ? encoded[f] : next[f]]));
    await this.writer.commit(prior, next, [this.source(next.br2_id, prior, fields)]); return next;
  }
  private next(type: RecordType, record: FbrainRecord): V2Record {
    if (typeof record.title !== "string" || !Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== "string")) throw new Error("Invalid V2 summary");
    const id = recordKey(type, record.slug);
    return { ...record, tags: [...new Set(record.tags)], br2_id: id, br2_type: type, br2_scope: "brain",
      br2_status: statusKey(type, record.status), br2_order: orderKey(id, record.updated_at), br2_revision: randomUUID(), br2_count_hash: "" };
  }
  private source(id: string, previous: V2Record | null, fields: Record<string, unknown>, remove = false): BatchMutationOp {
    return { mutationType: remove ? "delete" : previous ? "update" : "create", schemaHash: this.schemas.record, keyHash: id, fields,
      expected: previous ? { type: "value", field: "br2_revision", value: previous.br2_revision } : { type: "absent", field: "br2_revision" } };
  }
  async patch(type: RecordType, slug: string, patch: Partial<FbrainRecord>): Promise<V2Record> {
    const prior = await this.get(type, slug); if (!prior) throw new Error("V2 patch target is absent");
    return this.put(type, { ...prior, ...patch, slug, updated_at: patch.updated_at ?? new Date().toISOString() }, prior);
  }
  async patchSummary(type: RecordType, slug: string, patch: Partial<FbrainRecord>): Promise<Record<string, unknown>> {
    if (Object.keys(patch).some(f => !["title", "status", "tags", "updated_at"].includes(f))) throw new Error("Unknown summary patch field");
    const prior = (await this.getMany([{ type, slug }], false))[0]; if (!prior) throw new Error("V2 summary target is absent");
    const next = this.next(type, { ...prior, ...patch, slug, updated_at: patch.updated_at ?? new Date().toISOString() });
    ensureStatus(type, next.status);
    const fields = Object.fromEntries(["br2_status", "br2_order", "br2_revision"].filter(f => next[f] !== prior[f]).map(f => [f, next[f]]));
    await this.writer.commit(prior, next, [this.source(next.br2_id, prior, fields)]); return project(next, V2_SUMMARY_FIELDS);
  }
  async delete(type: RecordType, slug: string): Promise<void> {
    const prior = await this.get(type, slug); if (!prior) throw new Error("V2 delete target is absent");
    const ops = [this.source(prior.br2_id, prior, {}, true)];
    for (const [layout, hash] of [["type", prior.br2_type], ["status", prior.br2_status]] as const) ops.push({ mutationType: "delete",
      schemaHash: this.schemas[layout], keyHash: hash, keyRange: prior.br2_order, fields: {} });
    await this.writer.commit(prior, null, ops);
  }
  async list(options: Options = {}): Promise<{ items: Record<string, unknown>[]; cursor: unknown; hasMore: boolean }> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("V2 list limit must be 1..100");
    if (options.status && !options.type) throw new Error("V2 status requires a type");
    if (!options.type && !options.tag) {
      const { records } = await this.summaries();
      const after = options.cursor == null ? undefined : String(options.cursor);
      if (after && !/^[0-9a-f]{14}\.[A-Za-z0-9_-]{43}$/.test(after)) throw new Error("Invalid V2 summary cursor");
      const candidates = after ? records.filter(row => cardOrder(row) > after) : records, page = candidates.slice(0, limit);
      return { items: page.map(row => project(row, V2_SUMMARY_FIELDS)), cursor: page.length ? cardOrder(page.at(-1)!) : null, hasMore: candidates.length > limit };
    }
    const layout = options.tag ? "tag" : options.status ? "status" : "type";
    const hash = options.tag ?? (options.status ? statusKey(options.type!, options.status) : options.type!);
    const result = await rawData(this.node, "POST", "/api/query", { schema_name: this.schemas[layout], fields: [layout === "tag" ? "bt2_id" : "br2_id"],
      filter: { HashKey: hash }, limit, ...(options.cursor ? { cursor: options.cursor } : {}), response_format: "values" });
    if (!Array.isArray(result.results) || result.unresolved_rows !== 0 || result.tombstoned_rows !== 0) throw new Error("Incomplete V2 keyed list");
    const { splitId } = await import("./paged-seed.ts");
    const rows = await this.getMany(result.results.map((row: any) => splitId(row.fields[layout === "tag" ? "bt2_id" : "br2_id"])), false);
    const byId = new Map(rows.map(row => [row.br2_id, row]));
    const items = result.results.map((row: any) => {
      const record = byId.get(row.fields[layout === "tag" ? "bt2_id" : "br2_id"]);
      if (!record || record.br2_order !== row.key.range || (layout !== "tag" && ((options.type && record.br2_type !== options.type)
          || (options.status && record.status !== options.status))) || (options.tag && !record.tags.includes(options.tag))) throw new Error("V2 keyed list differs from its summary");
      return record;
    }).filter((record: V2Record) => (!options.type || record.br2_type === options.type) && (!options.status || record.status === options.status))
      .map((record: V2Record) => project(record, V2_SUMMARY_FIELDS));
    return { items, cursor: result.next_cursor ?? null, hasMore: result.has_more === true };
  }
  async *pages(options: Omit<Options, "cursor" | "limit"> & { fields?: string[]; pageSize?: number } = {}): AsyncGenerator<any> {
    const fields = options.fields ?? V2_SUMMARY_FIELDS;
    if (fields.some(f => !V2_RECORD_FIELDS.includes(f))) throw new Error("Unknown V2 field");
    if (options.type || options.status || options.tag) {
      let cursor: unknown;
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const result = await this.list({ ...options, limit: 100, cursor });
        const rows = fields.some(f => !V2_SUMMARY_FIELDS.includes(f))
          ? await this.getMany(result.items.map(r => ({ type: r.br2_type as RecordType, slug: r.slug as string }))) : result.items;
        yield { ...result, items: rows.map(row => project(row as V2Record, fields)) };
        if (!result.hasMore) return;
        const token = JSON.stringify(result.cursor);
        if (!result.cursor || seen.has(token)) throw new Error("V2 keyed continuation stalled");
        seen.add(token); cursor = result.cursor;
      }
      throw new Error("V2 keyed traversal exceeded 1000 pages");
    }
    const { records } = await this.summaries();
    const selected = records.filter(r => (!options.type || r.br2_type === options.type) && (!options.status || r.status === options.status)
      && (!options.tag || r.tags.includes(options.tag)));
    const full = fields.some(f => !V2_SUMMARY_FIELDS.includes(f));
    for (let i = 0; i < selected.length; i += 100) {
      const slice = selected.slice(i, i + 100);
      const rows = full ? await this.getMany(slice.map(r => ({ type: r.br2_type, slug: r.slug }))) : slice;
      if (rows.length !== slice.length) throw new Error("V2 full page lost a summary");
      yield { items: rows.map(row => project(row, fields)), hasMore: i + 100 < selected.length, cursor: null };
    }
  }
}
