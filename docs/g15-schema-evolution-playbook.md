# G15: fbrain schema evolution playbook

**Date:** 2026-05-24
**Status:** spike + playbook (no production migration in this PR)
**Command:** `fbrain migrate --add-field <type> <field> <type-spec> [--default V]`
**Related:** `docs/phase-5-delete-spike.md` (append-only constraint),
`docs/phase-7-search-latency-spike.md` (reindex precedent)

## What this is

A safe way to add a new field to an fbrain record type — Design, Task,
or any of the six Phase 6 kinds backed by `FbrainKindNote` — without
orphaning records that were written under the old shape. It's the
direct response to the gap left after Phase 6: the schema set is
locked, and we needed a credible answer to "what happens when we want
to add field N+1?".

The command is implemented; the doc is the model. Both are paired so
the playbook isn't theoretical and the spike has a place to land its
weight.

## The hard fact

fold_db identity-hashes a schema by `SHA256(descriptive_name +
sorted_field_names)`
(`fold_db/crates/core/src/schema/types/declarative_schemas.rs:672-694`),
and atoms get pinned to their `source_schema_name` at create time
(`fold_db/crates/core/src/atom/atom_def.rs:1-30`). Combine those two
and:

- Adding **any** field necessarily produces a **new** schema hash.
- Existing records do not follow the schema as it changes — they stay
  pinned to the old hash.
- fold_db is append-only (Phase 5 spike), so we cannot remove the old
  records once we've migrated. They orphan harmlessly at the old
  hash, reachable only via `fbrain raw GET /api/query` with the old
  hash spelled out.

There is no in-place "evolve" API in fold_db. The only existing
migration pattern is `apple_consolidation`
(`fold_db_node/src/fold_node/migrations/apple_consolidation.rs`) —
scan-and-reingest with marker-file idempotency. This playbook
generalises that pattern to a CLI command.

## The model — re-register, re-`put`, atomic config swap

`fbrain migrate --add-field` runs these seven steps. Each is logged
with a `[N/7]` prefix in the command's stdout so a failure is legible.

```
1. Register the new schema (descriptive_name bumped to _v<next>)
2. POST /api/schemas/load                       → new hash live in node
3. Write the manifest as in_progress
4. Enumerate records under the old hash
5. Re-`put` each under the new hash (idempotent: skip if already there)
6. Atomic config swap (tmp file + rename(2))
7. Mark manifest complete
```

### Why descriptive_name bumps

`FbrainKindNote` → `FbrainKindNote_v2` → `..._v3`. The version is
legible in `/api/schemas`, and future name-based queries (currently
none in fbrain — we resolve by canonical hash — but defensive against
later code paths) can't ambiguously resolve.

### Why the per-migration version marker field

Each migration's new schema gets an extra field named
`_<descriptive_name>_marker` (e.g. `_FbrainKindNote_v2_marker`),
defaulted to the descriptive_name itself. This is the same
structural-distinctness trick that `v1_marker_a` / `v1_marker_b`
play for the original Phase 6 noteSchema (`src/schemas.ts:9-20`):
fold_db's schema service has a known **overlap-merge** behavior on
`/api/schemas/load` (issue #261) where a new schema whose field set
is a near-superset of an existing one can collapse onto the existing
canonical hash. The marker field makes each migration's field set
unambiguously distinct so the schema service can't merge our new
registration onto an unrelated prior one.

The migrate command also runs a **post-registration sanity check**:
after `registerSchema` returns a canonical hash, it `GET`s
`/v1/schema/<hash>` and asserts our requested field is in the
returned schema's fields list. If not, it bails with
`schema_overlap_merge` and a hint pointing here. This catches the
escape case where the merge happens despite the marker — which can
happen on a shared / dev schema service that has accumulated many
similar `FbrainKindNote_v2` registrations from prior runs.

If you hit `schema_overlap_merge` against a shared dev schema service,
the workaround is: bump your descriptive_name past the polluted
range (e.g. force `_v99`), or run against an isolated schema
service. Production users normally won't hit this — they own their
schema-service state.

### Why all six Phase 6 types migrate together

`noteSchema` backs six logical types via the `kind` discriminator
(see `src/schemas.ts:9-20`). If only the named type moved to the new
hash, the formerly-shared schema would fan out into up to six
divergent hashes. Migrating all six at once preserves the Phase 6
invariant ("one schema, six kinds") at the cost of a small extra
write count per migration. For Design / Task migrations, only the
named type moves.

### Why the manifest

Every migration writes `~/.fbrain/migrations/<ts>-add-<scope>-<field>.json`
**before** any record writes. The manifest is the single source of
truth for:

- `fbrain migrate --status` (tabular history)
- `fbrain migrate --resume <id>` (crash recovery)
- `fbrain doctor`'s drift-check softening (see "Doctor interaction"
  below)

Schema:

```json
{
  "id": "2026-05-24T22-30-00-000Z-add-note-urgency",
  "scope": { "schema_key": "note", "affected_types": ["concept", "preference", ...] },
  "from_hash": "...64-hex...",
  "to_hash":   "...64-hex...",
  "descriptive_name_from": "FbrainKindNote",
  "descriptive_name_to":   "FbrainKindNote_v2",
  "field_added": "urgency",
  "field_type": "String",
  "default": "normal",
  "applied_at": "2026-05-24T22:30:00.000Z",
  "status": "complete",
  "migrated_count": 17,
  "total_count": 17
}
```

### Crash recovery — `--resume`

The manifest stays `in_progress` until step 7 marks it `complete`. If
step 5 or 6 dies mid-flight (network blip, ^C, exception):

1. The config still points at `from_hash` — reads stay correct.
2. The records already re-put under `to_hash` are reachable via raw
   query but invisible to fbrain's normal read paths (which still pin
   to `from_hash`).
3. `fbrain migrate --status` shows `migrated_count < total_count` with
   `status: "in_progress"`.

Recovery:

```
fbrain migrate --resume <manifest-id>
```

This re-enumerates records under `from_hash`, skips ones already
present under `to_hash` (per-record `findBySlug` probe), writes the
rest, and runs steps 6 + 7. Safe to re-run as many times as needed.

### Dry-run

`fbrain migrate --add-field … --dry-run`:

- Computes the field-added schema request and would-be
  `descriptive_name`.
- Writes the manifest as `dry_run` with `to_hash` set to
  `dry-run:not-registered`.
- Does NOT register the schema with the schema service.
- Does NOT load schemas into the node.
- Does NOT re-put any records.
- Does NOT swap the config.
- Cannot be `--resume`d — re-run with a real (non-dry) invocation.

Use this to preview the planned schema name, affected types, field
shape, and manifest before committing to the schema-service and node
writes.

## CLI

```
fbrain migrate --add-field <type> <field> <type-spec> [--default V] [--dry-run]
fbrain migrate --status
fbrain migrate --resume <manifest-id>
```

`<type-spec>` is `String` or `Array:String` — matches fbrain's
existing `FieldType`. `--default` is **required** for `String` (no
implicit empty default; too easy to silently corrupt
post-migration records); optional for `Array:String` where it
defaults to `[]`.

### Canonical example

```bash
# Add `urgency` (String) to every Phase 6 record, defaulted to "normal":
fbrain migrate --add-field concept urgency String --default "normal"

# Check what happened:
fbrain migrate --status

# Probe a single migrated record:
fbrain get my-first-concept --type concept   # `urgency: normal` will be present
```

## After a migration — update `src/schemas.ts`

This is the one human step the command can't automate. Once a
migration completes:

1. Edit `src/schemas.ts` to add the new field to the affected schema
   (with the same name, type, description, and a
   `field_data_classifications` entry).
2. Commit.

If you skip this, `fbrain doctor` will surface drift (now demoted to
**WARN** because the manifest explains it — see "Doctor interaction")
and the next `fbrain init` will register the *old* schemas.ts shape,
get the *old* hash back, and write that to config. All migrated
records would then look orphaned.

The migrate command's final stdout line is a reminder:

```
note: update src/schemas.ts to add "urgency" to the affected schema so the next `fbrain init` keeps the new hash.
```

## Doctor interaction

`fbrain doctor`'s schema-drift check (`src/commands/doctor.ts:243-280`)
normally FAILs when the registered schema disagrees with `schemas.ts`.
After a migration, that's the *expected* state until the human follow-up
in the section above lands. The doctor reads
`~/.fbrain/migrations/*.json` and, when it finds a `status: "complete"`
manifest whose `to_hash` matches the live config hash for that schema,
demotes the drift to **WARN** with a fix-pointer:

```
[WARN] schema-drift[FbrainKindNote]  — fields missing from registered schema: urgency — explained by migration 2026-05-24T22-30-00-000Z-add-note-urgency
       fix:   update src/schemas.ts to add "urgency" to the note schema so the next `fbrain init` keeps the new hash
```

WARN entries don't flip the doctor exit code, so this stays
informational until the source edit lands and the drift naturally
resolves.

## Failure modes (and what to do)

| Failure | What you see | Recovery |
|---|---|---|
| Schema service rejects registration | step 1 errors with `schema_http_<status>` | Manifest never written. Re-run after fixing the service. |
| `/api/schemas/load` returns `failed_schemas: [...]` | step 2 errors with `schema_load_partial` | New schema is registered but not loaded into the node. Re-run `fbrain migrate --add-field` (idempotent; will register again to the same hash and re-load). |
| Mid-flight crash during step 5 | manifest `status: "in_progress"`, `migrated_count < total_count`. `fbrain doctor` flags drift only after the swap; until then config still points at `from_hash`. | `fbrain migrate --resume <id>`. Idempotent — already-migrated records are skipped. |
| Config swap (step 6) fails (disk full, permission) | step 6 throws; manifest still `in_progress`; records already re-put under `to_hash` (orphans of a half-done migration) | Fix the disk/permission issue and `fbrain migrate --resume <id>`. The records under `to_hash` are detected via `findBySlug` and not duplicated. |
| You re-ran `fbrain init` post-migration before editing schemas.ts | config gets schemaHashes reverted to the old hashes; migrated records orphan | The migration manifest is still on disk. Edit schemas.ts to match the migrated shape and re-run `fbrain init`; the new shape will register, get the migrated hash back, and config will land correctly. |
| Field name already exists in schema | step 0 errors with `field_already_present` | Pick a different name, or check `fbrain migrate --status` for a prior migration that already added it. |
| `--default` missing for String field | command refuses to start with a message about implicit empties | Re-run with `--default <value>`. |

## What is NOT supported (by design)

- **Field removal.** fold_db is append-only — old records carrying the
  removed field would orphan with no recovery path. Soft-deprecate
  via a tag (the `__fbrain_deleted__` tombstone pattern from
  `docs/phase-5-delete-spike.md`); set the deprecated field to a
  sentinel value, then ignore it on read.
- **Field type change.** Same root cause as removal — old records carry
  the old typed bytes; reinterpretation is a data migration. The
  approximate recipe (manual, not in this command): add a new
  field, dual-write for one release, copy old values into new field
  shape via a one-shot script, soft-deprecate the old field.
- **Field rename.** Equivalent to add-and-deprecate. Add the new
  name, dual-write or backfill via a one-shot script, soft-deprecate
  the old.
- **Record type changes.** `RECORD_TYPES` and `RECORDS` in
  `src/schemas.ts` are the source of truth; adding a new type is a
  separate, larger change (it touches dispatch in put/get/list/status,
  the help text, the MCP server, and the doctor drift table). Out of
  scope for this command.

## How this maps to the kanban G-numbered series

G15 = "schema evolution playbook + working spike", filed against the
G0 replacement-readiness gate (`docs/g0-replacement-readiness-gate.md`).
It's a precondition for trusting fbrain as a long-lived store: every
shipped schema represents a future migration target, and the cost of
the first migration sets the ceiling for how fast subsequent ones can
ship. Today: ~7 steps, one CLI command, manifest-resumable. Tomorrow:
add `--dry-run` aggregation across multiple field-adds, then
auto-update `schemas.ts` from the manifest.

## Source pointers

- Command: `src/commands/migrate.ts`
- Pure helpers (manifest IO, schema cloning, default parsing):
  `src/migration.ts`
- CLI wiring + help: `src/cli.ts`
- Doctor drift softening: `src/commands/doctor.ts` (look for
  `softenDriftIfMigrated`)
- Unit tests: `test/unit/migration.test.ts`, `test/unit/migrate.test.ts`
- Integration test (real fold harness): `test/integration/migrate.test.ts`
