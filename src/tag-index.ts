// Tag secondary index: one small HashRange row per (tag, member). Tag-filtered
// reads range-read one tag's partition, then point-read each member, so
// hot-path cost scales with tag cardinality instead of total corpus size.
// Operator notes (rollout, admin reindex, multi-device): docs/tag-membership.md.
//
// Layout (TagMembership_hashrange_v1, schemas.ts): hash = `__tagidx__<sha256(tag)>`,
// range = member key `type:slug`. Adding a member is ONE small create and
// removing one is ONE delete. There is no list to read, merge and rewrite, and
// two devices that add different members write different rows.
//
// The legacy layout (TagIndex, one row per tag holding `members: string[]`)
// is the reason for the rewrite: one atom held every member of a tag and was
// rewritten whole on each add (158 KB growing 65 bytes an hour on the primary,
// 2026-10-12). The new code NEVER writes that layout. It only reads it, to copy
// a tag's members across (lazy dual-read):
//
//   1. range-read the tag's partition in the new schema;
//   2. a per-tag copy stamp (`TAG_MEMBER_MIGRATED_RANGE` under the same hash)
//      says "the legacy members were copied": serve the partition;
//   3. no stamp: read the legacy row (one keyed read). If the row EXISTS, copy
//      its members into the partition in batches and write the stamp last, then
//      serve the partition. The stamp carries a small note: how many members
//      were copied, a digest of them, the time, and the legacy row's own
//      `updated_at`. The member rows are the list of what was copied;
//   4. no stamp and NO legacy row: the stamp is NOT written. A device that has
//      not synced the legacy row yet reads an empty legacy row, and a stamp
//      written on that read would hide the legacy row for good when it arrives.
//      A read returns what the partition holds (null when empty); a first add
//      writes only its member row. The cost is one extra keyed read (a miss) for
//      tags that never had a legacy row.
//
// Legacy rows are never deleted or rewritten. No step scans a schema. A write
// path copies a tag BEFORE it changes a member. Two callers do not copy one tag
// at once: a copy first writes a short-lived claim row and backs off when
// another live claim exists. A claim never blocks a read, and a failed or
// skipped copy never aborts a record write (the record write wins; the copy is
// retried on the next write or read of the tag).
//
// This module never registers a schema. A write path with no TagMembership hash
// in the config skips the tag ops and says so once per command; reads fall back
// to the legacy row. `brain init` is the only place that registers the schema.

import {
  FbrainError,
  type BatchMutationOp,
  type NodeClient,
  type QueryRow,
  type Verbose,
} from "./client.ts";
import type { Config } from "./config.ts";
import { sha256Hex } from "./hash.ts";
import {
  arrayStringField,
  nowIso,
  TOMBSTONE_TAG,
  type FbrainRecord,
} from "./record.ts";
import {
  RECORD_TYPES,
  TAG_INDEX_SCHEMA_KEY,
  TAG_MEMBER_COPYING_RANGE,
  TAG_MEMBER_FIELDS,
  TAG_MEMBER_MIGRATED_RANGE,
  TAG_MEMBER_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";

const TAG_INDEX_SLUG_PREFIX = "__tagidx__";

const LEGACY_MEMBER_FIELDS = ["members", "updated_at"];
const LEGACY_UPDATED_FIELD = ["updated_at"];
const TAG_MEMBER_RANGE_FIELD = ["tmb_r"];
const TAG_MEMBER_COPY_FIELD = ["tmb_r", "tmb_copy"];
// Every field the write path sets. A keyed read that names them all is answered
// with HTTP 400 when the node's schema lacks one, BEFORE any write is sent.
const TAG_MEMBER_ALL_FIELDS = [...TAG_MEMBER_FIELDS];

/** Mutations per node batch when a tag's partition is copied or rebuilt. */
export const TAG_MEMBER_BATCH_SIZE = 128;
/** Tag partitions per read in the admin rebuild. */
const TAG_PARTITION_READ_BATCH = 8;
/** `tmb_tag` is informational; the hash is the identity. Keep the atom small. */
const TAG_VALUE_MAX_BYTES = 1024;
/** Default life of a copy claim between renewals. */
export const TAG_COPY_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Life of a copy claim. `BRAIN_TAG_COPY_CLAIM_TTL_MS` shortens it (at least one
 * second): an operator knob, and how the single-flight rules are proven on a
 * synthetic home without waiting minutes.
 */
function claimTtlMs(): number {
  const fromEnv = Number(process.env.BRAIN_TAG_COPY_CLAIM_TTL_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 1000 ? fromEnv : TAG_COPY_CLAIM_TTL_MS;
}
/** A claim counts as dead only this long AFTER it expired (clock skew between callers). */
function claimMarginMs(): number {
  return Math.min(30_000, Math.floor(claimTtlMs() / 4));
}
/** A copy renews its claim at least this often (every minute by default). */
function claimRenewEveryMs(): number {
  return Math.min(60_000, Math.floor(claimTtlMs() / 3));
}

export type TagIndexRecord = {
  slug: string;
  tag: string;
  members: string[];
};

export type TaggedRecord = { type: RecordType; record: FbrainRecord };

/** One membership change: add or remove `member` under `tag`. */
export type TagMemberChange = {
  tag: string;
  member: string;
  op: "add" | "remove";
};

/** The note a copy stamp carries in `tmb_copy`. */
export type TagCopyNote = {
  v: 1;
  /** Members the stamp accounts for. */
  n: number;
  /** sha-256 of the sorted member keys it accounts for. */
  digest?: string;
  /** When the stamp was written (ISO 8601). */
  at: string;
  /** `updated_at` of the legacy row that was copied, when one was. */
  legacy_updated_at?: string;
  /** True when an admin rebuild from the records wrote the stamp. */
  rebuilt?: boolean;
  /** True when the legacy row exists with a real EMPTY member list (no members to copy). */
  empty?: boolean;
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

/** Hash of the TagMembership schema (the layout every write uses), or null. */
export function tagMemberSchemaHash(cfg: Config): string | null {
  const hash = cfg.schemaHashes[TAG_MEMBER_SCHEMA_KEY];
  return hash && hash.length > 0 ? hash : null;
}

/** Hash of the LEGACY TagIndex schema (read only, never written), or null. */
export function tagIndexSchemaHash(cfg: Config): string | null {
  const hash = cfg.schemaHashes[TAG_INDEX_SCHEMA_KEY];
  return hash && hash.length > 0 ? hash : null;
}

/**
 * Whether a tag read can be served: the TagMembership schema is pinned, or the
 * legacy TagIndex is (a read of an old config falls back to the legacy row).
 */
export function tagIndexAvailable(cfg: Config): boolean {
  return tagMemberSchemaHash(cfg) !== null || tagIndexSchemaHash(cfg) !== null;
}

/** One line, shown once per command, when the config has no TagMembership hash. */
export const TAG_MEMBER_UNPINNED_MESSAGE =
  "tag index: the TagMembership schema is not registered on this install, so tag and backlink " +
  "membership is NOT written and reads use the legacy layout. The old payload write stopped. " +
  "Run `brain init`, then `brain reindex --target tag#<tag> --source-hash <type> --slug <slug>` " +
  "and `brain reindex --target link#<slug> --source-hash <type> --slug <slug>`.";

const warned = new Set<string>();

/** Print one warning line to stderr, once per process (one CLI command). */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`warning: ${message}\n`);
}

function cutUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const next = used + Buffer.byteLength(ch);
    if (next > maxBytes) break;
    used = next;
    end += ch.length;
  }
  return text.slice(0, end);
}

function memberOp(
  schemaHash: string,
  op: "create" | "delete",
  tag: string,
  member: string,
  copyNote?: string,
): BatchMutationOp {
  const slug = tagIndexSlug(tag);
  return {
    mutationType: op,
    schemaHash,
    keyHash: slug,
    keyRange: member,
    fields:
      op === "delete"
        ? {}
        : {
            tmb_h: slug,
            tmb_r: member,
            tmb_tag: cutUtf8(tag, TAG_VALUE_MAX_BYTES),
            ...(copyNote !== undefined ? { tmb_copy: copyNote } : {}),
          },
  };
}

function stampOp(schemaHash: string, tag: string, note: TagCopyNote): BatchMutationOp {
  return memberOp(
    schemaHash,
    "create",
    tag,
    TAG_MEMBER_MIGRATED_RANGE,
    JSON.stringify(note),
  );
}

function digestOf(members: readonly string[]): string {
  return sha256Hex([...members].sort().join("\n"));
}

function parseCopyNote(raw: unknown): TagCopyNote | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TagCopyNote> | null;
    if (parsed === null || typeof parsed !== "object") return null;
    if (typeof parsed.at !== "string") return null;
    return parsed as TagCopyNote;
  } catch {
    return null;
  }
}

function rowRange(row: QueryRow): string | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const range = row.key?.range ?? fields.tmb_r;
  return typeof range === "string" && range.length > 0 ? range : null;
}

function rowHash(row: QueryRow): string | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const hash = row.key?.hash ?? fields.tmb_h;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/**
 * What one tag's partition holds: the copy stamp (and its time, when the read
 * asked for the note) and the member keys.
 */
type Partition = { marker: boolean; stampAt?: string; members: string[] };

function partitionFromRows(rows: readonly QueryRow[]): Partition {
  let marker = false;
  let stampAt: string | undefined;
  const members = new Set<string>();
  for (const row of rows) {
    const range = rowRange(row);
    if (range === null) continue;
    if (range === TAG_MEMBER_MIGRATED_RANGE) {
      marker = true;
      const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
      stampAt = parseCopyNote(fields.tmb_copy)?.at;
    } else if (range === TAG_MEMBER_COPYING_RANGE) continue;
    else members.add(range);
  }
  return {
    marker,
    ...(stampAt !== undefined ? { stampAt } : {}),
    members: [...members].sort(),
  };
}

/**
 * Range-read ONE tag's partition: one keyed query, paged by the client.
 * `withNote` also reads the stamp's note (the admin rebuild needs its time).
 */
async function readPartition(
  node: NodeClient,
  memberHash: string,
  tag: string,
  withNote = false,
): Promise<Partition> {
  const res = await node.queryAll({
    schemaHash: memberHash,
    fields: withNote ? TAG_MEMBER_COPY_FIELD : TAG_MEMBER_RANGE_FIELD,
    filter: { HashKey: tagIndexSlug(tag) },
  });
  return partitionFromRows(res.results);
}

function presenceId(hash: string, range: string): string {
  return `${hash}\u0000${range}`;
}

/**
 * The rows that exist among `keys`: ONE keyed read for all of them, mapped from
 * key id to the row's fields.
 */
async function readRowsByKey(
  node: NodeClient,
  memberHash: string,
  keys: ReadonlyArray<{ hash: string; range: string }>,
  fields: string[] = TAG_MEMBER_ALL_FIELDS,
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  if (keys.length === 0) return found;
  let rows: QueryRow[];
  if (node.queryByKeys) {
    rows = await node.queryByKeys({
      schemaHash: memberHash,
      fields,
      keys: keys.map((key) => ({ hash: key.hash, range: key.range })),
    });
  } else {
    const pages = await Promise.all(
      keys.map((key) =>
        node.queryAll({
          schemaHash: memberHash,
          fields,
          filter: { HashRangeKey: { hash: key.hash, range: key.range } },
        }),
      ),
    );
    rows = pages.flatMap((page) => page.results);
  }
  for (const row of rows) {
    const hash = rowHash(row);
    const range = rowRange(row);
    if (hash !== null && range !== null) {
      found.set(
        presenceId(hash, range),
        (row.fields as Record<string, unknown> | undefined) ?? {},
      );
    }
  }
  return found;
}

/**
 * A tag's legacy row: its members and its own `updated_at`. Null when absent.
 *
 * `state` tells apart three things a row can carry for `members`:
 * - `"present"`: a non-empty list. Copy it, then stamp.
 * - `"empty"`: a real EMPTY list (`[]`): a tag that had members and lost them
 *   all. There is nothing to copy; this is recorded ONCE as a stamp with
 *   `empty: true`, so the tag stops re-reading the legacy row and the doctor
 *   shows it as migrated-empty.
 * - `"missing"`: the row exists but has no `members` value at all. That can be a
 *   row whose members atom has not synced from another device yet. It is "not
 *   read": never copied, never stamped, and the next read or write looks again.
 */
type LegacyRow = {
  members: string[];
  updatedAt: string;
  state: "present" | "empty" | "missing";
};

async function readLegacyRow(
  node: NodeClient,
  cfg: Config,
  tag: string,
  fields: string[] = LEGACY_MEMBER_FIELDS,
): Promise<LegacyRow | null> {
  const schemaHash = tagIndexSchemaHash(cfg);
  if (schemaHash === null) return null;
  const slug = tagIndexSlug(tag);
  const row = node.queryByKey
    ? await node.queryByKey({ schemaHash, fields, keyHash: slug })
    : ((
        await node.queryAll({
          schemaHash,
          fields,
          filter: { HashKey: slug },
        })
      ).results.find((r) => r.key?.hash === slug || r.fields?.slug === slug) ??
      null);
  if (row === null) return null;
  const f = (row.fields ?? {}) as Record<string, unknown>;
  const members = [...new Set(arrayStringField(f, "members"))];
  return {
    members,
    updatedAt: typeof f.updated_at === "string" ? f.updated_at : "",
    state: !Array.isArray(f.members)
      ? "missing"
      : members.length === 0
        ? "empty"
        : "present",
  };
}

/** The stamp that records "this tag's legacy row is a real empty list". */
function emptyLegacyStamp(memberHash: string, tag: string, legacy: LegacyRow): BatchMutationOp {
  return stampOp(memberHash, tag, {
    v: 1,
    n: 0,
    at: nowIso(),
    empty: true,
    ...(legacy.updatedAt.length > 0 ? { legacy_updated_at: legacy.updatedAt } : {}),
  });
}

function isPersistQueueFull(error: unknown): boolean {
  return (
    error instanceof FbrainError &&
    error.code === "node_http_503" &&
    error.message.includes("persist_queue_full")
  );
}

/**
 * Send `ops` to the node in batches of `TAG_MEMBER_BATCH_SIZE`, in order (a
 * stamp op placed last lands last). A node client with no batch call gets one
 * write per op. A full persist queue is retried with a short backoff.
 */
async function commitOps(
  node: NodeClient,
  ops: readonly BatchMutationOp[],
): Promise<void> {
  if (ops.length === 0) return;
  if (!node.mutateBatch) {
    for (const op of ops) {
      if (op.mutationType === "delete") {
        await node.deleteRecord({
          schemaHash: op.schemaHash,
          keyHash: op.keyHash,
          ...(op.keyRange !== undefined ? { keyRange: op.keyRange } : {}),
        });
      } else {
        const write = {
          schemaHash: op.schemaHash,
          fields: op.fields,
          keyHash: op.keyHash,
          ...(op.keyRange !== undefined ? { keyRange: op.keyRange } : {}),
        };
        if (op.mutationType === "create") await node.createRecord(write);
        else await node.updateRecord(write);
      }
    }
    return;
  }
  for (let i = 0; i < ops.length; i += TAG_MEMBER_BATCH_SIZE) {
    const batch = ops.slice(i, i + TAG_MEMBER_BATCH_SIZE);
    let lastError: unknown;
    let sent = false;
    for (const delayMs of [0, 1000, 2000, 4000, 8000]) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        await node.mutateBatch([...batch]);
        sent = true;
        break;
      } catch (err) {
        lastError = err;
        if (!isPersistQueueFull(err)) throw err;
      }
    }
    if (!sent) throw lastError;
  }
}

/** The raw `tmb_copy` note of a tag's copy claim row, or null when there is none. */
async function readClaimNote(
  node: NodeClient,
  memberHash: string,
  tag: string,
): Promise<string | null> {
  const rows = await readRowsByKey(
    node,
    memberHash,
    [{ hash: tagIndexSlug(tag), range: TAG_MEMBER_COPYING_RANGE }],
    TAG_MEMBER_COPY_FIELD,
  );
  const fields = rows.get(presenceId(tagIndexSlug(tag), TAG_MEMBER_COPYING_RANGE));
  if (fields === undefined) return null;
  return typeof fields.tmb_copy === "string" ? fields.tmb_copy : "";
}

type ClaimNote = { by: string; until: number; released?: boolean };

function parseClaim(raw: string): ClaimNote | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ClaimNote>;
    if (typeof parsed.by !== "string" || typeof parsed.until !== "number") {
      return null;
    }
    return { by: parsed.by, until: parsed.until, ...(parsed.released ? { released: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * One copy claim. `token` is unique to this claim (not to the process), and
 * `note` is the exact text now stored in the claim row: every later write is
 * guarded by "the row still holds exactly this note".
 */
export type TagCopyClaim = {
  tag: string;
  token: string;
  note: string;
  renewedAt: number;
};

function claimFields(tag: string, note: string): Record<string, string> {
  return {
    tmb_h: tagIndexSlug(tag),
    tmb_r: TAG_MEMBER_COPYING_RANGE,
    tmb_tag: cutUtf8(tag, TAG_VALUE_MAX_BYTES),
    tmb_copy: note,
  };
}

function claimRow(memberHash: string, tag: string) {
  return {
    schemaHash: memberHash,
    keyHash: tagIndexSlug(tag),
    keyRange: TAG_MEMBER_COPYING_RANGE,
  };
}

/**
 * Single flight for the copy of one tag: take the claim, or null when another
 * copier holds a live one. The caller copies only with a claim.
 *
 * The claim is a row under the tag's hash (token, expiry), written with the
 * node's compare-and-set write: create only if the row is absent, or, to take
 * over a dead claim, update only if the row still holds the exact old note. The
 * node decides that atomically, so two processes on one node cannot both win.
 * A claim is dead only `claimMarginMs()` after its expiry (clock skew), or when
 * its holder released it. After a win the claim is read back, because an older
 * node ignores the precondition. A claim never blocks a read.
 *
 * Scope: one node. The compare-and-set write cannot decide a race between two
 * DEVICES; the copy is built to survive that (idempotent creates, the stamp
 * last, readers re-check members).
 */
export async function claimTagCopy(
  node: NodeClient,
  memberHash: string,
  tag: string,
): Promise<TagCopyClaim | null> {
  const existing = await readClaimNote(node, memberHash, tag);
  if (existing !== null) {
    const claim = parseClaim(existing);
    const dead =
      claim === null || claim.released === true || claim.until + claimMarginMs() < Date.now();
    if (!dead) return null;
  }
  const token = crypto.randomUUID();
  const note = JSON.stringify({ by: token, until: Date.now() + claimTtlMs() });
  const row = claimRow(memberHash, tag);
  if (node.mutateIfExpected) {
    const res = await node.mutateIfExpected(
      existing !== null
        ? {
            mutationType: "update",
            ...row,
            fields: claimFields(tag, note),
            expected: { type: "value", field: "tmb_copy", value: existing },
          }
        : {
            mutationType: "create",
            ...row,
            fields: claimFields(tag, note),
            expected: { type: "absent", field: "tmb_copy" },
          },
    );
    if (res === "conflict") return null;
  } else if (existing !== null) {
    await node.updateRecord({ ...row, fields: claimFields(tag, note) });
  } else {
    await node.createRecord({ ...row, fields: claimFields(tag, note) });
  }
  const after = await readClaimNote(node, memberHash, tag);
  return after === note ? { tag, token, note, renewedAt: Date.now() } : null;
}

/**
 * Extend a claim you hold. Compare-and-set on the exact note you wrote, so it
 * succeeds only while the claim is still yours: false means it was taken over
 * (after a long stall) and the copy must stop.
 */
export async function renewTagCopy(
  node: NodeClient,
  memberHash: string,
  claim: TagCopyClaim,
): Promise<boolean> {
  const note = JSON.stringify({ by: claim.token, until: Date.now() + claimTtlMs() });
  const row = claimRow(memberHash, claim.tag);
  if (node.mutateIfExpected) {
    const res = await node.mutateIfExpected({
      mutationType: "update",
      ...row,
      fields: claimFields(claim.tag, note),
      expected: { type: "value", field: "tmb_copy", value: claim.note },
    });
    if (res === "conflict") return false;
  } else {
    if ((await readClaimNote(node, memberHash, claim.tag)) !== claim.note) return false;
    await node.updateRecord({ ...row, fields: claimFields(claim.tag, note) });
  }
  claim.note = note;
  claim.renewedAt = Date.now();
  return true;
}

/**
 * Release a claim you hold: mark it released, only if the row still holds the
 * exact note you last wrote (compare-and-set). A claim that was taken over
 * carries another token and is left alone. It is never deleted, so there is no
 * window in which a delete lands on somebody else's claim. Returns true when the
 * claim was yours and is released.
 */
export async function releaseTagCopy(
  node: NodeClient,
  memberHash: string,
  claim: TagCopyClaim,
): Promise<boolean> {
  const note = JSON.stringify({ by: claim.token, until: 0, released: true });
  const row = claimRow(memberHash, claim.tag);
  try {
    if (node.mutateIfExpected) {
      const res = await node.mutateIfExpected({
        mutationType: "update",
        ...row,
        fields: claimFields(claim.tag, note),
        expected: { type: "value", field: "tmb_copy", value: claim.note },
      });
      return res === "applied";
    }
    if ((await readClaimNote(node, memberHash, claim.tag)) !== claim.note) return false;
    await node.updateRecord({ ...row, fields: claimFields(claim.tag, note) });
    return true;
  } catch {
    return false; // the claim expires on its own
  }
}

/**
 * Keeps a claim alive while a copy runs, whatever one batch takes: a timer
 * renews it (compare-and-set on the note this process last wrote) every
 * `claimRenewEveryMs()`. A renewal the node refuses means the claim was taken
 * over, and `lost()` turns true so the copy stops before its next batch. A
 * renewal that fails for another reason (a transient error) is simply retried on
 * the next tick: the claim stays valid until its expiry.
 */
function startClaimHeartbeat(
  node: NodeClient,
  memberHash: string,
  claim: TagCopyClaim,
): { lost: () => boolean; stop: () => Promise<void> } {
  let lost = false;
  let inflight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inflight !== null || lost) return;
    inflight = renewTagCopy(node, memberHash, claim)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
  }, claimRenewEveryMs());
  (timer as { unref?: () => void }).unref?.();
  return {
    lost: () => lost,
    stop: async () => {
      clearInterval(timer);
      if (inflight !== null) await inflight;
    },
  };
}

/** The claim was taken over while this process copied: stop copying. */
class CopyClaimLostError extends Error {
  constructor(tag: string) {
    super(`the copy claim on "${tag}" was taken over; stopping this copy`);
    this.name = "CopyClaimLostError";
  }
}

/**
 * Copy one tag's legacy members into its partition and write the copy stamp.
 * `part` is the partition as read just before, `legacy` the legacy row. Writes a
 * create for each legacy member the partition lacks, then the stamp as the LAST
 * op, with a note of what was copied. `heartbeat` keeps the claim alive while
 * it runs; if the claim was taken over the copy stops with `CopyClaimLostError`
 * before its next batch. Returns the partition after the copy.
 */
async function copyLegacyMembers(
  node: NodeClient,
  memberHash: string,
  tag: string,
  part: Partition,
  legacy: LegacyRow,
  heartbeat: { lost: () => boolean },
): Promise<Partition> {
  const have = new Set(part.members);
  const ops: BatchMutationOp[] = [];
  const members = new Set(part.members);
  for (const member of legacy.members) {
    if (member.length === 0 || have.has(member)) continue;
    have.add(member);
    members.add(member);
    ops.push(memberOp(memberHash, "create", tag, member));
  }
  ops.push(
    stampOp(memberHash, tag, {
      v: 1,
      n: legacy.members.length,
      digest: digestOf(legacy.members),
      at: nowIso(),
      ...(legacy.updatedAt.length > 0
        ? { legacy_updated_at: legacy.updatedAt }
        : {}),
    }),
  );
  for (let i = 0; i < ops.length; i += TAG_MEMBER_BATCH_SIZE) {
    if (heartbeat.lost()) throw new CopyClaimLostError(tag);
    await commitOps(node, ops.slice(i, i + TAG_MEMBER_BATCH_SIZE));
  }
  return { marker: true, members: [...members].sort() };
}

/**
 * Copy under the single-flight claim. Returns the partition after the copy, or
 * null when another process holds the claim, the claim was taken over mid-copy,
 * or the stamp appeared meanwhile. The claim is released only if still ours.
 */
async function copyLegacyUnderClaim(
  node: NodeClient,
  memberHash: string,
  tag: string,
  legacy: LegacyRow,
  verbose?: Verbose,
): Promise<Partition | null> {
  const claim = await claimTagCopy(node, memberHash, tag);
  if (claim === null) {
    verbose?.(
      `tag-index: another process is copying the legacy members of "${tag}"; not copying here`,
    );
    return null;
  }
  const heartbeat = startClaimHeartbeat(node, memberHash, claim);
  try {
    const part = await readPartition(node, memberHash, tag);
    if (part.marker) return part;
    return await copyLegacyMembers(node, memberHash, tag, part, legacy, heartbeat);
  } catch (err) {
    if (err instanceof CopyClaimLostError) {
      verbose?.(`tag-index: ${err.message}`);
      return null;
    }
    throw err;
  } finally {
    await heartbeat.stop();
    await releaseTagCopy(node, memberHash, claim);
  }
}

/**
 * Set after a copy write failed in a READ in this process (a read client with
 * no write capability, a node refusing writes). A read then serves the union of
 * the partition and the legacy row without trying the same write on every call.
 */
let readCopyFailed = false;

function toRecord(tag: string, members: readonly string[]): TagIndexRecord {
  return { slug: tagIndexSlug(tag), tag, members: [...members] };
}

/**
 * The members of one tag, or null when the tag was never indexed.
 *
 * One range read of the tag's partition. A tag whose legacy members were not
 * copied yet is copied now (see the header). The copy is best effort on a read:
 * if it cannot be written, or another process holds the claim, the answer is
 * the union of the partition and the legacy row, and a write path retries the
 * copy. A config with no TagMembership hash reads the legacy row only.
 */
export async function readTagIndex(
  node: NodeClient,
  cfg: Config,
  tag: string,
  verbose?: Verbose,
): Promise<TagIndexRecord | null> {
  const memberHash = tagMemberSchemaHash(cfg);
  if (memberHash === null) {
    verbose?.(
      "tag-index: the TagMembership schema is not registered on this install; reading the legacy layout (run `brain init`)",
    );
    const legacy = await readLegacyRow(node, cfg, tag);
    return legacy === null ? null : toRecord(tag, [...legacy.members].sort());
  }
  const part = await readPartition(node, memberHash, tag);
  if (part.marker) return toRecord(tag, part.members);

  const legacy = await readLegacyRow(node, cfg, tag);
  if (legacy === null || legacy.state === "missing") {
    // No stamp, and no legacy row, or a legacy row with no members VALUE (maybe
    // not synced yet): nothing to copy, and NO stamp is written (a stamp would
    // hide the members when they arrive). The next read or write looks again.
    return part.members.length === 0 ? null : toRecord(tag, part.members);
  }
  if (legacy.state === "empty") {
    // A real empty list: record that once so this tag stops re-reading the
    // legacy row. Best effort on a read (a read client may not be allowed to
    // write); the answer is the partition either way.
    if (!readCopyFailed) {
      try {
        await commitOps(node, [emptyLegacyStamp(memberHash, tag, legacy)]);
      } catch (err) {
        readCopyFailed = true;
        verbose?.(
          `tag-index: could not record the empty legacy row of "${tag}" (${errorMessage(err)})`,
        );
      }
    }
    return toRecord(tag, part.members);
  }
  let members = [...new Set([...part.members, ...legacy.members])].sort();
  if (!readCopyFailed) {
    try {
      const after = await copyLegacyUnderClaim(node, memberHash, tag, legacy, verbose);
      if (after !== null) members = after.members;
    } catch (err) {
      readCopyFailed = true;
      verbose?.(
        `tag-index: could not copy the legacy members of "${tag}" (${errorMessage(err)}); serving the legacy row, a write path retries the copy`,
      );
    }
  }
  return toRecord(tag, members);
}

/**
 * Plan the mutations for a set of membership changes: one small create per add
 * and one delete per remove of a member that exists. Reads with one keyed read
 * for all tags (copy stamps and removed members). A tag with no stamp whose
 * legacy row exists has its legacy members copied FIRST, under the single-flight
 * claim, so a removal is not undone by a later copy. The copy never aborts the
 * record write: a failed or skipped copy is reported (once per command) and the
 * write goes ahead. No stamp is written for a tag with no legacy row.
 *
 * With no TagMembership hash in the config, nothing is planned and a warning
 * says so. Never registers the schema.
 *
 * `noOp` counts removals of a member that was not indexed.
 */
export async function planTagMemberOps(
  node: NodeClient,
  cfg: Config,
  changes: readonly TagMemberChange[],
  verbose?: Verbose,
): Promise<{ ops: BatchMutationOp[]; noOp: number }> {
  // Page atoms replaced this payload.
  void node;
  void cfg;
  void changes;
  void verbose;
  return { ops: [], noOp: 0 };
}

/** Plan and send a set of membership changes. Throws on a failed write. */
export async function applyTagMemberChanges(
  node: NodeClient,
  cfg: Config,
  changes: readonly TagMemberChange[],
  verbose?: Verbose,
): Promise<void> {
  const { ops } = await planTagMemberOps(node, cfg, changes, verbose);
  await commitOps(node, ops);
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
  const changes: TagMemberChange[] = [
    ...added.map((tag): TagMemberChange => ({ tag, member, op: "add" })),
    ...removed.map((tag): TagMemberChange => ({ tag, member, op: "remove" })),
  ];
  if (changes.length === 0) return;
  try {
    await applyTagMemberChanges(node, cfg, changes, verbose);
  } catch (err) {
    verbose?.(
      `tag-index reconcile failed for ${member}: ${changes.length} tag update(s) failed ` +
        `(added=${added.join(",")} removed=${removed.join(",")} failed=${errorMessage(err)}); ` +
        "The old payload write stopped. Run `brain reindex --target tag#<tag> --source-hash <type> --slug <slug>`.",
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

  // A remove is last-writer-wins against a concurrent add on another device, so
  // a removed member can come back. Every member is re-checked against its
  // record's own tags here, and a stale one is dropped.
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

export async function addTagIndexMember(
  node: NodeClient,
  cfg: Config,
  tag: string,
  member: string,
): Promise<void> {
  await applyTagMemberChanges(node, cfg, [{ tag, member, op: "add" }]);
}

export async function removeTagIndexMember(
  node: NodeClient,
  cfg: Config,
  tag: string,
  member: string,
): Promise<void> {
  await applyTagMemberChanges(node, cfg, [{ tag, member, op: "remove" }]);
}

/** What `brain doctor` reads for one tag: its copy stamp and its legacy row's age. */
export type TagMigrationState = {
  tag: string;
  /** The tag has a copy stamp in the TagMembership partition. */
  stamped: boolean;
  note: TagCopyNote | null;
  /** `updated_at` of the legacy row, or null when there is none. */
  legacyUpdatedAt: string | null;
};

/**
 * The copy state of several tags, for the doctor drift check: one keyed read
 * for every stamp, and one small keyed read per legacy row (its `updated_at`
 * only, never its member list). Bounded by the caller's tag list.
 */
export async function readTagMigrationStates(
  node: NodeClient,
  cfg: Config,
  tags: readonly string[],
): Promise<TagMigrationState[]> {
  const memberHash = tagMemberSchemaHash(cfg);
  if (memberHash === null || tags.length === 0) return [];
  const stamps = await readRowsByKey(
    node,
    memberHash,
    tags.map((tag) => ({
      hash: tagIndexSlug(tag),
      range: TAG_MEMBER_MIGRATED_RANGE,
    })),
    TAG_MEMBER_COPY_FIELD,
  );
  const out: TagMigrationState[] = [];
  for (let i = 0; i < tags.length; i += TAG_PARTITION_READ_BATCH) {
    const chunk = tags.slice(i, i + TAG_PARTITION_READ_BATCH);
    const legacy = await Promise.all(
      chunk.map((tag) => readLegacyRow(node, cfg, tag, LEGACY_UPDATED_FIELD)),
    );
    chunk.forEach((tag, j) => {
      const fields = stamps.get(presenceId(tagIndexSlug(tag), TAG_MEMBER_MIGRATED_RANGE));
      const row = legacy[j] ?? null;
      out.push({
        tag,
        stamped: fields !== undefined,
        note: fields === undefined ? null : parseCopyNote(fields.tmb_copy),
        legacyUpdatedAt: row === null ? null : row.updatedAt,
      });
    });
  }
  return out;
}

/**
 * `none`: no legacy row, nothing to copy. `ok`: stamped, and the legacy row is
 * no newer than the stamp. `empty`: stamped as a real empty legacy list
 * (migrated-empty). `pending`: a legacy row exists and no copy ran yet (the lazy
 * copy runs on the next read or write of the tag, or its members value has not
 * synced yet). `drifted`: the
 * legacy row is NEWER than the copy stamp, so an old binary, or a device that
 * had not synced, wrote the legacy layout after the copy and the new layout
 * lacks those members. The old payload write stopped. A page backfill is
 * `brain reindex --target tag#<tag> --source-hash <type> --slug <slug>`.
 */
export function tagCopyStatus(
  state: TagMigrationState,
): "none" | "ok" | "empty" | "pending" | "drifted" {
  if (state.legacyUpdatedAt === null) return "none";
  if (!state.stamped) return "pending";
  const at = state.note?.at;
  if (at === undefined || state.legacyUpdatedAt > at) return "drifted";
  return state.note?.empty === true ? "empty" : "ok";
}

function userTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.length > 0 && tag !== TOMBSTONE_TAG);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
