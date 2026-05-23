# fbrain Phase 5 delete spike — fold_db append-only delete

**Date:** 2026-05-23
**Spike duration:** ~30min (probes + source read)
**fold_db ref:** `/Users/tomtang/code/edgevector/fold` (the same monorepo Phase 0–3 used)
**Targeted node:** the existing local node at `http://127.0.0.1:9101`
**Trigger:** orchestrator's 2026-05-23 smoketest dismissed a delete-returned-200-but-get-still-finds-it observation as "fold_db caching"; this spike re-opens it and root-causes it before shipping a CLI delete.

## **VERDICT: SOFT-DELETE WORKAROUND (fold_db is append-only)**

`POST /api/mutation` with `mutation_type=delete` is not a hard delete and never has been. fold_db's atom store is append-only at every layer; the delete mutation only writes a sync-log marker and the molecule's hash → atom_uuid mapping is left intact, so every subsequent query path (`/api/query`, `/api/native-index/search`) continues to surface the record exactly as before. This is **documented behavior in fold_db's own source**, not a regression — see the references below.

The orchestrator was therefore right that "the delete returned 200" — it did, and the server-side behavior was the documented one — and wrong that the contradiction was a caching artifact. There is no cache to invalidate; the record is still on disk.

For fbrain, this means a "real" `fbrain delete <slug>` cannot rely on fold_db to remove anything. The CLI must implement a soft-delete workaround at the fbrain layer that:

1. Overwrites every user-visible field with sentinel/empty values via an `update` mutation.
2. Marks the record with a tombstone tag (`__fbrain_deleted__`) so all fbrain read paths can filter it out at the client layer.
3. Also fires the fold_db `mutation_type=delete` for symbolic intent and to populate the sync-log marker (forward-compat — see "Follow-up to file" below).
4. Verifies post-delete by reading the record back and asserting the tombstone tag is present.

The result: `fbrain get`, `fbrain list`, `fbrain status`, `fbrain link`, and `fbrain search` all behave as if the record were gone (because all of them resolve through `findBySlug` / `listRecords`, and those filter tombstoned records). Re-creating the same slug with `fbrain design new <slug>` (no `--force`) works because the tombstone makes the slug "look free" to the duplicate-check.

The slug itself, the molecule, the prior atoms, and the per-mutation sync-log entries are all retained on disk. fbrain doesn't pretend otherwise — the `deleted <type> <slug>` success line names this as a soft-delete and points back to this doc.

## Reproduced behavior

Two delete-mutation bodies were probed against an existing fbrain-registered Design (`spike-delete-probe-1`, `body: "indexed body content for the spike"`).

### Probe A — orchestrator's exact body (with `fields_and_values: {slug: …}`)

```bash
curl -s -X POST http://127.0.0.1:9101/api/mutation \
  -H "Content-Type: application/json" \
  -H "X-User-Hash: $USER_HASH" \
  -d '{"type":"mutation","schema":"<design hash>","mutation_type":"delete","fields_and_values":{"slug":"spike-delete-probe-1"},"key_value":{"hash":"spike-delete-probe-1","range":null}}'
```

**Response:** `{"ok":true,"mutation_id":"abb32da0…","success":true}`

**Immediate `fbrain get spike-delete-probe-1 --type design`:** record returns in full, unchanged. `fbrain list --type design` includes it; `fbrain search "spike body content"` still hits it with the same score it had pre-delete.

This body also has the side-effect of *writing* an atom whose payload is the slug string itself, then pointing the molecule's slug-field at that atom. So calling this body actually rewrites the slug field with the slug value — visibly a no-op, but it does generate an extra atom on storage.

### Probe B — minimal body (`fields_and_values: {}`)

```bash
curl -s -X POST http://127.0.0.1:9101/api/mutation \
  -H "Content-Type: application/json" \
  -H "X-User-Hash: $USER_HASH" \
  -d '{"type":"mutation","schema":"<design hash>","mutation_type":"delete","fields_and_values":{},"key_value":{"hash":"spike-delete-probe-1","range":null}}'
```

**Response:** `{"ok":true,"mutation_id":"88f64116…","success":true}`

**Immediate `fbrain get spike-delete-probe-1 --type design`:** record still returns in full, unchanged. Identical observable outcome to Probe A, but without the spurious slug-field rewrite (since no fields were supplied, the per-field atom-build loop iterates zero times).

**Conclusion from probes A + B:** the delete mutation is essentially a no-op at the read-path. The only difference between the two bodies is that the orchestrator's body costs an extra atom write for no benefit. fbrain should use Probe B's body if it fires the delete at all.

### Probe C — soft-delete workaround via UPDATE

```bash
curl -s -X POST http://127.0.0.1:9101/api/mutation \
  -d '{"type":"mutation","schema":"<design hash>","mutation_type":"update","fields_and_values":{"slug":"spike-delete-probe-1","title":"(deleted)","body":"","status":"archived","tags":["__fbrain_deleted__"],"created_at":"<preserved>","updated_at":"<now>"},"key_value":{"hash":"spike-delete-probe-1","range":null}}'
```

**Response:** `{"ok":true,"mutation_id":"c1a74c24…","success":true}`

**Immediate `fbrain get spike-delete-probe-1 --type design`:**
```
[design] spike-delete-probe-1
title:      (deleted)
status:     archived
tags:       __fbrain_deleted__
created_at: 2026-05-23T22:51:56.767Z
updated_at: 2026-05-23T22:55:12.000Z
```

The record's content is fully wiped. The tombstone tag is observable from the client side, which is exactly what fbrain needs to filter on.

### Probe D — re-create after wipe

```bash
fbrain design new spike-delete-probe-1 --title "after re-create" --body "fresh content" --force
fbrain get spike-delete-probe-1 --type design
# → [design] spike-delete-probe-1
#   title:      after re-create
#   status:     draft
#   tags:       (none)
#   …
#   fresh content
```

After the wipe-via-update, the slug is reusable: fold_db's `set_atom_uuid` just rebinds the molecule's hash → atom_uuid mapping to the newly-created atom. (The current `--force` is needed because `findBySlug` doesn't yet treat tombstoned records as gone — once fbrain's `findBySlug` filters tombstones, re-creating without `--force` will also work.)

## fold_db source references (why this is documented behavior)

1. **`fold_db_node/src/fold_node/migrations/apple_consolidation.rs:25-27`** — the canonical statement of intent:
   > **Originals are not removed.** fold_db's mutation pipeline is append-only: `MutationType::Delete` writes a sync-log marker and shows up in trigger retention semantics, but it does NOT remove molecule entries on local storage. Trying to scrub the fragmented records would therefore be a no-op at the storage layer while creating false confidence at the API layer.

2. **`fold_db_node/tests/apple_consolidation_migration_test.rs:23-26`** — same statement from a test docstring:
   > fold_db is append-only and `MutationType::Delete` doesn't actually remove molecule entries, so the migration only consolidates forward; the canonical schema becomes the source of truth and the legacy schemas hold a strict subset.

3. **`fold_db/crates/core/src/fold_db_core/mutation_manager.rs:598-622`** (`prepare_atoms_and_key_values`) — the per-mutation atom-build loop iterates over `mutation.fields_and_values` only. A Delete with empty `fields_and_values` produces zero atoms; the rest of the pipeline (`apply_mutations_to_molecules`, `write_mutation`) has nothing to operate on for that mutation. The `mutation_type` is propagated down to `MutationEvent` (trigger semantics) but it never reaches the atom store as a delete-of-prior-atoms instruction.

4. **`fold_db/crates/core/src/schema/types/field/hash_field.rs:63-114`** (`HashField::write_mutation`) — this is the only write path for Hash-keyed schemas. It calls `molecule.set_atom_uuid(hash_key, atom_uuid, signer)` for whatever atoms the caller supplied. It does not branch on `mutation_type`, does not remove existing entries, and has no "delete this hash key" path.

5. **`fold_db_node/src/handlers/mutation.rs:41-111`** — the HTTP `/api/mutation` handler just forwards `(schema, fields_and_values, key_value, mutation_type)` to `OperationProcessor::execute_mutation_op_with_access`, which forwards to `MutationManager::write_mutations_with_access`. The trip from HTTP boundary to atom store carries the `mutation_type` but no special-cased "tear-down" branch ever triggers.

6. **`fold_db/crates/core/src/fold_db_core/trigger_runner.rs:4061-4117`** — `MutationType::Delete` is consumed exclusively by trigger eviction logic (downstream view eviction, sync-log semantics). It is not consumed by the read path or the on-disk atom store.

So the contradiction the orchestrator saw was not eventual consistency, not a cache, not a malformed body — it was the literal documented design. The delete mutation is, today, a synchronous write of a sync-log marker; it makes no claim about removing what came before.

## What the fbrain delete CLI does (Phase 5 implementation contract)

```
fbrain delete <slug> [--type design|task]
```

1. **Resolve `--type`** the same way `fbrain get` does (probe both schemas if omitted; error on ambiguous slug; error with "No <type>: <slug>" if absent).
2. **Build a soft-delete update** with these fields, using the freshly-read record so `created_at` is preserved:
   - `title = "(deleted)"`
   - `body = ""`
   - `status = "archived"` (design) or `"cancelled"` (task) — both already exist in the per-type enum, no schema change needed
   - `tags = ["__fbrain_deleted__"]` (the tombstone sentinel — exported from `src/record.ts` so test code references it directly)
   - `design_slug = ""` (task only)
   - `updated_at = nowIso()`
3. **Fire the update** via `node.updateRecord({ schemaHash, fields, keyHash: slug })`.
4. **Fire the fold_db delete mutation** via `node.deleteRecord({ schemaHash, keyHash: slug })`, where `deleteRecord` is fixed to send `fields_and_values: {}` (Probe B's minimal body — no spurious slug-field write). Forward-compatibility: when fold_db ever grows a real delete, this call starts mattering and fbrain's behavior stays correct.
5. **Verify** by re-reading the record raw (a new `findBySlugRaw` that bypasses the tombstone filter) and asserting `tags.includes("__fbrain_deleted__")`. If verification fails, throw `FbrainError{code: "delete_not_applied"}` with a hint to re-run with `--verbose` and check the node log.
6. **Print** the result honestly:
   ```
   deleted <type> <slug> (soft — fold_db is append-only; see docs/phase-5-delete-spike.md)
   ```
7. Exit `0`.

**Read-path filtering** is the other half of the workaround: `record.ts:findBySlug` filters out tombstoned records (returning `null`), and `list` filters them out of the output. That naturally cascades to every existing command:

| Command | After soft-delete | Why |
|---|---|---|
| `fbrain get <slug>` | `error: No <type>: <slug>` | `findBySlug` returns `null` |
| `fbrain list` | record absent from output | list filters tombstones |
| `fbrain status <slug>` | `error: No <type>: <slug>` | uses `findBySlug` |
| `fbrain link t d` (where `d` is tombstoned) | rejects `--design` | uses `findBySlug` |
| `fbrain search <q>` | tombstoned hits silently skipped | already calls `findBySlug` per hit and skips on `null` |
| `fbrain design new <slug>` (no `--force`) | re-create succeeds | `findBySlug` returns `null`, so the duplicate-check passes |

`fbrain raw GET /api/query ...` still returns the wiped molecule directly — that's the escape hatch. Anyone going around fbrain sees the raw fold_db state.

## Edge cases the implementation handles

- **Slug exists in both Design and Task with `--type` omitted** → error mirrors `fbrain get`'s ambiguous-slug path; user must specify `--type`. No deletes occur.
- **Slug exists in neither** → `error: No <type>: <slug>` (or `No design or task with slug "<slug>"` if `--type` omitted). Matches `fbrain get`'s message exactly. Exit 1.
- **Slug is already tombstoned** (re-delete) → `findBySlug` returns `null` (because tombstoned), so the user sees `error: No <type>: <slug>`. Symmetric with how a real hard-delete would behave on a missing slug.
- **Network failure mid-flow** (update succeeds, fold_db delete fails) → the soft-delete is already applied via update, but the error from `deleteRecord` propagates and the user sees a non-zero exit. The record is functionally deleted from fbrain's perspective; re-running `fbrain delete <slug>` returns "no such record" because the tombstone is in place. The fold_db sync-log marker is missing — acceptable v0 since fold_db's own pipeline doesn't act on it for local-only state.

## Follow-up to file in fold_db

> **fold_db follow-up:** `POST /api/mutation` with `mutation_type=delete` is documented as append-only (see `apple_consolidation.rs:25-27`), but the response shape `{ok: true, success: true, mutation_id: "…"}` doesn't communicate that to clients. Two possible fixes — pick whichever is in scope:
> - **(a)** Add a response field like `"semantics": "append-only-marker"` so any client probe makes the actual behavior legible.
> - **(b)** Implement an actual hard-delete path that prunes the molecule's hash → atom_uuid binding for the supplied key, behind an opt-in body field (`hard_delete: true`) so existing append-only semantics don't break.
>
> fbrain Phase 5 does NOT touch fold_db. The workaround above is purely fbrain-layer; if fold_db ever ships (b), the soft-delete tombstone becomes the wrapper around it (fbrain still wants the read-path filter for in-flight delete events).
>
> File location: this monorepo lives at `EdgeVector/fold`. Suggested label: `area:mutation-api`, `kind:dx`.

## What does NOT change in fbrain Phase 5

- `src/schemas.ts` — schema definitions are byte-identical (no new fields, no schema bump). Phase 6 stays unblocked.
- `src/commands/{design,task}.ts` — create still uses `findBySlug` for the duplicate check; with the new filter, a tombstoned slug counts as gone (intended). No behavior change for non-tombstoned slugs.
- `src/commands/search.ts` — already skips stale `findBySlug` hits; tombstoned hits are now treated the same way. No code change.
- The fold_db tree — strictly read-only this phase per the task's OUT OF SCOPE block.

## Reproduction recipe (for future agents)

```bash
# Against a fresh local fold node (or any existing fbrain-init'd node):
fbrain design new spike-delete-probe --title "delete probe" --body "indexed body content"
fbrain get spike-delete-probe --type design                # confirms present
fbrain raw POST /api/mutation '{"type":"mutation","schema":"<DESIGN_HASH from ~/.fbrain/config.json>","mutation_type":"delete","fields_and_values":{},"key_value":{"hash":"spike-delete-probe","range":null}}'
fbrain get spike-delete-probe --type design                # still present — that's the spike's whole point
fbrain delete spike-delete-probe --type design             # the Phase 5 workaround
fbrain get spike-delete-probe --type design                # error: No design: spike-delete-probe
fbrain raw POST /api/query '{"schema_name":"<DESIGN_HASH>","fields":["slug","title","body","status","tags"]}' | jq '.results[]|select(.fields.slug=="spike-delete-probe")'
# → still present at the raw layer, with tags=["__fbrain_deleted__"] — exactly what we expect
```
