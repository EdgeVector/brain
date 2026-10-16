// `brain backlinks <slug>` — one link page, then live source fields.
// A target-type filter verifies body references, including a stored tail.

import {
  displayCap,
  pageBackfill,
  pageRangeOrThrow,
  readStoredPage,
  type StoredCard,
  type StoredPage,
} from "../backlink-index.ts";
import { newReadClientFromCfg, type Verbose } from "../client.ts";
import { hydrateRecord, parseSpillMarker } from "../body-spill.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import { extractGraphEdges } from "../graph-edge.ts";
import { BACKLINK_PAGE, HEAD_RANGE } from "../list-page.ts";
import {
  arrayStringField,
  normalizeSlug,
  parseGenericLinkTag,
  schemaHashFor,
  stringField,
  TOMBSTONE_TAG,
} from "../record.ts";
import { recordFromPrimaryFields } from "../resident-write-plan.ts";
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
type LinkSource = { status: string; tags: string[]; designSlug: string; body?: string };

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
  const live = await readLinkSources(node, cfg, shown, target, targetType);
  const links: ShownLink[] = [];
  for (const card of shown) {
    if (!isRecordType(card.type)) continue;
    const row = live.get(`${card.type}\0${card.slug}`);
    if (row === undefined || row.tags.includes(TOMBSTONE_TAG)) continue;
    const via = linkVia(row, card.type, target, targetType);
    if (via.length === 0) continue;
    const status = row.status.length > 0 ? row.status : card.status;
    links.push({
      type: card.type,
      slug: card.slug,
      status,
      via,
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

async function readLinkSources(
  node: ReturnType<typeof newReadClientFromCfg>,
  cfg: Config,
  cards: readonly StoredCard[],
  target: string,
  targetType: RecordType | undefined,
): Promise<Map<string, LinkSource>> {
  const byType = new Map<RecordType, string[]>();
  for (const card of cards) {
    if (!isRecordType(card.type)) continue;
    const slugs = byType.get(card.type) ?? [];
    slugs.push(card.slug);
    byType.set(card.type, slugs);
  }
  const out = new Map<string, LinkSource>();
  if (!node.queryByKeys) return out;
  await Promise.all([...byType].map(async ([type, slugs]) => {
    let schemaHash: string;
    try {
      schemaHash = schemaHashFor(type, cfg);
    } catch {
      return;
    }
    const rows = await node.queryByKeys!({
      schemaHash,
      fields: [
        "status", "tags",
        ...(type === "task" ? ["design_slug"] : []),
        ...(targetType !== undefined ? ["body"] : []),
      ],
      keys: slugs.map((hash) => ({ hash, range: "" })),
    });
    await Promise.all(rows.map(async (row) => {
      const hash = row.key?.hash;
      if (!hash) return;
      const source: LinkSource = {
        status: stringField(row.fields, "status"),
        tags: arrayStringField(row.fields, "tags"),
        designSlug: stringField(row.fields, "design_slug"),
      };
      if (targetType !== undefined) {
        const rawBody = stringField(row.fields, "body");
        const marker = parseSpillMarker(rawBody);
        source.body = marker ? marker.head : rawBody;
        // A typed mismatch can still be a body link in the stored tail.
        if (marker && !hasExplicitLink(source, type, target, targetType) &&
            !bodyLinksTo(hash, source.body, target)) {
          const full = await hydrateRecord(node, cfg, type,
            recordFromPrimaryFields({ ...row.fields, slug: hash }), { fields: ["body"] });
          source.body = full.body;
        }
      }
      out.set(`${type}\0${hash}`, source);
    }));
  }));
  return out;
}

function hasExplicitLink(
  source: LinkSource,
  sourceType: RecordType,
  target: string,
  targetType: RecordType | undefined,
): boolean {
  if (sourceType === "task" && normalizeSlug(source.designSlug) === target &&
      (targetType === undefined || targetType === "design")) return true;
  for (const tag of source.tags) {
    const parsed = parseGenericLinkTag(tag);
    if (parsed === null) continue;
    if (normalizeSlug(parsed.to_slug) !== target) continue;
    if (targetType !== undefined && parsed.to_type !== targetType) continue;
    return true;
  }
  return false;
}

function bodyLinksTo(sourceSlug: string, body: string, target: string): boolean {
  return extractGraphEdges({ sourceSlug, body }).some((edge) => edge.dst === target.toLowerCase());
}

function linkVia(
  source: LinkSource,
  sourceType: RecordType,
  target: string,
  targetType: RecordType | undefined,
): Array<"explicit" | "body"> {
  const via: Array<"explicit" | "body"> = [];
  if (hasExplicitLink(source, sourceType, target, targetType)) via.push("explicit");
  if (source.body !== undefined && bodyLinksTo("backlink-source", source.body, target)) {
    via.push("body");
  } else if (targetType === undefined && via.length === 0) {
    // The page establishes the body edge when no typed filter needs proof.
    via.push("body");
  }
  return via;
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
