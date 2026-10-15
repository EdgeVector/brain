// Thin list pages, locators, the type directory, edge set, and token set.
// Keyword page atoms wait. A head insert does not walk the older chain.
// The head atom is a compare-and-set write so a conflict retries that one key.

import type { NodeClient, QueryRow } from "./client.ts";
import { edgeRange, extractGraphEdges, type GraphEdge } from "./graph-edge.ts";
import { utf8Head } from "./index-payload.ts";
import { SPILL_HEAD_BYTES, parseSpillMarker } from "./body-spill.ts";
import { TOMBSTONE_TAG, type FbrainRecord } from "./record.ts";
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
export const LIST_PAGE = 20;
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
  | "token-set";

export type SideOp = {
  mutationType: "create" | "update" | "delete";
  schemaHash: string;
  keyHash: string;
  keyRange?: string;
  fields: Record<string, unknown>;
  projection: SideProjection;
};

export type HeadReplay =
  | { kind: "place"; card: ListCard; bound: number }
  | { kind: "remove"; type: string; slug: string }
  | { kind: "symptom"; slug: string }
  | { kind: "clear"; slug: string };

export type HeadCommit = {
  schemaHash: string;
  keyHash: string;
  keyRange: string;
  mutationType: "create" | "update";
  fields: Record<string, unknown>;
  expected:
    | { type: "absent"; field: "blp_page" }
    | { type: "value"; field: "blp_page"; value: string };
  replay: HeadReplay;
};

export type ListSidePlan = {
  ops: SideOp[];
  heads: HeadCommit[];
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

export function postingTokens(
  title: string,
  body: string,
): { tokens: string[]; dropped: boolean } {
  const marker = parseSpillMarker(body);
  const head = marker ? marker.head : utf8Head(body, SPILL_HEAD_BYTES);
  const seen = new Set<string>();
  const tokens: string[] = [];
  let dropped = false;
  for (const token of [...tokenize(title), ...tokenize(head)]) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (tokens.length >= POSTING_CAP) {
      dropped = true;
      break;
    }
    tokens.push(token);
  }
  return { tokens, dropped };
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

function renderPage(page: PageBody, symptom: boolean): string {
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
  return last;
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

  const pageKey = (hash: string, range: string) => `${hash}\0${range}`;
  const locKey = (listHash: string, range: string) => `${listHash}\0${range}`;

  const ensurePage = (hash: string, range: string, symptom: boolean): MemPage => {
    const id = pageKey(hash, range);
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
  };

  const installPage = (hash: string, range: string, raw: string | null, symptom: boolean) => {
    const page = ensurePage(hash, range, symptom);
    if (raw === null) return page;
    const parsed = parsePage(raw);
    page.cards = parsed.cards;
    page.older = parsed.older;
    page.existed = true;
    page.original = raw;
    page.symptom = symptom;
    return page;
  };

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

    // The page id lives in the locator atom, so name those pages only after
    // that read. Still one exact key each. Do not follow `older`.
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
    // A preserved link can name a head the first wave did not read.
    // Read that head by exact key. Do not follow `older`.
    const unreadHeads = [...oldSlots, ...finalNew].filter(
      (slot) => !queriedHeads.has(slot.hash),
    );
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
  if (pageSchema.length > 0) {
    for (const page of pages.values()) {
      if (!page.touched) continue;
      const json = renderPage(page, page.symptom);
      if (page.existed && page.original === json) continue;
      const fields = { blp_h: page.hash, blp_r: page.range, blp_page: json };
      if (page.range === HEAD_RANGE) {
        const replay = replayFor(page, opts.type, slug, opts.next);
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

  if (opts.next && tokenSchema.length > 0) {
    const posted = postingTokens(opts.next.title, opts.next.body);
    if (posted.dropped) notePartial(details, "token cap");
    const json = JSON.stringify(posted.tokens);
    if (!tokenExisted || storedTokenJson !== json) {
      ops.push({
        mutationType: tokenExisted ? "update" : "create",
        schemaHash: tokenSchema,
        keyHash: `ts#${opts.type}#${slug}`,
        keyRange: HEAD_RANGE,
        fields: {
          bts_h: `ts#${opts.type}#${slug}`,
          bts_r: HEAD_RANGE,
          bts_tokens: json,
        },
        projection: "token-set",
      });
    }
  } else if (!opts.next && tokenExisted && tokenSchema.length > 0) {
    ops.push({
      mutationType: "delete",
      schemaHash: tokenSchema,
      keyHash: `ts#${opts.type}#${slug}`,
      keyRange: HEAD_RANGE,
      fields: {},
      projection: "token-set",
    });
  }

  return {
    ops,
    heads,
    partial: details.includes(INDEX_PARTIAL),
    details,
    previousEdgeIds,
    writtenEdgeIds: opts.next ? nextIds : [],
    preservedEdgeIds,
  };
}

function replayFor(
  page: MemPage,
  type: RecordType,
  slug: string,
  next: FbrainRecord | null,
): HeadReplay | null {
  if (page.symptom) {
    if (!next) return { kind: "clear", slug };
    return { kind: "symptom", slug };
  }
  const bound = page.hash.startsWith("link#")
    ? BACKLINK_PAGE
    : page.hash.startsWith("child#")
      ? CHILD_PAGE
      : LIST_PAGE;
  if (!next) return { kind: "remove", type, slug };
  return { kind: "place", card: subjectCard(type, next), bound };
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

function rebuildHead(head: HeadCommit, raw: string | null): { commit: HeadCommit; trimmed: boolean } | null {
  const page = parsePage(raw);
  const existed = raw !== null;
  let trimmed = false;
  if (head.replay.kind === "place") {
    const card = head.replay.card;
    page.cards = dropCard(page.cards, card.type ?? "", card.slug);
    page.cards.unshift(card);
    while (page.cards.length > head.replay.bound) {
      page.cards.pop();
      trimmed = true;
    }
  } else if (head.replay.kind === "remove") {
    page.cards = dropCard(page.cards, head.replay.type, head.replay.slug);
  } else if (head.replay.kind === "symptom") {
    const held = page.cards[0]?.slug ?? "";
    if (held.length > 0 && held !== head.replay.slug) return null;
    page.cards = [{ slug: head.replay.slug }];
    page.older = "";
  } else {
    const held = page.cards[0]?.slug ?? "";
    if (held.length > 0 && held !== head.replay.slug) return { commit: head, trimmed: false };
    page.cards = [];
    page.older = "";
  }
  const symptom = head.replay.kind === "symptom" || head.replay.kind === "clear";
  const json = renderPage(page, symptom);
  return {
    trimmed,
    commit: {
      ...head,
      mutationType: existed ? "update" : "create",
      fields: { ...head.fields, blp_page: json },
      expected: existed
        ? { type: "value", field: "blp_page", value: raw ?? "" }
        : { type: "absent", field: "blp_page" },
    },
  };
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
    if (!rebuilt) {
      notePartial(details, "symptom occupied");
      continue;
    }
    if (rebuilt.trimmed) notePartial(details, "head retry dropped a card");
    const second = await casHead(node, rebuilt.commit);
    if (second !== "applied") notePartial(details, "head conflict");
  }
  return details;
}

async function readCount(
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

async function writeCount(
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
