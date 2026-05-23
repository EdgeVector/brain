# fbrain

> ⚠️ **PROTOTYPE — archive review by 2026-08-23**
>
> This is a v0 prototype that probes whether [fold_db](https://github.com/EdgeVector/fold) is a viable storage backend for a personal "brain" CLI. If by **2026-08-23** the prototype hasn't graduated into [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) Workstream B, this repo is archived with `ARCHIVED.md` and a `pre-commit` reject hook — the same discipline applied to the four predecessor monorepo predecessors.

A CLI named `fbrain` that uses fold_db as the storage engine for a personal brain that tracks **designs** and **tasks**, with semantic search and a Phase 3 sharing probe.

## Status

| Phase | Description | Status |
|---|---|---|
| 0 | fold_db feasibility spike | ✅ GO (with canonical-hash caveat) — see [spike notes](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/spikes/fbrain-phase-0-spike-notes.md) |
| 1 | Bootstrap + core CRUD (init, design new, task new, get, list, status, link) | ✅ Landed |
| 2 | Search + doctor + raw passthrough + polish | ✅ Landed |
| 3 | Sharing spike | ✅ Memo — see [`docs/phase-3-sharing-memo.md`](docs/phase-3-sharing-memo.md) |
| 5 | `fbrain delete` (soft, with verified semantics) | ✅ Landed — see [`docs/phase-5-delete-spike.md`](docs/phase-5-delete-spike.md) |

## Plans

- [`FBRAIN_PROTOTYPE_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PROTOTYPE_PLAN.md) — this prototype (v0)
- [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) — the 9–11 month production vision (separate from this prototype)

## Prerequisites

- **Bun** ≥ 1.3.10 — `bun --version`.
- **Rust toolchain** — only used by fold_db, but its first `./run.sh` invocation compiles the full Rust workspace. **Allow several minutes for the cold build** (cargo target/ is shared across runs once warmed). Subsequent runs are near-instant. `fbrain init` will print a "compiling Rust — give it a few minutes" hint and back off with retries if it hits the node before it's listening.
- **A local checkout of `EdgeVector/fold`** — fbrain talks to a running `fold_db_node` + `schema_service`. By default, it expects them on `http://127.0.0.1:9101` and `http://127.0.0.1:9102` (the auto-slotter may pick higher ports if those are taken — pass `--node-url` / `--schema-service-url` to `init`).

## Quick start

Assuming `fold` is already running (warm Rust build), you'll be at "first record" in under 5 minutes.

```bash
# 1. start fold (separate shell)
cd /path/to/fold/fold_db_node
./run.sh --local --local-schema --empty-db --home /tmp/fbrain-node

# 2. clone, install, link this repo (one-time)
git clone https://github.com/EdgeVector/fbrain && cd fbrain
bun install
bun link                              # exposes a global `fbrain` binary

# 3. bootstrap + drive it
fbrain init                           # 5 steps; writes ~/.fbrain/config.json
fbrain design new my-first-design --title "First design" --tag spike --body "the body that gets embedded"
fbrain task new t1 --design my-first-design --title "first task"

# Or pipe a markdown note with frontmatter (idempotent upsert — re-put updates in place):
cat <<'NOTE' | fbrain put my-second-design
---
type: design
title: Piped via put
tags: [via-stdin, dogfood]
---
the body becomes the indexed body
NOTE

fbrain list
fbrain search "body that gets embedded"
fbrain doctor                         # confirms everything is wired
```

A global `--verbose` flag echoes every HTTP request and response — including the canonical schema hash being targeted, per the Phase 0 spike's debugging guidance.

## Commands

| Command | What it does |
|---|---|
| `fbrain init` | Bootstraps the node + registers Design/Task schemas + writes `~/.fbrain/config.json` with canonical hashes |
| `fbrain design new <slug> [--title T] [--tag T]… [--body STR] [--force]` | Creates a Design |
| `fbrain task new <slug> [--title T] [--design D] [--tag T]… [--body STR] [--force]` | Creates a Task (rejects dangling `--design`) |
| `fbrain put <slug>` | Upserts a Design or Task from stdin (YAML frontmatter aware). Re-puts update in place — no `--force`, no 409. v0 only supports `type: design` and `type: task`; other types error and point at Phase 6 |
| `fbrain get <slug> [--type design|task]` | Prints a record by slug |
| `fbrain list [--type T] [--status S] [--tag T] [-n N]` | Lists records, newest-first |
| `fbrain status <slug> [<new>] [--type T]` | Reads or updates a record's status |
| `fbrain link <task-slug> <design-slug>` | Links a task to its parent design |
| `fbrain search <query> [-n N] [--exact] [--min-score F]` | Semantic search; dedupes fragments per record, skips stale hits |
| `fbrain doctor` | Live health check: reachability, provisioning, schemas-loaded, schema drift |
| `fbrain raw <method> <path> [body]` | Authenticated passthrough to node (`/api/…`) or schema service (`/v1/…`) |
| `fbrain share` | Placeholder. Prints a pointer to the Phase 3 memo and exits 1 (see [Sharing](#sharing)) |
| `fbrain delete <slug> [--type design|task]` | Soft-deletes a record. fold_db is append-only — the workaround stamps a tombstone tag so every fbrain read path treats the record as gone (see [Delete](#delete)) |

Run `fbrain help <command>` for per-command usage.

## Doctor

`fbrain doctor` runs a fixed sequence of live checks and exits non-zero if any fail.

**Green example:**

```
[PASS] config  — nodeUrl=http://127.0.0.1:9101 schemaServiceUrl=http://127.0.0.1:9102
[PASS] schema-service-reachable
[PASS] node-reachable
[PASS] node-provisioned  — user_hash=dd616fa8…
[PASS] schemas-loaded  — 932/932 loaded
[PASS] schema-drift[Design]  — Design @ 84d9f350b4ff…
[PASS] schema-drift[Task]  — Task @ c0352ec0c453…

OK
```

**Red example** (drift detected after schemas.ts was edited but `fbrain init` wasn't re-run):

```
[PASS] config  — nodeUrl=http://127.0.0.1:9101 schemaServiceUrl=http://127.0.0.1:9102
[PASS] schema-service-reachable
[PASS] node-reachable
[PASS] node-provisioned  — user_hash=dd616fa8…
[PASS] schemas-loaded  — 932/932 loaded
[FAIL] schema-drift[Design]  — fields missing from registered schema: owner
       fix:   re-run `fbrain init` so the config picks up the current canonical hash; otherwise reconcile schemas.ts with the registered schema
[PASS] schema-drift[Task]  — Task @ c0352ec0c453…

FAIL: 1 issue
```

## Sharing

Phase 3 was a sharing spike: stand up two local fold_db nodes, walk every `/api/sharing/*` endpoint, and either land a working `fbrain share` or land a memo explaining why a localhost-only test can't get there. **Outcome: memo.**

In short: the sharing **metadata** (ShareRule, ShareInvite, ShareSubscription) is fully wireable on loopback — two nodes with distinct identities can hand-deliver an invite and persist a subscription end-to-end. But the **data** never actually moves between nodes, because fold_db's cross-node transport is the cloud sync engine (S3-backed, mediated by an Auth Lambda + discovery service), and that layer is unreachable from a localhost-only spike. Without the transport, the "B cannot read an unshared record" negative test is moot — B can't read **any** of A's records, shared or not.

`fbrain share` is currently a placeholder: it prints a pointer to the memo and exits non-zero. A real implementation requires fold_db's exemem service to be configured.

Read [`docs/phase-3-sharing-memo.md`](docs/phase-3-sharing-memo.md) for the full evidence: every endpoint with its captured request/response JSON, what worked, what didn't, and exactly what a real two-device test would require.

## Delete

fold_db's mutation pipeline is documented as append-only — `MutationType::Delete` writes a sync-log marker but does not remove molecule entries on local storage. `POST /api/mutation` with `mutation_type=delete` therefore returns `{ok: true, success: true}` but the record is still present on every read path. **This is documented behavior, not a bug** (see fold_db's own [`apple_consolidation.rs:25-27`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/fold_node/migrations/apple_consolidation.rs)).

`fbrain delete` works around this at the fbrain layer:

1. Resolves `--type` the same way `fbrain get` does (probes both schemas if omitted; errors on ambiguous slug).
2. Fires an `update` mutation that overwrites every user field with sentinel values (`title="(deleted)"`, `body=""`, `status="archived"|"cancelled"`, `tags=["__fbrain_deleted__"]`, `design_slug=""` for tasks).
3. Fires the fold_db `delete` mutation for forward-compat (when fold_db ever grows a real hard-delete, this call starts mattering).
4. Verifies by reading the record back and asserting the tombstone tag is present. If verification fails, errors with `delete_not_applied`.

Every fbrain read path (`get`, `list`, `status`, `link`, `search`) filters tombstoned records via `findBySlug`, so the user-visible behavior matches a hard delete. The slug is also reusable: `fbrain design new <same-slug>` (no `--force`) recreates it cleanly.

`fbrain raw POST /api/query` is the escape hatch — it returns the raw fold_db state including tombstoned rows.

Read [`docs/phase-5-delete-spike.md`](docs/phase-5-delete-spike.md) for the full source-code references, probe transcripts, and the fold_db follow-up that's been filed.

## Architecture

`fbrain` is a thin **two-service client** over fold_db's local-schema mode:

```
fbrain CLI (TypeScript / Bun)
   │
   │  HTTP (localhost)
   ├──────────────────────────┐
   ▼                          ▼
fold_db_node              schema_service
:auto-slotted             :auto-slotted
(9101–9199)               (9101–9199)
```

All persistence, indexing, and embedding live in fold_db. fbrain holds only the schemas, the CLI parsing, and the error-message layer. See [`FBRAIN_PROTOTYPE_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PROTOTYPE_PLAN.md) for the rationale.

## Troubleshooting

Top errors you'll hit and the fix:

- **`error: node not reachable at http://127.0.0.1:9101 — run \`fbrain doctor\` for a full diagnosis.`**  
  fold_db isn't running or is still compiling. Check that `./run.sh --local --local-schema` is still going in another shell. On a first run, give it 1–3 minutes for the Rust cold build.

- **`error: Node not set up — run \`fbrain doctor\` for a full diagnosis.`**  
  The node is running but not provisioned. Run `fbrain init`.

- **`error: Node rejected /api/mutation: schema collision (canonical hashes …); fbrain config out of date — run \`fbrain init\` — run \`fbrain doctor\` for a full diagnosis.`**  
  Schema definitions have moved on since your config was written (likely because `schemas.ts` changed). Re-run `fbrain init` — it's idempotent and refreshes the canonical hashes.

- **`error: Config not found at ~/.fbrain/config.json. Run \`fbrain init\` first.`**  
  You haven't initialised fbrain yet. Run `fbrain init`.

When in doubt, `fbrain doctor` will tell you exactly which check is failing and what to do.

## Tests

```bash
bun test           # runs unit + integration tests
bun run typecheck  # strict tsc --noEmit
```

Integration tests spawn a real `fold_db_node` + `schema_service` against a unique tmpdir. They skip cleanly when `FOLD_NODE_DIR` (defaults to `/Users/tomtang/code/edgevector/fold/fold_db_node`) isn't reachable, so CI runs the unit subset.

## Out of scope for v0

- Not a replacement for gbrain
- Not E2E-encrypted (Phase 3 sharing probes the surface, doesn't build a product)
- Not running new fold_db core code
- No git-to-brain sync
- No published binaries (`bun link` for local install)
