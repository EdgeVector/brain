# fbrain

> ⚠️ **PROTOTYPE graduating into gbrain replacement**
>
> This is the active prototype for the EdgeVector team-shared brain. The 2026-05-24 review reaffirmed: fbrain replaces gbrain for org deploys. Readiness-gate status: pending (see [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md)). If the readiness gate hasn't shipped by **2026-08-23**, this repo gets an archive review per the same discipline applied to the four predecessor monorepo predecessors — see [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) Workstream B.

A CLI named `fbrain` that uses fold_db as the storage engine for a personal brain. Eight record types — **designs**, **tasks**, **concepts**, **preferences**, **references**, **agents**, **projects**, **spikes** — with semantic search and a Phase 3 sharing probe.

## Status

| Phase | Description | Status |
|---|---|---|
| 0 | fold_db feasibility spike | ✅ GO (with canonical-hash caveat) — see [spike notes](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/spikes/fbrain-phase-0-spike-notes.md) |
| 1 | Bootstrap + core CRUD (init, design new, task new, get, list, status, link) | ✅ Landed |
| 2 | Search + doctor + raw passthrough + polish | ✅ Landed |
| 3 | Sharing spike | ✅ Memo — see [`docs/phase-3-sharing-memo.md`](docs/phase-3-sharing-memo.md) |
| 5 | `fbrain delete` (soft, with verified semantics) | ✅ Landed — see [`docs/phase-5-delete-spike.md`](docs/phase-5-delete-spike.md) |
| 6 | Multi-type schemas (Concept / Preference / Reference / Agent / Project / Spike) + table-driven put dispatch | ✅ Landed |

## Plans

- [`FBRAIN_PROTOTYPE_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PROTOTYPE_PLAN.md) — this prototype (v0)
- [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) — the 9–11 month production vision (separate from this prototype)

## Prerequisites

- **Bun** ≥ 1.3.10 — `bun --version`.
- **Rust toolchain** — only used by fold_db, but its first `./run.sh` invocation compiles the full Rust workspace. **Allow several minutes for the cold build** (cargo target/ is shared across runs once warmed). Subsequent runs are near-instant. `fbrain init` will print a "compiling Rust — give it a few minutes" hint and back off with retries if it hits the node before it's listening.
- **A running `fold_db_node`** — fbrain defaults to the homebrew daemon at `http://127.0.0.1:9001`. The schema service is the prod cloud Lambda at `https://axo709qs11.execute-api.us-east-1.amazonaws.com` (no local schema_service to run; iteration/CI uses the dev Lambda at `https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com`). Override either with `--node-url` / `--schema-service-url` on `fbrain init` (e.g. to point at a worktree-spawned `./run.sh --local --dev` checkout).

## Quick start

Assuming the homebrew `fold_db_node` daemon is running on `:9001` and you have
network access to the prod schema-service Lambda, you'll be at "first record"
in under a minute.

```bash
# 1. install, link (one-time)
git clone https://github.com/EdgeVector/fbrain && cd fbrain
bun install
bun link                              # exposes a global `fbrain` binary

# 2. bootstrap + drive it
fbrain init                           # 5 steps; writes ~/.fbrain/config.json
                                      # (auto-heals a stale local-schema config
                                      #  to the new cloud-Lambda default)
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

`<TYPE>` below is one of: `design | task | concept | preference | reference | agent | project | spike`.

| Command | What it does |
|---|---|
| `fbrain init` | Bootstraps the node + registers schemas + writes `~/.fbrain/config.json` with canonical hashes |
| `fbrain design new <slug> [--title T] [--tag T]… [--body STR] [--force]` | Creates a Design |
| `fbrain task new <slug> [--title T] [--design D] [--tag T]… [--body STR] [--force]` | Creates a Task (rejects dangling `--design`) |
| `fbrain put <slug>` | Upserts a record from stdin (YAML frontmatter aware). `type:` in frontmatter picks the schema — all 8 types route to writes. Re-puts update in place — no `--force`, no 409 |
| `fbrain get <slug> [--type T]` | Prints a record by slug. Without `--type`, queries every type and errors on ambiguity |
| `fbrain list [--type T] [--status S] [--tag T] [-n N]` | Lists records, newest-first |
| `fbrain status <slug> [<new>] [--type T]` | Reads or updates a record's status (per-type enum validation) |
| `fbrain link <task-slug> <design-slug>` | Links a task to its parent design (v0: Task → Design only) |
| `fbrain search <query> [-n N] [--exact] [--min-score F]` | Semantic search; dedupes fragments per record, skips stale hits |
| `fbrain doctor` | Live health check: reachability, provisioning, schemas-loaded, schema drift |
| `fbrain raw <method> <path> [body]` | Authenticated passthrough to node (`/api/…`) or schema service (`/v1/…`) |
| `fbrain share` | Placeholder. Prints a pointer to the Phase 3 memo and exits 1 (see [Sharing](#sharing)) |
| `fbrain delete <slug> [--type design|task]` | Soft-deletes a record. fold_db is append-only — the workaround stamps a tombstone tag so every fbrain read path treats the record as gone (see [Delete](#delete)) |
| `fbrain mcp` | Start a Model Context Protocol server over stdio. Exposes 3 read tools — `fbrain_search`, `fbrain_get`, `fbrain_list` — to MCP clients (Claude Code, Codex, …) so agents can query fbrain in-process (see [MCP](#mcp)) |

Run `fbrain help <command>` for per-command usage.

## Record types

| Type | Status enum | Schema (in fold_db) |
|---|---|---|
| `design` | `draft \| reviewed \| approved \| implemented \| archived` | dedicated `Design` schema |
| `task` | `open \| in_progress \| blocked \| done \| cancelled` | dedicated `Task` schema (carries `design_slug` for `link`) |
| `concept` | `active \| archived` | shared `FbrainKindNote` schema |
| `preference` | `active \| superseded` | shared `FbrainKindNote` schema |
| `reference` | `active \| broken \| archived` | shared `FbrainKindNote` schema |
| `agent` | `active \| archived` | shared `FbrainKindNote` schema |
| `project` | `planning \| in_progress \| done \| archived` | shared `FbrainKindNote` schema |
| `spike` | `active \| concluded` | shared `FbrainKindNote` schema |

The six Phase 6 types share a single `FbrainKindNote` schema with a `kind` discriminator field. We started with one schema per type, but fold_db's node merges schemas with overlapping field positions during `/api/schemas/load` — the second schema's data becomes inaccessible. The shared schema sidesteps that bug entirely. The trade-off is that slugs are unique GLOBALLY across the six Phase 6 types (a concept and a preference cannot share a slug). For the gbrain → fbrain migration this is fine because gbrain page slugs are already path-prefixed (`concepts/foo` ≠ `projects/foo`).

Default status on create (used when frontmatter omits `status:`): first value of each enum (so `active` for most types, `planning` for project, `draft` for design, `open` for task).

Example: pipe a concept through `fbrain put`:

```bash
cat <<'NOTE' | fbrain put my-concept
---
type: concept
title: Idempotency in fold
tags: [fold, concept]
---
mutations are keyed by canonical hash; re-POST of the same body is a no-op.
NOTE
```

## Doctor

`fbrain doctor` runs a fixed sequence of live checks and exits non-zero if any fail.

**Green example:**

```
[PASS] config  — nodeUrl=http://127.0.0.1:9001 schemaServiceUrl=https://axo709qs11.execute-api.us-east-1.amazonaws.com
[PASS] schema-service-reachable
[PASS] node-reachable
[PASS] node-provisioned  — user_hash=dd616fa8…
[PASS] schemas-loaded  — 932/932 loaded
[PASS] schema-drift[Design]  — Design @ 84d9f350b4ff…
[PASS] schema-drift[Task]  — Task @ c0352ec0c453…
[PASS] schema-drift[FbrainKindNote]  — FbrainKindNote @ 57df5c3fe50c…

OK
```

**Red example** (drift detected after schemas.ts was edited but `fbrain init` wasn't re-run):

```
[PASS] config  — nodeUrl=http://127.0.0.1:9001 schemaServiceUrl=https://axo709qs11.execute-api.us-east-1.amazonaws.com
[PASS] schema-service-reachable
[PASS] node-reachable
[PASS] node-provisioned  — user_hash=dd616fa8…
[PASS] schemas-loaded  — 932/932 loaded
[FAIL] schema-drift[Design]  — fields missing from registered schema: owner
       fix:   re-run `fbrain init` so the config picks up the current canonical hash; otherwise reconcile schemas.ts with the registered schema
[PASS] schema-drift[Task]  — Task @ c0352ec0c453…
[PASS] schema-drift[FbrainKindNote]  — FbrainKindNote @ 57df5c3fe50c…

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

## MCP

fbrain ships an MCP (Model Context Protocol) server so AI agents — Claude Code, Codex, and any other MCP client — can read the brain in-process without shelling out. G6 read scope only: `fbrain_search`, `fbrain_get`, `fbrain_list`. The write tools (`put`, `delete`, `link`) land in a separate task.

```bash
# Register fbrain with Claude Code (one-time, after `bun install`):
claude mcp add fbrain bun "$(realpath src/mcp/main.ts)"

# Or run the server standalone (useful for testing with @modelcontextprotocol/inspector):
bun run src/mcp/main.ts
```

The server speaks MCP over stdio, reads `~/.fbrain/config.json` at startup, and re-uses the CLI's existing command functions in-process. See [`docs/mcp-smoketest.md`](docs/mcp-smoketest.md) for an end-to-end "ask Claude to search fbrain" verification.

| Tool | Input | What it does |
|---|---|---|
| `fbrain_search` | `query` + `limit?` + `exact?` + `min_score?` | Semantic search; same dedupe + stale-skip as `fbrain search` |
| `fbrain_get` | `slug` + `type?` | Print one record; errors on ambiguous slug across types |
| `fbrain_list` | `type?` + `status?` + `tag?` + `limit?` | Newest-first list with filters |

## Architecture

`fbrain` is a thin **two-service client** that splits across local + cloud:

```
fbrain CLI (TypeScript / Bun)
   │
   ├──── HTTP (localhost) ─────────► fold_db_node (homebrew daemon, :9001)
   │                                  persistence, indexing, mutations
   │
   └──── HTTPS (cloud) ────────────► schema_service (AWS Lambda)
                                       prod: us-east-1 (daily use)
                                       dev:  us-west-2 (iteration + CI tests)
```

The node binary is local — Sled storage, all reads/writes go through it. The
schema service moved to two cloud Lambdas: prod is the default for daily use,
dev is targeted by `fbrain init --schema-service-url <dev URL>` and the
integration test harness. fbrain holds only the schemas, the CLI parsing, and
the error-message layer. See [`FBRAIN_PROTOTYPE_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PROTOTYPE_PLAN.md) for the rationale.

Power users contributing to fold itself can still point at a worktree-local
schema service with `--node-url` / `--schema-service-url` on `fbrain init`
(e.g. when running `./run.sh --local --local-schema` from a fold checkout).

## Troubleshooting

Top errors you'll hit and the fix:

- **`error: node not reachable at http://127.0.0.1:9001 — run \`fbrain doctor\` for a full diagnosis.`**  
  The homebrew `fold_db_node` daemon isn't running. Start it (typically `brew services start fold_db_node` or whatever your install procedure is). If you're contributing to fold itself and running a worktree-local `./run.sh --local`, point fbrain at the auto-slotted port with `fbrain init --node-url http://127.0.0.1:<slot>`.

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

Integration tests spawn a real `fold_db_node` against a unique tmpdir and point it at the dev cloud schema-service Lambda (us-west-2). They skip cleanly when `FOLD_NODE_DIR` (defaults to `/Users/tomtang/code/edgevector/fold/fold_db_node`) isn't reachable, so CI runs the unit subset. Set `FBRAIN_SKIP_INTEGRATION=1` to force-skip even when the node dir is present (offline dev). Override the dev Lambda URL via `FBRAIN_TEST_SCHEMA_URL` and the node URL via `FBRAIN_TEST_NODE_URL`.

## Replacement direction

fbrain is the planned replacement for [gbrain](https://github.com/garrytan/gbrain) at EdgeVector. The 2026-05-24 gap-consolidation review locked the replacement direction. **Status:** v0+ prototype, NOT shipped — see the upcoming [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md) for the migration plan, acceptance criteria, and rollback.

Until the readiness gate ships, both gbrain and fbrain coexist; the `gbrain put` → fbrain mirror hook keeps writes flowing to both.

## Out of scope for v0

- Not E2E-encrypted (Phase 3 sharing probes the surface, doesn't build a product)
- Not running new fold_db core code
- No git-to-brain sync
- No published binaries (`bun link` for local install)
