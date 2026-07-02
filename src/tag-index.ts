// Tag secondary index — an fbrain-maintained inverted index mapping each tag to
// the records that carry it, so tag-filtered reads (`fbrain list --tag`,
// `fbrain_list {tag}`, `fbrain delete --tag`) scale with the tag's cardinality
// instead of the size of the record type(s) being scanned.
//
// WHY: fold_db has NO server-side field index. `/api/query` cannot filter by a
// body field (see the `queryAll` comment in client.ts), so an un-indexed
// `list --tag papercut` must fetch EVERY record of the type(s) in scope and
// filter client-side — O(rows in the scanned type), not O(rows carrying the
// tag). That's the papercut `papercut-fbrain-tag-query-no-index`: imperceptible
// today (dozens–hundreds of rows) but a latent scaling cliff, since tags are the
// primary cross-type organizing axis (`papercut`, `incident`, `friction`, …).
//
// DESIGN: one `TagIndex` record per tag (schema `fbrain/TagIndex`), keyed by a
// reserved `__tagidx__…` slug no user record can collide with (user slugs must
// start with `[a-z0-9]`, so a leading `_` is impossible — see `validateSlug`).
// The record's `members` array holds `"<type>:<slug>"` entries, one per live
// record carrying the tag. A tag-filtered read resolves the member set from this
// one point-read, then point-looks-up each member by slug (index-backed, flat
// per fold #905) — so the cost is O(tag matches), independent of corpus size.
//
// The index is a pure OPTIMIZATION, never the source of truth. Every read path
// that consults it retains the legacy scan as an index-miss fallback:
//   - the `TagIndex` schema isn't in this config (an older `init`) → scan;
//   - no `TagIndex` record exists for the tag yet → scan;
// so correctness never depends on the index being present or perfectly current.
//
// MAINTENANCE is transactional on the write paths that change tag membership
// (`put` create/update, `<type> new` create, `delete` tombstone): each diffs a
// record's old vs new tags and adds/removes its member entry from the affected
// tags' index records. Writes that PRESERVE tags (`status`, `link`, `append`,
// `migrate`) don't move membership, so they don't touch the index. Index writes
// are best-effort: a failure to update the index is logged (verbose) and
// swallowed so it can never fail a user's real write — the worst case is a stale
// index entry, which the read path's membership re-check (below) filters out and
// `fbrain reindex --tags` fully repairs.

import type { NodeClient, Verbose } from "./client.ts";
import type { Config } from "./config.ts";
import { sha256Hex } from "./hash.ts";
import { isTombstoned, nowIso, type FbrainRecord } from "./record.ts";
import {
  RECORD_TYPES,
  TAG_INDEX_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";

// Slug prefix for every TagIndex record. A leading `_` can never appear in a
// user slug (`validateSlug` requires `^[a-z0-9]`), so this namespace is
// collision-proof against real records.
export const TAG_INDEX_SLUG_PREFIX = "__tagidx__";

// The reserved TagIndex record slug for a tag. The tag value is arbitrary text
// (spaces, colons, unicode all legal in a tag), and this slug is used verbatim
// as a fold_db hash key, so we HASH the tag (lowercase-hex sha256) rather than
// embed it — the key stays a fixed-shape ASCII token regardless of the tag's
// characters, and two distinct tags can never collide onto one key. The literal
// tag is stored in the record's `tag` field for readability/debugging.
export function tagIndexSlug(tag: string): string {
  return `${TAG_INDEX_SLUG_PREFIX}${sha256Hex(tag)}`;
}

// A member entry: the (type, slug) pair identifying a record that carries the
// tag. Encoded as `"<type>:<slug>"`. RecordType names never contain a colon and
// come first, so the FIRST colon is always the type/slug boundary.
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

// The TagIndex schema hash for this config, or null when it isn't registered
// (an older `init` that predates the tag index — the read/write paths then fall
// back to the scan, and index maintenance is a silent no-op). This one check
// gates the ENTIRE feature: no hash ⇒ fbrain behaves exactly as it did before
// this index existed.
export function tagIndexSchemaHash(cfg: Config): string | null {
  const hash = cfg.schemaHashes[TAG_INDEX_SCHEMA_KEY];
  return hash && hash.length > 0 ? hash : null;
}

export function tagIndexAvailable(cfg: Config): boolean {
  return tagIndexSchemaHash(cfg) !== null;
}

// The fields a TagIndex record carries (mirrors `tagIndexSchema` in schemas.ts).
const TAG_INDEX_FIELDS = ["slug", "tag", "members", "created_at", "updated_at"];

export type TagIndexRecord = {
  slug: string;
  tag: string;
  members: string[];
  created_at: string;
  updated_at: string;
};

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

// Point-read the TagIndex record for a tag. Returns null on an index MISS —
// either the schema isn't registered (feature off) or no record exists for this
// tag yet — so callers uniformly treat null as "fall back to the scan". Reads
// the single reserved key via the node's `HashKey` filter (`queryByKey`), a
// flat O(1) point read (fold #905) — NOT a full-schema listing — so even the
// index lookup itself doesn't scale with the number of distinct tags.
export async function readTagIndex(
  node: NodeClient,
  cfg: Config,
  tag: string,
): Promise<TagIndexRecord | null> {
  const schemaHash = tagIndexSchemaHash(cfg);
  if (schemaHash === null) return null;
  const slug = tagIndexSlug(tag);
  const row = await node.queryByKey({ schemaHash, fields: TAG_INDEX_FIELDS, keyHash: slug });
  if (row === null) return null;
  return rowToTagIndex((row.fields ?? {}) as Record<string, unknown>);
}

// Write a tag's index record (create or overwrite) with the given member set.
// An empty member set writes an empty-`members` record (rather than deleting the
// row) — fold_db is append-only, so a tombstone would only re-materialize on the
// next add; an empty `members` array is the natural "no members" state and reads
// back as an index HIT with zero members (correctly returning no records).
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
  // Deterministic member order (sorted) so re-writes are stable and diffs are
  // reviewable; membership is a set, so order carries no meaning.
  const sorted = [...new Set(members)].sort();
  const fields = {
    slug,
    tag,
    members: sorted,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  if (existing) {
    await node.updateRecord({ schemaHash, fields, keyHash: slug });
  } else {
    await node.createRecord({ schemaHash, fields, keyHash: slug });
  }
}

// Add `member` to a tag's index, creating the tag's record if absent.
async function addMember(
  node: NodeClient,
  cfg: Config,
  tag: string,
  member: string,
): Promise<void> {
  const existing = await readTagIndex(node, cfg, tag);
  const members = existing ? existing.members : [];
  if (members.includes(member)) return; // already present — no write
  await writeTagIndex(node, cfg, tag, [...members, member], existing);
}

// Remove `member` from a tag's index. A missing record or absent member is a
// no-op (the member already isn't indexed under this tag).
async function removeMember(
  node: NodeClient,
  cfg: Config,
  tag: string,
  member: string,
): Promise<void> {
  const existing = await readTagIndex(node, cfg, tag);
  if (!existing || !existing.members.includes(member)) return;
  const members = existing.members.filter((m) => m !== member);
  await writeTagIndex(node, cfg, tag, members, existing);
}

// Reconcile the tag index for a single record whose tags changed from `oldTags`
// to `newTags`. Adds the record's member entry to every newly-present tag and
// removes it from every dropped tag; unchanged tags are untouched. The tombstone
// tag is never indexed (a soft-deleted record must not appear in any tag query).
//
// Best-effort: any index write failure is swallowed (logged via `verbose`) so it
// can NEVER fail the user's real write. A dropped index update leaves a stale
// entry, which the read path's live-membership re-check filters out and
// `fbrain reindex --tags` repairs.
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
  const added = [...newSet].filter((t) => !oldSet.has(t));
  const removed = [...oldSet].filter((t) => !newSet.has(t));
  try {
    for (const tag of added) await addMember(node, cfg, tag, member);
    for (const tag of removed) await removeMember(node, cfg, tag, member);
  } catch (err) {
    verbose?.(
      `tag-index reconcile failed for ${member} (added=${added.join(",")} removed=${removed.join(",")}): ` +
        `${err instanceof Error ? err.message : String(err)} — index left stale; \`fbrain reindex --tags\` repairs it`,
    );
  }
}

// A record was created / had tags added: index it under `tags`.
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

// A record was deleted (tombstoned): drop it from every tag it carried.
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

// Drop the tombstone sentinel (and any empty strings) from a tag list before
// indexing — a soft-deleted record must never contribute to a tag query, and
// the internal tombstone tag is not a user tag.
function userTags(tags: readonly string[]): string[] {
  return tags.filter((t) => t.length > 0 && !isTombstoneTag(t));
}

// Local copy of the tombstone-tag test that doesn't need a full record — the
// tag-index module works with raw tag lists, not `FbrainRecord`s.
function isTombstoneTag(tag: string): boolean {
  return tag === "__fbrain_deleted__";
}

// A live record matched by a tag query, carrying its resolved type alongside
// the record — the shape both `list --tag` and `delete --tag` consume.
export type TaggedRecord = { type: RecordType; record: FbrainRecord };

// Resolve every LIVE record carrying `tag` THROUGH the index. Returns null on an
// index MISS (feature off, or no index record for the tag) so the caller falls
// back to the legacy scan. On an index HIT, point-looks-up each member by slug
// (index-backed, flat per fold #905 — cost O(members), i.e. tag cardinality, NOT
// corpus size) and RE-CHECKS that each resolved record is live AND still carries
// the tag: a stale index entry (record deleted, or tag removed, without the
// index catching up) is silently skipped, so a lagging index can never surface a
// wrong row — it can only (transiently) omit one, which `fbrain reindex --tags`
// repairs.
//
// The membership re-check is what makes the best-effort index write path safe:
// the index is a candidate set, and the authoritative live record is the filter.
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
  if (index === null) return null; // index miss → caller scans
  const out: TaggedRecord[] = [];
  const seen = new Set<string>();
  for (const entry of index.members) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    const parsed = parseMemberKey(entry);
    if (parsed === null) continue; // malformed entry — skip defensively
    const record = await deps.findBySlug(
      parsed.type,
      deps.schemaHashFor(parsed.type),
      parsed.slug,
    );
    // Authoritative live-membership re-check: skip a stale entry whose record is
    // gone or no longer carries the tag.
    if (record === null) continue;
    if (!record.tags.includes(tag)) continue;
    out.push({ type: parsed.type, record });
  }
  return out;
}

// Full rebuild of the entire tag index from a corpus scan — the authoritative
// repair path (used by `fbrain reindex --tags`). Sweeps every live record of
// every type, accumulates the tag → members map, and overwrites each tag's index
// record. Returns a summary for the caller to report. This is the one O(corpus)
// operation in the feature — deliberately so: it's an explicit maintenance
// command, not a hot read path.
export type TagIndexRebuildResult = {
  tagsIndexed: number;
  membersIndexed: number;
};

export async function rebuildTagIndex(
  node: NodeClient,
  cfg: Config,
  opts: {
    // Injected corpus reader: `(type, schemaHash) => live records of that type`.
    // Passed in (rather than importing `listRecords`) to avoid an import cycle
    // and to let `reindex`/tests scope the sweep.
    listRecords: (type: RecordType, schemaHash: string) => Promise<FbrainRecord[]>;
    schemaHashFor: (type: RecordType) => string;
  },
): Promise<TagIndexRebuildResult> {
  if (!tagIndexAvailable(cfg)) {
    return { tagsIndexed: 0, membersIndexed: 0 };
  }
  // tag → set of member keys
  const map = new Map<string, Set<string>>();
  for (const type of RECORD_TYPES) {
    const records = await opts.listRecords(type, opts.schemaHashFor(type));
    for (const r of records) {
      if (isTombstoned(r)) continue;
      const member = memberKey(type, r.slug);
      for (const tag of userTags(r.tags)) {
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
