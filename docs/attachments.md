# File attachments — storage model

**Date:** 2026-07-16
**Commands:** `brain attach` / `brain attachments` / `brain detach` /
`brain attachment get`
**Code:** `src/attachments.ts` (model), `src/commands/attach.ts` (CLI),
`src/schemas.ts` (`attachmentIndexSchema`, `attachmentBlobSchema`)

## What this is

Brain records used to be text-only: PDFs, images, and other artifacts lived
outside the brain with informal text-path "pointers". Attachments put the
actual bytes in the brain — content-addressed, cloud-synced with the node's
data, and **excluded from every search index by construction**.

## The two internal schemas

Both are internal support schemas like `TagIndex` — registered by
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

Entry shape inside `attachments_json`:

```json
{
  "name": "operating-agreement.pdf",
  "blob_ref": "sha256:<64 hex>",
  "size": 613626,
  "media_type": "application/pdf",
  "added_at": "2026-07-16T21:00:00.000Z"
}
```

### `BrainAttachmentBlob` — one record per unique content hash

| Field | Type | Indexed? | Notes |
|---|---|---|---|
| `content_hash` | String | no | SHA-256 hex of raw bytes (hash key) |
| `size` | String | no | raw byte length |
| `media_type` | String | no | inferred from extension at attach time |
| `data` | String | **no (`no_index`,`binary`)** | base64 bytes |
| `created_at` | String | no | RFC 3339 |

## Why NOT a field on the 10 knowledge schemas

fold_db identity-hashes a schema by its name + field set, and records pin to
their schema hash at write time. Adding an `attachments` field to the existing
schemas would mint 10 new hashes and require re-putting **every record in the
brain** under the new hashes (`migrate --add-field`, the G15 playbook), with
the old copies orphaned forever in an append-only store. Two dedicated
schemas get the same user-visible feature with zero migration, zero risk to
the live primary, and a natural CAS dedup boundary. This satisfies the
"additive/optional" schema requirement in the strongest possible sense: the
knowledge schemas are not touched at all.

## Search-exclusion guarantees (three layers)

1. **Node native index (BM25 + vector):** when a schema declares
   `field_classifications`, fold_db's mutation manager indexes only fields
   classified `word` and never fields classified `secret`/`no_index`
   (`searchable_native_index_fields` in
   `fold_db/crates/core/src/fold_db_core/mutation_manager/helpers.rs`). Every
   attachment field except `filenames` is `no_index`; `data` is additionally
   `binary` with `data_domain: "binary"`. This mirrors the LastSecrets
   `secret_value` policy and lastgit's `LastgitPackBlob.data`.
2. **Brain local BM25:** the CLI's own BM25 corpus is built exclusively from
   knowledge-record `title + body` across `RECORD_TYPES`
   (`src/retrieval/bm25.ts`); internal schemas never enter it.
3. **Read surfaces:** `get`/`list`/`ask` only read the 10 record types, so
   blob base64 can't leak through result payloads either.

Searchable on purpose: the filename (via `filenames`, classified `word`), so
"where is the operating agreement" can find the carrying record.

## Storage plane: today and later

Mini/lastdbd currently has **no app-blob CAS routes** — `PUT/GET
/api/app/blob/cas/sha256/{hash}` are structurally absent (content-free 404;
`lastdb_node/src/exec.rs`). v1 therefore stores base64 bytes in the
`BrainAttachmentBlob` record — the same documented stand-in lastgit uses for
pack bytes — which means attachment bytes ride cloud sync **as database
bytes** today.

The fold-side design contract
(`fold/docs/designs/cloud-file-blobs-on-demand-sync.md`, P0 merged
2026-07-16) defines the real file-blob plane: seal with a per-blob DEK,
upload to B2 `{scope}/cas/sha256/*` (metered as `file_reference_bytes` —
this is what makes `lastdb cloud status` report `files > 0`), and store a
`$lastdb_file` pointer. When its P1/P2 land in the node
(kanban `file-blobs-ingest-upload-pointer`), swap the storage inside
`src/attachments.ts` (`putAttachmentBlob`/`getAttachmentBlob`): write the
bytes through the node's blob/pointer API, keep `attachments_json` entries as
the stable metadata surface, and backfill existing blob records with a
one-shot re-upload. The CLI verbs, index schema, and entry shape do not
change.

## Semantics quick reference

- Attach same name + same content → idempotent no-op (`deduplicated`).
- Attach same name + different content → error; `--force` replaces the entry.
- Attach different name + same content → new entry, blob stored once (CAS).
- Detach → removes the index entry only; the blob record remains (append-only
  store; other records may reference the same content).
- `attachment get` → decodes, re-hashes, and hard-fails on mismatch
  (`attachment_integrity_error`) — corrupt bytes are never written silently.
- Per-file cap: 32 MiB raw (UDS transport caps bodies at 64 MiB; base64 is
  4/3 + JSON overhead).
- Zero-byte files are rejected.

## Validation

Unit: `test/unit/attachments.test.ts` (round-trip byte-identity, CAS dedup,
force-replace, detach, integrity failure, size caps, classification
assertions).

E2E (run against an isolated node first, then the live primary): attach two
real PDFs to a record, `attachments` lists both, `attachment get` round-trips
byte-identical (`shasum -a 256` equal), and a `brain search`/`ask` for
distinctive strings of the PDF body returns no attachment payloads while a
filename search still finds the carrying record.
