# Body spill: long record text lives in a local file blob

**Date:** 2026-10-12
**Command:** `brain spill <slug> [--type T]`
**Code:** `src/body-spill.ts` (model, write funnel, read funnel),
`src/record.ts` (`findBySlugRaw`, `writeRecordFields`),
`src/resident-write-plan.ts` (plan write), `src/commands/spill.ts` (CLI),
`src/schemas.ts` (`bodyFileSchema`)

## Why

A LastDB atom is one field value of one record. The node refuses an atom above
64 KiB (`413 atom_content_too_large`). Brain bodies reached 334 KB. A routine
that appends to a log record rewrote the whole text on every write, and the
record list, the lifecycle rows, the child-task row and the papercut status row
each copied the whole record again.

Rule: an atom stays small. Long text goes to a file blob.

## The layout

| Part | What it holds |
|---|---|
| Knowledge record (11 schemas, unchanged) | The first 24 KiB of the text, then `\n\n`, then one marker line |
| `BrainBodyFile` sidecar record (new internal schema) | One record per (record type, slug, field). `file` (type `Any`) holds the `$lastdb_file` pointer as the WHOLE value |
| Local blob (`cas_blobs` plane) | The full text, sealed by the node |

The marker is always the last line:

```
<!-- brain-body-file v1 field=body sha256=<64 hex> bytes=<n> head=<16 hex> -->
```

`sha256` and `bytes` describe the full text. `head` is the first 16 hex chars of
the sha256 of the inline head, so an edited head is detected.

`BrainBodyFile` fields: `file_key` (hash key, `__bodyfile__<sha256(type:slug:field)>`),
`record_type`, `record_slug`, `record_field`, `content_hash`, `size`, `file`,
`created_at`, `updated_at`. All are classified `no_index`. No field is added to
the 11 knowledge schemas: that would give each a new hash and re-put every record.

Fields that can spill: `body` of every type. A papercut also spills
`verified_by` (a live-check transcript by design) and `fixed_by`. A papercut
close appends its evidence block to `body`, so evidence is covered. Every other
field is only size-guarded.

## Write path (one funnel)

`sealRecordFields` in `src/body-spill.ts` is the only place that spills.

1. Spill a field when its serialized size (`Buffer.byteLength(JSON.stringify(v))`)
   is above 32 KiB. Also spill when the index copy of the record would pass
   44 KiB: index rows hold the record as JSON inside a JSON string, so escapes
   grow it.
2. Cut the head at 24 KiB on a UTF-8 and line boundary. The head shrinks when the
   index copy would still pass 44 KiB.
3. Order: blob (`POST /api/db/put-blob-local`, owner socket, no cloud), read the
   blob back and verify sha256, sidecar record (one small write), then the
   record.
4. If a sidecar with the same text hash exists, nothing is written. A record
   whose body did not change costs one sidecar read.
5. Refuse a blob above 16 MiB with a clear error.
6. Guard: any field above 48 KiB serialized throws `record_field_too_large`
   before the node sees it. `commitResidentWritePlan` applies the same guard to
   every index row (tag and backlink rows are skipped: they hold a growing
   member list, which is a separate change).

Callers of the funnel: `buildResidentWritePlan` (put, new, status, papercut
file/close/set) and `writeRecordFields` (append, tag, link, gate, migrate).
`--verbose` prints `body-spill: <type> <slug> field=<f> bytes=<n> head=<n>` on
stderr for every spill, so the large writers can be named.

## Read path (one funnel)

`findBySlugRaw` hydrates. `findBySlug` and `resolveBySlug` call it, so `get`,
`append`, `put` (and its shrink guard, which compares FULL bodies), `status`,
`tag`, `link`, `delete` and the MCP tools see the FULL text. Hydration reads the
sidecar, checks its hash against the marker, fetches the blob
(`POST /api/db/fetch-file-blob`), and checks sha256 and size. A mismatch is a
hard error. `consolidate` hydrates members it read from index rows.

List, search, `ask`, BM25 and the index snapshots read the inline head. They are
approximate on purpose.

A write that does not touch the body (`tag`, `link`, `status`) hydrates first
and writes the same text back. The funnel finds the sidecar unchanged and writes
no blob. The stored record keeps the same marker.

A writer that read the head only (the admin `reindex` family) writes back the
same head and marker. The marker passes through after the funnel checks that the
sidecar exists and the head hash still matches. A marker that is not the last
line, or a head that was edited, is refused with a clear error.

## Legacy records

A record already above 64 KiB stays readable. Nothing scans a schema to migrate
it. It spills the next time anything writes it. `brain spill <slug>` spills one
known record now: point read, spill, read back, proof of identical text. Output
names the slug, the full text size, and the stored size before and after.

## Limits and risks

- The blob plane is local. Nothing uploads a local blob to the cloud object
  store. Another device that syncs the records has the head and the sidecar but
  not the bytes, and a read there fails with `body_spill_blob_missing`. The
  whole-node backup includes `cas_blobs`.
- Old blobs become unreferenced after an append. `lastdb db gc-file-blobs`
  reclaims them after its 600 s grace window.
- The schema must be registered. `brain init` declares `BrainBodyFile`; a write
  that needs it declares it lazily and saves the hash to config.
- An older `brain` binary sees only the head and marker of a spilled record.
  Upgrade every brain caller together.
- `reindex --backlinks` and `--tags` rebuild from the stored head, so links that
  sit past the head are not seen by a rebuild. `reconcileGraphEdges` leaves the
  edges of a head-only body alone. A rebuild that hydrates is a follow-up in
  `src/commands/reindex.ts`.
- `papercut list --body-resolved` and the other list readers match the inline
  head. A closure stamp that sits past the first 24 KiB of a spilled papercut is
  not seen there. `brain get` returns the full text.
- Each write of a changed long text stores a new full blob. A log record that
  grows by append stores one blob per append until `gc-file-blobs` reclaims the
  old ones.
- Deleting a record leaves its sidecar and blob. A later `gc-file-blobs` cannot
  reclaim them while the sidecar exists.

## Validation

Run on a fresh empty home with the default 64 KiB limit (see the PR):

- unmodified main: a 300 KB `put` fails with 413 and logs `lastdb::atom_size`
- this change: the same `put` succeeds, `get` returns identical bytes, ten 3 KB
  appends keep the text identical, a 150 KB papercut and a papercut close with
  a 100 KB `verified_by` read back identical, `tag`, `status`, `link` and
  re-`put` keep the text, MCP put/append/get agree, `brain spill` spills a legacy
  record, and the node log has zero `lastdb::atom_size` lines
- largest live atom on the node: 42,146 bytes; none above 64 KiB
