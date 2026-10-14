# Tag and backlink membership layout

Applies to brain from PR 466. Code: `src/tag-index.ts`, `src/backlink-index.ts`,
`src/index-payload.ts`, `src/commands/doctor/tag-index.ts`.

## Layout

Tag membership and backlink membership use one schema,
`TagMembership_hashrange_v1` (config key `__tagmember__`).

- Hash `tmb_h`: `__tagidx__<sha256(tag)>`. A backlink target uses the tag
  `__fbrain_backlink__:<target slug>`.
- Range `tmb_r`: the member key `type:slug`.
- One small row per (tag, member). Adding a member is one create. Removing a
  member is one delete. A read is one range query under the hash.
- Two reserved ranges sit under the same hash: `__tmb_migrated__` (the copy
  stamp) and `__tmb_copying__` (a short-lived copy claim). Both carry a small
  JSON note in `tmb_copy`.

The old layout (`TagIndex`, `members: string[]`, one row per tag) is read, never
written. Its rows are never deleted or rewritten. The old layout is the reason
for the change: one atom held every member of a tag.

## Registration

Only `brain init` registers the schema. No write path and no `reindex` command
registers it. The node registers a new schema in the Schema Service of its own
environment (`FOLD_SCHEMA_SERVICE_URL` or the node environment), not the one
named in brain's config, so a registration from a write path on a dev run could
land in prod.

A config with no TagMembership hash:

- reads the legacy layout (read only; `--verbose` says so);
- skips every tag and backlink write, with one warning line on stderr per
  command;
- fails `brain doctor` (check `tag-index`);
- makes `brain reindex --tags` and `--backlinks` stop and say to run
  `brain init`.

## Copy of the legacy members (lazy, per tag)

1. Read the tag partition. A copy stamp (`__tmb_migrated__`) means the legacy
   members were copied: serve the partition.
2. No stamp: read the legacy row. If the row exists, copy its members in
   batches of 128 and write the stamp last. The stamp note holds the count, a
   digest of the copied members, the time, and the legacy row's `updated_at`.
   The member rows are the list of what was copied; the stamp does not repeat
   the list (a list in one atom is the defect this layout removes).
3. No stamp and no legacy row, or a legacy row with no `members` VALUE: write NO
   stamp. A device that has not synced the legacy row (or its `members` atom)
   yet reads nothing, and a stamp written then would hide the members for good
   when they arrive. A first add writes only its member row. Tags that never had
   a legacy row cost one extra keyed read (a miss) per read.
   A legacy row whose `members` is a real EMPTY list (a tag that lost all its
   members) is different: there is nothing to copy, and it is recorded ONCE as a
   stamp with `empty: true`, so the tag stops re-reading the legacy row.
   `brain doctor` shows it as migrated-empty.
4. Single flight: a copy first takes a claim, a row written with the node's
   compare-and-set write (create if absent, or take over a dead claim only if the
   row still holds the exact old note). The claim carries a token that is unique
   to that claim. While it copies, the process renews the claim (compare-and-set
   on its own note, at least every minute) so a copy that outlives the expiry
   (5 minutes) keeps it; if the renewal is refused the claim was taken over and
   the copy stops. The claim is released only while it still holds the process's
   own note (compare-and-set), never deleted. A claim counts as dead only after
   its expiry plus a margin (clock skew), or when it was released. The claim
   never blocks a read. `BRAIN_TAG_COPY_CLAIM_TTL_MS` shortens the expiry (at
   least 1000).
5. A failed or skipped copy never aborts a record write. The write goes ahead,
   one warning line is printed, and the copy is retried on the next read or
   write of the tag.

A tag with legacy members costs one copy: for the 158 KB hot tag on the primary
(about 2,400 members) that is about 2,400 creates, measured at 25-30 ms each on
a loaded node, so about a minute once.

## Rollout

After a tag has a stamp, an OLD binary (an old CLI, `brain-mcp`, a routine, a
second device) still writes only the legacy row, and the new code never reads
it again. Old readers do the reverse: they miss every record written by new
code. So:

1. Replace every binary on every device (CLI, `brain-mcp`, routine hosts).
2. Run `brain init` once where the schema is not registered.
3. Run `brain reindex --tags` and `brain reindex --backlinks`.

`brain doctor` samples tags from a small slice of the type-list index and
reports a tag whose legacy row is newer than its copy stamp (check
`tag-index`). It is a sample, not a census.

## Admin operations and multi-device

- `brain reindex --tags` and `--backlinks` rebuild the layout from the records.
  They are admin operations for a quiet moment, on one device at a time. They
  delete rows that no record backs, so a member that another device added after
  the run read the records can be deleted.
- A remove is last-writer-wins against a concurrent add of the same member, so a
  removed member can come back. `list --tag`, `backlinks` and `linked_from`
  re-check each member against its record (the record's tags, or its links) and
  drop a stale one.
- Two devices that add different members of one tag write different rows.
  Nothing conflicts.
- Nothing deletes or rewrites a legacy row.

## Index payloads

Index rows that keep a snapshot of the record (`RecordListEntry`, `LiveIndex`
and its siblings, `ChildTaskIndex`, `PapercutStatusIndex`) follow one rule
(`src/index-payload.ts`). The payload is the whole record when its atom is at
most 8 KiB. Otherwise, until it fits: the body is cut to a head of at most 2 KiB
(then smaller); every other text field above 2 KiB is cut to 2 KiB (then 512
bytes); last, only the keys and summary fields (slug, status, timestamps, a
short title, a bounded list of short tags). `idx_truncated` (`psi_truncated` for
papercuts) names the cut fields (`*` for keys only). The payload is always
bounded. Short titles, ids and tags are never cut.

A keys-only row keeps at most 2 KiB of short tags (the tombstone tag is always
kept), so its key is marked `tagsCut`. A `--tag` filter or count over keys
completes those keys first (`completeKeyTags`, one batched product read), and
`matchesListKeyFilters` refuses to match a tag against a cut key, so a count never
excludes such a record.

A cut snapshot is not a record, and the types enforce it. A reader gets an
`IndexSnapshot`: a whole record, or a `SnapshotSummary` that has no `body` and is
not assignable to `FbrainRecord`. To get the record, complete it with a keyed
read of the product schema (`completeSnapshots`, `readFullRecords` in
`record.ts`). That read retries an empty answer (a known flake) and then THROWS
`index_row_incomplete` or skips; it never returns the head as if it were the
record. What happens when a cut row's product record is missing is chosen by the
caller, with no default (`onMissing`):

- `"skip"` for READ and DISPLAY paths (`list`, `search`, `ask`, the BM25 build,
  the child-task display lookup). The row is a stale index row (a native LastDB
  delete leaves its list row behind). It is left out, ONE warning per command
  names the count and the first slug, and every other row is served.
- `"throw"` for REBUILD and DESTRUCTIVE paths (`reindex --graph-edges`, the
  backlink rebuild, `consolidate`). They stop with `index_row_incomplete` and
  change nothing.

Callers that read no body ask for summaries (`listRecords(..., { summary: true
})`). `admin-snapshot` only counts, so it reads summaries; a type it cannot read
is recorded as `null` in `type_counts` and named in `unavailable_types`, never
reported as 0.

`brain consolidate` compares bodies and can delete a record. It uses the cluster
snapshot only to name the members, and point-reads the body of every member from
the product schema; if one cannot be read it stops and changes nothing.

`papercut list` and `papercut census` print only fields the papercut snapshot
keeps whole; the reader (`needFields`) point-reads a row only when a needed
field is cut. A fast papercut read returns `SnapshotSummary` rows; the
`--body-resolved` filter refuses a row that has no body.

Existing oversize rows stay until the row is next written, or until the matching
`reindex` command runs.

## TTL

None is planned for tag members. The range key is `type:slug`; a time prefix
would break removing a member by its member key. Tag membership is state, not a
log.
