// Tag secondary index: one internal TagIndex record per tag. Tag-filtered
// reads point-read that tag record, then point-read each member, so hot-path
// cost scales with tag cardinality instead of total corpus size.

import type { NodeClient, Verbose } from "./client.ts";
import type { Config } from "./config.ts";
import { sha256Hex } from "./hash.ts";
import {
  isSchemaNotFoundReadError,
  isTombstoned,
  nowIso,
  type FbrainRecord,
} from "./record.ts";
import {
  RECORD_TYPES,
  TAG_INDEX_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";

export const TAG_INDEX_SLUG_PREFIX = "__tagidx__";

const TAG_INDEX_FIELDS = ["slug", "tag", "members", "created_at", "updated_at"];

export type TagIndexRecord = {
  slug: string;
  tag: string;
  members: string[];
  created_at: string;
  updated_at: string;
};

export type TaggedRecord = { type: RecordType; record: FbrainRecord };

export type TagIndexRebuildResult = {
  tagsIndexed: number;
  membersIndexed: number;
};

export function tagIndexSlug(tag: string): string {
  return `${TAG_INDEX_SLUG_PREFIX}${sha256Hex(tag)}`;
}

export function memberKey(type: RecordType, slug: string): string {
  return `${type}:${slug}`;
}

export function parseMemberKey(
  entry: string,
): { type: RecordType; slug: string } | null {
  const idx = entry.indexOf(":");
  if (idx <= 0) return null;
  const type = entry.slice(0, idx);
  const slug = entry.slice(idx + 1);
  if (!(RECORD_TYPES as readonly string[]).includes(type) || slug.length === 0) {
    return null;
  }
  return { type: type as RecordType, slug };
}

export function tagIndexSchemaHash(cfg: Config): string | null {
  const hash = cfg.schemaHashes[TAG_INDEX_SCHEMA_KEY];
  return hash && hash.length > 0 ? hash : null;
}

export function tagIndexAvailable(cfg: Config): boolean {
  return tagIndexSchemaHash(cfg) !== null;
}

export async function readTagIndex(
  node: NodeClient,
  cfg: Config,
  tag: string,
): Promise<TagIndexRecord | null> {
  const schemaHash = tagIndexSchemaHash(cfg);
  if (schemaHash === null) return null;
  const slug = tagIndexSlug(tag);
  const row = node.queryByKey
    ? await node.queryByKey({
        schemaHash,
        fields: TAG_INDEX_FIELDS,
        keyHash: slug,
      })
    : (await node.queryAll({ schemaHash, fields: TAG_INDEX_FIELDS })).results.find(
        (r) => r.key?.hash === slug || r.fields?.slug === slug,
      ) ?? null;
  if (row === null) return null;
  return rowToTagIndex((row.fields ?? {}) as Record<string, unknown>);
}

export async function reconcileTagIndex(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
  oldTags: readonly string[],
  newTags: readonly string[],
  verbose?: Verbose,
): Promise<void> {
  if (!tagIndexAvailable(cfg)) return;
  const member = memberKey(type, slug);
  const oldSet = new Set(userTags(oldTags));
  const newSet = new Set(userTags(newTags));
  const added = [...newSet].filter((tag) => !oldSet.has(tag));
  const removed = [...oldSet].filter((tag) => !newSet.has(tag));
  try {
    for (const tag of added) await addMember(node, cfg, tag, member);
    for (const tag of removed) await removeMember(node, cfg, tag, member);
  } catch (err) {
    verbose?.(
      `tag-index reconcile failed for ${member} (added=${added.join(",")} removed=${removed.join(",")}): ` +
        `${err instanceof Error ? err.message : String(err)}; run \`fbrain reindex --tags\` to repair`,
    );
  }
}

export async function indexRecordTags(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
  tags: readonly string[],
  verbose?: Verbose,
): Promise<void> {
  await reconcileTagIndex(node, cfg, type, slug, [], tags, verbose);
}

export async function unindexRecordTags(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
  tags: readonly string[],
  verbose?: Verbose,
): Promise<void> {
  await reconcileTagIndex(node, cfg, type, slug, tags, [], verbose);
}

export async function resolveRecordsByTag(
  node: NodeClient,
  cfg: Config,
  tag: string,
  deps: {
    findBySlug: (
      type: RecordType,
      schemaHash: string,
      slug: string,
    ) => Promise<FbrainRecord | null>;
    schemaHashFor: (type: RecordType) => string;
  },
): Promise<TaggedRecord[] | null> {
  const index = await readTagIndex(node, cfg, tag);
  if (index === null) return null;

  const out: TaggedRecord[] = [];
  const seen = new Set<string>();
  for (const member of index.members) {
    if (seen.has(member)) continue;
    seen.add(member);
    const parsed = parseMemberKey(member);
    if (parsed === null) continue;
    let schemaHash: string;
    try {
      schemaHash = deps.schemaHashFor(parsed.type);
    } catch {
      continue;
    }
    const record = await deps.findBySlug(
      parsed.type,
      schemaHash,
      parsed.slug,
    );
    if (record === null) continue;
    if (!record.tags.includes(tag)) continue;
    out.push({ type: parsed.type, record });
  }
  return out;
}

export async function rebuildTagIndex(
  node: NodeClient,
  cfg: Config,
  opts: {
    listRecords: (type: RecordType, schemaHash: string) => Promise<FbrainRecord[]>;
    schemaHashFor: (type: RecordType) => string;
    onSkipUnavailableType?: (type: RecordType) => void;
  },
): Promise<TagIndexRebuildResult> {
  if (!tagIndexAvailable(cfg)) return { tagsIndexed: 0, membersIndexed: 0 };

  const map = new Map<string, Set<string>>();
  for (const type of RECORD_TYPES) {
    let records: FbrainRecord[];
    try {
      records = await opts.listRecords(type, opts.schemaHashFor(type));
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
      for (const tag of userTags(record.tags)) {
        let set = map.get(tag);
        if (!set) {
          set = new Set<string>();
          map.set(tag, set);
        }
        set.add(member);
      }
    }
  }

  let membersIndexed = 0;
  for (const [tag, members] of map) {
    const existing = await readTagIndex(node, cfg, tag);
    await writeTagIndex(node, cfg, tag, [...members], existing);
    membersIndexed += members.size;
  }
  return { tagsIndexed: map.size, membersIndexed };
}

function rowToTagIndex(fields: Record<string, unknown>): TagIndexRecord {
  const members = fields.members;
  return {
    slug: typeof fields.slug === "string" ? fields.slug : "",
    tag: typeof fields.tag === "string" ? fields.tag : "",
    members: Array.isArray(members)
      ? members.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [],
    created_at: typeof fields.created_at === "string" ? fields.created_at : "",
    updated_at: typeof fields.updated_at === "string" ? fields.updated_at : "",
  };
}

async function addMember(
  node: NodeClient,
  cfg: Config,
  tag: string,
  member: string,
): Promise<void> {
  const existing = await readTagIndex(node, cfg, tag);
  const members = existing ? existing.members : [];
  if (members.includes(member)) return;
  await writeTagIndex(node, cfg, tag, [...members, member], existing);
}

async function removeMember(
  node: NodeClient,
  cfg: Config,
  tag: string,
  member: string,
): Promise<void> {
  const existing = await readTagIndex(node, cfg, tag);
  if (!existing || !existing.members.includes(member)) return;
  await writeTagIndex(
    node,
    cfg,
    tag,
    existing.members.filter((m) => m !== member),
    existing,
  );
}

async function writeTagIndex(
  node: NodeClient,
  cfg: Config,
  tag: string,
  members: string[],
  existing: TagIndexRecord | null,
): Promise<void> {
  const schemaHash = tagIndexSchemaHash(cfg);
  if (schemaHash === null) return;
  const slug = tagIndexSlug(tag);
  const now = nowIso();
  const fields = {
    slug,
    tag,
    members: [...new Set(members)].sort(),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  if (existing) {
    await node.updateRecord({ schemaHash, fields, keyHash: slug });
  } else {
    await node.createRecord({ schemaHash, fields, keyHash: slug });
  }
}

function userTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.length > 0 && tag !== "__fbrain_deleted__");
}
