// `brain backlinks <slug>` — one link page, then status and tags for that page.

import {
  displayCap,
  pageBackfill,
  pageRangeOrThrow,
  readStoredPage,
  type StoredCard,
  type StoredPage,
} from "../backlink-index.ts";
import { newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import { BACKLINK_PAGE, HEAD_RANGE } from "../list-page.ts";
import {
  arrayStringField,
  normalizeSlug,
  parseGenericLinkTag,
  schemaHashFor,
  stringField,
} from "../record.ts";
import { BRAIN_LIST_PAGE_SCHEMA_KEY, isRecordType, type RecordType } from "../schemas.ts";

export type BacklinksJson = {
  slug: string;
  type?: RecordType;
  linked_from: Array<{
    type: RecordType;
    slug: string;
    status: string;
    via: Array<"explicit" | "body">;
  }>;
  older?: string;
  absent?: boolean;
  partial?: boolean;
  backfill?: string;
  truncated?: boolean;
};

export type BacklinksOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  page?: string;
  limit?: number;
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  onResult?: (payload: BacklinksJson) => void;
};

type ShownLink = BacklinksJson["linked_from"][number];

export async function backlinksCmd(opts: BacklinksOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const range =
    opts.page !== undefined && opts.page.length > 0 ? pageRangeOrThrow(opts.page) : HEAD_RANGE;
  const hash = `link#${slug}`;
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);
  const schemaHash = opts.cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
  const page = await readStoredPage(node, schemaHash, hash, range);
  const view = await decoratePage(node, opts.cfg, page, slug, opts.type, opts.limit);
  const json = backlinksToJson(slug, opts.type, hash, view);
  opts.onResult?.(json);
  if (opts.json) {
    print(JSON.stringify(json));
    return;
  }
  print(formatBacklinks(json, view.lines));
}

async function decoratePage(
  node: ReturnType<typeof newReadClientFromCfg>,
  cfg: Config,
  page: StoredPage,
  target: string,
  targetType: RecordType | undefined,
  limit: number | undefined,
): Promise<{ links: ShownLink[]; lines: string[]; older: string; absent: boolean; partial: boolean; clipped: boolean }> {
  if (page.kind === "absent") {
    return {
      links: [],
      lines: ["sample", "index record absent", pageBackfill(`link#${target}`, "<type>")],
      older: "",
      absent: true,
      partial: false,
      clipped: false,
    };
  }
  if (page.kind === "bad") {
    return {
      links: [],
      lines: ["sample", "index partial"],
      older: "",
      absent: false,
      partial: true,
      clipped: false,
    };
  }
  const { cap, partial } = displayCap(limit, BACKLINK_PAGE, page.bytes);
  const shown = page.cards.slice(0, cap);
  const clipped = page.cards.length > shown.length;
  const live = await statusAndTags(node, cfg, shown);
  const links: ShownLink[] = [];
  for (const card of shown) {
    if (!isRecordType(card.type)) continue;
    const row = live.get(`${card.type}\0${card.slug}`);
    const status = row !== undefined && row.status.length > 0 ? row.status : card.status;
    const tags = row?.tags ?? [];
    links.push({
      type: card.type,
      slug: card.slug,
      status,
      via: linkVia(tags, target, targetType),
    });
  }
  const lines: string[] = [];
  if (clipped) lines.push("the cap cut this page");
  if (page.older.length > 0) lines.push(`sample ${page.older}`);
  if (partial) lines.push("index partial");
  return {
    links,
    lines,
    older: page.older,
    absent: false,
    partial,
    clipped,
  };
}

async function statusAndTags(
  node: ReturnType<typeof newReadClientFromCfg>,
  cfg: Config,
  cards: readonly StoredCard[],
): Promise<Map<string, { status: string; tags: string[] }>> {
  const byType = new Map<RecordType, string[]>();
  for (const card of cards) {
    if (!isRecordType(card.type)) continue;
    const slugs = byType.get(card.type) ?? [];
    slugs.push(card.slug);
    byType.set(card.type, slugs);
  }
  const out = new Map<string, { status: string; tags: string[] }>();
  if (!node.queryByKeys) return out;
  for (const [type, slugs] of byType) {
    let schemaHash: string;
    try {
      schemaHash = schemaHashFor(type, cfg);
    } catch {
      continue;
    }
    const rows = await node.queryByKeys({
      schemaHash,
      fields: ["status", "tags"],
      keys: slugs.map((hash) => ({ hash, range: "" })),
    });
    for (const row of rows) {
      const hash = row.key?.hash;
      if (!hash) continue;
      out.set(`${type}\0${hash}`, {
        status: stringField(row.fields, "status"),
        tags: arrayStringField(row.fields, "tags"),
      });
    }
  }
  return out;
}

function linkVia(
  tags: readonly string[],
  target: string,
  targetType: RecordType | undefined,
): Array<"explicit" | "body"> {
  for (const tag of tags) {
    const parsed = parseGenericLinkTag(tag);
    if (parsed === null) continue;
    if (normalizeSlug(parsed.to_slug) !== target) continue;
    if (targetType !== undefined && parsed.to_type !== targetType) continue;
    return ["explicit"];
  }
  return ["body"];
}

function backlinksToJson(
  slug: string,
  type: RecordType | undefined,
  hash: string,
  view: {
    links: ShownLink[];
    older: string;
    absent: boolean;
    partial: boolean;
    clipped: boolean;
  },
): BacklinksJson {
  const out: BacklinksJson = { slug, linked_from: view.links };
  if (type !== undefined) out.type = type;
  if (view.older.length > 0) out.older = view.older;
  if (view.absent) {
    out.absent = true;
    out.backfill = pageBackfill(hash, "<type>");
  }
  if (view.partial) out.partial = true;
  if (view.clipped || view.older.length > 0 || view.absent || view.partial) out.truncated = true;
  return out;
}

function formatBacklinks(json: BacklinksJson, notes: readonly string[]): string {
  const target = json.type === undefined ? json.slug : `${json.type} ${json.slug}`;
  if (json.linked_from.length === 0 && notes.length === 0) {
    return `backlinks for ${target}: (none)`;
  }
  const lines = [`backlinks for ${target}:`];
  for (const link of json.linked_from) {
    lines.push(`- ${link.type} ${link.slug} (${link.status}; ${link.via.join(", ")})`);
  }
  for (const note of notes) lines.push(note);
  return lines.join("\n");
}
