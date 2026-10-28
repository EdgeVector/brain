import { FbrainError, type BatchMutationOp, type NodeClient, type QueryRow } from "./client.ts";
import { countAfterDelta, parseListCount } from "./count-state.ts";
import { edgeRange, extractGraphEdges, type GraphEdge } from "./graph-edge.ts";
import { utf8Head } from "./index-payload.ts";
import { parseSpillMarker } from "./body-spill.ts";
import { TOMBSTONE_TAG, isTombstoned, normalizeSlug, parseGenericLinkTag, type FbrainRecord } from "./record.ts";
import { tokenize } from "./tokenize.ts";
import { locatorMutations, locatorSchema, readLocators } from "./list-locator.ts";
import {
  BRAIN_EDGE_SET_SCHEMA_KEY,
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
// An old locator can add one retirement per compact replacement. Keep the
// one-request conversion bounded without trimming the required page writes.
export const WRITE_BATCH_MAX = 128;
export const READ_KEY_CAP = 43;
export const HEAD_RANGE = "__head__";
export const FRONTMATTER_RANGE = "__frontmatter__";
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

// Once a page is linked, no mutation removes it from the older chain. This
// proof lets a writer distinguish a reachable page from a staged orphan.
type PageBody = { cards: ListCard[]; older: string; linked?: boolean };

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
  | { kind: "ensure-empty" }
  | { kind: "backfill" }
  | { kind: "stage-overflow" }
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
  /** Retained ids absent from the supplied edges, after the cap. */
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
  legacy?: boolean;
  compact?: boolean;
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

function parseKeywordCards(raw: string | null, strict = false): KeywordCard[] {
  if (raw === null) return [];
  const invalid = (): KeywordCard[] => {
    if (strict) {
      throw new FbrainError({
        code: "keyword_page_invalid",
        message: "Cannot update a malformed keyword page.",
        hint: "Repair the named keyword page before a manual retry.",
      });
    }
    return [];
  };
  try {
    const value = JSON.parse(raw) as { cards?: unknown } | null;
    if (!value || !Array.isArray(value.cards)) return invalid();
    const cards: KeywordCard[] = [];
    for (const item of value.cards) {
      if (!item || typeof item !== "object") {
        if (strict) return invalid();
        continue;
      }
      const card = item as Record<string, unknown>;
      if (typeof card.type !== "string" || card.type.length === 0 ||
          typeof card.slug !== "string" || card.slug.length === 0 ||
          typeof card.weight !== "number" || !Number.isFinite(card.weight)) {
        if (strict) return invalid();
        continue;
      }
      cards.push({ type: card.type, slug: card.slug, weight: card.weight });
    }
    return cards;
  } catch {
    return invalid();
  }
}

/** Rank insert shared by put, keyword commit, and named-slug backfill. */
function nextKeywordCards(
  cards: readonly KeywordCard[],
  type: string,
  slug: string,
  weight: number | null,
): KeywordCard[] | "saturated" | "full" | "same" {
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
    if (!lowest || weight <= lowest.weight) return "saturated";
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
    const value = JSON.parse(raw) as { cards?: unknown; older?: unknown; linked?: unknown };
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
      ...(typeof value.linked === "boolean" ? { linked: value.linked } : {}),
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
      ...(page.linked !== undefined ? { linked: page.linked } : {}),
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
  page.linked = parsed.linked;
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
  return slots;
}

/** Explicit record relationships belong to the same graph as body links. */
export function recordGraphEdges(
  type: RecordType,
  record: FbrainRecord,
  frontmatterEdges: readonly string[] = [],
  now?: string,
): GraphEdge[] {
  const edges = new Map(
    extractGraphEdges({ sourceSlug: record.slug, body: record.body, frontmatterEdges, now })
      .map((edge) => [edgeRange(edge), edge]),
  );
  const destinations: string[] = [];
  for (const tag of record.tags) {
    const link = parseGenericLinkTag(tag);
    if (link) destinations.push(link.to_slug);
  }
  if (type === "task" && record.design_slug) destinations.push(record.design_slug);
  for (const destination of destinations) {
    const dst = normalizeSlug(destination).toLowerCase();
    if (dst.length === 0) continue;
    const edge: GraphEdge = {
      src: normalizeSlug(record.slug).toLowerCase(),
      dst,
      type: "mentions",
      provenance: "explicit",
      created_at: now ?? record.updated_at,
    };
    edges.set(edgeRange(edge), edge);
  }
  return [...edges.values()];
}

function linkDestsFromRecord(type: RecordType, record: FbrainRecord | null): string[] {
  if (!record) return [];
  return uniqueDests(edgeIdsOf(recordGraphEdges(type, record)));
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
  /** A supplied list replaces the typed frontmatter metadata, including []. */
  frontmatterEdges?: readonly string[];
  /** Append keeps edge-set ids that are not in the body, so those graph rows stay. */
  preserveStoredEdges?: boolean;
}): Promise<ListSidePlan> {
  const details: string[] = [];
  const pageSchema = schemaOf(opts.cfg, BRAIN_LIST_PAGE_SCHEMA_KEY);
  const locSchema = locatorSchema(opts.cfg);
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
  const previousDests = linkDestsFromRecord(opts.type, opts.previous);
  const knownOld = opts.previous
    ? slotsFor(opts.type, opts.previous, previousDests, details)
    : [];
  const knownNew = opts.next
    ? slotsFor(opts.type, opts.next, nextDests, details)
    : [];

  const pages = new Map<string, MemPage>();
  const locs = new Map<string, MemLoc>();
  let previousEdgeIds: string[] = [];
  let previousFrontmatterIds: string[] = [];
  let frontmatterJson: string | null = null;
  let frontmatterExisted = false;
  let nextFrontmatterIds = opts.next && opts.frontmatterEdges !== undefined
    ? edgeIdsOf(extractGraphEdges({ sourceSlug: slug, body: "", frontmatterEdges: opts.frontmatterEdges }))
    : [];
  if (nextFrontmatterIds.length > EDGE_CAP) notePartial(details, "edge cap");
  nextFrontmatterIds = nextFrontmatterIds.slice(0, EDGE_CAP);
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
      readLocators(
        opts.node,
        opts.cfg,
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
            { hash: `es#${opts.type}#${slug}`, range: FRONTMATTER_RANGE },
          ])
        : Promise.resolve([]),
      tokenSchema.length > 0
        ? readExact(opts.node, tokenSchema, ["bts_h", "bts_r", "bts_tokens"], [
            { hash: `ts#${opts.type}#${slug}`, range: HEAD_RANGE },
          ])
        : Promise.resolve([]),
      dirSchema.length > 0 && opts.next !== null
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
        legacy: row.fields?.__legacy_locator === true,
        compact: row.fields?.__compact_locator === true,
      });
    }
    for (const row of headRows) {
      const hash = rowHash(row) || rowField(row, "blp_h") || "";
      const range = rowRange(row) || rowField(row, "blp_r") || HEAD_RANGE;
      const slot = headKeys.get(hash);
      installPage(hash, range, rowField(row, "blp_page"), slot?.kind === "symptom");
    }
    const edgeRow = edgeRows.find((row) =>
      (rowRange(row) || rowField(row, "bes_r") || HEAD_RANGE) === HEAD_RANGE,
    );
    if (edgeRow) {
      edgeExisted = true;
      previousEdgeIds = parseStringList(rowField(edgeRow, "bes_ids"));
    }
    const frontmatterRow = edgeRows.find((row) =>
      (rowRange(row) || rowField(row, "bes_r")) === FRONTMATTER_RANGE,
    );
    if (frontmatterRow) {
      frontmatterExisted = true;
      frontmatterJson = rowField(frontmatterRow, "bes_ids");
      let parsed: unknown;
      try {
        parsed = JSON.parse(frontmatterJson ?? "");
      } catch {
        parsed = null;
      }
      if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
        throw new FbrainError({
          code: "frontmatter_edges_invalid",
          message: `Cannot update malformed frontmatter edges for ${opts.type} ${slug}.`,
        });
      }
      previousFrontmatterIds = parsed;
    }
    if (opts.next) {
      if (opts.frontmatterEdges === undefined && opts.previous !== null) nextFrontmatterIds = previousFrontmatterIds;
      if (nextFrontmatterIds.length > EDGE_CAP) notePartial(details, "edge cap");
      nextFrontmatterIds = nextFrontmatterIds.slice(0, EDGE_CAP);
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

    const storedDests = edgeExisted || frontmatterExisted
      ? uniqueDests([...previousEdgeIds, ...previousFrontmatterIds])
      : previousDests;
    const oldSlots = opts.previous
      ? slotsFor(opts.type, opts.previous, storedDests, details)
      : knownOld;
    const extraLocators = oldSlots.filter((slot) => {
      if (slot.kind !== "list") return false;
      return !locs.has(locKey(slot.hash, `${opts.type}#${slug}`));
    });
    if (extraLocators.length > 0 && locSchema.length > 0) {
      const extraRows = await readLocators(
        opts.node,
        opts.cfg,
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
          legacy: row.fields?.__legacy_locator === true,
          compact: row.fields?.__compact_locator === true,
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

    const suppliedIds = new Set(nextIds);
    nextIds = [...new Set([...nextIds, ...nextFrontmatterIds])];
    if (opts.preserveStoredEdges && opts.previous) {
      // Known old explicit relationships must disappear when their tag or
      // design field disappears. Unknown frontmatter/tail ids can stay.
      const prevBodyIds = new Set(edgeIdsOf(recordGraphEdges(opts.type, opts.previous)));
      const frontmatterIds = new Set(nextFrontmatterIds);
      const extras = previousEdgeIds.filter((id) => !prevBodyIds.has(id) || frontmatterIds.has(id));
      const merged: string[] = [];
      const seenIds = new Set<string>();
      for (const id of [...nextIds, ...extras]) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(id);
      }
      if (merged.length > EDGE_CAP) notePartial(details, "edge cap");
      nextIds = merged.slice(0, EDGE_CAP);
    } else if (nextIds.length > EDGE_CAP) {
      notePartial(details, "edge cap");
      nextIds = nextIds.slice(0, EDGE_CAP);
    }
    preservedEdgeIds = nextIds.filter((id) => !suppliedIds.has(id));

    const finalNew = opts.next
      ? slotsFor(opts.type, opts.next, uniqueDests(nextIds), details)
      : [];
    const unreadByHash = new Map<string, Slot>();
    for (const slot of [...finalNew, ...oldSlots]) {
      if (queriedHeads.has(slot.hash) || unreadByHash.has(slot.hash)) continue;
      unreadByHash.set(slot.hash, slot);
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

    await validatePageLocators({
      node: opts.node, pageSchema, type: opts.type, slug, oldSlots, pages, locs,
    });

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
      if (page.range === HEAD_RANGE || page.existed) {
        const replay = page.range === HEAD_RANGE
          ? actionFor(page, opts.type, slug, opts.next)
          : { kind: "remove" as const, type: opts.type, slug };
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
      heads.push({
        mutationType: "create",
        schemaHash: pageSchema,
        keyHash: page.hash,
        keyRange: page.range,
        fields,
        expected: { type: "absent", field: "blp_page" },
        replay: { kind: "stage-overflow" },
      });
    }
  }
  if (locSchema.length > 0) {
    for (const loc of locs.values()) {
      if (!loc.touched) continue;
      for (const op of locatorMutations(opts.cfg, loc)) {
        ops.push({ ...op, projection: "list-locator" });
      }
    }
  }

  // A write also repairs a directory that predates the list-page migration.
  if (opts.next && dirSchema.length > 0) {
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

  if (opts.type === "design" && opts.next && opts.previous === null && pageSchema.length > 0) {
    const hash = `child#${slug}`;
    heads.push({
      schemaHash: pageSchema, keyHash: hash, keyRange: HEAD_RANGE,
      mutationType: "create",
      fields: { blp_h: hash, blp_r: HEAD_RANGE, blp_page: JSON.stringify({ cards: [], older: "" }) },
      expected: { type: "absent", field: "blp_page" },
      replay: { kind: "ensure-empty" },
    });
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
    if (!same && nextIds.length > 0) {
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
  }
  if ((!opts.next || nextIds.length === 0) && edgeExisted && edgeSchema.length > 0) {
    ops.push({
      mutationType: "delete",
      schemaHash: edgeSchema,
      keyHash: `es#${opts.type}#${slug}`,
      keyRange: HEAD_RANGE,
      fields: {},
      projection: "edge-set",
    });
  }
  if (edgeSchema.length > 0 && opts.next &&
      (opts.frontmatterEdges !== undefined || opts.previous === null)) {
    const json = JSON.stringify(nextFrontmatterIds);
    if (nextFrontmatterIds.length > 0 && (!frontmatterExisted || frontmatterJson !== json)) {
      ops.push({
        mutationType: frontmatterExisted ? "update" : "create",
        schemaHash: edgeSchema,
        keyHash: `es#${opts.type}#${slug}`,
        keyRange: FRONTMATTER_RANGE,
        fields: { bes_h: `es#${opts.type}#${slug}`, bes_r: FRONTMATTER_RANGE, bes_ids: json },
        projection: "edge-set",
      });
    }
  }
  if ((!opts.next || nextFrontmatterIds.length === 0) && frontmatterExisted && edgeSchema.length > 0) {
    ops.push({
      mutationType: "delete",
      schemaHash: edgeSchema,
      keyHash: `es#${opts.type}#${slug}`,
      keyRange: FRONTMATTER_RANGE,
      fields: {},
      projection: "edge-set",
    });
  }

  const posted = opts.next
    ? postingTokens(opts.next.title, opts.sealedBody ?? "")
    : { tokens: [] as PostingToken[], dropped: false };
  // The token bound is the normal search shape, not a failed record index.
  if (opts.next && posted.dropped) details.push("token cap");
  const nextTokenNames = posted.tokens.map((item) => item.token);
  const tokenKey = `ts#${opts.type}#${slug}`;
  const tokenJson = JSON.stringify(nextTokenNames);
  const tokenChanged =
    tokenSchema.length > 0 &&
    slug.length > 0 &&
    (opts.next
      ? (nextTokenNames.length > 0 && !tokenExisted)
        || (tokenExisted && (nextTokenNames.length === 0 || storedTokenJson !== tokenJson))
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
        const cards = parseKeywordCards(prior ?? null, true);
        const weight = weightByToken.get(token);
        const placed = nextKeywordCards(cards, opts.type, slug, weight ?? null);
        if (placed === "same") continue;
        if (placed === "saturated") {
          if (!details.includes("keyword cap")) details.push("keyword cap");
          continue;
        }
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
    } else if (!opts.next || nextTokenNames.length === 0) {
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

// Legacy locators and a failed head CAS can name an unreachable staged page.
// Only linked:true proves reachability without a walk. Follow the older keys
// for every unproven hint, batching independent lists at each depth.
async function validatePageLocators(opts: {
  node: NodeClient;
  pageSchema: string;
  type: RecordType;
  slug: string;
  oldSlots: readonly Slot[];
  pages: Map<string, MemPage>;
  locs: Map<string, MemLoc>;
}): Promise<void> {
  return validatePageLocatorSubjects({ ...opts, subjects: [{ slug: opts.slug, oldSlots: opts.oldSlots }] });
}

async function validatePageLocatorSubjects(opts: {
  node: NodeClient;
  pageSchema: string;
  type: RecordType;
  subjects: readonly { slug: string; oldSlots: readonly Slot[] }[];
  pages: Map<string, MemPage>;
  locs: Map<string, MemLoc>;
}): Promise<void> {
  const holds = (page: MemPage, slug: string): boolean => page.cards.some(
    (card) => card.slug === slug && (card.type === undefined || card.type === opts.type),
  );
  const locate = (hash: string, pageId: string, slug: string): void => {
    const subjectRange = `${opts.type}#${slug}`;
    const id = locMemKey(hash, subjectRange);
    const old = opts.locs.get(id);
    opts.locs.set(id, {
      listHash: hash, range: subjectRange, pageId,
      existed: old?.existed ?? false, touched: false, deleted: false,
      legacy: old?.legacy ?? false, compact: old?.compact ?? false,
    });
  };
  type Walk = { hash: string; range: string; slug: string; seen: Set<string> };
  let pending: Walk[] = [];
  for (const { slug, oldSlots } of opts.subjects) {
    for (const slot of oldSlots) {
    if (slot.kind !== "list") continue;
    const head = ensureMemPage(opts.pages, slot.hash, HEAD_RANGE, false);
    if (holds(head, slug)) {
      locate(slot.hash, HEAD_RANGE, slug);
      continue;
    }
    const hint = opts.locs.get(locMemKey(slot.hash, `${opts.type}#${slug}`));
    const page = hint ? opts.pages.get(pageMemKey(slot.hash, hint.pageId)) : undefined;
    if (page?.linked === true && holds(page, slug)) continue;
    if (head.older.length === 0) {
      locate(slot.hash, HEAD_RANGE, slug);
      continue;
    }
    pending.push({ hash: slot.hash, range: head.older, slug, seen: new Set([HEAD_RANGE]) });
    }
  }
  const refuse = (hash: string, slug: string): never => {
    throw new FbrainError({
      code: "list_membership_unproven",
      message: `Cannot prove list membership for ${opts.type} ${slug} in ${hash}.`,
      hint: "The list update was not sent. Read the product record and repair the named list before a manual retry.",
    });
  };
  for (let depth = 0; pending.length > 0; depth++) {
    if (depth >= 1000) refuse(pending[0]!.hash, pending[0]!.slug);
    const missing = new Map(pending
      .filter((walk) => !opts.pages.has(pageMemKey(walk.hash, walk.range)))
      .map((walk) => [pageMemKey(walk.hash, walk.range), walk]));
    const rows = await readExact(
      opts.node, opts.pageSchema, ["blp_h", "blp_r", "blp_page"],
      [...missing.values()].map((walk) => ({ hash: walk.hash, range: walk.range })),
    );
    for (const row of rows) {
      const hash = rowHash(row) || rowField(row, "blp_h") || "";
      const range = rowRange(row) || rowField(row, "blp_r") || "";
      installMemPage(opts.pages, hash, range, rowField(row, "blp_page"), false);
    }
    const next: Walk[] = [];
    for (const walk of pending) {
      if (walk.seen.has(walk.range)) refuse(walk.hash, walk.slug);
      walk.seen.add(walk.range);
      const page = opts.pages.get(pageMemKey(walk.hash, walk.range)) ?? refuse(walk.hash, walk.slug);
      if (!page.existed) refuse(walk.hash, walk.slug);
      if (holds(page, walk.slug)) {
        page.linked = true;
        locate(walk.hash, walk.range, walk.slug);
      } else if (page.older.length > 0) {
        next.push({ ...walk, range: page.older });
      } else {
        locate(walk.hash, HEAD_RANGE, walk.slug);
      }
    }
    pending = next;
  }
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
      page.linked = false;
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
      if (loc && loc.pageId !== HEAD_RANGE) {
        const oldPage = opts.ensurePage(hash, loc.pageId, false);
        oldPage.cards = dropCard(oldPage.cards, opts.type, opts.slug);
        oldPage.touched = true;
      }
      place(nextSlot);
      continue;
    }
    if (previousSlot) {
      if (loc) {
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

/** Cards on one list hash. Absent head is an empty list. A missing schema is null. */
export async function readPageChain(
  node: NodeClient,
  cfg: { schemaHashes: Record<string, string> },
  hash: string,
  maxPages = 1000,
): Promise<ListCard[] | null> {
  const schemaHash = schemaOf(cfg, BRAIN_LIST_PAGE_SCHEMA_KEY);
  if (schemaHash.length === 0) return null;
  const cards: ListCard[] = [];
  const seen = new Set<string>();
  let range = HEAD_RANGE;
  // A bulk reader knows the hash. Fetch its page atoms together, then follow
  // only the linked chain. Staged overflow pages are never membership proof.
  // The one-page callers retain one exact read and do not fetch older pages.
  const pages = new Map<string, string>();
  if (maxPages > 1) {
    const result = await node.queryAll({ schemaHash, fields: ["blp_h", "blp_r", "blp_page"], filter: { HashKey: hash } });
    for (const row of result.results) {
      const key = row.key?.range ?? rowField(row, "blp_r");
      const raw = rowField(row, "blp_page");
      if (key && raw !== null) pages.set(key, raw);
    }
  }
  for (let depth = 0; depth < maxPages; depth++) {
    if (seen.has(range)) throw new FbrainError({ code: "list_chain_incomplete", message: `The list ${hash} repeats a page.` });
    seen.add(range);
    const raw = maxPages > 1 ? pages.get(range) ?? null : await readOnePage(node, schemaHash, hash, range);
    if (raw === null) {
      if (range === HEAD_RANGE) return [];
      throw new FbrainError({ code: "list_chain_incomplete", message: `The list ${hash} is missing page ${range}.` });
    }
    try {
      const value = JSON.parse(raw);
      if (!value || !Array.isArray(value.cards) || (value.older !== undefined && typeof value.older !== "string")) throw new Error("Invalid page");
    } catch {
      throw new FbrainError({ code: "list_chain_incomplete", message: `The list ${hash} has an invalid page ${range}.` });
    }
    const page = parsePage(raw);
    for (const card of page.cards) cards.push(card);
    if (page.older.length === 0 || maxPages === 1) return cards;
    range = page.older;
  }
  throw new FbrainError({ code: "list_chain_incomplete", message: `The list ${hash} exceeded ${maxPages} pages.` });
}

/**
 * Replay each head on the shared prior page. A single list head is already
 * that page. A single keyword head is replayed too: its stored fields can
 * replace another card on a full ranker page.
 */
export function mergeHeadCommits(
  heads: readonly HeadCommit[],
): { head: HeadCommit | null; note: string | null } {
  const first = heads[0];
  if (!first) return { head: null, note: null };
  if (heads.length === 1 && first.replay.kind !== "keyword") return { head: first, note: null };
  if (heads.some((head) => head.replay.kind === "keyword")) return mergeKeywordCommits(heads);
  return mergeListCommits(heads);
}

function expectedPageRaw(heads: readonly HeadCommit[]): string | null {
  for (const head of heads) {
    if (head.expected.type === "value") return head.expected.value;
  }
  return null;
}

function mergeListCommits(
  heads: readonly HeadCommit[],
): { head: HeadCommit | null; note: string | null } {
  let page = parsePage(expectedPageRaw(heads));
  let note: string | null = null;
  let lost = false;
  for (const head of heads) {
    const replay = head.replay;
    if (replay.kind === "place") {
      // A full head stays as the prior page. Do not pop a card, and do not
      // point older at an overflow page that already holds the moved card.
      if (replay.overflowId.length > 0) {
        note = "head full";
        lost = true;
        continue;
      }
      const cards = dropCard(page.cards, replay.card.type ?? "", replay.card.slug);
      cards.unshift(replay.card);
      if (cards.length > replay.bound) {
        note = "head full";
        lost = true;
        continue;
      }
      page = { cards, older: page.older, ...(page.linked !== undefined ? { linked: page.linked } : {}) };
      continue;
    }
    if (replay.kind === "remove") {
      page = {
        ...page,
        cards: dropCard(page.cards, replay.type, replay.slug),
      };
      continue;
    }
    if (replay.kind === "symptom") {
      const held = page.cards[0]?.slug ?? "";
      if (held.length > 0 && held !== replay.slug) {
        note = "symptom occupied";
        lost = true;
        continue;
      }
      page = { cards: [{ slug: replay.slug }], older: "" };
      continue;
    }
    if (replay.kind === "clear") {
      const held = page.cards[0]?.slug ?? "";
      if (held.length > 0 && held !== replay.slug) {
        note = "symptom occupied";
        lost = true;
        continue;
      }
      page = { cards: [], older: "" };
      continue;
    }
    if (replay.kind === "ensure-empty") {
      if (page.cards.length === 0) page = { cards: [], older: "" };
      continue;
    }
    note = note ?? "page allocation conflict";
    lost = true;
  }
  if (lost) return { head: null, note };
  const last = heads[heads.length - 1];
  if (!last) return { head: null, note };
  const symptom = last.replay.kind === "symptom" || last.replay.kind === "clear";
  const json = renderPage(page, symptom);
  if (json === null) return { head: null, note: note ?? "page cap" };
  const existed = heads.some((head) => head.expected.type === "value");
  return {
    head: {
      ...last,
      mutationType: existed ? "update" : "create",
      fields: { blp_h: last.keyHash, blp_r: last.keyRange, blp_page: json },
    },
    note,
  };
}

function mergeKeywordCommits(
  heads: readonly HeadCommit[],
): { head: HeadCommit | null; note: string | null } {
  let cards = parseKeywordCards(expectedPageRaw(heads), false);
  let note: string | null = null;
  let lost = false;
  for (const head of heads) {
    const replay = head.replay;
    if (replay.kind !== "keyword") {
      note = note ?? "keyword page";
      lost = true;
      continue;
    }
    // A higher weight must not replace the other twin. A full ranker page
    // refuses the new card the same way a full list head does.
    const present = cards.some((card) => card.type === replay.type && card.slug === replay.slug);
    if (replay.weight !== null && !present && cards.length >= RANKER_PAGE) {
      note = "keyword cap";
      lost = true;
      continue;
    }
    const placed = nextKeywordCards(cards, replay.type, replay.slug, replay.weight);
    if (placed === "saturated") {
      note = "keyword cap";
      lost = true;
      continue;
    }
    if (placed === "full") {
      note = "keyword page";
      lost = true;
      continue;
    }
    if (placed !== "same") cards = placed;
  }
  if (lost) return { head: null, note };
  const last = heads[heads.length - 1];
  if (!last) return { head: null, note };
  if (cards.length === 0) {
    const existed = heads.some((head) => head.expected.type === "value" || head.mutationType === "delete");
    if (!existed) return { head: null, note };
    return { head: { ...last, mutationType: "delete", fields: {} }, note };
  }
  const json = JSON.stringify({ cards: sortKeyword(cards) });
  if (Buffer.byteLength(json) > PAGE_BYTE_CAP) return { head: null, note: note ?? "keyword page" };
  const existed = heads.some((head) => head.expected.type === "value");
  return {
    head: {
      ...last,
      mutationType: existed ? "update" : "create",
      fields: { blp_h: last.keyHash, blp_r: last.keyRange, blp_page: json },
    },
    note,
  };
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
  await Promise.all(heads.map(async (head) => {
    const first = await casHead(node, head);
    let applied = first === "applied";
    if (first === "conflict") {
      const raw = await readOnePage(node, head.schemaHash, head.keyHash, head.keyRange);
      let write: HeadCommit | null = null;
      let note: string | null = null;
      if (head.replay.kind === "keyword") {
        const replay = head.replay;
        const cards = parseKeywordCards(raw, true);
        const placed = nextKeywordCards(cards, replay.type, replay.slug, replay.weight);
        if (placed === "saturated") {
          if (!details.includes("keyword cap")) details.push("keyword cap");
        } else if (placed === "full") {
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
  }));
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
  // Another task can create the first child page while the design is created.
  // Its existing contents prove initialization and must never be cleared.
  if (head.replay.kind === "ensure-empty") return { write: null, note: null };
  if (head.replay.kind === "backfill") return { write: null, note: "backfill head conflict" };
  if (head.replay.kind === "stage-overflow") return { write: null, note: "page allocation conflict" };
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
    if (head.keyRange !== HEAD_RANGE && raw === null) return { write: null, note: "page absent" };
    const write = headWrite(
      head,
      raw,
      {
        ...fresh,
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
    // An unconditional fallback can restore a deleted card from an old page.
    return "error";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "cas_conflict") return "conflict";
    return "error";
  }
}

async function confirmOverflowLinked(node: NodeClient, head: HeadCommit): Promise<boolean> {
  if (head.replay.kind !== "place" || head.replay.overflowId.length === 0) return true;
  const range = head.replay.overflowId;
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await readOnePage(node, head.schemaHash, head.keyHash, range).catch(() => null);
    if (raw === null) return false;
    const page = parsePage(raw);
    if (page.linked === true) return true;
    const json = renderPage({ ...page, linked: true }, false);
    if (json === null) return false;
    const result = await casHead(node, {
      ...head,
      mutationType: "update",
      keyRange: range,
      fields: { blp_h: head.keyHash, blp_r: range, blp_page: json },
      expected: { type: "value", field: "blp_page", value: raw },
    });
    if (result === "applied") return true;
    if (result === "error") return false;
  }
  return false;
}

// A competing insert can move the removed head card into an overflow page.
// After the head removal CAS, an older snapshot cannot link that card again.
// Follow that successful head's older chain and remove any displaced copy.
async function removeOlderCopies(node: NodeClient, head: HeadCommit): Promise<boolean> {
  if (head.replay.kind !== "remove" || head.keyRange !== HEAD_RANGE) return true;
  const replay = head.replay;
  const current = typeof head.fields.blp_page === "string" ? head.fields.blp_page : null;
  let range = parsePage(current).older;
  const seen = new Set<string>([HEAD_RANGE]);
  for (let depth = 0; range.length > 0; depth++) {
    if (depth >= 1000 || seen.has(range)) return false;
    seen.add(range);
    let done = false;
    let older = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await readOnePage(node, head.schemaHash, head.keyHash, range).catch(() => null);
      if (raw === null) return false;
      const page = parsePage(raw);
      older = page.older;
      const cards = dropCard(page.cards, replay.type, replay.slug);
      if (cards.length === page.cards.length) {
        done = true;
        break;
      }
      const json = renderPage({ ...page, cards, linked: true }, false);
      if (json === null) return false;
      const result = await casHead(node, {
        ...head, keyRange: range, mutationType: "update",
        fields: { blp_h: head.keyHash, blp_r: range, blp_page: json },
        expected: { type: "value", field: "blp_page", value: raw },
      });
      if (result === "applied") {
        done = true;
        break;
      }
      if (result === "error") return false;
    }
    if (!done) return false;
    range = older;
  }
  return true;
}

export async function commitHeadPages(
  node: NodeClient,
  heads: readonly HeadCommit[],
): Promise<string[]> {
  const byHash = new Map<string, HeadCommit[]>();
  for (const head of heads) {
    const id = `${head.schemaHash}\0${head.keyHash}`;
    const group = byHash.get(id) ?? [];
    group.push(head);
    byHash.set(id, group);
  }
  const results = await Promise.all([...byHash.values()].map((group) => commitHeadPageGroup(node, group)));
  return [...new Set(results.flat())];
}

async function commitHeadPageGroup(
  node: NodeClient,
  heads: readonly HeadCommit[],
): Promise<string[]> {
  const details: string[] = [];
  const failedPlaces = new Set<string>();
  let failedStage = false;
  const placeId = (head: HeadCommit): string => {
    const replay = head.replay;
    const subject = replay.kind === "place"
      ? `${replay.card.type ?? ""}#${replay.card.slug}`
      : replay.kind === "remove" ? `${replay.type}#${replay.slug}` : "";
    return `${head.schemaHash}\0${head.keyHash}\0${subject}`;
  };
  // A source page stays intact if its replacement head cannot accept the card.
  const ordered = [
    ...heads.filter((head) => head.replay.kind === "stage-overflow"),
    ...heads.filter((head) => head.keyRange === HEAD_RANGE),
    ...heads.filter((head) => head.keyRange !== HEAD_RANGE && head.replay.kind !== "stage-overflow"),
  ];
  for (const head of ordered) {
    if (failedStage && head.replay.kind !== "stage-overflow") {
      if (head.replay.kind === "place") failedPlaces.add(placeId(head));
      continue;
    }
    if (head.keyRange !== HEAD_RANGE && failedPlaces.has(placeId(head))) continue;
    const first = await casHead(node, head);
    if (first === "applied") {
      if (!(await confirmOverflowLinked(node, head))) details.push("page reachability unconfirmed");
      continue;
    }
    if (first === "error") {
      notePartial(details, "head write failed");
      if (head.replay.kind === "stage-overflow") failedStage = true;
      if (head.replay.kind === "place") failedPlaces.add(placeId(head));
      continue;
    }
    if (head.replay.kind === "ensure-empty") continue;
    const raw = await readOnePage(node, head.schemaHash, head.keyHash, head.keyRange);
    const rebuilt = rebuildHead(head, raw);
    if (rebuilt.note) notePartial(details, rebuilt.note);
    if (!rebuilt.write) {
      if (head.replay.kind === "stage-overflow") failedStage = true;
      if (head.replay.kind === "place") failedPlaces.add(placeId(head));
      continue;
    }
    const second = await casHead(node, rebuilt.write);
    if (second !== "applied") {
      notePartial(details, "head conflict");
      if (head.replay.kind === "place") failedPlaces.add(placeId(head));
    } else if (!(await confirmOverflowLinked(node, rebuilt.write))) {
      details.push("page reachability unconfirmed");
    }
    if (second === "applied" && !(await removeOlderCopies(node, rebuilt.write))) {
      notePartial(details, "older page removal unconfirmed");
    }
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
  const raw = row.fields?.bln_n;
  if (typeof raw !== "string") {
    throw new FbrainError({
      code: "invalid_list_count",
      message: `The count for ${hash} has an invalid value.`,
      hint: "Repair the named count before another count change.",
    });
  }
  return raw;
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
    if (row && typeof row.fields?.bln_n !== "string") {
      unconfirmed = true;
      continue;
    }
    const raw = row ? rowField(row, "bln_n") : null;
    const state = parseListCount(raw);
    if (raw !== null && state === null) {
      unconfirmed = true;
      continue;
    }
    const existed = state !== null;
    if (!existed && delta < 0) continue;
    const next = countAfterDelta(raw, delta);
    if (next === null) {
      unconfirmed = true;
      continue;
    }
    let applied = await writeCount(node, schemaHash, hash, existed ? raw : null, next);
    if (!applied) {
      let again: string | null;
      try {
        again = await readCount(node, schemaHash, hash);
      } catch {
        unconfirmed = true;
        continue;
      }
      if (again !== null && parseListCount(again) === null) {
        unconfirmed = true;
        continue;
      }
      const retry = countAfterDelta(again, delta);
      if (retry === null) {
        unconfirmed = true;
        continue;
      }
      applied = await writeCount(
        node,
        schemaHash,
        hash,
        again,
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
  | { kind: "directory" }
  | { kind: "keyword"; token: string | null };

export type NamedBackfillPlan = {
  ops: BatchMutationOp[];
  heads: HeadCommit[];
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
    heads: [],
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
  if (opts.target.kind === "directory") {
    const schemaHash = schemaOf(opts.cfg, BRAIN_TYPE_DIRECTORY_SCHEMA_KEY);
    if (schemaHash.length === 0) {
      return { ...blankPlan(lastSlug, traces, notes), blocked: "directory schema absent" };
    }
    const live = opts.slugOrder.filter((slug) => {
      const record = bySlug.get(slug);
      return record !== undefined && !isTombstoned(record);
    });
    const rows = await readKeyed(
      opts.node, schemaHash, ["btd_h", "btd_r", "btd_types"],
      live.map((slug) => ({ hash: slug, range: DIRECTORY_RANGE })),
      "BrainTypeDirectory", traces,
    );
    const existing = new Map(rows.map((row) => [
      rowHash(row) || rowField(row, "btd_h") || "", rowField(row, "btd_types"),
    ]));
    const ops: BatchMutationOp[] = [];
    let covered = 0;
    for (const slug of live) {
      const raw = existing.get(slug);
      const types = parseStringList(raw ?? null);
      if (types.includes(opts.sourceType)) {
        covered++;
        continue;
      }
      types.push(opts.sourceType);
      types.sort();
      ops.push({
        mutationType: existing.has(slug) ? "update" : "create",
        schemaHash, keyHash: slug, keyRange: DIRECTORY_RANGE,
        fields: { btd_h: slug, btd_r: DIRECTORY_RANGE, btd_types: JSON.stringify(types) },
      });
    }
    return {
      ...blankPlan(lastSlug, traces, notes), ops, added: ops.length, covered,
      lastAdded: ops.some((op) => op.keyHash === lastSlug) ? 1 : 0,
    };
  }
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
          cards: existed ? parseKeywordCards(raw ?? "", true) : [],
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
        if (nextCards === "saturated") {
          if (!notes.includes("keyword cap")) notes.push("keyword cap");
          continue;
        }
        if (nextCards === "full") {
          notePartial(notes, "keyword page");
          continue;
        }
        if (nextCards === "same") continue;
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
      heads: [],
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
  const locSchema = locatorSchema(opts.cfg);
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
    traces.push(`HashRangeKeys compact locator keys=${opts.slugOrder.length}`);
    const rows = await readLocators(
      opts.node,
      opts.cfg,
      opts.slugOrder.map((slug) => ({
        hash: `loc#${target.hash}`,
        range: `${prefix}${slug}`,
      })),
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
        legacy: row.fields?.__legacy_locator === true,
        compact: row.fields?.__compact_locator === true,
      });
    }
    if (located.size > 0) {
      const ranges = new Set([HEAD_RANGE, ...[...locs.values()].map((loc) => loc.pageId)]);
      const rows = await readKeyed(
        opts.node, pageSchema, ["blp_h", "blp_r", "blp_page"],
        [...ranges].map((range) => ({ hash: target.hash, range })),
        "BrainListPage locator proof", traces,
      );
      for (const row of rows) {
        const hash = rowHash(row) || rowField(row, "blp_h") || "";
        const range = rowRange(row) || rowField(row, "blp_r") || "";
        installMemPage(pages, hash, range, rowField(row, "blp_page"), false);
      }
      await validatePageLocatorSubjects({
        node: opts.node, pageSchema, type: opts.sourceType, pages, locs,
        subjects: opts.slugOrder.filter((slug) => located.has(slug)).map((slug) => ({
          slug, oldSlots: [{ hash: target.hash, kind: "list", bound: target.bound }],
        })),
      });
      for (const slug of opts.slugOrder) {
        if (!located.has(slug)) continue;
        const loc = locs.get(locMemKey(target.hash, `${opts.sourceType}#${slug}`));
        const page = loc ? pages.get(pageMemKey(target.hash, loc.pageId)) : undefined;
        if (!page?.cards.some((card) => card.slug === slug && card.type === opts.sourceType)) {
          located.delete(slug);
        }
      }
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
  const heads: HeadCommit[] = [];
  const placed = new Set<string>();
  const newlyEligible = new Set(pending.map((record) => record.slug));
  for (const page of pages.values()) {
    if (!page.touched) continue;
    const json = renderPage(page, page.symptom);
    if (json === null) {
      return { ...blankPlan(lastSlug, traces, notes), blocked: "page cap" };
    }
    if (page.existed && page.original === json) continue;
    if (page.range === HEAD_RANGE) {
      heads.push({
        mutationType: page.existed ? "update" : "create",
        schemaHash: pageSchema, keyHash: page.hash, keyRange: page.range,
        fields: { blp_h: page.hash, blp_r: page.range, blp_page: json },
        expected: page.existed
          ? { type: "value", field: "blp_page", value: page.original ?? "" }
          : { type: "absent", field: "blp_page" },
        replay: { kind: "backfill" },
      });
      continue;
    }
    heads.push({
      mutationType: "create",
      schemaHash: pageSchema,
      keyHash: page.hash,
      keyRange: page.range,
      fields: { blp_h: page.hash, blp_r: page.range, blp_page: json },
      expected: { type: "absent", field: "blp_page" },
      replay: { kind: "stage-overflow" },
    });
  }
  if (locSchema.length > 0) {
    for (const loc of locs.values()) {
      if (!loc.touched || loc.deleted) continue;
      const slug = loc.range.startsWith(`${opts.sourceType}#`)
        ? loc.range.slice(opts.sourceType.length + 1)
        : "";
      if (newlyEligible.has(slug) && !located.has(slug)) placed.add(slug);
      ops.push(...locatorMutations(opts.cfg, loc));
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
    heads,
    added: placed.size,
    covered,
    lastSlug,
    lastAdded: placed.has(lastSlug) ? 1 : 0,
    notes,
    traces,
    blocked: null,
  };
}
