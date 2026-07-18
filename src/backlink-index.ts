// Backlink secondary index: one internal membership record per target slug.
// Reads point-read that index record, then point-read each candidate source
// and re-validate the edge, so `get`/`backlinks` cost scales with inbound link
// cardinality rather than total fbrain corpus size.

import type { NodeClient, Verbose } from "./client.ts";
import type { Config } from "./config.ts";
import {
  addTagIndexMember,
  memberKey,
  parseMemberKey,
  readTagIndex,
  removeTagIndexMember,
  tagIndexAvailable,
  writeTagIndex,
} from "./tag-index.ts";
import {
  findBySlug,
  isSchemaNotFoundReadError,
  isTombstoned,
  listRecords,
  normalizeSlug,
  parseGenericLinkTag,
  schemaHashFor,
  wikiLinkSlugs,
  type Backlink,
  type BacklinkVia,
  type FbrainRecord,
} from "./record.ts";
import { RECORD_TYPES, type RecordType } from "./schemas.ts";

export const BACKLINK_INDEX_TAG_PREFIX = "__fbrain_backlink__:";

export type BacklinkIndexRebuildResult = {
  targetsIndexed: number;
  membersIndexed: number;
};

export function backlinkIndexTag(targetSlug: string): string {
  return `${BACKLINK_INDEX_TAG_PREFIX}${normalizeSlug(targetSlug)}`;
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

  const failures: string[] = [];
  for (const target of added) {
    try {
      await addTagIndexMember(node, cfg, backlinkIndexTag(target), member);
    } catch (err) {
      failures.push(`add:${target}:${errorMessage(err)}`);
    }
  }
  for (const target of removed) {
    try {
      await removeTagIndexMember(node, cfg, backlinkIndexTag(target), member);
    } catch (err) {
      failures.push(`remove:${target}:${errorMessage(err)}`);
    }
  }

  if (failures.length > 0) {
    verbose?.(
      `backlink-index reconcile failed for ${member}: ${failures.length} target update(s) failed ` +
        `(added=${added.join(",")} removed=${removed.join(",")} failed=${failures.join("; ")}); ` +
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

  const byTarget = new Map<string, Set<string>>();
  const list = opts.listRecords ?? ((type, hash) => listRecords(node, type, hash, cfg));
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

  let membersIndexed = 0;
  for (const [target, members] of byTarget) {
    const tag = backlinkIndexTag(target);
    const existing = await readTagIndex(node, cfg, tag);
    const next = [...members].sort();
    if (!sameMembers(existing?.members ?? [], next)) {
      await writeTagIndex(node, cfg, tag, next, existing);
    }
    membersIndexed += next.length;
  }

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

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  if (left.length !== right.length) return false;
  return left.every((member, idx) => member === right[idx]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
