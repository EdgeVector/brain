// Stored list pages. One page is one HashRangeKey on blp_page.
// backlinkIndexTag and backlinkTargetSlugs still name the old membership layout.

import { FbrainError, type NodeClient } from "./client.ts";
import { HEAD_RANGE } from "./list-page.ts";
import {
  normalizeSlug,
  parseGenericLinkTag,
  wikiLinkSlugs,
  type FbrainRecord,
} from "./record.ts";
import { type RecordType } from "./schemas.ts";

const BACKLINK_INDEX_TAG_PREFIX = "__fbrain_backlink__:";

const PAGE_BYTE_CAP = 8 * 1024;
const PAGE_LIMIT_CAP = 100;
const PAGE_ID = /^p\d{8}$/;

export type StoredCard = {
  type: string;
  slug: string;
  status: string;
  title: string;
  updated_at: string;
};

export type StoredPage =
  | { kind: "absent" }
  | { kind: "bad" }
  | { kind: "page"; cards: StoredCard[]; older: string; bytes: number };

export function pageBackfill(hash: string, source: string): string {
  return `brain reindex --target ${hash} --source-hash ${source} --slug <slug>`;
}

export function pageRangeOrThrow(pageId: string): string {
  if (pageId === HEAD_RANGE || PAGE_ID.test(pageId)) return pageId;
  throw new FbrainError({
    code: "invalid_page",
    message: `page id ${pageId} is not a list page id`,
    hint: "Use __head__ or a page id of p plus eight digits.",
  });
}

// A stored atom over 8 KiB keeps the named bound. A caller limit cannot raise it.
export function displayCap(
  limit: number | undefined,
  named: number,
  bytes: number,
): { cap: number; partial: boolean } {
  const asked = limit === undefined ? named : Math.min(limit, PAGE_LIMIT_CAP);
  if (bytes > PAGE_BYTE_CAP) return { cap: Math.min(asked, named), partial: true };
  return { cap: asked, partial: false };
}

// One exact page. A missing atom is absent. Bad JSON is not an empty page.
export async function readStoredPage(
  node: NodeClient,
  schemaHash: string,
  hash: string,
  range: string,
): Promise<StoredPage> {
  if (schemaHash.length === 0) return { kind: "absent" };
  const res = await node.queryAll({
    schemaHash,
    fields: ["blp_page"],
    filter: { HashRangeKey: { hash, range } },
  });
  const row = res.results.find((item) => {
    const keyHash = item.key?.hash;
    const keyRange = item.key?.range;
    if (keyHash && keyHash !== hash) return false;
    if (keyRange && keyRange !== range) return false;
    return true;
  });
  const raw = row?.fields.blp_page;
  if (typeof raw !== "string" || raw.length === 0) return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "bad" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "bad" };
  const obj = value as { cards?: unknown; older?: unknown };
  if (!Array.isArray(obj.cards)) return { kind: "bad" };
  if ("older" in obj && typeof obj.older !== "string") return { kind: "bad" };
  const cards: StoredCard[] = [];
  for (const item of obj.cards) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const card = item as Record<string, unknown>;
    if (typeof card.slug !== "string" || card.slug.length === 0) continue;
    cards.push({
      type: typeof card.type === "string" ? card.type : "",
      slug: card.slug,
      status: typeof card.status === "string" ? card.status : "",
      title: typeof card.title === "string" ? card.title : "",
      updated_at: typeof card.updated_at === "string" ? card.updated_at : "",
    });
  }
  return {
    kind: "page",
    cards,
    older: typeof obj.older === "string" ? obj.older : "",
    bytes: Buffer.byteLength(raw),
  };
}

export function backlinkIndexTag(targetSlug: string): string {
  return `${BACKLINK_INDEX_TAG_PREFIX}${normalizeSlug(targetSlug)}`;
}

export function backlinkTargetSlugs(
  record: FbrainRecord,
  sourceType: RecordType,
): string[] {
  const targets = new Set<string>();
  if (sourceType === "task" && record.design_slug && record.design_slug.length > 0) {
    const designSlug = normalizeSlug(record.design_slug);
    if (designSlug.length > 0) targets.add(designSlug);
  }
  for (const tag of record.tags) {
    const parsed = parseGenericLinkTag(tag);
    if (!parsed) continue;
    const slug = normalizeSlug(parsed.to_slug);
    if (slug.length > 0) targets.add(slug);
  }
  for (const slug of wikiLinkSlugs(record.body)) {
    if (slug.length > 0) targets.add(slug);
  }
  return [...targets].sort();
}
