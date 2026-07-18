# File attachments — storage model

**Date:** 2026-07-16 (v1, record-stored bytes) · 2026-07-17 (v2, file-blob plane)
**Commands:** `brain attach` / `brain attachments` / `brain detach` /
`brain attachment get` / `brain attachments migrate`
**Code:** `src/attachments.ts` (model), `src/commands/attach.ts` (CLI),
`src/schemas.ts` (`attachmentIndexSchema`, `attachmentFileSchema`,
legacy `attachmentBlobSchema`)

## What this is

Brain records used to be text-only: PDFs, images, and other artifacts lived
outside the brain with informal text-path "pointers". Attachments put the
actual bytes in the brain — content-addressed, cloud-synced, and **excluded
from every search index by construction**. Since v2 the bytes live in the
node's **file-blob plane**: encrypted CAS blobs in B2 cloud file storage
(`{scope}/cas/sha256/…`, metered as `file_reference_bytes`), with only a
`$lastdb_file` pointer record in the DB.

## The internal schemas

All are internal support schemas like `TagIndex` — registered by
`brain init` (or declared lazily on first `attach`), never surfaced by
`get`/`list`/`search`, and NOT record types.

### `BrainAttachmentIndex` — one record per (record_type, record_slug)

| Field | Type | Indexed? | Notes |
|---|---|---|---|
| `slug` | String | no | `__attidx__<sha256(type:slug)>` (hash key) |
| `record_type` | String | no | owning record's type |
| `record_slug` | String | no | owning record's slug |
| `filenames` | Array\<String\> | **word** | the ONLY searchable attachment surface |
| `attachments_json` | String | no | JSON array of entries (below) |
| `created_at` / `updated_at` | String | no | RFC 3339 |

Entry shape inside `attachments_json` (unchanged from v1):

```json
{
  "name": "operating-agreement.pdf",
  "blob_ref": "sha256:<64 hex>",
  "size": 613626,
  "media_type": "application/pdf",
  "added_at": "2026-07-16T21:00:00.000Z"
}
```

### `BrainAttachmentFile` — one pointer record per unique content hash (v2)

| Field | Type | Indexed? | Notes |
|---|---|---|---|
| `content_hash` | String | no | SHA-256 hex of raw bytes (hash key) |
| `size` | String | no | raw byte length |
| `media_type` | String | no | inferred from extension at attach time |
| `file` | Any | no | `$lastdb_file` pointer written by the node's file-blob plane |
| `created_at` | String | no | RFC 3339 |

The raw bytes are NOT in this record. `putAttachmentBlob` POSTs
`/api/db/file-blob` on the node's owner socket: the node seals the bytes with
a per-blob DEK, uploads the ciphertext to B2 under `{scope}/cas/sha256/…`
(metered as file bytes — `lastdb cloud status` reports them under `files`),
persists the returned `$lastdb_file` pointer (blob_ref, file_hash,
cipher_suite, dek, encrypted_size_bytes) into `file`, and seeds the local CAS
cache so the attaching device round-trips without a download. Reads resolve
the pointer with `POST /api/db/fetch-file-blob` (local cache first, then one
explicit B2 GET) and are sha256-verified in `getAttachmentBlob` before any
byte is handed back. Design contract:
`fold/docs/designs/cloud-file-blobs-on-demand-sync.md`.

### `BrainAttachmentBlob` — LEGACY v1 stand-in

v1 stored base64 bytes in a `no_index`/`binary` record field (`data`),
riding cloud sync as **database** bytes. Nothing writes this schema anymore;
`getAttachmentBlob` still falls back to it for unmigrated content, and it
stays registered so migration can read it.

## Migration: `brain attachments migrate [<slug>]`

Moves v1 record-stored blobs into the file plane and deletes the legacy
stand-in records. Scoped to one record when a slug is given, otherwise sweeps
every attachment index. Per unique blob: read the legacy record,
**sha256-verify before upload** (a corrupt legacy blob is a hard error, never
laundered into the file plane), upload through `/api/db/file-blob`, then
delete the legacy record. Idempotent — blobs already in the file plane are
skipped, and their legacy records are still cleaned up if present. Index
entries do not change (the `blob_ref` is the same content hash in both
worlds).

## Why NOT a field on the 10 knowledge schemas

fold_db identity-hashes a schema by its name + field set, and records pin to
their schema hash at write time. Adding an `attachments` field to the existing
schemas would mint 10 new hashes and require re-putting **every record in the
brain** under the new hashes (`migrate --add-field`, the G15 playbook), with
the old copies orphaned forever in an append-only store. Dedicated internal
schemas get the same user-visible feature with zero migration, zero risk to
the live primary, and a natural CAS dedup boundary. The knowledge schemas are
not touched at all.

## Search-exclusion guarantees (three layers)

1. **Node native index (BM25 + vector):** when a schema declares
   `field_classifications`, fold_db's mutation manager indexes only fields
   classified `word` and never fields classified `secret`/`no_index`
   (`searchable_native_index_fields` in
   `fold_db/crates/core/src/fold_db_core/mutation_manager/helpers.rs`). Every
   attachment field except `filenames` is `no_index`; in v2 the indexed
   surface shrinks further — the DB carries only pointer metadata, the
   content bytes never enter the DB at all.
2. **Brain local BM25:** the CLI's own BM25 corpus is built exclusively from
   knowledge-record `title + body` across `RECORD_TYPES`
   (`src/retrieval/bm25.ts`); internal schemas never enter it.
3. **Read surfaces:** `get`/`list`/`ask` only read the 10 record types, so
   neither pointers nor bytes can leak through result payloads either.

Searchable on purpose: the filename (via `filenames`, classified `word`), so
"where is the operating agreement" can find the carrying record.

## Semantics quick reference

- Attach same name + same content → idempotent no-op (`deduplicated`).
- Attach same name + different content → error; `--force` replaces the entry.
- Attach different name + same content → new entry, blob stored once (CAS).
- Detach → removes the index entry only; the pointer record and CAS blob
  remain (append-only store; other records may reference the same content).
- `attachment get` → fetches via the pointer, re-hashes, and hard-fails on
  mismatch (`attachment_integrity_error`) — corrupt bytes are never written
  silently. Unmigrated v1 blobs are still readable (legacy fallback).
- Node without cloud-sync support (501) or without cloud sync configured
  (409) → clear `attachment_file_plane_unavailable` error; attachments
  require the file plane.
- Per-file cap: 32 MiB raw (UDS transport caps bodies at 64 MiB; base64 is
  4/3 + JSON overhead).
- Zero-byte files are rejected.

## Validation

Unit: `test/unit/attachments.test.ts` (file-plane round-trip byte-identity,
CAS dedup, force-replace, detach, integrity failure, CAS-miss 404 mapping,
legacy fallback, migration incl. idempotency/scoping/corruption, size caps,
classification assertions).

E2E (run against the live primary): attach/migrate two real PDFs on a record,
`attachments` lists both, `attachment get` round-trips byte-identical
(`shasum -a 256` equal), `lastdb cloud status` shows the bytes under
**files** (`file_reference_bytes > 0`), the B2 bucket holds
`{scope}/cas/sha256/…` objects, and a `brain search`/`ask` for distinctive
strings of the PDF body returns no attachment payloads while a filename
search still finds the carrying record.
