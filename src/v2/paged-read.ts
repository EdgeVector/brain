import { statusKey, type V2Record } from "./store.ts";
import { PageIO } from "./paged-io.ts";
import { cardId, cardOrder, publicCard, readHead, route, unpack, type Directory } from "./paged-model.ts";
import type { RecordType } from "../schemas.ts";

export type ReadOptions = { type?: RecordType; status?: string; tag?: string; cursor?: unknown };
export type PageResult = { items: V2Record[]; cursor: unknown; hasMore: boolean };
export class PageReader {
  constructor(readonly io: PageIO) {}
  async directoryHead(): Promise<{ directory: Directory; cards: ReturnType<typeof unpack> }> {
    const [root, page] = await this.io.batch([this.io.root(), { schema_name: this.io.schemas.page, fields: ["bsp_doc"], keys: ["head"] }]);
    const directory = readHead(root?.[0]?.fields.bsd_doc);
    if (!directory.raw) {
      if (page!.length) throw new Error("V2 summary page lacks its directory");
      return { directory, cards: [] };
    }
    if (page!.length !== 1) throw new Error("V2 canonical head is absent");
    return { directory, cards: unpack(page![0]!.fields.bsp_doc) };
  }
  async first(options: ReadOptions, limit: number): Promise<PageResult | null> {
    if (options.cursor || options.type || options.status || options.tag) return null;
    const { directory, cards } = await this.directoryHead();
    const matches = cards.filter(r => (!options.type || r.br2_type === options.type) && (!options.status || r.status === options.status)
      && (!options.tag || r.tags.includes(options.tag)));
    if (matches.length < limit && directory.head.leaves.length > 1) return null;
    const selected = matches.slice(0, limit), hasMore = matches.length > limit || directory.head.leaves.length > 1;
    return { items: selected.map(publicCard), hasMore, cursor: hasMore ? `r1:${cardOrder(selected.at(-1)!)}` : null };
  }
  async native(options: ReadOptions, limit: number, full = false): Promise<PageResult> {
    if (options.status && !options.type) throw new Error("V2 status requires a type");
    const layout = options.tag ? "tag" : options.status ? "status" : options.type ? "type" : "recent";
    const hash = options.tag ?? (options.type ? options.status ? statusKey(options.type, options.status) : options.type : "brain");
    const idField = layout === "tag" ? "bt2_id" : "br2_id";
    let after: string | undefined;
    if (options.cursor != null) {
      if (typeof options.cursor !== "string" || !/^r1:[0-9a-f]{14}\.[A-Za-z0-9_-]{43}$/.test(options.cursor)) throw new Error("Invalid V2 range continuation");
      after = options.cursor.slice(3);
    }
    const [root, result] = await this.io.replies([this.io.query(this.io.root()), { schema_name: this.io.schemas[layout],
      fields: [idField, ...(full && layout !== "tag" ? ["br2_content"] : [])],
      filter: after ? { HashRangeRange: { hash, start: after, end: "\uffff" } } : { HashKey: hash },
      limit: Math.min(500, limit + 1), response_format: "values" }]);
    const directory = readHead(this.io.clean(root)[0]?.fields.bsd_doc);
    if (!Array.isArray(result.results) || result.unresolved_rows !== 0 || result.tombstoned_rows !== 0
        || typeof result.has_more !== "boolean" || (result.has_more && !result.next_cursor)) throw new Error("Incomplete V2 native page");
    const candidates = (result.results as any[]).filter(row => !after || row.key.range > after);
    const rows = candidates.slice(0, limit), hasMore = result.has_more || candidates.length > limit;
    if (!rows.length) {
      if (hasMore) throw new Error("V2 native range did not advance");
      return { items: [], hasMore: false, cursor: null };
    }
    if (!directory.raw || rows.some(row => row.key.hash !== hash || typeof row.key.range !== "string" || typeof row.fields[idField] !== "string")) throw new Error("Invalid V2 native coordinate");
    const leaves = [...new Set(rows.map(row => route(directory.head, row.key.range)))];
    const snapshot = await this.io.pages(directory, leaves);
    const cards = new Map(snapshot.rows.flatMap(row => unpack(row.fields.bsp_doc).map(card => [cardId(card), card] as const)));
    const items = rows.map(row => {
      const card = cards.get(row.fields[idField]);
      if (!card || cardOrder(card) !== row.key.range || (layout !== "tag" && ((options.type && card.br2_type !== options.type)
          || (options.status && card.status !== options.status))) || (options.tag && !card.tags.includes(options.tag))) throw new Error("V2 native key differs from its canonical summary");
      return { ...(full && layout !== "tag" ? JSON.parse(row.fields.br2_content) : {}), ...publicCard(card) } as V2Record;
    }).filter(card => (!options.type || card.br2_type === options.type) && (!options.status || card.status === options.status));
    return { items, hasMore, cursor: hasMore ? `r1:${rows.at(-1)!.key.range}` : null };
  }
}
