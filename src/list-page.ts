import type { BatchMutationOp, NodeClient, QueryRow } from "./client.ts";
import { edgeRange, extractGraphEdges, type GraphEdge } from "./graph-edge.ts";
import { utf8Head } from "./index-payload.ts";
import { parseSpillMarker } from "./body-spill.ts";
import { TOMBSTONE_TAG, isTombstoned, type FbrainRecord } from "./record.ts";
import { tokenize } from "./retrieval/bm25.ts";
import {
  BRAIN_EDGE_SET_SCHEMA_KEY,
  BRAIN_LIST_LOCATOR_SCHEMA_KEY,
  BRAIN_LIST_PAGE_SCHEMA_KEY,
  BRAIN_TOKEN_SET_SCHEMA_KEY,
  BRAIN_TYPE_DIRECTORY_SCHEMA_KEY,
  BRAIN_LIST_COUNT_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";

export const TAG_CAP = 2;
export const LINK_CAP = 2;
export const EDGE_CAP = 16;
export const POSTING_CAP = 8;
export const RANKER_PAGE = 25;
export const LIST_PAGE = 20;
export const BACKFILL_PAGE = 25;
export const CHILD_PAGE = 20;
export const BACKLINK_PAGE = 50;
export const SYMPTOM_PAGE = 1;
export const WRITE_BATCH_MAX = 64;
export const READ_KEY_CAP = 43;
export const HEAD_RANGE = "__head__";
export const DIRECTORY_RANGE = "__types__";
const PAGE_BYTE_CAP = 8 * 1024;
const TITLE_BYTES = 64;
const TITLE_BYTES_TIGHT = 32;
export const INDEX_PARTIAL = "index partial";
export const COUNT_UNCONFIRMED = "the count did not confirm";

type SchemaCfg = { schemaHashes: Record<string, string> };

export type ListCard = {
  type?: string;
  slug: string;
  status?: string;
  updated_at?: string;
  title?: string;
};

type PageBody = { cards: ListCard[]; older: string };

export type SideProjection =
  | "list-page"
  | "list-locator"
  | "directory"
  | "edge-set"
  | "token-set"
  | "keyword";

export type SideOp = {
  mutationType: "create" | "update" | "delete";
  schemaHash: string;
  keyHash: string;
  keyRange?: string;
  fields: Record<string, unknown>;
  projection: SideProjection;
};

export type HeadReplay =
  | { kind: "place"; card: ListCard; bound: number; overflowId: string }
  | { kind: "remove"; type: string; slug: string }
  | { kind: "symptom"; slug: string }
  | { kind: "clear"; slug: string }
  | { kind: "keyword"; type: string; slug: string; weight: number | null };

export type HeadCommit = {
  schemaHash: string;
  keyHash: string;
  keyRange: string;
  mutationType: "create" | "update" | "delete";
  fields: Record<string, unknown>;
  expected:
    | { type: "absent"; field: "blp_page" }
    | { type: "value"; field: "blp_page"; value: string };
  replay: HeadReplay;
};

/** Written after keyword heads ack, so a failed head does not drop its token name. */
export type DeferredTokenSet = {
  schemaHash: string;
  keyHash: string;
  existed: boolean;
  stored: string | null;
  nextNames: string[];
};

export type ListSidePlan = {
  ops: SideOp[];
  heads: HeadCommit[];
  keywordHeads: HeadCommit[];
  tokenSet: DeferredTokenSet | null;
  partial: boolean;
  details: string[];
  previousEdgeIds: string[];
  /** Edge ids actually stored, after the cap and any preserved frontmatter ids. */
  writtenEdgeIds: string[];
  /** Stored ids that were not in the previous body and survived the cap. */
  preservedEdgeIds: string[];
};

type Slot = { hash: string; kind: "list" | "symptom"; bound: number };

type MemPage = PageBody & {
  hash: string;
  range: string;
  existed: boolean;
  original: string | null;
  touched: boolean;
  symptom: boolean;
};

type MemLoc = {
  listHash: string;
  range: string;
  pageId: string;
  existed: boolean;
  touched: boolean;
  deleted: boolean;
};

function schemaOf(cfg: SchemaCfg, key: string): string {
  const hash = cfg.schemaHashes[key];
  return hash && hash.length > 0 ? hash : "";
}

function notePartial(details: string[], why: string): void {
  if (!details.includes(INDEX_PARTIAL)) details.push(INDEX_PARTIAL);
  if (why.length > 0 && !details.includes(why)) details.push(why);
}

function userTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag.length === 0 || tag === TOMBSTONE_TAG || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function textField(record: FbrainRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export type PostingToken = { token: string; weight: number };

const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;

export function postingTokens(
  title: string,
  body: string,
): { tokens: PostingToken[]; dropped: boolean } {
  // The seal already stored the head. A second cut would index the spilled tail.
  const marker = parseSpillMarker(body);
  const head = marker ? marker.head : body;
  const titleTokens = new Set(tokenize(title));
  const seen = new Set<string>();
  const tokens: PostingToken[] = [];
  let dropped = false;
  for (const token of [...tokenize(title), ...tokenize(head)]) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (tokens.length >= POSTING_CAP) {
      dropped = true;
      break;
    }
    tokens.push({ token, weight: titleTokens.has(token) ? TITLE_WEIGHT : BODY_WEIGHT });
  }
  return { tokens, dropped };
}

type KeywordCard = { type: string; slug: string; weight: number };

function keywordHash(token: string): string {
  return `kw#${token}`;
}

function sortKeyword(cards: KeywordCard[]): KeywordCard[] {
  return [...cards].sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    if (a.type < b.type) return -1;
    if (a.type > b.type) return 1;
    return 0;
  });
}

function parseKeywordCards(raw: string | null): KeywordCard[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { cards?: unknown };
    if (!Array.isArray(value.cards)) return [];
    const cards: KeywordCard[] = [];
    for (const item of value.cards) {
      if (!item || typeof item !== "object") continue;
      const card = item as Record<string, unknown>;
      if (typeof card.type !== "string" || card.type.length === 0) continue;
      if (typeof card.slug !== "string" || card.slug.length === 0) continue;
      if (typeof card.weight !== "number" || !Number.isFinite(card.weight)) continue;
      cards.push({ type: card.type, slug: card.slug, weight: card.weight });
    }
    return cards;
  } catch {
    return [];
  }
}

/** Rank insert shared by put, keyword commit, and named-slug backfill. */
function nextKeywordCards(
  cards: readonly KeywordCard[],
  type: string,
  slug: string,
  weight: number | null,
): KeywordCard[] | "full" | "same" {
  if (weight === null) {
    const filtered = cards.filter((card) => !(card.type === type && card.slug === slug));
    if (filtered.length === cards.length) return "same";
    return filtered;
  }
  const rest = cards.filter((card) => !(card.type === type && card.slug === slug));
  const already = rest.length !== cards.length;
  let next: KeywordCard[];
  if (already || rest.length < RANKER_PAGE) {
    next = sortKeyword([...rest, { type, slug, weight }]);
  } else {
    const sorted = sortKeyword(rest);
    const lowest = sorted[sorted.length - 1];
    if (!lowest || weight <= lowest.weight) return "full";
    sorted[sorted.length - 1] = { type, slug, weight };
    next = sortKeyword(sorted);
  }
  if (Buffer.byteLength(JSON.stringify({ cards: next })) > PAGE_BYTE_CAP) return "full";
  return next;
}

function uniqueDests(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const cut = id.indexOf("#");
    const dest = cut >= 0 ? id.slice(cut + 1) : "";
    if (dest.length === 0 || seen.has(dest)) continue;
    seen.add(dest);
    out.push(dest);
  }
  return out;
}

function edgeIdsOf(edges: readonly GraphEdge[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const id = edgeRange(edge);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parsePage(raw: string | null): PageBody {
  if (!raw) return { cards: [], older: "" };
  try {
    const value = JSON.parse(raw) as { cards?: unknown; older?: unknown };
    const cards: ListCard[] = [];
    if (Array.isArray(value.cards)) {
      for (const item of value.cards) {
        if (!item || typeof item !== "object") continue;
        const card = item as Record<string, unknown>;
        if (typeof card.slug !== "string" || card.slug.length === 0) continue;
        const next: ListCard = { slug: card.slug };
        if (typeof card.type === "string") next.type = card.type;
        if (typeof card.status === "string") next.status = card.status;
        if (typeof card.updated_at === "string") next.updated_at = card.updated_at;
        if (typeof card.title === "string") next.title = card.title;
        cards.push(next);
      }
    }
    return {
      cards,
      older: typeof value.older === "string" ? value.older : "",
    };
  } catch {
    return { cards: [], older: "" };
  }
}

function renderCard(
  card: ListCard,
  mode: "full" | "tight" | "none",
  symptom: boolean,
): Record<string, string> {
  if (symptom) return { slug: card.slug };
  const out: Record<string, string> = {
    type: card.type ?? "",
    slug: card.slug,
    status: card.status ?? "",
    updated_at: card.updated_at ?? "",
  };
  if (mode !== "none" && card.title && card.title.length > 0) {
    const title = utf8Head(card.title, mode === "full" ? TITLE_BYTES : TITLE_BYTES_TIGHT);
    if (title.length > 0) out.title = title;
  }
  return out;
}

function renderPage(page: PageBody, symptom: boolean): string | null {
  const modes: Array<"full" | "tight" | "none"> = symptom
    ? ["none"]
    : ["full", "tight", "none"];
  let last = "";
  for (const mode of modes) {
    const json = JSON.stringify({
      cards: page.cards.map((card) => renderCard(card, mode, symptom)),
      older: page.older,
    });
    last = json;
    if (Buffer.byteLength(json) <= PAGE_BYTE_CAP) return json;
  }
  if (Buffer.byteLength(last) <= PAGE_BYTE_CAP) return last;
  return null;
}

function subjectCard(type: RecordType, record: FbrainRecord): ListCard {
  return {
    type,
    slug: record.slug,
    status: record.status,
    updated_at: record.updated_at,
    title: record.title,
  };
}

function dropCard(cards: ListCard[], type: string, slug: string): ListCard[] {
  return cards.filter((card) => !(card.slug === slug && (card.type === undefined || card.type === type)));
}

function rowField(row: QueryRow, name: string): string | null {
  const value = (row.fields as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : null;
}

function rowHash(row: QueryRow): string {
  return row.key?.hash ?? "";
}

function rowRange(row: QueryRow): string {
  return row.key?.range ?? "";
}

function pageMemKey(hash: string, range: string): string {
  return `${hash}\0${range}`;
}

function locMemKey(listHash: string, range: string): string {
  return `${listHash}\0${range}`;
}

function ensureMemPage(
  pages: Map<string, MemPage>,
  hash: string,
  range: string,
  symptom: boolean,
): MemPage {
  const id = pageMemKey(hash, range);
  const found = pages.get(id);
  if (found) return found;
  const created: MemPage = {
    hash,
    range,
    cards: [],
    older: "",
    existed: false,
    original: null,
    touched: false,
    symptom,
  };
  pages.set(id, created);
  return created;
}

function installMemPage(
  pages: Map<string, MemPage>,
  hash: string,
  range: string,
  raw: string | null,
  symptom: boolean,
): MemPage {
  const page = ensureMemPage(pages, hash, range, symptom);
  if (raw === null) return page;
  const parsed = parsePage(raw);
  page.cards = parsed.cards;
  page.older = parsed.older;
  page.existed = true;
  page.original = raw;
  page.symptom = symptom;
  return page;
}

async function readExact(
  node: NodeClient,
  schemaHash: string,
  fields: string[],
  keys: ReadonlyArray<{ hash: string; range: string }>,
): Promise<QueryRow[]> {
  if (schemaHash.length === 0 || keys.length === 0) return [];
  const limited = keys.slice(0, READ_KEY_CAP);
  const res = await node.queryAll({
    schemaHash,
    fields,
    filter: {
      HashRangeKeys: limited.map((key) => [key.hash, key.range]),
    },
  });
  return res.results;
}

function slotsFor(
  type: RecordType,
  record: FbrainRecord,
  linkDests: readonly string[],
  details: string[],
): Slot[] {
  const slots: Slot[] = [
    { hash: "all", kind: "list", bound: LIST_PAGE },
    { hash: type, kind: "list", bound: LIST_PAGE },
  ];
  if (record.status.length > 0) {
    slots.push({
      hash: `${type}#${record.status}`,
      kind: "list",
      bound: LIST_PAGE,
    });
  }
  const tags = userTags(record.tags);
  if (tags.length > TAG_CAP) notePartial(details, "tag cap");
  for (const tag of tags.slice(0, TAG_CAP)) {
    slots.push({ hash: `tag#${tag}`, kind: "list", bound: LIST_PAGE });
  }
  if (linkDests.length > LINK_CAP) notePartial(details, "link cap");
  for (const dest of linkDests.slice(0, LINK_CAP)) {
    slots.push({ hash: `link#${dest}`, kind: "list", bound: BACKLINK_PAGE });
  }
  if (type === "task" && record.design_slug && record.design_slug.length > 0) {
    slots.push({
      hash: `child#${record.design_slug}`,
      kind: "list",
      bound: CHILD_PAGE,
    });
  }
  if (type === "papercut") {
    const symptom = textField(record, "symptom_hash");
    if (symptom.length > 0) {
      slots.push({ hash: `symptom#${symptom}`, kind: "symptom", bound: SYMPTOM_PAGE });
    }
  }
  return slots;
}

function linkDestsFromBody(record: FbrainRecord | null): string[] {
  if (!record) return [];
  return uniqueDests(
    edgeIdsOf(
      extractGraphEdges({
        sourceSlug: record.slug,
        body: record.body,
      }),
    ),
  );
}

export async function planRecordListSide(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  type: RecordType;
  previous: FbrainRecord | null;
  next: FbrainRecord | null;
  /** Sealed product body. Keyword tokens must not see the pre-seal tail. */
  sealedBody?: string;
  nextEdges: readonly GraphEdge[];
  /** Append keeps edge-set ids that are not in the body, so those graph rows stay. */
  preserveStoredEdges?: boolean;
}): Promise<ListSidePlan> {
  const details: string[] = [];
  const pageSchema = schemaOf(opts.cfg, BRAIN_LIST_PAGE_SCHEMA_KEY);
  const locSchema = schemaOf(opts.cfg, BRAIN_LIST_LOCATOR_SCHEMA_KEY);
  const dirSchema = schemaOf(opts.cfg, BRAIN_TYPE_DIRECTORY_SCHEMA_KEY);
  const edgeSchema = schemaOf(opts.cfg, BRAIN_EDGE_SET_SCHEMA_KEY);
  const tokenSchema = schemaOf(opts.cfg, BRAIN_TOKEN_SET_SCHEMA_KEY);
  if (
    pageSchema.length === 0 ||
    locSchema.length === 0 ||
    dirSchema.length === 0 ||
    edgeSchema.length === 0 ||
    tokenSchema.length === 0
  ) {
    notePartial(details, "list schema absent");
  }

  const slug = (opts.next ?? opts.previous)?.slug ?? "";
  let nextIds = edgeIdsOf(opts.nextEdges);
  let preservedEdgeIds: string[] = [];
  const nextDests = uniqueDests(nextIds);
  const previousDests = linkDestsFromBody(opts.previous);
  const knownOld = opts.previous
    ? slotsFor(opts.type, opts.previous, previousDests, details)
    : [];
  const knownNew = opts.next
    ? slotsFor(opts.type, opts.next, nextDests, details)
    : [];

  const pages = new Map<string, MemPage>();
  const locs = new Map<string, MemLoc>();
  let previousEdgeIds: string[] = [];
  let storedTokenJson: string | null = null;
  let tokenExisted = false;
  let edgeExisted = false;
  let directoryRaw: string | null = null;
  let directoryExisted = false;

  const pageKey = pageMemKey;
  const locKey = locMemKey;
  const ensurePage = (hash: string, range: string, symptom: boolean): MemPage =>
    ensureMemPage(pages, hash, range, symptom);
  const installPage = (hash: string, range: string, raw: string | null, symptom: boolean): MemPage =>
    installMemPage(pages, hash, range, raw, symptom);

  if (pageSchema.length > 0 && locSchema.length > 0 && slug.length > 0) {
    const locatorKeys = knownOld
      .filter((slot) => slot.kind === "list")
      .map((slot) => ({
        hash: `loc#${slot.hash}`,
        range: `${opts.type}#${slug}`,
        listHash: slot.hash,
      }));
    const headKeys = new Map<string, Slot>();
    for (const slot of [...knownOld, ...knownNew]) {
      headKeys.set(slot.hash, slot);
    }
    const queriedHeads = new Set<string>();
    for (const slot of headKeys.values()) queriedHeads.add(slot.hash);
    const [locRows, headRows, edgeRows, tokenRows, dirRows] = await Promise.all([
      readExact(
        opts.node,
        locSchema,
        ["bll_h", "bll_r", "bll_page"],
        locatorKeys.map((key) => ({ hash: key.hash, range: key.range })),
      ),
      readExact(
        opts.node,
        pageSchema,
        ["blp_h", "blp_r", "blp_page"],
        [...headKeys.values()].map((slot) => ({ hash: slot.hash, range: HEAD_RANGE })),
      ),
      edgeSchema.length > 0
        ? readExact(opts.node, edgeSchema, ["bes_h", "bes_r", "bes_ids"], [
            { hash: `es#${opts.type}#${slug}`, range: HEAD_RANGE },
          ])
        : Promise.resolve([]),
      tokenSchema.length > 0
        ? readExact(opts.node, tokenSchema, ["bts_h", "bts_r", "bts_tokens"], [
            { hash: `ts#${opts.type}#${slug}`, range: HEAD_RANGE },
          ])
        : Promise.resolve([]),
      dirSchema.length > 0 && opts.previous === null && opts.next !== null
        ? readExact(opts.node, dirSchema, ["btd_h", "btd_r", "btd_types"], [
            { hash: slug, range: DIRECTORY_RANGE },
          ])
        : Promise.resolve([]),
    ]);

    for (const row of locRows) {
      const listHash = rowHash(row).startsWith("loc#")
        ? rowHash(row).slice(4)
        : (rowField(row, "bll_h") ?? "").replace(/^loc#/, "");
      const range = rowRange(row) || rowField(row, "bll_r") || "";
      const pageId = rowField(row, "bll_page") ?? "";
      if (listHash.length === 0 || range.length === 0 || pageId.length === 0) continue;
      locs.set(locKey(listHash, range), {
        listHash,
        range,
        pageId,
        existed: true,
        touched: false,
        deleted: false,
      });
    }
    for (const row of headRows) {
      const hash = rowHash(row) || rowField(row, "blp_h") || "";
      const range = rowRange(row) || rowField(row, "blp_r") || HEAD_RANGE;
      const slot = headKeys.get(hash);
      installPage(hash, range, rowField(row, "blp_page"), slot?.kind === "symptom");
    }
    const edgeRow = edgeRows[0];
    if (edgeRow) {
      edgeExisted = true;
      previousEdgeIds = parseStringList(rowField(edgeRow, "bes_ids"));
    }
    const tokenRow = tokenRows[0];
    if (tokenRow) {
      tokenExisted = true;
      storedTokenJson = rowField(tokenRow, "bts_tokens");
    }
    const dirRow = dirRows[0];
    if (dirRow) {
      directoryExisted = true;
      directoryRaw = rowField(dirRow, "btd_types");
    }

    const storedDests = edgeExisted ? uniqueDests(previousEdgeIds) : previousDests;
    const oldSlots = opts.previous
      ? slotsFor(opts.type, opts.previous, storedDests, details)
      : knownOld;
    const extraLocators = oldSlots.filter((slot) => {
      if (slot.kind !== "list") return false;
      return !locs.has(locKey(slot.hash, `${opts.type}#${slug}`));
    });
    if (extraLocators.length > 0 && locSchema.length > 0) {
      const extraRows = await readExact(
        opts.node,
        locSchema,
        ["bll_h", "bll_r", "bll_page"],
        extraLocators.map((slot) => ({
          hash: `loc#${slot.hash}`,
          range: `${opts.type}#${slug}`,
        })),
      );
      for (const row of extraRows) {
        const listHash = rowHash(row).startsWith("loc#")
          ? rowHash(row).slice(4)
          : (rowField(row, "bll_h") ?? "").replace(/^loc#/, "");
        const range = rowRange(row) || rowField(row, "bll_r") || "";
        const pageId = rowField(row, "bll_page") ?? "";
        if (listHash.length === 0 || range.length === 0 || pageId.length === 0) continue;
        locs.set(locKey(listHash, range), {
          listHash,
          range,
          pageId,
          existed: true,
          touched: false,
          deleted: false,
        });
      }
    }

    const missing: Array<{ hash: string; range: string; symptom: boolean }> = [];
    const slotByHash = new Map<string, Slot>();
    for (const slot of [...oldSlots, ...knownNew]) slotByHash.set(slot.hash, slot);
    for (const loc of locs.values()) {
      if (pages.has(pageKey(loc.listHash, loc.pageId))) continue;
      missing.push({
        hash: loc.listHash,
        range: loc.pageId,
        symptom: slotByHash.get(loc.listHash)?.kind === "symptom",
      });
    }
    if (missing.length > 0) {
      const more = await readExact(
        opts.node,
        pageSchema,
        ["blp_h", "blp_r", "blp_page"],
        missing.map((key) => ({ hash: key.hash, range: key.range })),
      );
      const symptomByKey = new Map(missing.map((key) => [pageKey(key.hash, key.range), key.symptom]));
      for (const row of more) {
        const hash = rowHash(row) || rowField(row, "blp_h") || "";
        const range = rowRange(row) || rowField(row, "blp_r") || "";
        installPage(
          hash,
          range,
          rowField(row, "blp_page"),
          symptomByKey.get(pageKey(hash, range)) === true,
        );
      }
    }

    if (opts.preserveStoredEdges && opts.previous) {
      const prevBodyIds = new Set(
        edgeIdsOf(
          extractGraphEdges({
            sourceSlug: slug,
            body: opts.previous.body,
          }),
        ),
      );
      const extras = previousEdgeIds.filter((id) => !prevBodyIds.has(id));
      const merged: string[] = [];
      const seenIds = new Set<string>();
      for (const id of [...nextIds, ...extras]) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(id);
      }
      if (merged.length > EDGE_CAP) notePartial(details, "edge cap");
      nextIds = merged.slice(0, EDGE_CAP);
      const keptIds = new Set(nextIds);
      preservedEdgeIds = extras.filter((id) => keptIds.has(id));
    } else if (nextIds.length > EDGE_CAP) {
      notePartial(details, "edge cap");
      nextIds = nextIds.slice(0, EDGE_CAP);
    }

    const finalNew = opts.next
      ? slotsFor(opts.type, opts.next, uniqueDests(nextIds), details)
      : [];
    const entering = new Set(finalNew.map((slot) => slot.hash));
    const subjectRange = `${opts.type}#${slug}`;
    const unreadByHash = new Map<string, Slot>();
    for (const slot of [...finalNew, ...oldSlots]) {
      if (queriedHeads.has(slot.hash) || unreadByHash.has(slot.hash)) continue;
      if (entering.has(slot.hash)) {
        unreadByHash.set(slot.hash, slot);
        continue;
      }
      const loc = locs.get(locKey(slot.hash, subjectRange));
      if (loc?.pageId === HEAD_RANGE) unreadByHash.set(slot.hash, slot);
    }
    const unreadHeads = [...unreadByHash.values()];
    if (unreadHeads.length > 0) {
      const extraHeads = await readExact(
        opts.node,
        pageSchema,
        ["blp_h", "blp_r", "blp_page"],
        unreadHeads.map((slot) => ({ hash: slot.hash, range: HEAD_RANGE })),
      );
      for (const slot of unreadHeads) queriedHeads.add(slot.hash);
      for (const row of extraHeads) {
        const hash = rowHash(row) || rowField(row, "blp_h") || "";
        const range = rowRange(row) || rowField(row, "blp_r") || HEAD_RANGE;
        const slot = unreadHeads.find((item) => item.hash === hash);
        installPage(hash, range, rowField(row, "blp_page"), slot?.kind === "symptom");
      }
    }

    const oldForApply = oldSlots;
    const newForApply = finalNew;
    applyMembership({
      type: opts.type,
      slug,
      previous: opts.previous,
      next: opts.next,
      oldSlots: oldForApply,
      newSlots: newForApply,
      pages,
      locs,
      pageKey,
      locKey,
      ensurePage,
      details,
    });
  }

  const ops: SideOp[] = [];
  const heads: HeadCommit[] = [];
  const keywordHeads: HeadCommit[] = [];
  if (pageSchema.length > 0) {
    for (const page of pages.values()) {
      if (!page.touched) continue;
      const json = renderPage(page, page.symptom);
      if (json === null) {
        notePartial(details, "page cap");
        continue;
      }
      if (page.existed && page.original === json) continue;
      const fields = { blp_h: page.hash, blp_r: page.range, blp_page: json };
      if (page.range === HEAD_RANGE) {
        const replay = actionFor(page, opts.type, slug, opts.next);
        if (!replay) continue;
        heads.push({
          schemaHash: pageSchema,
          keyHash: page.hash,
          keyRange: page.range,
          mutationType: page.existed ? "update" : "create",
          fields,
          expected: page.existed
            ? { type: "value", field: "blp_page", value: page.original ?? "" }
            : { type: "absent", field: "blp_page" },
          replay,
        });
        continue;
      }
      if (!page.existed && page.cards.length === 0) continue;
      ops.push({
        mutationType: page.existed ? "update" : "create",
        schemaHash: pageSchema,
        keyHash: page.hash,
        keyRange: page.range,
        fields,
        projection: "list-page",
      });
    }
  }
  if (locSchema.length > 0) {
    for (const loc of locs.values()) {
      if (!loc.touched) continue;
      if (loc.deleted) {
        if (!loc.existed) continue;
        ops.push({
          mutationType: "delete",
          schemaHash: locSchema,
          keyHash: `loc#${loc.listHash}`,
          keyRange: loc.range,
          fields: {},
          projection: "list-locator",
        });
        continue;
      }
      ops.push({
        mutationType: loc.existed ? "update" : "create",
        schemaHash: locSchema,
        keyHash: `loc#${loc.listHash}`,
        keyRange: loc.range,
        fields: {
          bll_h: `loc#${loc.listHash}`,
          bll_r: loc.range,
          bll_page: loc.pageId,
        },
        projection: "list-locator",
      });
    }
  }

  if (opts.next && dirSchema.length > 0 && opts.previous === null) {
    const types = parseStringList(directoryRaw);
    if (!types.includes(opts.type)) types.push(opts.type);
    types.sort();
    const json = JSON.stringify(types);
    if (!directoryExisted || directoryRaw !== json) {
      ops.push({
        mutationType: directoryExisted ? "update" : "create",
        schemaHash: dirSchema,
        keyHash: slug,
        keyRange: DIRECTORY_RANGE,
        fields: { btd_h: slug, btd_r: DIRECTORY_RANGE, btd_types: json },
        projection: "directory",
      });
    }
  }
  if (!opts.next && opts.previous && dirSchema.length > 0) {
    const dirRows = await readExact(opts.node, dirSchema, ["btd_h", "btd_r", "btd_types"], [
      { hash: slug, range: DIRECTORY_RANGE },
    ]);
    const dirRow = dirRows[0];
    if (dirRow) {
      const types = parseStringList(rowField(dirRow, "btd_types")).filter(
        (name) => name !== opts.type,
      );
      if (types.length === 0) {
        ops.push({
          mutationType: "delete",
          schemaHash: dirSchema,
          keyHash: slug,
          keyRange: DIRECTORY_RANGE,
          fields: {},
          projection: "directory",
        });
      } else {
        ops.push({
          mutationType: "update",
          schemaHash: dirSchema,
          keyHash: slug,
          keyRange: DIRECTORY_RANGE,
          fields: {
            btd_h: slug,
            btd_r: DIRECTORY_RANGE,
            btd_types: JSON.stringify(types),
          },
          projection: "directory",
        });
      }
    }
  }

  if (opts.next && edgeSchema.length > 0) {
    if (nextIds.length > EDGE_CAP) {
      notePartial(details, "edge cap");
      nextIds = nextIds.slice(0, EDGE_CAP);
    }
    const json = JSON.stringify(nextIds);
    const same = edgeExisted && JSON.stringify(previousEdgeIds) === json;
    if (!same) {
      ops.push({
        mutationType: edgeExisted ? "update" : "create",
        schemaHash: edgeSchema,
        keyHash: `es#${opts.type}#${slug}`,
        keyRange: HEAD_RANGE,
        fields: {
          bes_h: `es#${opts.type}#${slug}`,
          bes_r: HEAD_RANGE,
          bes_ids: json,
        },
        projection: "edge-set",
      });
    }
  } else if (!opts.next && edgeExisted && edgeSchema.length > 0) {
    ops.push({
      mutationType: "delete",
      schemaHash: edgeSchema,
      keyHash: `es#${opts.type}#${slug}`,
      keyRange: HEAD_RANGE,
      fields: {},
      projection: "edge-set",
    });
  }

  const posted = opts.next
    ? postingTokens(opts.next.title, opts.sealedBody ?? "")
    : { tokens: [] as PostingToken[], dropped: false };
  if (opts.next && posted.dropped) notePartial(details, "token cap");
  const nextTokenNames = posted.tokens.map((item) => item.token);
  const tokenKey = `ts#${opts.type}#${slug}`;
  const tokenJson = JSON.stringify(nextTokenNames);
  const tokenChanged =
    tokenSchema.length > 0 &&
    slug.length > 0 &&
    (opts.next
      ? !tokenExisted || storedTokenJson !== tokenJson
      : tokenExisted);

  if (pageSchema.length > 0 && slug.length > 0) {
    const oldNames = parseStringList(storedTokenJson).slice(0, POSTING_CAP);
    const weightByToken = new Map(posted.tokens.map((item) => [item.token, item.weight]));
    const names: string[] = [];
    const seenTokens = new Set<string>();
    for (const token of [...oldNames, ...posted.tokens.map((item) => item.token)]) {
      if (token.length === 0 || seenTokens.has(token)) continue;
      seenTokens.add(token);
      names.push(token);
    }
    if (names.length > 0) {
      const rows = await readExact(
        opts.node,
        pageSchema,
        ["blp_h", "blp_r", "blp_page"],
        names.map((token) => ({ hash: keywordHash(token), range: HEAD_RANGE })),
      );
      const byHash = new Map<string, string>();
      for (const row of rows) {
        const hash = rowHash(row) || rowField(row, "blp_h") || "";
        if (hash.length === 0) continue;
        byHash.set(hash, rowField(row, "blp_page") ?? "");
      }
      for (const token of names) {
        const hash = keywordHash(token);
        const prior = byHash.get(hash);
        const existed = prior !== undefined;
        const cards = parseKeywordCards(prior ?? null);
        const weight = weightByToken.get(token);
        const placed = nextKeywordCards(cards, opts.type, slug, weight ?? null);
        if (placed === "same") continue;
        if (placed === "full") {
          notePartial(details, "keyword page");
          continue;
        }
        const nextCards = placed;
        const replay = {
          kind: "keyword" as const,
          type: opts.type,
          slug,
          weight: weight ?? null,
        };
        if (nextCards.length === 0) {
          if (!existed) continue;
          keywordHeads.push({
            schemaHash: pageSchema,
            keyHash: hash,
            keyRange: HEAD_RANGE,
            mutationType: "delete",
            fields: {},
            expected: { type: "value", field: "blp_page", value: prior ?? "" },
            replay,
          });
          continue;
        }
        const json = JSON.stringify({ cards: nextCards });
        if (Buffer.byteLength(json) > PAGE_BYTE_CAP) {
          notePartial(details, "keyword page");
          continue;
        }
        if (existed && prior === json) continue;
        keywordHeads.push({
          schemaHash: pageSchema,
          keyHash: hash,
          keyRange: HEAD_RANGE,
          mutationType: existed ? "update" : "create",
          fields: { blp_h: hash, blp_r: HEAD_RANGE, blp_page: json },
          expected: existed
            ? { type: "value", field: "blp_page", value: prior ?? "" }
            : { type: "absent", field: "blp_page" },
          replay,
        });
      }
    }
  }

  let tokenSet: DeferredTokenSet | null = null;
  if (tokenChanged && tokenSchema.length > 0) {
    if (keywordHeads.length > 0) {
      tokenSet = {
        schemaHash: tokenSchema,
        keyHash: tokenKey,
        existed: tokenExisted,
        stored: storedTokenJson,
        nextNames: nextTokenNames,
      };
    } else if (!opts.next) {
      ops.push({
        mutationType: "delete",
        schemaHash: tokenSchema,
        keyHash: tokenKey,
        keyRange: HEAD_RANGE,
        fields: {},
        projection: "token-set",
      });
    } else {
      ops.push({
        mutationType: tokenExisted ? "update" : "create",
        schemaHash: tokenSchema,
        keyHash: tokenKey,
        keyRange: HEAD_RANGE,
        fields: {
          bts_h: tokenKey,
          bts_r: HEAD_RANGE,
          bts_tokens: tokenJson,
        },
        projection: "token-set",
      });
    }
  }

  return {
    ops,
    heads,
    keywordHeads,
    tokenSet,
    partial: details.includes(INDEX_PARTIAL),
    details,
    previousEdgeIds,
    writtenEdgeIds: opts.next ? nextIds : [],
    preservedEdgeIds,
  };
}

function actionFor(
  page: MemPage,
  type: RecordType,
  slug: string,
  next: FbrainRecord | null,
): HeadReplay | null {
  if (page.symptom) {
    const held = page.cards[0]?.slug ?? "";
    if (held === slug) return { kind: "symptom", slug };
    if (page.cards.length === 0) return { kind: "clear", slug };
    return null;
  }
  const bound = page.hash.startsWith("link#")
    ? BACKLINK_PAGE
    : page.hash.startsWith("child#")
      ? CHILD_PAGE
      : LIST_PAGE;
  const present = page.cards.some(
    (card) => card.slug === slug && (card.type === undefined || card.type === type),
  );
  if (present) {
    if (!next) return null;
    const originalOlder = page.original ? parsePage(page.original).older : "";
    const overflowId = page.older !== originalOlder ? page.older : "";
    return { kind: "place", card: subjectCard(type, next), bound, overflowId };
  }
  return { kind: "remove", type, slug };
}

function applyMembership(opts: {
  type: RecordType;
  slug: string;
  previous: FbrainRecord | null;
  next: FbrainRecord | null;
  oldSlots: Slot[];
  newSlots: Slot[];
  pages: Map<string, MemPage>;
  locs: Map<string, MemLoc>;
  pageKey: (hash: string, range: string) => string;
  locKey: (listHash: string, range: string) => string;
  ensurePage: (hash: string, range: string, symptom: boolean) => MemPage;
  details: string[];
}): void {
  const oldByHash = new Map(opts.oldSlots.map((slot) => [slot.hash, slot]));
  const newByHash = new Map(opts.newSlots.map((slot) => [slot.hash, slot]));
  const hashes = new Set<string>([...oldByHash.keys(), ...newByHash.keys()]);
  const subjectRange = `${opts.type}#${opts.slug}`;
  const card = opts.next ? subjectCard(opts.type, opts.next) : null;

  const locator = (listHash: string): MemLoc | null =>
    opts.locs.get(opts.locKey(listHash, subjectRange)) ?? null;

  const setLocator = (listHash: string, pageId: string) => {
    const id = opts.locKey(listHash, subjectRange);
    const found = opts.locs.get(id);
    if (found) {
      found.pageId = pageId;
      found.touched = true;
      found.deleted = false;
      return;
    }
    opts.locs.set(id, {
      listHash,
      range: subjectRange,
      pageId,
      existed: false,
      touched: true,
      deleted: false,
    });
  };

  const deleteLocator = (listHash: string) => {
    const found = locator(listHash);
    if (!found) return;
    found.touched = true;
    found.deleted = true;
  };

  const movedLocator = (listHash: string, moved: ListCard, pageId: string) => {
    if (!moved.type || moved.type.length === 0) return;
    const range = `${moved.type}#${moved.slug}`;
    const id = opts.locKey(listHash, range);
    const found = opts.locs.get(id);
    if (found) {
      found.pageId = pageId;
      found.touched = true;
      found.deleted = false;
      return;
    }
    // The moved card was already on the head, so its locator exists.
    opts.locs.set(id, {
      listHash,
      range,
      pageId,
      existed: true,
      touched: true,
      deleted: false,
    });
  };

  const overflow = (head: MemPage, bound: number) => {
    const avoid = new Set<string>([HEAD_RANGE, head.older]);
    for (const page of opts.pages.values()) {
      if (page.hash === head.hash) avoid.add(page.range);
    }
    while (head.cards.length > bound) {
      const moved = head.cards[head.cards.length - 1];
      if (!moved) break;
      head.cards = head.cards.slice(0, -1);
      const previousOlder = head.older;
      let id = "";
      for (let n = 0; n < 8 && id.length === 0; n++) {
        const candidate = `p${String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0")}`;
        if (!avoid.has(candidate)) id = candidate;
      }
      if (id.length === 0) {
        id = `p${String(Date.now() % 100_000_000).padStart(8, "0")}`;
      }
      avoid.add(id);
      const page = opts.ensurePage(head.hash, id, false);
      page.cards = [moved];
      page.older = previousOlder;
      page.touched = true;
      head.older = id;
      head.touched = true;
      movedLocator(head.hash, moved, id);
    }
  };

  const place = (slot: Slot) => {
    if (!card) return;
    const head = opts.ensurePage(slot.hash, HEAD_RANGE, false);
    head.cards = dropCard(head.cards, opts.type, opts.slug);
    head.cards.unshift(card);
    head.touched = true;
    overflow(head, slot.bound);
    setLocator(slot.hash, HEAD_RANGE);
  };

  for (const hash of hashes) {
    const previousSlot = oldByHash.get(hash) ?? null;
    const nextSlot = newByHash.get(hash) ?? null;
    const kind = (nextSlot ?? previousSlot)?.kind ?? "list";
    if (kind === "symptom") {
      const head = opts.ensurePage(hash, HEAD_RANGE, true);
      head.symptom = true;
      const held = head.cards[0]?.slug ?? "";
      if (nextSlot && opts.next) {
        if (held.length > 0 && held !== opts.slug) {
          notePartial(opts.details, "symptom occupied");
          continue;
        }
        head.cards = [{ slug: opts.slug }];
        head.older = "";
        head.touched = true;
        continue;
      }
      if (previousSlot && held === opts.slug) {
        head.cards = [];
        head.older = "";
        head.touched = true;
      }
      continue;
    }
    const loc = locator(hash);
    if (previousSlot && nextSlot) {
      if (loc?.existed && loc.pageId !== HEAD_RANGE) {
        const oldPage = opts.ensurePage(hash, loc.pageId, false);
        oldPage.cards = dropCard(oldPage.cards, opts.type, opts.slug);
        oldPage.touched = true;
      }
      place(nextSlot);
      continue;
    }
    if (previousSlot) {
      if (loc?.existed) {
        const oldPage = opts.ensurePage(hash, loc.pageId, false);
        oldPage.cards = dropCard(oldPage.cards, opts.type, opts.slug);
        oldPage.touched = true;
        deleteLocator(hash);
      }
      continue;
    }
    if (nextSlot) place(nextSlot);
  }
}

async function readOnePage(
  node: NodeClient,
  schemaHash: string,
  hash: string,
  range: string,
): Promise<string | null> {
  const res = await node.queryAll({
    schemaHash,
    fields: ["blp_h", "blp_r", "blp_page"],
    filter: { HashRangeKey: { hash, range } },
  });
  const row = res.results[0];
  if (!row) return null;
  return rowField(row, "blp_page");
}

function headWrite(head: HeadCommit, raw: string | null, page: PageBody, symptom: boolean): HeadCommit | null {
  const json = renderPage(page, symptom);
  if (json === null) return null;
  const existed = raw !== null;
  return {
    ...head,
    mutationType: existed ? "update" : "create",
    fields: { ...head.fields, blp_page: json },
    expected: existed
      ? { type: "value", field: "blp_page", value: raw ?? "" }
      : { type: "absent", field: "blp_page" },
  };
}

export async function commitKeywordHeads(
  node: NodeClient,
  heads: readonly HeadCommit[],
  tokenSet: DeferredTokenSet | null,
): Promise<string[]> {
  const details: string[] = [];
  const failedRemove = new Set<string>();
  for (const head of heads) {
    const first = await casHead(node, head);
    let applied = first === "applied";
    if (first === "conflict") {
      const raw = await readOnePage(node, head.schemaHash, head.keyHash, head.keyRange);
      let write: HeadCommit | null = null;
      let note: string | null = null;
      if (head.replay.kind === "keyword") {
        const replay = head.replay;
        const cards = parseKeywordCards(raw);
        const placed = nextKeywordCards(cards, replay.type, replay.slug, replay.weight);
        if (placed === "full") {
          note = "keyword page";
        } else if (placed !== "same") {
          if (placed.length === 0) {
            if (raw !== null) {
              write = {
                ...head,
                mutationType: "delete",
                fields: {},
                expected: { type: "value", field: "blp_page", value: raw },
              };
            }
          } else if (raw !== JSON.stringify({ cards: placed })) {
            const existed = raw !== null;
            const json = JSON.stringify({ cards: placed });
            write = {
              ...head,
              mutationType: existed ? "update" : "create",
              fields: { blp_h: head.keyHash, blp_r: head.keyRange, blp_page: json },
              expected: existed
                ? { type: "value", field: "blp_page", value: raw }
                : { type: "absent", field: "blp_page" },
            };
          }
        }
      }
      if (note) notePartial(details, note);
      if (!write) {
        applied = note === null;
      } else {
        const second = await casHead(node, write);
        applied = second === "applied";
        if (!applied) notePartial(details, "keyword conflict");
      }
    } else if (first === "error") {
      notePartial(details, "keyword conflict");
    }
    if (!applied && head.replay.kind === "keyword" && head.replay.weight === null) {
      const token = head.keyHash.startsWith("kw#") ? head.keyHash.slice(3) : "";
      if (token.length > 0) failedRemove.add(token);
    }
  }
  if (tokenSet) {
    // A failed remove stays in the set. Put it first so a later cap keeps it.
    const names = [...failedRemove];
    for (const token of tokenSet.nextNames) {
      if (!names.includes(token)) names.push(token);
    }
    if (names.length > POSTING_CAP) notePartial(details, "token cap");
    try {
      if (names.length === 0) {
        if (tokenSet.existed) {
          await node.deleteRecord({
            schemaHash: tokenSet.schemaHash,
            keyHash: tokenSet.keyHash,
            keyRange: HEAD_RANGE,
          });
        }
      } else {
        const json = JSON.stringify(names);
        if (!tokenSet.existed || tokenSet.stored !== json) {
          const fields = { bts_h: tokenSet.keyHash, bts_r: HEAD_RANGE, bts_tokens: json };
          if (tokenSet.existed) {
            await node.updateRecord({
              schemaHash: tokenSet.schemaHash,
              fields,
              keyHash: tokenSet.keyHash,
              keyRange: HEAD_RANGE,
            });
          } else {
            await node.createRecord({
              schemaHash: tokenSet.schemaHash,
              fields,
              keyHash: tokenSet.keyHash,
              keyRange: HEAD_RANGE,
            });
          }
        }
      }
    } catch {
      notePartial(details, "token set");
    }
  }
  return details;
}

function rebuildHead(
  head: HeadCommit,
  raw: string | null,
): { write: HeadCommit | null; note: string | null } {
  const fresh = parsePage(raw);
  if (head.replay.kind === "place") {
    const card = head.replay.card;
    const cards = dropCard(fresh.cards, card.type ?? "", card.slug);
    cards.unshift(card);
    // A full fresh head stays as the node has it. Do not pop, and do not
    // point older at the overflow page: that page already holds the moved card.
    if (cards.length > head.replay.bound) {
      return { write: null, note: "head full" };
    }
    // The batch already wrote an overflow page. A clean insert would leave
    // the moved card on this head and on that page.
    if (head.replay.overflowId.length > 0) {
      return { write: null, note: "head full" };
    }
    const write = headWrite(head, raw, { cards, older: fresh.older }, false);
    return { write, note: write ? null : "page cap" };
  }
  if (head.replay.kind === "remove") {
    const write = headWrite(
      head,
      raw,
      {
        cards: dropCard(fresh.cards, head.replay.type, head.replay.slug),
        older: fresh.older,
      },
      false,
    );
    return { write, note: write ? null : "page cap" };
  }
  if (head.replay.kind === "symptom") {
    const held = fresh.cards[0]?.slug ?? "";
    if (held.length > 0 && held !== head.replay.slug) {
      return { write: null, note: "symptom occupied" };
    }
    const write = headWrite(head, raw, { cards: [{ slug: head.replay.slug }], older: "" }, true);
    return { write, note: write ? null : "page cap" };
  }
  const held = fresh.cards[0]?.slug ?? "";
  if (held.length > 0 && held !== head.replay.slug) {
    return { write: null, note: "symptom occupied" };
  }
  const write = headWrite(head, raw, { cards: [], older: "" }, true);
  return { write, note: write ? null : "page cap" };
}

async function casHead(node: NodeClient, head: HeadCommit): Promise<"applied" | "conflict" | "error"> {
  try {
    if (node.mutateIfExpected) {
      return await node.mutateIfExpected({
        mutationType: head.mutationType,
        schemaHash: head.schemaHash,
        fields: head.fields,
        keyHash: head.keyHash,
        keyRange: head.keyRange,
        expected: head.expected,
      });
    }
    if (head.mutationType === "create") {
      await node.createRecord({
        schemaHash: head.schemaHash,
        fields: head.fields,
        keyHash: head.keyHash,
        keyRange: head.keyRange,
      });
    } else if (head.mutationType === "delete") {
      await node.deleteRecord({
        schemaHash: head.schemaHash,
        keyHash: head.keyHash,
        keyRange: head.keyRange,
      });
    } else {
      await node.updateRecord({
        schemaHash: head.schemaHash,
        fields: head.fields,
        keyHash: head.keyHash,
        keyRange: head.keyRange,
      });
    }
    return "applied";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "cas_conflict") return "conflict";
    return "error";
  }
}

export async function commitHeadPages(
  node: NodeClient,
  heads: readonly HeadCommit[],
): Promise<string[]> {
  const details: string[] = [];
  for (const head of heads) {
    const first = await casHead(node, head);
    if (first === "applied") continue;
    if (first === "error") {
      notePartial(details, "head write failed");
      continue;
    }
    const raw = await readOnePage(node, head.schemaHash, head.keyHash, head.keyRange);
    const rebuilt = rebuildHead(head, raw);
    if (rebuilt.note) notePartial(details, rebuilt.note);
    if (!rebuilt.write) continue;
    const second = await casHead(node, rebuilt.write);
    if (second !== "applied") notePartial(details, "head conflict");
  }
  return details;
}

export async function readCount(
  node: NodeClient,
  schemaHash: string,
  hash: string,
): Promise<string | null> {
  const res = await node.queryAll({
    schemaHash,
    fields: ["bln_h", "bln_n"],
    filter: { HashRangeKey: { hash, range: "" } },
  });
  const row = res.results.find((item) => (item.key?.hash ?? rowField(item, "bln_h")) === hash);
  if (!row) return null;
  return rowField(row, "bln_n");
}

export async function writeCount(
  node: NodeClient,
  schemaHash: string,
  hash: string,
  previous: string | null,
  next: string,
): Promise<boolean> {
  const fields = { bln_h: hash, bln_n: next };
  const expected =
    previous === null
      ? ({ type: "absent", field: "bln_n" } as const)
      : ({ type: "value", field: "bln_n", value: previous } as const);
  const mutationType = previous === null ? "create" : "update";
  try {
    if (node.mutateIfExpected) {
      const result = await node.mutateIfExpected({
        mutationType,
        schemaHash,
        fields,
        keyHash: hash,
        expected,
      });
      return result === "applied";
    }
    if (mutationType === "create") {
      await node.createRecord({ schemaHash, fields, keyHash: hash });
    } else {
      await node.updateRecord({ schemaHash, fields, keyHash: hash });
    }
    return true;
  } catch {
    return false;
  }
}

export async function adjustListCounts(
  node: NodeClient,
  cfg: SchemaCfg,
  type: RecordType,
  delta: 1 | -1,
): Promise<"ok" | "unconfirmed" | "skipped"> {
  const schemaHash = schemaOf(cfg, BRAIN_LIST_COUNT_SCHEMA_KEY);
  if (schemaHash.length === 0) return "skipped";
  const hashes = ["all", type];
  let rows: QueryRow[] = [];
  try {
    if (node.queryByKeys) {
      rows = await node.queryByKeys({
        schemaHash,
        fields: ["bln_h", "bln_n"],
        keys: hashes.map((hash) => ({ hash })),
      });
    } else {
      rows = await readExact(
        node,
        schemaHash,
        ["bln_h", "bln_n"],
        hashes.map((hash) => ({ hash, range: "" })),
      );
    }
  } catch {
    return "unconfirmed";
  }
  let unconfirmed = false;
  for (const hash of hashes) {
    const row = rows.find((item) => (item.key?.hash ?? rowField(item, "bln_h")) === hash);
    const raw = row ? rowField(row, "bln_n") : null;
    const existed = raw !== null && /^-?\d+$/.test(raw);
    if (!existed && delta < 0) continue;
    const current = existed ? Number(raw) : 0;
    const next = String(Math.max(0, current + delta));
    let applied = await writeCount(node, schemaHash, hash, existed ? raw : null, next);
    if (!applied) {
      const again = await readCount(node, schemaHash, hash).catch(() => null);
      const againNum = again !== null && /^-?\d+$/.test(again) ? Number(again) : 0;
      const retry = String(Math.max(0, againNum + delta));
      applied = await writeCount(
        node,
        schemaHash,
        hash,
        again !== null && /^-?\d+$/.test(again) ? again : null,
        retry,
      );
    }
    if (!applied) unconfirmed = true;
  }
  return unconfirmed ? "unconfirmed" : "ok";
}

export async function rankKeywordQuery(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  query: string;
  /** Phrases after the query. Tokens past the cap of 8 are dropped. */
  extraText?: readonly string[];
  verbose?: (line: string) => void;
}): Promise<KeywordCard[]> {
  const pageSchema = schemaOf(opts.cfg, BRAIN_LIST_PAGE_SCHEMA_KEY);
  if (pageSchema.length === 0) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  const texts = [opts.query, ...(opts.extraText ?? [])];
  let full = false;
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (seen.has(token)) continue;
      if (tokens.length >= POSTING_CAP) {
        full = true;
        break;
      }
      seen.add(token);
      tokens.push(token);
    }
    if (full) break;
  }
  if (tokens.length === 0) return [];
  opts.verbose?.(`HashRangeKeys keyword keys=${tokens.length} field=blp_page`);
  const rows = await readExact(
    opts.node,
    pageSchema,
    ["blp_page"],
    tokens.map((token) => ({ hash: keywordHash(token), range: HEAD_RANGE })),
  );
  const best = new Map<string, KeywordCard>();
  for (const row of rows) {
    for (const card of parseKeywordCards(rowField(row, "blp_page"))) {
      const id = `${card.type}#${card.slug}`;
      const prior = best.get(id);
      if (!prior || card.weight > prior.weight) {
        best.set(id, { type: card.type, slug: card.slug, weight: card.weight });
      }
    }
  }
  return sortKeyword([...best.values()]);
}

export type NamedPageTarget = {
  kind: "page";
  hash: string;
  symptomFromField: boolean;
  bound: number;
  symptom: boolean;
  tag: string | null;
  childOf: string | null;
  linkDest: string | null;
  status: string | null;
};

export type NamedBackfillTarget =
  | NamedPageTarget
  | { kind: "keyword"; token: string | null };

export type NamedBackfillPlan = {
  ops: BatchMutationOp[];
  added: number;
  /** Eligible slugs whose locator or head already held the card. */
  covered: number;
  lastSlug: string;
  lastAdded: number;
  notes: string[];
  traces: string[];
  blocked: string | null;
};

async function readKeyed(
  node: NodeClient,
  schemaHash: string,
  fields: string[],
  keys: ReadonlyArray<{ hash: string; range: string }>,
  label: string,
  traces: string[],
): Promise<QueryRow[]> {
  if (schemaHash.length === 0 || keys.length === 0) return [];
  const first = keys[0];
  if (keys.length === 1 && first) {
    traces.push(`HashRangeKey ${label} keys_visited=1`);
    const res = await node.queryAll({
      schemaHash,
      fields,
      filter: { HashRangeKey: { hash: first.hash, range: first.range } },
    });
    return res.results;
  }
  traces.push(`HashRangeKeys ${label} keys_visited=${keys.length}`);
  return readExact(node, schemaHash, fields, keys);
}

function blankPlan(lastSlug: string, traces: string[], notes: string[]): NamedBackfillPlan {
  return {
    ops: [],
    added: 0,
    covered: 0,
    lastSlug,
    lastAdded: 0,
    notes,
    traces,
    blocked: null,
  };
}

/** One target page for the named slugs. The caller sends the ops in its one batch. */
export async function planNamedSlugBackfill(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  sourceType: RecordType;
  target: NamedBackfillTarget;
  slugOrder: readonly string[];
  records: readonly FbrainRecord[];
}): Promise<NamedBackfillPlan> {
  const traces: string[] = [];
  const notes: string[] = [];
  const lastSlug = opts.slugOrder[opts.slugOrder.length - 1] ?? "";
  const bySlug = new Map<string, FbrainRecord>();
  for (const record of opts.records) {
    if (record.slug.length > 0) bySlug.set(record.slug, record);
  }
  const pageSchema = schemaOf(opts.cfg, BRAIN_LIST_PAGE_SCHEMA_KEY);
  if (pageSchema.length === 0) {
    return { ...blankPlan(lastSlug, traces, notes), blocked: "list schema absent" };
  }

  if (opts.target.kind === "keyword") {
    const token = opts.target.token;
    const tokenSchema = schemaOf(opts.cfg, BRAIN_TOKEN_SET_SCHEMA_KEY);
    const wanted = new Map<string, PostingToken[]>();
    const tokens = new Set<string>();
    for (const slug of opts.slugOrder) {
      const record = bySlug.get(slug);
      if (!record || isTombstoned(record)) continue;
      let list = postingTokens(record.title, record.body).tokens;
      if (token !== null) list = list.filter((item) => item.token === token);
      wanted.set(slug, list);
      for (const item of list) tokens.add(item.token);
    }
    if (tokens.size === 0) return blankPlan(lastSlug, traces, notes);

    const tokenRows =
      tokenSchema.length === 0
        ? []
        : await readKeyed(
            opts.node,
            tokenSchema,
            ["bts_h", "bts_r", "bts_tokens"],
            [...wanted.keys()].map((slug) => ({
              hash: `ts#${opts.sourceType}#${slug}`,
              range: HEAD_RANGE,
            })),
            "BrainTokenSet",
            traces,
          );
    const storedTokens = new Map<string, string | null>();
    const tokenPrefix = `ts#${opts.sourceType}#`;
    for (const row of tokenRows) {
      const hash = rowHash(row) || rowField(row, "bts_h") || "";
      if (!hash.startsWith(tokenPrefix)) continue;
      storedTokens.set(hash.slice(tokenPrefix.length), rowField(row, "bts_tokens"));
    }

    // readExact keeps 43 keys. A head this call did not read must not look empty.
    type KeywordMem = {
      existed: boolean;
      original: string | null;
      cards: KeywordCard[];
      touched: boolean;
    };
    const pages = new Map<string, KeywordMem>();
    const tokenList = [...tokens];
    for (let offset = 0; offset < tokenList.length; offset += READ_KEY_CAP) {
      const group = tokenList.slice(offset, offset + READ_KEY_CAP);
      const rows = await readKeyed(
        opts.node,
        pageSchema,
        ["blp_h", "blp_r", "blp_page"],
        group.map((name) => ({ hash: keywordHash(name), range: HEAD_RANGE })),
        "BrainListPage",
        traces,
      );
      const found = new Map<string, string | null>();
      for (const row of rows) {
        const hash = rowHash(row) || rowField(row, "blp_h") || "";
        const name = hash.startsWith("kw#") ? hash.slice(3) : "";
        if (!group.includes(name)) continue;
        found.set(name, rowField(row, "blp_page"));
      }
      for (const name of group) {
        const existed = found.has(name);
        const raw = existed ? (found.get(name) ?? null) : null;
        pages.set(name, {
          existed,
          original: existed ? raw : null,
          cards: existed ? parseKeywordCards(raw) : [],
          touched: false,
        });
      }
    }

    const placed = new Set<string>();
    const tokenWrites: Array<{
      slug: string;
      json: string;
      existed: boolean;
    }> = [];
    let covered = 0;
    for (const slug of opts.slugOrder) {
      const list = wanted.get(slug) ?? [];
      if (list.length === 0) continue;
      const stored = storedTokens.has(slug) ? (storedTokens.get(slug) ?? null) : null;
      const existed = storedTokens.has(slug);
      let nextNames: string[];
      if (token === null) {
        nextNames = list.map((item) => item.token);
      } else {
        nextNames = [];
        const seen = new Set<string>();
        for (const name of parseStringList(stored)) {
          if (name.length === 0 || seen.has(name)) continue;
          seen.add(name);
          nextNames.push(name);
        }
        if (!seen.has(token)) nextNames.push(token);
        if (nextNames.length > POSTING_CAP) {
          const kept = nextNames.filter((name) => name !== token).slice(0, POSTING_CAP - 1);
          nextNames = [...kept, token];
        }
      }
      const json = JSON.stringify(nextNames);
      if (tokenSchema.length > 0 && !(existed && stored === json)) {
        tokenWrites.push({ slug, json, existed });
      }
      const already = list.every((item) => {
        const page = pages.get(item.token);
        return (
          page?.cards.some(
            (card) =>
              card.type === opts.sourceType && card.slug === slug && card.weight === item.weight,
          ) === true
        );
      });
      if (already) {
        covered += 1;
        continue;
      }
      let wrote = false;
      for (const item of list) {
        const page = pages.get(item.token);
        if (!page) continue;
        const nextCards = nextKeywordCards(page.cards, opts.sourceType, slug, item.weight);
        if (nextCards === "same" || nextCards === "full") continue;
        page.cards = nextCards;
        page.touched = true;
        wrote = true;
      }
      if (wrote) placed.add(slug);
    }

    const ops: BatchMutationOp[] = [];
    for (const [name, page] of pages) {
      if (!page.touched) continue;
      const json = JSON.stringify({ cards: page.cards });
      if (page.existed && page.original === json) continue;
      const hash = keywordHash(name);
      ops.push({
        mutationType: page.existed ? "update" : "create",
        schemaHash: pageSchema,
        keyHash: hash,
        keyRange: HEAD_RANGE,
        fields: { blp_h: hash, blp_r: HEAD_RANGE, blp_page: json },
      });
    }
    if (tokenSchema.length > 0) {
      for (const write of tokenWrites) {
        const hash = `ts#${opts.sourceType}#${write.slug}`;
        ops.push({
          mutationType: write.existed ? "update" : "create",
          schemaHash: tokenSchema,
          keyHash: hash,
          keyRange: HEAD_RANGE,
          fields: { bts_h: hash, bts_r: HEAD_RANGE, bts_tokens: write.json },
        });
      }
    }
    if (ops.length + 1 > WRITE_BATCH_MAX) {
      return {
        ...blankPlan(lastSlug, traces, notes),
        blocked: "one batch cannot hold this backfill",
      };
    }
    return {
      ops,
      added: placed.size,
      covered,
      lastSlug,
      lastAdded: placed.has(lastSlug) ? 1 : 0,
      notes,
      traces,
      blocked: null,
    };
  }

  const target = opts.target;
  const locSchema = schemaOf(opts.cfg, BRAIN_LIST_LOCATOR_SCHEMA_KEY);
  const edgeSchema = schemaOf(opts.cfg, BRAIN_EDGE_SET_SCHEMA_KEY);
  const useLocator = !target.symptom;
  if (useLocator && locSchema.length === 0) {
    return { ...blankPlan(lastSlug, traces, notes), blocked: "list schema absent" };
  }
  if (target.linkDest !== null && edgeSchema.length === 0) {
    return { ...blankPlan(lastSlug, traces, notes), blocked: "list schema absent" };
  }

  const pages = new Map<string, MemPage>();
  const locs = new Map<string, MemLoc>();
  const located = new Set<string>();
  if (useLocator) {
    const prefix = `${opts.sourceType}#`;
    const rows = await readKeyed(
      opts.node,
      locSchema,
      ["bll_h", "bll_r", "bll_page"],
      opts.slugOrder.map((slug) => ({
        hash: `loc#${target.hash}`,
        range: `${prefix}${slug}`,
      })),
      "BrainListLocator",
      traces,
    );
    for (const row of rows) {
      const range = rowRange(row) || rowField(row, "bll_r") || "";
      const pageId = rowField(row, "bll_page") ?? "";
      if (!range.startsWith(prefix) || pageId.length === 0) continue;
      const slug = range.slice(prefix.length);
      located.add(slug);
      locs.set(locMemKey(target.hash, range), {
        listHash: target.hash,
        range,
        pageId,
        existed: true,
        touched: false,
        deleted: false,
      });
    }
  }

  const chosen = new Map<string, Slot>();
  let pending: FbrainRecord[] = [];
  let covered = 0;
  for (const slug of opts.slugOrder) {
    const record = bySlug.get(slug);
    if (!record || isTombstoned(record)) continue;
    if (target.linkDest !== null) {
      if (located.has(slug)) {
        covered += 1;
        continue;
      }
      pending.push(record);
      continue;
    }
    const hash = target.symptomFromField
      ? `symptom#${textField(record, "symptom_hash")}`
      : target.hash;
    const slotNotes: string[] = [];
    const slots = slotsFor(opts.sourceType, record, [], slotNotes);
    const slot = slots.find((item) => item.hash === hash) ?? null;
    if (!slot) continue;
    if (located.has(slug)) {
      covered += 1;
      continue;
    }
    chosen.set(slug, slot);
    pending.push(record);
  }

  if (target.linkDest !== null && pending.length > 0) {
    const dest = target.linkDest;
    const rows = await readKeyed(
      opts.node,
      edgeSchema,
      ["bes_h", "bes_r", "bes_ids"],
      pending.map((record) => ({
        hash: `es#${opts.sourceType}#${record.slug}`,
        range: HEAD_RANGE,
      })),
      "BrainEdgeSet",
      traces,
    );
    const dests = new Map<string, string[]>();
    const prefix = `es#${opts.sourceType}#`;
    for (const row of rows) {
      const hash = rowHash(row) || rowField(row, "bes_h") || "";
      if (!hash.startsWith(prefix)) continue;
      dests.set(hash.slice(prefix.length), uniqueDests(parseStringList(rowField(row, "bes_ids"))));
    }
    const kept: FbrainRecord[] = [];
    for (const record of pending) {
      const found = dests.get(record.slug);
      if (!found) {
        notes.push("index record absent");
        continue;
      }
      if (!found.includes(dest)) continue;
      const slotNotes: string[] = [];
      const slots = slotsFor(opts.sourceType, record, [dest], slotNotes);
      const slot = slots.find((item) => item.hash === target.hash) ?? null;
      if (!slot) continue;
      chosen.set(record.slug, slot);
      kept.push(record);
    }
    pending = kept;
  }

  if (pending.length > 0) {
    const pageKeys: Array<{ hash: string; range: string }> = [];
    const symptomByHash = new Map<string, boolean>();
    for (const record of pending) {
      const slot = chosen.get(record.slug);
      if (!slot || symptomByHash.has(slot.hash)) continue;
      symptomByHash.set(slot.hash, slot.kind === "symptom");
      pageKeys.push({ hash: slot.hash, range: HEAD_RANGE });
    }
    const rows = await readKeyed(
      opts.node,
      pageSchema,
      ["blp_h", "blp_r", "blp_page"],
      pageKeys,
      "BrainListPage",
      traces,
    );
    const found = new Set<string>();
    for (const row of rows) {
      const hash = rowHash(row) || rowField(row, "blp_h") || "";
      if (hash.length === 0 || !symptomByHash.has(hash)) continue;
      found.add(hash);
      installMemPage(
        pages,
        hash,
        HEAD_RANGE,
        rowField(row, "blp_page"),
        symptomByHash.get(hash) === true,
      );
    }
    for (const key of pageKeys) {
      if (found.has(key.hash)) continue;
      ensureMemPage(pages, key.hash, HEAD_RANGE, symptomByHash.get(key.hash) === true);
    }

    const still: FbrainRecord[] = [];
    for (const record of pending) {
      const slot = chosen.get(record.slug);
      if (!slot) continue;
      if (slot.kind === "symptom") {
        const page = ensureMemPage(pages, slot.hash, HEAD_RANGE, true);
        const held = page.cards[0]?.slug ?? "";
        if (held === record.slug) {
          covered += 1;
          continue;
        }
        if (held.length > 0) continue;
      }
      still.push(record);
    }
    for (const record of still) {
      const slot = chosen.get(record.slug);
      if (!slot) continue;
      applyMembership({
        type: opts.sourceType,
        slug: record.slug,
        previous: null,
        next: record,
        oldSlots: [],
        newSlots: [slot],
        pages,
        locs,
        pageKey: pageMemKey,
        locKey: locMemKey,
        ensurePage: (hash, range, symptom) => ensureMemPage(pages, hash, range, symptom),
        details: notes,
      });
    }
    pending = still;
  }

  const ops: BatchMutationOp[] = [];
  const placed = new Set<string>();
  for (const page of pages.values()) {
    if (!page.touched) continue;
    const json = renderPage(page, page.symptom);
    if (json === null) {
      return { ...blankPlan(lastSlug, traces, notes), blocked: "page cap" };
    }
    if (page.existed && page.original === json) continue;
    ops.push({
      mutationType: page.existed ? "update" : "create",
      schemaHash: pageSchema,
      keyHash: page.hash,
      keyRange: page.range,
      fields: { blp_h: page.hash, blp_r: page.range, blp_page: json },
    });
  }
  if (locSchema.length > 0) {
    for (const loc of locs.values()) {
      if (!loc.touched || loc.deleted) continue;
      const slug = loc.range.startsWith(`${opts.sourceType}#`)
        ? loc.range.slice(opts.sourceType.length + 1)
        : "";
      if (slug.length > 0) placed.add(slug);
      ops.push({
        mutationType: loc.existed ? "update" : "create",
        schemaHash: locSchema,
        keyHash: `loc#${loc.listHash}`,
        keyRange: loc.range,
        fields: {
          bll_h: `loc#${loc.listHash}`,
          bll_r: loc.range,
          bll_page: loc.pageId,
        },
      });
    }
  }
  if (target.symptom) {
    for (const record of pending) {
      const slot = chosen.get(record.slug);
      if (!slot) continue;
      const page = pages.get(pageMemKey(slot.hash, HEAD_RANGE));
      if (page?.touched && page.cards.some((card) => card.slug === record.slug)) {
        placed.add(record.slug);
      }
    }
  }

  if (ops.length + 1 > WRITE_BATCH_MAX) {
    return {
      ...blankPlan(lastSlug, traces, notes),
      blocked: "one batch cannot hold this backfill",
    };
  }
  return {
    ops,
    added: placed.size,
    covered,
    lastSlug,
    lastAdded: placed.has(lastSlug) ? 1 : 0,
    notes,
    traces,
    blocked: null,
  };
}
