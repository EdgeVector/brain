import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import {
  findBySlugRaw,
  isTombstoned,
  listRecords,
  nowIso,
  schemaHashFor,
  TOMBSTONE_TAG,
  type FbrainRecord,
} from "./record.ts";
import { RECORD_TYPES, type RecordType } from "./schemas.ts";

export const TAG_INDEX_TYPE: RecordType = "reference";
export const TAG_INDEX_SLUG = "__fbrain_tag_index__";
const TAG_INDEX_VERSION = 1;

export type TagIndexEntry = {
  type: RecordType;
  slug: string;
  title: string;
  status: string;
  tags: string[];
  design_slug?: string;
  created_at: string;
  updated_at: string;
};

type TagIndex = {
  version: 1;
  tags: Record<string, TagIndexEntry[]>;
};

export async function lookupTagIndex(
  node: NodeClient,
  cfg: Config,
  tag: string,
): Promise<TagIndexEntry[] | null> {
  const loaded = await loadTagIndex(node, cfg);
  if (!loaded) return null;
  const entries = loaded.index.tags[tag];
  return entries ? entries.slice() : null;
}

export async function updateTagIndexForRecord(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  record: FbrainRecord,
): Promise<void> {
  const liveTags = record.tags.filter((tag) => tag !== TOMBSTONE_TAG);
  const loaded = await loadTagIndex(node, cfg);
  if (!loaded && liveTags.length === 0) return;
  const state = loaded ?? {
    index: await rebuildTagIndexInMemory(node, cfg),
    existing: null,
  };
  removeEntry(state.index, type, record.slug);
  if (!isTombstoned(record)) {
    const entry = entryFromRecord(type, record);
    for (const tag of liveTags) {
      if (!state.index.tags[tag]) state.index.tags[tag] = [];
      state.index.tags[tag]!.push(entry);
      state.index.tags[tag]!.sort(compareEntry);
    }
  }
  await writeTagIndex(node, cfg, state.index, state.existing);
}

export async function removeFromTagIndex(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
): Promise<void> {
  const loaded = await loadTagIndex(node, cfg);
  if (!loaded) return;
  removeEntry(loaded.index, type, slug);
  await writeTagIndex(node, cfg, loaded.index, loaded.existing);
}

function entryFromRecord(type: RecordType, record: FbrainRecord): TagIndexEntry {
  const entry: TagIndexEntry = {
    type,
    slug: record.slug,
    title: record.title,
    status: record.status,
    tags: record.tags.filter((tag) => tag !== TOMBSTONE_TAG),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.design_slug !== undefined) entry.design_slug = record.design_slug;
  return entry;
}

export function recordFromTagIndexEntry(entry: TagIndexEntry): FbrainRecord {
  const record: FbrainRecord = {
    slug: entry.slug,
    title: entry.title,
    body: "",
    status: entry.status,
    tags: entry.tags.slice(),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
  if (entry.design_slug !== undefined) record.design_slug = entry.design_slug;
  return record;
}

async function loadTagIndex(
  node: NodeClient,
  cfg: Config,
): Promise<{ index: TagIndex; existing: FbrainRecord } | null> {
  const hash = schemaHashFor(TAG_INDEX_TYPE, cfg);
  const existing = await findBySlugRaw(node, TAG_INDEX_TYPE, hash, TAG_INDEX_SLUG);
  if (!existing) return null;
  const parsed = parseTagIndex(existing.body);
  if (!parsed) return null;
  return { index: parsed, existing };
}

function parseTagIndex(body: string): TagIndex | null {
  try {
    const raw = JSON.parse(body) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== TAG_INDEX_VERSION || !obj.tags || typeof obj.tags !== "object") {
      return null;
    }
    const tags: Record<string, TagIndexEntry[]> = {};
    for (const [tag, value] of Object.entries(obj.tags as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const entries = value.filter(isTagIndexEntry).sort(compareEntry);
      if (entries.length > 0) tags[tag] = entries;
    }
    return { version: TAG_INDEX_VERSION, tags };
  } catch {
    return null;
  }
}

function isTagIndexEntry(value: unknown): value is TagIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.slug === "string" &&
    typeof entry.title === "string" &&
    typeof entry.status === "string" &&
    typeof entry.created_at === "string" &&
    typeof entry.updated_at === "string" &&
    Array.isArray(entry.tags) &&
    entry.tags.every((tag) => typeof tag === "string") &&
    typeof entry.type === "string" &&
    (RECORD_TYPES as readonly string[]).includes(entry.type)
  );
}

async function rebuildTagIndexInMemory(
  node: NodeClient,
  cfg: Config,
): Promise<TagIndex> {
  const index: TagIndex = { version: TAG_INDEX_VERSION, tags: {} };
  for (const type of RECORD_TYPES) {
    const rows = await listRecords(node, type, schemaHashFor(type, cfg));
    for (const record of rows) {
      if (isTombstoned(record)) continue;
      if (type === TAG_INDEX_TYPE && record.slug === TAG_INDEX_SLUG) continue;
      const entry = entryFromRecord(type, record);
      for (const tag of entry.tags) {
        if (!index.tags[tag]) index.tags[tag] = [];
        index.tags[tag]!.push(entry);
      }
    }
  }
  for (const entries of Object.values(index.tags)) entries.sort(compareEntry);
  return index;
}

async function writeTagIndex(
  node: NodeClient,
  cfg: Config,
  index: TagIndex,
  existing: FbrainRecord | null,
): Promise<void> {
  const now = nowIso();
  const fields = {
    slug: TAG_INDEX_SLUG,
    title: "fbrain tag index",
    body: JSON.stringify(index),
    status: "archived",
    tags: [TOMBSTONE_TAG, "fbrain-internal-index"],
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const schemaHash = schemaHashFor(TAG_INDEX_TYPE, cfg);
  if (existing) {
    await node.updateRecord({ schemaHash, fields, keyHash: TAG_INDEX_SLUG });
  } else {
    await node.createRecord({ schemaHash, fields, keyHash: TAG_INDEX_SLUG });
  }
}

function removeEntry(index: TagIndex, type: RecordType, slug: string): void {
  for (const [tag, entries] of Object.entries(index.tags)) {
    const kept = entries.filter((entry) => entry.type !== type || entry.slug !== slug);
    if (kept.length === 0) delete index.tags[tag];
    else index.tags[tag] = kept;
  }
}

function compareEntry(a: TagIndexEntry, b: TagIndexEntry): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return 0;
}
