// Canonical summary pages replace per-record card atoms and count members.
import { randomUUID } from "node:crypto";
import { RECORD_TYPES, type RecordType } from "../schemas.ts";
import { definition } from "./schemas.ts";
import { orderKey, recordKey, statusKey, type V2Record } from "./store.ts";

export const PAGE_FIELDS = ["br2_id", "br2_type", "br2_scope", "br2_status", "br2_order", "br2_revision", "br2_content"];
export const PAGED_SCHEMAS = {
  record: definition("BrainV2PageRecord", PAGE_FIELDS, "br2_id"),
  recent: definition("BrainV2PageRecent", ["br2_scope", "br2_order", "br2_id", "br2_content"], "br2_scope", "br2_order"),
  type: definition("BrainV2PageByType", ["br2_type", "br2_order", "br2_id", "br2_content"], "br2_type", "br2_order"),
  status: definition("BrainV2PageByStatus", ["br2_status", "br2_order", "br2_id", "br2_content"], "br2_status", "br2_order"),
  tag: definition("BrainV2PageTag", ["bt2_tag", "bt2_order", "bt2_id"], "bt2_tag", "bt2_order"),
  directory: definition("BrainV2SummaryDirectory", ["bsd_key", "bsd_doc"], "bsd_key"),
  page: definition("BrainV2SummaryPage", ["bsp_key", "bsp_doc"], "bsp_key"),
};
export type PageSchemas = Record<keyof typeof PAGED_SCHEMAS, string>;
export type Card = Pick<V2Record, "br2_type" | "slug" | "title" | "status" | "tags" | "updated_at">;
export type Head = { version: 1; revision: string; counts: number[]; leaves: [string, string][] };
export type Directory = { head: Head; raw: string | null };
// Timestamp and type are compact; repeated tag sets and statuses share a page dictionary.
type Row = [number, string, string, number, number, number, string?];
const MAX_ATOM = 60 * 1024;
export function bounded(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(JSON.stringify(text)) > MAX_ATOM) throw new Error("Brain V2 summary atom exceeds 60 KiB");
  return text;
}
export function emptyHead(): Head {
  return { version: 1, revision: randomUUID(), counts: RECORD_TYPES.map(() => 0), leaves: [["head", ""]] };
}
export function readHead(raw: unknown): Directory {
  if (raw === undefined) return { head: emptyHead(), raw: null };
  if (typeof raw !== "string") throw new Error("Invalid summary directory");
  const head = JSON.parse(raw) as Head;
  if (head.version !== 1 || typeof head.revision !== "string" || !Array.isArray(head.counts)
      || head.counts.length !== RECORD_TYPES.length || head.counts.some(n => !Number.isSafeInteger(n) || n < 0)
      || !Array.isArray(head.leaves) || !head.leaves.length || head.leaves.length > 500
      || head.leaves[0]?.[0] !== "head"
      || new Set(head.leaves.map(([id]) => id)).size !== head.leaves.length
      || head.leaves.some(([id, low], i) => typeof id !== "string" || typeof low !== "string"
        || (i === 0 ? low !== "" : low <= head.leaves[i - 1]![1]))) throw new Error("Invalid summary directory");
  return { head, raw };
}
export function cardId(card: Card): string { return recordKey(card.br2_type, card.slug); }
export function cardOrder(card: Card): string { return orderKey(cardId(card), card.updated_at); }
export function route(head: Head, key: string): string {
  let lo = 0, hi = head.leaves.length;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (head.leaves[mid]![1] <= key) lo = mid; else hi = mid; }
  return head.leaves[lo]![0];
}
export function pack(cards: Card[]): string {
  const statuses: string[] = [], tags: string[][] = [], sets = new Map<string, number>();
  const rows: Row[] = cards.map(card => {
    let status = statuses.indexOf(card.status); if (status < 0) { status = statuses.length; statuses.push(card.status); }
    const tag = JSON.stringify(card.tags); let set = sets.get(tag);
    if (set === undefined) { set = tags.length; sets.set(tag, set); tags.push(card.tags); }
    const millis = Date.parse(card.updated_at);
    const row: Row = [RECORD_TYPES.indexOf(card.br2_type), card.slug, card.title, status, set, millis];
    if (new Date(millis).toISOString() !== card.updated_at) row.push(card.updated_at);
    return row;
  });
  return bounded([rows, statuses, tags]);
}
export function unpack(raw: unknown): Card[] {
  if (typeof raw !== "string") throw new Error("Missing summary page");
  const [rows, statuses, tags] = JSON.parse(raw) as [Row[], string[], string[][]];
  if (!Array.isArray(rows) || !Array.isArray(statuses) || !Array.isArray(tags)) throw new Error("Invalid summary page");
  return rows.map(row => {
    const type = RECORD_TYPES[row[0]], status = statuses[row[3]], set = tags[row[4]];
    if (![6, 7].includes(row.length) || !type || typeof row[1] !== "string" || typeof row[2] !== "string" || typeof status !== "string"
        || !Array.isArray(set) || set.some(tag => typeof tag !== "string") || !Number.isSafeInteger(row[5])
        || (row.length === 7 && (typeof row[6] !== "string" || Date.parse(row[6]) !== row[5]))) throw new Error("Invalid summary row");
    return { br2_type: type, slug: row[1], title: row[2], status, tags: set, updated_at: row[6] ?? new Date(row[5]).toISOString() };
  });
}
export function sortCards(cards: Card[]): Card[] {
  return cards.sort((a, b) => {
    const time = Date.parse(b.updated_at) - Date.parse(a.updated_at);
    if (time) return time;
    const left = cardOrder(a), right = cardOrder(b); return left < right ? -1 : left > right ? 1 : 0;
  });
}
export function publicCard(card: Card): V2Record {
  return { ...card, tags: [...card.tags], br2_id: cardId(card), br2_scope: "brain", br2_status: statusKey(card.br2_type, card.status),
    br2_order: cardOrder(card) } as V2Record;
}
export function counter(head: Head): { total: number; types: Record<RecordType, number> } {
  return { total: head.counts.reduce((sum, count) => sum + count, 0),
    types: Object.fromEntries(RECORD_TYPES.map((type, i) => [type, head.counts[i]!])) as Record<RecordType, number> };
}
