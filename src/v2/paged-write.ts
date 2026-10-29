import { randomUUID } from "node:crypto";
import { FbrainError, type BatchMutationOp } from "../client.ts";
import { RECORD_TYPES } from "../schemas.ts";
import type { V2Record } from "./store.ts";
import { PageIO } from "./paged-io.ts";
import { bounded, cardId, cardOrder, pack, route, sortCards, unpack, type Card, type Directory } from "./paged-model.ts";

export function tagWrites(schemaHash: string, previous: V2Record | null, next: V2Record | null): BatchMutationOp[] {
  const ops: BatchMutationOp[] = [];
  if (previous) for (const tag of previous.tags) {
    if (!next || next.br2_order !== previous.br2_order || !next.tags.includes(tag)) ops.push({ mutationType: "delete", schemaHash,
      keyHash: tag, keyRange: previous.br2_order, fields: {} });
  }
  if (next) for (const tag of next.tags) {
    if (!previous || previous.br2_order !== next.br2_order || !previous.tags.includes(tag)) ops.push({ mutationType: "create", schemaHash,
      keyHash: tag, keyRange: next.br2_order, fields: { bt2_tag: tag, bt2_order: next.br2_order, bt2_id: next.br2_id } });
  }
  return ops;
}

export class PageWriter {
  constructor(readonly io: PageIO) {}
  async commit(previous: V2Record | null, next: V2Record | null, source: BatchMutationOp[]): Promise<void> {
    const id = (next ?? previous)!.br2_id;
    for (let attempt = 0; attempt < 20; attempt++) {
      const directory = await this.io.directory(), head = directory.head;
      const ids = [...new Set([previous?.br2_order, next?.br2_order].filter((v): v is string => !!v).map(key => route(head, key)))];
      let selected;
      try { selected = await this.io.pages(directory, ids, [{ schema_name: this.io.schemas.record, fields: ["br2_revision"], keys: [id] }]); }
      catch (error) { if (String(error).includes("summary snapshot changed") && attempt < 19) continue; throw error; }
      const revision = selected.extra[0]?.[0]?.fields.br2_revision;
      if ((previous?.br2_revision ?? undefined) !== revision) throw new FbrainError({ code: "cas_conflict", message: "V2 record revision changed." });
      const pages = new Map(ids.map(id => [id, [] as Card[]]));
      for (const row of selected.rows) pages.set(row.key.hash!, unpack(row.fields.bsp_doc));
      if (previous) {
        const old = pages.get(route(head, previous.br2_order))!;
        const position = old.findIndex(card => cardId(card) === id);
        if (position < 0) throw new Error("V2 source has no canonical summary");
        old.splice(position, 1); head.counts[RECORD_TYPES.indexOf(previous.br2_type)]!--;
      }
      if (next) {
        const leaf = pages.get(route(head, next.br2_order))!;
        if (leaf.some(card => cardId(card) === id)) throw new Error("V2 summary identity already exists");
        leaf.push(next); head.counts[RECORD_TYPES.indexOf(next.br2_type)]!++;
      }
      if (pages.get("head")?.length === 0 && head.leaves.length > 1) {
        // Keep the first canonical page at its known key. A merge changes
        // page objects, never the record keys that refer to the directory.
        const following = head.leaves[1]![0];
        if (!pages.has(following)) {
          try {
            const loaded = await this.io.pages(directory, [following]);
            pages.set(following, unpack(loaded.rows[0]!.fields.bsp_doc));
          } catch (error) { if (String(error).includes("summary snapshot changed") && attempt < 19) continue; throw error; }
        }
        pages.set("head", pages.get(following)!); pages.set(following, []);
      }
      const mutations = this.pageMutations(directory, pages);
      head.revision = randomUUID();
      const expected = directory.raw === null ? { type: "absent" as const, field: "bsd_doc" }
        : { type: "value" as const, field: "bsd_doc", value: directory.raw };
      mutations.push({ mutationType: directory.raw === null ? "create" : "update", schemaHash: this.io.schemas.directory, keyHash: "brain",
        fields: { bsd_doc: bounded(head), ...(directory.raw === null ? { bsd_key: "brain" } : {}) }, expected });
      const ops = [...source, ...mutations, ...tagWrites(this.io.schemas.tag, previous, next)];
      if (ops.length > 128 || head.leaves.length > 500) throw new Error("V2 summary write exceeds its bounded directory");
      try {
        const result = await this.io.node.mutateBatch!(ops, { durability: "durable" });
        if (result.durability !== "durable") throw new Error("V2 summary batch lacks a durable result");
        return;
      } catch (error) {
        // Only an explicit atomic CAS refusal is safe to retry. A transport or
        // durable-write error has ambiguous state and always reaches the caller.
        if (!(error instanceof FbrainError) || !["cas_conflict", "node_http_409"].includes(error.code)
            || !/cas|compare.and.set|precondition/i.test(error.message)) throw error;
        if (attempt === 19) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(20, 1 + attempt * 2)));
      }
    }
  }
  private pageMutations(directory: Directory, pages: Map<string, Card[]>): BatchMutationOp[] {
    const ops: BatchMutationOp[] = [], head = directory.head;
    const existing = new Set(directory.raw === null ? [] : head.leaves.map(([id]) => id));
    for (const [id, unsorted] of pages) {
      const cards = sortCards(unsorted);
      if (!cards.length && head.leaves.length > 1) {
        head.leaves.splice(head.leaves.findIndex(([key]) => key === id), 1);
        head.leaves[0]![1] = "";
        ops.push({ mutationType: "delete", schemaHash: this.io.schemas.page, keyHash: id, fields: {} });
      } else this.split(head, id, cards, existing, ops);
    }
    return ops;
  }
  private split(head: Directory["head"], id: string, cards: Card[], existing: Set<string>, ops: BatchMutationOp[]): void {
    let doc: string;
    try { doc = pack(cards); }
    catch (error) {
      if (cards.length < 2) throw error;
      const middle = cards.length >>> 1, right = cards.slice(middle), key = randomUUID();
      head.leaves.splice(head.leaves.findIndex(([key]) => key === id) + 1, 0, [key, cardOrder(right[0]!)]);
      this.split(head, id, cards.slice(0, middle), existing, ops);
      this.split(head, key, right, existing, ops); return;
    }
    ops.push({ mutationType: existing.has(id) ? "update" : "create", schemaHash: this.io.schemas.page, keyHash: id,
      fields: { bsp_doc: doc, ...(!existing.has(id) ? { bsp_key: id } : {}) } });
  }
}
