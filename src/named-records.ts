// Merge bounded prefixes from the finite set of record kinds. No unkeyed read.
import { BrainError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { keyPage } from "./multi-key.ts";
import { RECORD_TYPES, isRecordType, type RecordType } from "./schemas.ts";

type Scope = { type?: RecordType; status?: string; design?: string; updatedSinceMs?: number };
export type NamedCard = { type: RecordType; slug: string; title: string; status: string; updated_at: string };
type Anchor = { context: string; range: string; type: RecordType };

function contextOf(scope: Scope): string {
  return JSON.stringify([scope.type ?? null, scope.status ?? null, scope.design ?? null, scope.updatedSinceMs ?? null]);
}

function anchorOf(cursor: string | undefined, context: string): Anchor | null {
  if (!cursor || cursor === "__head__") return null;
  try {
    if (!cursor.startsWith("mk1.") || cursor.length > 4096) throw new Error("invalid cursor");
    const value = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8")) as Anchor;
    if (value.context !== context || !isRecordType(value.type) || !/^\d{20}#[a-z0-9][a-z0-9_-]*$/.test(value.range)) throw new Error("cursor scope differs");
    return value;
  } catch {
    throw new BrainError({ code: "invalid_page", message: "The page cursor does not match this named-key list." });
  }
}

function reverseTime(millis: number): string {
  if (!Number.isSafeInteger(millis)) throw new BrainError({ code: "invalid_time", message: "The list time needs integer UTC milliseconds." });
  return ((1n << 63n) - 1n - BigInt(millis)).toString().padStart(20, "0");
}

export async function namedRecordPage(
  node: NodeClient, cfg: Pick<Config, "schemaHashes">, scope: Scope,
  limit = 20, cursor?: string,
): Promise<{ items: NamedCard[]; next_page?: string; has_more: boolean }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new BrainError({ code: "invalid_list_scope", message: "The page limit is 1 to 500." });
  }
  const context = contextOf(scope);
  const anchor = anchorOf(cursor, context);
  const types = scope.type ? [scope.type] : [...RECORD_TYPES];
  const end = scope.updatedSinceMs === undefined ? ":" : reverseTime(scope.updatedSinceMs) + "$";
  const streams = await Promise.all(types.map(async (type) => {
    const hash = scope.design ?? scope.status ?? "all";
    const name = scope.design !== undefined ? "by_design" : scope.status !== undefined ? "by_status" : "recent";
    const page = await keyPage(node, cfg.schemaHashes[type]!, name,
      { HashRangeRange: { hash, start: anchor?.range ?? "", end } }, ["slug", "title", "status", "updated_at"], limit + 2);
    const rows = page.results.map((row) => {
      if (row.fields.slug !== row.key.hash) throw new BrainError({ code: "named_record_identity", message: "The named key differs from its primary record." });
      return { range: row.matched_key.range, card: { type, slug: row.key.hash!, title: String(row.fields.title ?? ""),
        status: String(row.fields.status ?? ""), updated_at: String(row.fields.updated_at ?? "") } };
    }).filter((row) => !anchor || row.range > anchor.range || (row.range === anchor.range && type > anchor.type));
    return { rows, more: page.has_more };
  }));
  const ordered = streams.flatMap((stream) => stream.rows).sort((a, b) =>
    a.range < b.range ? -1 : a.range > b.range ? 1 : a.card.type < b.card.type ? -1 : a.card.type > b.card.type ? 1 : 0);
  const selected = ordered.slice(0, limit);
  const has_more = ordered.length > selected.length || streams.some((stream) => stream.more);
  const last = selected.at(-1);
  if (has_more && !last) throw new BrainError({ code: "named_record_cursor_stalled", message: "The named-key list did not advance." });
  const next_page = has_more && last ? "mk1." + Buffer.from(JSON.stringify({ context, range: last.range, type: last.card.type })).toString("base64url") : undefined;
  return { items: selected.map((row) => row.card), has_more, ...(next_page ? { next_page } : {}) };
}

export function namedScope(hash: string): Scope | null {
  if (hash === "all") return {};
  if (isRecordType(hash)) return { type: hash };
  if (hash.startsWith("child#")) return { type: "task", design: hash.slice(6) };
  const split = hash.indexOf("#");
  const type = hash.slice(0, split);
  return split > 0 && isRecordType(type) ? { type, status: hash.slice(split + 1) } : null;
}

export async function namedCards(
  node: NodeClient, cfg: Pick<Config, "schemaHashes">, hash: string, firstPage = false,
): Promise<NamedCard[] | null> {
  const scope = namedScope(hash);
  if (!scope) return null;
  const out: NamedCard[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const page = await namedRecordPage(node, cfg, scope, firstPage ? 20 : 500, cursor);
    out.push(...page.items);
    if (firstPage || !page.has_more) return out;
    if (!page.next_page || cursor === page.next_page) throw new BrainError({ code: "named_record_cursor_stalled", message: "The named-key list did not advance." });
    cursor = page.next_page;
  }
  throw new BrainError({ code: "named_record_read_limit", message: "The named-key list exceeded its page limit." });
}
