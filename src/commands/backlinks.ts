// `brain backlinks <slug>` — one link page, then live source fields.
// A target-type filter verifies body and stored frontmatter references.

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
import { BACKLINK_PAGE, DIRECTORY_RANGE, EDGE_CAP, FRONTMATTER_RANGE, HEAD_RANGE } from "../list-page.ts";
import {
  arrayStringField,
  normalizeSlug,
  parseGenericLinkTag,
  schemaHashFor,
  stringField,
  TOMBSTONE_TAG,
} from "../record.ts";
import { recordFromPrimaryFields } from "../resident-write-plan.ts";
import {
  BRAIN_EDGE_SET_SCHEMA_KEY,
  BRAIN_LIST_PAGE_SCHEMA_KEY,
  BRAIN_TYPE_DIRECTORY_SCHEMA_KEY,
  GRAPH_EDGE_OUT_SCHEMA_KEY,
  isRecordType,
  type RecordType,
} from "../schemas.ts";

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
type LinkSource = {
  status: string;
  tags: string[];
  designSlug: string;
  body?: string;
  frontmatterLink?: boolean;
};

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
  const { cap, partial: capped } = displayCap(limit, BACKLINK_PAGE, page.bytes);
  const shown = page.cards.slice(0, cap);
  const clipped = page.cards.length > shown.length;
  const { sources: live, partial: unproven } = await readLinkSources(node, cfg, shown, target, targetType);
  const partial = capped || unproven;
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
): Promise<{ sources: Map<string, LinkSource>; partial: boolean }> {
  const byType = new Map<RecordType, string[]>();
  for (const card of cards) {
    if (!isRecordType(card.type)) continue;
    const slugs = byType.get(card.type) ?? [];
    slugs.push(card.slug);
    byType.set(card.type, slugs);
  }
  const out = new Map<string, LinkSource>();
  if (!node.queryByKeys) return { sources: out, partial: cards.length > 0 };
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
  const partial = targetType !== undefined
    ? await markFrontmatterLinks(node, cfg, cards, out, target, targetType)
    : false;
  return { sources: out, partial };
}

function storedStringList(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

/** Typed metadata proves frontmatter links; legacy graph rows need a unique source type. */
async function markFrontmatterLinks(
  node: ReturnType<typeof newReadClientFromCfg>,
  cfg: Config,
  cards: readonly StoredCard[],
  sources: Map<string, LinkSource>,
  target: string,
  targetType: RecordType,
): Promise<boolean> {
  const setSchema = cfg.schemaHashes[BRAIN_EDGE_SET_SCHEMA_KEY] ?? "";
  const graphSchema = cfg.schemaHashes[GRAPH_EDGE_OUT_SCHEMA_KEY] ?? "";
  const candidates = new Map<string, { slug: string; type: RecordType; source: LinkSource }>();
  for (const card of cards) {
    if (!isRecordType(card.type)) continue;
    const key = `${card.type}\0${card.slug}`;
    const source = sources.get(key);
    if (!source || source.tags.includes(TOMBSTONE_TAG) ||
        hasExplicitLink(source, card.type, target, targetType) ||
        bodyLinksTo(card.slug, source.body ?? "", target)) continue;
    candidates.set(`es#${card.type}#${card.slug}`, { slug: card.slug, type: card.type, source });
  }
  if (candidates.size === 0) return false;
  if (!node.queryByKeys || setSchema.length === 0) return true;
  const rows = await node.queryByKeys({
    schemaHash: setSchema,
    fields: ["bes_h", "bes_r", "bes_ids"],
    keys: [...candidates.keys()].flatMap((hash) => [
      { hash, range: HEAD_RANGE }, { hash, range: FRONTMATTER_RANGE },
    ]),
  });
  const destination = target.toLowerCase();
  const headIds = new Map<string, string[] | null>();
  const frontmatterIds = new Map<string, string[] | null>();
  for (const row of rows) {
    const hash = row.key?.hash || stringField(row.fields, "bes_h");
    const range = row.key?.range || stringField(row.fields, "bes_r");
    if (!candidates.has(hash)) continue;
    const ids = storedStringList(stringField(row.fields, "bes_ids"));
    if (range === HEAD_RANGE) headIds.set(hash, ids);
    if (range === FRONTMATTER_RANGE) frontmatterIds.set(hash, ids);
  }
  const matchesDestination = (id: string): boolean => {
    const cut = id.indexOf("#");
    return cut > 0 && id.slice(cut + 1) === destination;
  };
  let partial = false;
  const legacy = new Map<string, { slug: string; type: RecordType; source: LinkSource; ids: string[] }>();
  for (const [hash, candidate] of candidates) {
    const ids = headIds.get(hash);
    if (frontmatterIds.has(hash)) {
      const frontmatter = frontmatterIds.get(hash);
      if (!frontmatter || frontmatter.length > EDGE_CAP) {
        partial = true;
      } else if (frontmatter.length > 0) {
        if (!ids || ids.length > EDGE_CAP) partial = true;
        else candidate.source.frontmatterLink = frontmatter.some((id) =>
          matchesDestination(id) && ids.includes(id));
      }
      continue;
    }
    if (!ids || ids.length > EDGE_CAP) {
      partial = true;
      continue;
    }
    const matching = ids.filter(matchesDestination);
    if (matching.length > 0) legacy.set(hash, { ...candidate, ids: matching });
  }
  if (legacy.size === 0) return partial;
  const directorySchema = cfg.schemaHashes[BRAIN_TYPE_DIRECTORY_SCHEMA_KEY] ?? "";
  if (directorySchema.length === 0 || graphSchema.length === 0) return true;
  const directory = await node.queryByKeys({
    schemaHash: directorySchema,
    fields: ["btd_h", "btd_types"],
    keys: [...new Set([...legacy.values()].map(({ slug }) => slug))]
      .map((hash) => ({ hash, range: DIRECTORY_RANGE })),
  });
  const sourceTypes = new Map(directory.map((row) => [
    row.key?.hash || stringField(row.fields, "btd_h"),
    storedStringList(stringField(row.fields, "btd_types")),
  ]));
  const graphKeys = new Map<string, { hash: string; range: string; sources: LinkSource[] }>();
  for (const candidate of legacy.values()) {
    const types = sourceTypes.get(candidate.slug);
    if (!types || types.length !== 1 || types[0] !== candidate.type) {
      partial = true;
      continue;
    }
    for (const id of candidate.ids) {
      const hash = normalizeSlug(candidate.slug).toLowerCase();
      const key = `${hash}\0${id}`;
      const graph = graphKeys.get(key) ?? { hash, range: id, sources: [] };
      graph.sources.push(candidate.source);
      graphKeys.set(key, graph);
    }
  }
  if (graphKeys.size === 0) return partial;
  const edges = await node.queryByKeys({
    schemaHash: graphSchema,
    fields: ["bge_src", "bge_dst", "bge_type", "bge_provenance"],
    keys: [...graphKeys.values()].map(({ hash, range }) => ({ hash, range })),
  });
  for (const row of edges) {
    if (stringField(row.fields, "bge_provenance") !== "frontmatter") continue;
    const src = stringField(row.fields, "bge_src");
    const dst = stringField(row.fields, "bge_dst");
    if (dst !== destination) continue;
    const graph = graphKeys.get(`${src}\0${stringField(row.fields, "bge_type")}#${dst}`);
    for (const source of graph?.sources ?? []) source.frontmatterLink = true;
  }
  return partial;
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
  if (source.frontmatterLink ||
      (source.body !== undefined && bodyLinksTo("backlink-source", source.body, target))) {
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
