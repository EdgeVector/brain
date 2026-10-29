// Generated CI corpora use the same stored fields, pages, and directory as app writes.
import { randomUUID } from "node:crypto";
import type { NodeClient, BatchMutationOp } from "../client.ts";
import type { FbrainRecord } from "../record.ts";
import { isRecordType, RECORD_TYPES, type RecordType } from "../schemas.ts";
import { encodeV2Record, orderKey, recordKey, statusKey, type V2Record } from "./store.ts";
import { PAGE_FIELDS, bounded, cardOrder, emptyHead, pack, sortCards, type Card, type PageSchemas } from "./paged-model.ts";

export function splitId(id: unknown): { type: RecordType; slug: string } {
  if (typeof id !== "string" || !id.startsWith("v2c:")) throw new Error("Invalid V2 identity");
  const colon = id.indexOf(":", 4), type = id.slice(4, colon);
  if (colon < 0 || !isRecordType(type)) throw new Error("Invalid V2 identity");
  return { type, slug: id.slice(colon + 1) };
}
export function seedRecord(type: RecordType, record: FbrainRecord): V2Record {
  const id = recordKey(type, record.slug);
  return { ...record, br2_id: id, br2_type: type, br2_scope: "brain", br2_status: statusKey(type, record.status),
    br2_order: orderKey(id, record.updated_at), br2_revision: randomUUID(), br2_count_hash: "" };
}
export async function seedPaged(node: NodeClient, schemas: PageSchemas, inputs: Array<{ type: RecordType; record: FbrainRecord }>): Promise<void> {
  const head = emptyHead(), cards: Card[] = [], operations: BatchMutationOp[] = [];
  const add = async (op: BatchMutationOp) => {
    operations.push(op);
    if (operations.length >= 100) { await node.mutateBatch!(operations, { durability: "durable" }); operations.length = 0; }
  };
  for (const { type, record } of inputs) {
    const next = seedRecord(type, record), encoded = encodeV2Record(next);
    await add({ mutationType: "create", schemaHash: schemas.record, keyHash: next.br2_id,
      fields: Object.fromEntries(PAGE_FIELDS.map(f => [f, f === "br2_content" ? encoded[f] : next[f]])) });
    for (const tag of record.tags) await add({ mutationType: "create", schemaHash: schemas.tag, keyHash: tag, keyRange: next.br2_order,
      fields: { bt2_tag: tag, bt2_order: next.br2_order, bt2_id: next.br2_id } });
    cards.push(next); head.counts[RECORD_TYPES.indexOf(type)]!++;
  }
  function divide(cards: Card[]): Array<{ id: string; cards: Card[]; doc: string }> {
    try { return [{ id: randomUUID(), cards, doc: pack(cards) }]; }
    catch (error) { if (cards.length < 2) throw error; const mid = cards.length >>> 1; return [...divide(cards.slice(0, mid)), ...divide(cards.slice(mid))]; }
  }
  const leaves = divide(sortCards(cards));
  head.leaves = leaves.map((leaf, i) => [leaf.id, i === 0 ? "" : cardOrder(leaf.cards[0]!)]);
  for (const leaf of leaves) await add({ mutationType: "create", schemaHash: schemas.page, keyHash: leaf.id, fields: { bsp_key: leaf.id, bsp_doc: leaf.doc } });
  await add({ mutationType: "create", schemaHash: schemas.directory, keyHash: "brain", fields: { bsd_key: "brain", bsd_doc: bounded(head) }, expected: { type: "absent", field: "bsd_doc" } });
  if (operations.length) await node.mutateBatch!(operations, { durability: "durable" });
}
