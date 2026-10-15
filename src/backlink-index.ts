// Backlink secondary index: one internal membership partition per target slug,
// stored in the tag index layout (one small row per (target, source), see
// tag-index.ts). Reads range-read that partition, then point-read each
// candidate source and re-validate the edge, so `get`/`backlinks` cost scales
// with inbound link cardinality rather than total fbrain corpus size.

import { hasSpillMarker } from "./body-spill.ts";
import { FbrainError, type NodeClient, type QueryRow, type Verbose } from "./client.ts";
import type { Config } from "./config.ts";
import { HEAD_RANGE } from "./list-page.ts";
import {
  memberKey,
  parseMemberKey,
  readTagIndex,
  rebuildTagMemberPartitions,
  requireTagMemberSchema,
  tagIndexAvailable,
  warnOnce,
} from "./tag-index.ts";
import {
  findBySlug,
  findBySlugsRaw,
  isSchemaNotFoundReadError,
  isTombstoned,
  listRecords,
  normalizeSlug,
  parseGenericLinkTag,
  schemaHashFor,
  wikiLinkSlugs,
  type Backlink,
  type BacklinkRef,
  type BacklinkVia,
  type FbrainRecord,
} from "./record.ts";
import { RECORD_TYPES, type RecordType } from "./schemas.ts";

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
  const row = res.results.find((item) => pageRowMatches(item, hash, range));
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

function pageRowMatches(row: QueryRow, hash: string, range: string): boolean {
  const keyHash = row.key?.hash;
  const keyRange = row.key?.range;
  if (keyHash && keyHash !== hash) return false;
  if (keyRange && keyRange !== range) return false;
  return true;
}

export type BacklinkIndexRebuildResult = {
  targetsIndexed: number;
  membersIndexed: number;
};

export function backlinkIndexTag(targetSlug: string): string {
  return `${BACKLINK_INDEX_TAG_PREFIX}${normalizeSlug(targetSlug)}`;
}

// Backlink listing for `fbrain get` (`linked_from`): ONE range read of the
// membership partition, then ONE keyed read of the product schema for each
// record type among the sources, to re-check each source.
//
// Why a second reader exists: `findBacklinks` below point-reads every source
// record one by one to fetch its status and re-derive `via`, so a get of a
// record with 23 inbound links cost 25 node requests — the dominant amplifier
// behind the 18–45 s gets measured 2026-09-06 under node load
// (papercut-brain-get-issues-33-node-requests-for-one-record). This reader
// re-checks all sources of one type with a single keyed read, so a get costs
// one request per source TYPE (one to three), not one per source. The decorated
// view (status, via) stays on `fbrain backlinks`.
//
// Why it re-checks at all: a remove is last-writer-wins against a concurrent add
// (two devices, or a copy of the legacy members racing a removal), so a member
// that was removed can come back to the partition. A source that no longer
// exists, is deleted, or no longer links to the target is dropped here.
// If the re-check cannot read, the members are returned as stored and the
// failure is reported under --verbose.
export async function listBacklinkMembers(
  node: NodeClient,
  cfg: Config,
  targetSlug: string,
  options?: { verbose?: Verbose },
): Promise<BacklinkRef[]> {
  if (!tagIndexAvailable(cfg)) {
    options?.verbose?.(
      "backlinks index unavailable; returning fast empty linked_from " +
        "(run `fbrain init`, then `fbrain reindex --backlinks` to populate it)",
    );
    return [];
  }
  const normalized = normalizeSlug(targetSlug);
  const index = await readTagIndex(
    node,
    cfg,
    backlinkIndexTag(normalized),
    options?.verbose,
  );
  if (index === null) return [];

  const seen = new Set<string>();
  const refs: BacklinkRef[] = [];
  for (const member of index.members) {
    if (seen.has(member)) continue;
    seen.add(member);
    const parsed = parseMemberKey(member);
    if (parsed === null) continue;
    if (cfg.schemaHashes[parsed.type] === undefined) continue;
    refs.push({ type: parsed.type, slug: parsed.slug });
  }
  refs.sort((a, b) => a.type.localeCompare(b.type) || a.slug.localeCompare(b.slug));

  let checked: BacklinkRef[];
  try {
    checked = await recheckBacklinkSources(node, cfg, refs, normalized);
  } catch (err) {
    options?.verbose?.(
      `backlinks: could not re-check the sources of ${normalized} (${errorMessage(err)}); returning the index members as stored`,
    );
    checked = refs;
  }
  return checked;
}

// Keep the sources that still exist, are live, and still link to the target.
// One keyed read per record type (`findBySlugsRaw`).
//
// An EMPTY answer for a member the index names is not proof that the member is
// gone: `/api/query` is known to return an empty page under load. So a member
// the read does not return is retried (bounded, with backoff). One that is still
// missing is left out, but not silently: a warning names it (once per command),
// because dropping a real backlink on a flake is a wrong `linked_from`. A
// source whose record is soft-deleted, or that no longer links to the target, is
// a real answer and is dropped without a word.
const RECHECK_ATTEMPTS = 3;
const RECHECK_BACKOFF_MS = 250;

async function recheckBacklinkSources(
  node: NodeClient,
  cfg: Config,
  refs: readonly BacklinkRef[],
  targetSlug: string,
): Promise<BacklinkRef[]> {
  const byType = new Map<RecordType, string[]>();
  for (const ref of refs) {
    const slugs = byType.get(ref.type) ?? [];
    slugs.push(ref.slug);
    byType.set(ref.type, slugs);
  }
  const live = new Set<string>();
  const unreadable: string[] = [];
  for (const [type, slugs] of byType) {
    const hash = schemaHashFor(type, cfg);
    let pending = [...slugs];
    for (let attempt = 1; attempt <= RECHECK_ATTEMPTS && pending.length > 0; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, RECHECK_BACKOFF_MS * (attempt - 1)));
      }
      const records = await findBySlugsRaw(node, type, hash, pending);
      const missed: string[] = [];
      for (const slug of pending) {
        const record = records.get(slug) ?? null;
        if (record === null) {
          missed.push(slug);
          continue;
        }
        if (isTombstoned(record)) continue;
        // The tail lives in the file. A head with no wikilink is not proof the link is gone.
        if (
          backlinkVia(record, type, targetSlug, undefined).length === 0 &&
          !hasSpillMarker(record.body)
        ) {
          continue;
        }
        live.add(`${type}:${slug}`);
      }
      pending = missed;
    }
    for (const slug of pending) unreadable.push(`${type}:${slug}`);
  }
  if (unreadable.length > 0) {
    warnOnce(
      `backlinks:${targetSlug}`,
      `backlinks: ${unreadable.length} member(s) of "${targetSlug}" could not be read after ${RECHECK_ATTEMPTS} tries ` +
        `and were left out of linked_from (${unreadable.slice(0, 5).join(", ")}${unreadable.length > 5 ? ", ..." : ""}). ` +
        "Retry; if it persists the index names a record that is gone: `brain reindex --backlinks` (admin).",
    );
  }
  return refs.filter((ref) => live.has(`${ref.type}:${ref.slug}`));
}

export async function findBacklinks(
  node: NodeClient,
  cfg: Config,
  targetSlug: string,
  options?: { targetType?: RecordType; verbose?: Verbose },
): Promise<Backlink[]> {
  const normalized = normalizeSlug(targetSlug);
  if (!tagIndexAvailable(cfg)) {
    options?.verbose?.(
      "backlinks index unavailable; returning fast empty linked_from " +
        "(run `fbrain init`, then `fbrain reindex --backlinks` to populate it)",
    );
    return [];
  }

  const index = await readTagIndex(node, cfg, backlinkIndexTag(normalized));
  if (index === null) return [];

  const bySource = new Map<string, Backlink>();
  const seen = new Set<string>();
  for (const member of index.members) {
    if (seen.has(member)) continue;
    seen.add(member);
    const parsed = parseMemberKey(member);
    if (parsed === null) continue;

    let schemaHash: string;
    try {
      schemaHash = schemaHashFor(parsed.type, cfg);
    } catch {
      continue;
    }

    const record = await findBySlug(node, parsed.type, schemaHash, parsed.slug);
    if (record === null) continue;
    const via = backlinkVia(record, parsed.type, normalized, options?.targetType);
    if (via.length === 0) continue;

    bySource.set(member, {
      type: parsed.type,
      slug: record.slug,
      status: record.status,
      via,
      updated_at: record.updated_at,
    });
  }

  return Array.from(bySource.values()).sort(compareBacklinks);
}

export async function reconcileBacklinkIndex(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
  oldRecord: FbrainRecord | null,
  newRecord: FbrainRecord | null,
  verbose?: Verbose,
): Promise<void> {
  // Page atoms replaced this payload.
  void node;
  void cfg;
  void type;
  void slug;
  void oldRecord;
  void newRecord;
  void verbose;
  return;
}

export async function rebuildBacklinkIndex(
  node: NodeClient,
  cfg: Config,
  opts: {
    listRecords?: (type: RecordType, schemaHash: string) => Promise<FbrainRecord[]>;
    schemaHashFor?: (type: RecordType) => string;
    onSkipUnavailableType?: (type: RecordType) => void;
  } = {},
): Promise<BacklinkIndexRebuildResult> {
  if (!tagIndexAvailable(cfg)) return { targetsIndexed: 0, membersIndexed: 0 };
  // Fail before the corpus scan, not after it.
  requireTagMemberSchema(cfg);

  const byTarget = new Map<string, Set<string>>();
  const list = opts.listRecords ?? ((type: RecordType) =>
    // A rebuild writes (and deletes) from what it reads: a cut row whose record
    // cannot be read must stop it, not be skipped.
    listRecords(node, type, cfg, { onMissing: "throw" }));
  const hashFor = opts.schemaHashFor ?? ((type) => schemaHashFor(type, cfg));

  for (const type of RECORD_TYPES) {
    let records: FbrainRecord[];
    try {
      records = await list(type, hashFor(type));
    } catch (err) {
      if (isSchemaNotFoundReadError(err)) {
        opts.onSkipUnavailableType?.(type);
        continue;
      }
      throw err;
    }
    for (const record of records) {
      if (isTombstoned(record)) continue;
      const member = memberKey(type, record.slug);
      for (const target of backlinkTargetSlugs(record, type)) {
        let members = byTarget.get(target);
        if (!members) {
          members = new Set<string>();
          byTarget.set(target, members);
        }
        members.add(member);
      }
    }
  }

  const byTag = new Map<string, Set<string>>();
  for (const [target, members] of byTarget) {
    byTag.set(backlinkIndexTag(target), members);
  }
  const membersIndexed = await rebuildTagMemberPartitions(node, cfg, byTag);
  return { targetsIndexed: byTarget.size, membersIndexed };
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

function backlinkVia(
  record: FbrainRecord,
  sourceType: RecordType,
  targetSlug: string,
  targetType: RecordType | undefined,
): BacklinkVia[] {
  const via: BacklinkVia[] = [];

  if (
    sourceType === "task" &&
    record.design_slug === targetSlug &&
    (targetType === undefined || targetType === "design")
  ) {
    via.push("explicit");
  }

  for (const tag of record.tags) {
    const parsed = parseGenericLinkTag(tag);
    if (!parsed) continue;
    if (normalizeSlug(parsed.to_slug) !== targetSlug) continue;
    if (targetType !== undefined && parsed.to_type !== targetType) continue;
    via.push("explicit");
    break;
  }

  if (wikiLinkSlugs(record.body).includes(targetSlug)) via.push("body");
  return mergeVia([], via);
}

function mergeVia(existing: BacklinkVia[], incoming: BacklinkVia[]): BacklinkVia[] {
  const out = new Set<BacklinkVia>(existing);
  for (const item of incoming) out.add(item);
  return Array.from(out).sort();
}

function compareBacklinks(a: Backlink, b: Backlink): number {
  const byUpdated = b.updated_at.localeCompare(a.updated_at);
  if (byUpdated !== 0) return byUpdated;
  const byType = a.type.localeCompare(b.type);
  if (byType !== 0) return byType;
  return a.slug.localeCompare(b.slug);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
