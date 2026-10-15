// Backlink secondary index: one internal membership partition per target slug,
// stored in the tag index layout (one small row per (target, source), see
// tag-index.ts). Reads range-read that partition, then point-read each
// candidate source and re-validate the edge, so `get`/`backlinks` cost scales
// with inbound link cardinality rather than total fbrain corpus size.

import { hasSpillMarker } from "./body-spill.ts";
import type { NodeClient, Verbose } from "./client.ts";
import type { Config } from "./config.ts";
import {
  applyTagMemberChanges,
  memberKey,
  parseMemberKey,
  readTagIndex,
  rebuildTagMemberPartitions,
  requireTagMemberSchema,
  tagIndexAvailable,
  warnOnce,
  type TagMemberChange,
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
  if (!tagIndexAvailable(cfg)) return;

  const member = memberKey(type, slug);
  const oldTargets = oldRecord ? backlinkTargetSlugs(oldRecord, type) : [];
  const newTargets = newRecord && !isTombstoned(newRecord)
    ? backlinkTargetSlugs(newRecord, type)
    : [];
  const oldSet = new Set(oldTargets);
  const newSet = new Set(newTargets);
  const added = [...newSet].filter((target) => !oldSet.has(target));
  const removed = [...oldSet].filter((target) => !newSet.has(target));

  const changes: TagMemberChange[] = [
    ...added.map(
      (target): TagMemberChange => ({
        tag: backlinkIndexTag(target),
        member,
        op: "add",
      }),
    ),
    ...removed.map(
      (target): TagMemberChange => ({
        tag: backlinkIndexTag(target),
        member,
        op: "remove",
      }),
    ),
  ];
  if (changes.length === 0) return;
  try {
    await applyTagMemberChanges(node, cfg, changes, verbose);
  } catch (err) {
    verbose?.(
      `backlink-index reconcile failed for ${member}: ${changes.length} target update(s) failed ` +
        `(added=${added.join(",")} removed=${removed.join(",")} failed=${errorMessage(err)}); ` +
        "run `fbrain reindex --backlinks` to repair",
    );
  }
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
