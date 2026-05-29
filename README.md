# fbrain

> ⚠️ **PROTOTYPE graduating into gbrain replacement**
>
> This is the active prototype for the EdgeVector team-shared brain. The 2026-05-24 review reaffirmed: fbrain replaces gbrain for org deploys. Readiness-gate criteria are defined; **10 of 11 acceptance items are green** — only the dogfood-shaped items remain (#5 mirror-flip 7-day, #6 second-user, #8 rollback rehearsal). See [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md) for the full ship-criteria contract, named outstanding items, and rollback. If the gate isn't green by **2026-08-23**, this repo gets an archive review per the same discipline applied to the four predecessor monorepo predecessors — see [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) Workstream B.

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
| `fbrain put <slug> [--type T]` | Upserts a record from stdin (YAML frontmatter aware). One of frontmatter `type:` or `--type` is required — there is NO silent default. `--type` overrides absent frontmatter and errors on disagreement. Re-puts update in place — no `--force`, no 409 |
| `fbrain get <slug> [--type T]` | Prints a record by slug. Without `--type`, queries every type; on an ambiguous slug it prints all matches before erroring so you can pick one |
| `fbrain list [--type T] [--status S] [--tag T] [-n N]` | Lists records, newest-first |
| `fbrain status <slug> [<new>] [--type T]` | Reads or updates a record's status (per-type enum validation) |
| `fbrain link <task-slug> <design-slug>` | Links a task to its parent design (v0: Task → Design only) |
| `fbrain search <query> [-n N] [--exact] [--min-score F] [--type T]…` | Semantic search; dedupes fragments per record, skips stale hits. Repeatable `--type` scopes results to one or more of the 8 record types (e.g. `--type design --type task` to exclude noisy concept streams) |
| `fbrain ask <query> [--limit N] [--no-llm] [--explain] [--type T]…` | LLM-expanded hybrid retrieval: BM25 + vector fused via Reciprocal Rank Fusion. Wider recall than `search` — paraphrase via vector, rare-token / acronym matches via BM25. Repeatable `--type` narrows both the BM25 corpus and the vector schemas filter |
| `fbrain doctor [--freshness] [--usage]` | Live health check: reachability, provisioning, schemas-loaded, schema drift. `--freshness` adds the G3 freshness + pollution probes; `--usage` prints team-adoption write counts by userHash over the last 7 days (see [Doctor](#doctor)) |
| `fbrain raw <method> <path> [body]` | Authenticated passthrough to node (`/api/…`) or schema service (`/v1/…`) |
| `fbrain share` | Placeholder. Prints a pointer to the Phase 3 memo and exits 1 (see [Sharing](#sharing)) |
| `fbrain delete <slug> [--type T]` | Soft-deletes a record. fold_db is append-only — the workaround stamps a tombstone tag so every fbrain read path treats the record as gone (see [Delete](#delete)) |
| `fbrain reindex [--type T] [--dry-run]` | Re-puts every live record so fold_db refreshes its embedding entry — workaround for index pollution (see [Recovery](#recovery)) |
| `fbrain migrate --add-field <type> <field> <spec> [--default V] [--dry-run]` | Evolves a schema by adding a field: registers the new schema, re-puts every record with the default, atomically swaps `~/.fbrain/config.json`. Also `--status` (default; list manifests) and `--resume <id>` (continue an interrupted run). See [docs/g15-schema-evolution-playbook.md](docs/g15-schema-evolution-playbook.md) |
| `fbrain mcp` | Start a Model Context Protocol server over stdio. Exposes 6 tools to MCP clients (Claude Code, Codex, …) — read: `fbrain_search`, `fbrain_get`, `fbrain_list`; write: `fbrain_put`, `fbrain_delete`, `fbrain_link` — so agents can read and mutate fbrain in-process (see [MCP](#mcp)) |

Run `fbrain help <command>` for per-command usage.

## Record types

| Type | Status enum | Schema (in fold_db) |
|---|---|---|
| `design` | `draft \| reviewed \| approved \| implemented \| archived` | dedicated `Design` schema |
| `task` | `open \| in_progress \| blocked \| done \| cancelled` | dedicated `Task` schema (carries `design_slug` for `link`) |
| `concept` | `active \| archived` | dedicated `Concept` schema |
| `preference` | `active \| superseded` | dedicated `Preference` schema |
| `reference` | `active \| broken \| archived` | dedicated `Reference` schema |
| `agent` | `active \| archived` | dedicated `Agent` schema |
| `project` | `planning \| in_progress \| done \| archived` | dedicated `Project` schema |
| `spike` | `active \| concluded` | dedicated `Spike` schema |

Each of the six Phase 6 types gets its own dedicated schema with a distinct `descriptive_name` + `purpose_statement`. We originally landed a single combined schema (`FbrainKindNote`) plus a `kind` discriminator as a workaround for fold_db's structural canonicalization (the node merged schemas with overlapping field positions during `/api/schemas/load`, making the second schema's data inaccessible). As of Phase E (PR #63, dual-signal canonicalization cutover) the schema service consults the purpose-statement embedding alongside the structural signal, so distinct purpose statements veto the merge and all six can share the same 7-field shape without colliding onto one canonical hash. The combined-schema workaround was retired; the consolidation migration moved every pre-Phase-E row into its per-kind canonical, and the legacy `FbrainKindNote` schema is no longer registered or read.

Slug uniqueness is now per-type — a `concept` and a `preference` can share the slug `foo`. When `fbrain get`, `fbrain status`, or `fbrain delete` is invoked without `--type` on a slug that resolves in more than one schema, the command errors with `Slug "X" exists in multiple schemas (concept, preference). Specify --type.` and you re-issue with `--type` to disambiguate.

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
[PASS] schema-drift[Concept]  — Concept @ 57df5c3fe50c…
[PASS] schema-drift[Preference]  — Preference @ 9b1f04ac7e21…
[PASS] schema-drift[Reference]  — Reference @ a3d2cc18f9b5…
[PASS] schema-drift[Agent]  — Agent @ 42e7b6815ac0…
[PASS] schema-drift[Project]  — Project @ 7c5a90def142…
[PASS] schema-drift[Spike]  — Spike @ 1f8b3e6d24a7…
[WARN] single-machine-slice  — you're on this daemon; record set is local — multi-machine reads require fold_db sync transport (not yet built; tracked as G16)
[WARN] no-team-sync  — fbrain share is a placeholder until fold_db cloud sync transport lights up (see docs/phase-3-sharing-memo.md)

OK
```

The two `[WARN]` lines at the bottom are **always emitted** — they're disclosure, not detection. They flag fbrain's current single-machine + no-team-sync slice per [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md) §6 so a teammate dogfooding on a second machine sees the limitation instead of inferring a silent fork. WARN does not flip the exit code (same pattern as the pollution-probe WARN).

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
[PASS] schema-drift[Concept]  — Concept @ 57df5c3fe50c…
[PASS] schema-drift[Preference]  — Preference @ 9b1f04ac7e21…
[PASS] schema-drift[Reference]  — Reference @ a3d2cc18f9b5…
[PASS] schema-drift[Agent]  — Agent @ 42e7b6815ac0…
[PASS] schema-drift[Project]  — Project @ 7c5a90def142…
[PASS] schema-drift[Spike]  — Spike @ 1f8b3e6d24a7…
[WARN] single-machine-slice  — you're on this daemon; record set is local — multi-machine reads require fold_db sync transport (not yet built; tracked as G16)
[WARN] no-team-sync  — fbrain share is a placeholder until fold_db cloud sync transport lights up (see docs/phase-3-sharing-memo.md)

FAIL: 1 issue
```

### `--freshness` (retrieval-quality probes)

`fbrain doctor --freshness` appends two probes that surface the retrieval-quality issues documented in [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md):

- **freshness-probe** — 5 trials of `put → search`. Each trial writes a `doctor-freshness-probe-<nonce>-N` concept with a unique marker word and asserts the fresh record appears at score ≥ 0.5 in a search for that marker. Probes are soft-deleted in cleanup. FAILs (exit 1) if any trial misses.
- **pollution-probe** — issues one broad query (`fbrain`) and classifies every returned hit as live, stale (record gone or tombstoned but its embedding remains), or orphan-schema (a non-fbrain schema sharing the same daemon). Tagged PASS at <25% polluted, **WARN** at 25–50%, **FAIL** above 50%. WARN does not flip the exit code; FAIL does.

```
[PASS] freshness-probe  — 5/5 trials passed (min score ≥ 0.5; avg observed score 0.912)
[FAIL] pollution-probe  — query "fbrain" → 13 hits: live 2, stale 10 (77%), orphan 1 (8%) — pollution 85%
       fix:   see docs/phase-7-search-latency-spike.md — upstream fixes are G3d (schema-scoped search) and G3e (purge embeddings on tombstone)
```

A polluted result is informative, not a bug in fbrain — it tells you the homebrew daemon's native index is sharing slots with tombstoned embeddings and other schemas. The fix lives upstream in fold_db (G3d / G3e).

### `--usage` (team-adoption telemetry)

`fbrain doctor --usage` skips the health checks and prints a write-count report by `userHash` over the last 7 days. fold_db stamps every atom with the writing user's public key; fbrain derives the 16-byte `userHash` from `sha256(pubkey)` and groups records by it. Only the 8-char prefix of each `userHash` is printed — that's enough to distinguish teammates on a shared daemon without leaking the full identifier.

```
fbrain usage (last 7 days, by userHash):
  dcf41c3a  127 writes  (45 today)  types: concept(80) task(30) design(10) preference(7)
  9f2a1e07    3 writes  (0 today)   types: concept(3)
total: 130 writes across 2 users
```

The command also appends/updates a daily-summary line in `~/.fbrain/usage.jsonl`, one record per UTC date, so adoption can be plotted as a time series:

```jsonl
{"date":"2026-05-22","by_user":{"dcf41c3a":18},"total":18}
{"date":"2026-05-23","by_user":{"dcf41c3a":12,"9f2a1e07":1},"total":13}
{"date":"2026-05-24","by_user":{"dcf41c3a":45,"9f2a1e07":0},"total":45}
```

Re-running on the same day updates that date's line in-place (the report is a snapshot). Flags:

  - `--usage-window N` — override the rolling window (default 7)
  - `--usage-path PATH` — override the daily-summary file

This is the signal that backs the G0 definition-of-shipped: "2+ daily users with userHash-distinguishable writes for 7 consecutive days." Read writes are not counted — only new records (filtered by `created_at`) — because adoption is about people capturing knowledge, not querying it.

## Sharing

Phase 3 was a sharing spike: stand up two local fold_db nodes, walk every `/api/sharing/*` endpoint, and either land a working `fbrain share` or land a memo explaining why a localhost-only test can't get there. **Outcome: memo.**

In short: the sharing **metadata** (ShareRule, ShareInvite, ShareSubscription) is fully wireable on loopback — two nodes with distinct identities can hand-deliver an invite and persist a subscription end-to-end. But the **data** never actually moves between nodes on a `--local --local-schema` spike, because fold_db's cross-node transport is the cloud sync engine (S3-backed, mediated by an Auth Lambda + discovery service), and the spike intentionally didn't sign in to it. Without authenticated transport, the "B cannot read an unshared record" negative test is moot — B can't read **any** of A's records, shared or not.

**This is a sign-in gap, not a missing-infra gap.** Both halves of the transport are built and deployed: fold_db's sync engine ([`crates/core/src/sync/engine.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db/crates/core/src/sync/engine.rs) — `local Sled → SyncEngine → Auth Lambda → S3`) and the exemem cloud stack ([`exemem-infra/lambdas/`](https://github.com/EdgeVector/exemem-infra/tree/main/lambdas) — auth, discovery, storage, etc., live in dev us-west-2 and prod us-east-1). The homebrew daemon at `:9001` reports `GET /api/sharing/exemem-status → {"connected": false}` because nobody has signed it in yet; the sync engine has somewhere to talk to as soon as a cloud session exists. See [`docs/cloud-signin-spike-plan.md`](docs/cloud-signin-spike-plan.md) for what it would take to light up the positive end-to-end test.

`fbrain share` is currently a placeholder: it prints a pointer to the memo and exits non-zero. A real implementation drives `POST /api/sharing/rules` + `POST /api/sharing/invite` + `POST /api/sharing/accept`, gated on `exemem-status.connected == true`.

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

## Recovery

If `fbrain search` starts returning stale or empty results — most often after a batch of `fbrain delete` calls, or when the homebrew daemon hosts non-fbrain schemas alongside fbrain — run:

```bash
fbrain reindex             # all 8 types
fbrain reindex --type concept --dry-run   # preview what would be touched
```

`fbrain reindex` walks every live (non-tombstoned) record and re-issues an `update` mutation. fold_db's mutation pipeline re-runs `index_record` synchronously, which refreshes the record's embedding entry in the native index. The fresh embeddings then survive the top-50 budget even when tombstoned-but-not-purged phantoms still sit in the index alongside them.

What it does **not** do:

- It does not purge phantom embeddings left behind by `fbrain delete`. The native index has no per-record purge API today; that fix is filed upstream as G3e against fold_db.
- It does not change tombstone semantics — tombstoned records stay tombstoned and are reported as `skipped-tombstone`.
- It does not change the search resolver's top-K logic.

Per-record outcomes (`kept | reindexed | skipped-tombstone`) are printed with the global `--verbose` flag. Pollution-ratio measurement (before/after) is intentionally deferred to `fbrain doctor freshness` (G3a). For the full root-cause analysis and the chain of recommended follow-ups, see [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md).

## Verifying

`scripts/parity-smoketest.sh` is the one-command round-trip check that backs gate item #1 in [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md). It walks 20 hand-picked fixtures from `test/fixtures/parity/` — covering all 8 record types with frontmatter-shape and body variety — `put`s each, `get`s each back, and diffs title/body/tags/status for identity. Exits 0 on full parity; non-zero with a count of mismatches otherwise.

```bash
./scripts/parity-smoketest.sh                 # uses `fbrain` on PATH
FBRAIN="bun src/cli.ts" ./scripts/parity-smoketest.sh   # from a worktree
```

Re-running is idempotent — `fbrain put` upserts via Phase 4 semantics, so the second run re-asserts the same parity against records the first run created.

The script retries each `get` up to five times (250 ms backoff) to ride out the polluted-daemon read flake documented in [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md) — same query, different result count run-to-run. That flake is a fold_db read-consistency concern; the smoketest is scoped to fbrain-side parity.

## MCP

fbrain ships an MCP (Model Context Protocol) server so AI agents — Claude Code, Codex, and any other MCP client — can read **and write** the brain in-process without shelling out. Six tools across G6 read + G6-write scope: `fbrain_search`, `fbrain_get`, `fbrain_list`, `fbrain_put`, `fbrain_delete`, `fbrain_link`.

```bash
# Register fbrain with Claude Code (one-time, after `bun install`):
claude mcp add fbrain bun "$(realpath src/mcp/main.ts)"

# Or run the server standalone (useful for testing with @modelcontextprotocol/inspector):
bun run src/mcp/main.ts
```

The server speaks MCP over stdio, reads `~/.fbrain/config.json` at startup, and re-uses the CLI's existing command functions in-process. See [`docs/mcp-smoketest.md`](docs/mcp-smoketest.md) for end-to-end verification (ask Claude to search, put, delete, link).

| Tool | Input | What it does |
|---|---|---|
| `fbrain_search` | `query` + `limit?` + `exact?` + `min_score?` | Semantic search; same dedupe + stale-skip as `fbrain search` |
| `fbrain_get` | `slug` + `type?` | Print one record; errors on ambiguous slug across types |
| `fbrain_list` | `type?` + `status?` + `tag?` + `limit?` | Newest-first list with filters |
| `fbrain_put` | `slug` + `type?` + `title?` + `body?` + `status?` + `tags?` + `frontmatter?` | Upsert a record. Synthesizes frontmatter from structured args or passes through raw `frontmatter`. One of `type` or a `type:` field in `frontmatter` is required — there is NO silent default (matches CLI `put`); if `status` is set, fires a follow-up `fbrain status` mutation |
| `fbrain_delete` | `slug` + `type?` | Soft-delete a record (tombstone tag). Without `type`, errors on ambiguous slug |
| `fbrain_link` | `from_type` + `from_slug` + `to_type` + `to_slug` | Link a task to a parent design. v0: `task → design` only — any other pair errors with `unsupported_link_pair` |

Single-user trust at stdio — no MCP auth layer. The server inherits the CLI's `~/.fbrain/config.json` credentials (your `userHash`), so every write is attributed to you. If you put fbrain behind a remote MCP transport one day, you'll want a real auth story first.

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
  The homebrew `fold_db_node` daemon isn't running. Start it (typically `folddb daemon start` or whatever your install procedure is). If you're contributing to fold itself and running a worktree-local `./run.sh --local`, point fbrain at the auto-slotted port with `fbrain init --node-url http://127.0.0.1:<slot>`.

- **`error: Node not set up — run \`fbrain doctor\` for a full diagnosis.`**  
  The node is running but not provisioned. Run `fbrain init`.

- **`error: Node rejected /api/mutation: schema collision (canonical hashes …); fbrain config out of date — run \`fbrain init\` — run \`fbrain doctor\` for a full diagnosis.`**  
  Schema definitions have moved on since your config was written (likely because `schemas.ts` changed). Re-run `fbrain init` — it's idempotent and refreshes the canonical hashes.

- **`error: Config not found at ~/.fbrain/config.json. Run \`fbrain init\` first.`**  
  You haven't initialised fbrain yet. Run `fbrain init`.

- **`error: Node rejected POST /api/setup/bootstrap with 410 — already provisioned …`**  
  The daemon is in a contradictory state — `/api/system/auto-identity` says "not provisioned" but `/api/setup/bootstrap` says "already provisioned". This typically happens on a second-user dogfood machine where `~/.folddb/config/` carries over from a previous fold install. Recovery: (a) if you still have `~/.fbrain/config.json` from when this node was working, re-run `fbrain init` — it reuses the saved `userHash` and continues; (b) follow the node's own message (POST `/api/auth/restore` with the recovery phrase, if you have one); (c) for a clean slate, stop the daemon, `rm -rf ~/.folddb/config/`, restart, then re-run `fbrain init`.

- **`error: Semantic search is unavailable — the fold_db node failed to load its embedding model …`** (or, on older fbrain versions, the opaque `Bad request: Schema error: Invalid data: Failed to init embedding model: Failed to retrieve model.onnx`).  
  The fold_db_node loads its `model.onnx` lazily on the first `fbrain search` / `fbrain ask` call. After certain restarts (commonly `brew upgrade folddb`) that cache is partially populated and the node 400s instead of fetching. **Workaround:** `folddb daemon stop && folddb daemon start` — the embedding cache repopulates on next search. If the failure persists, run `fbrain doctor --freshness` and capture the node log (the latest file under `~/Library/Logs/Homebrew/folddb/`); the underlying cache-recovery bug is tracked upstream in `EdgeVector/fold` (fold/fold_db_node/). `fbrain doctor` (no flags) now runs a one-token search probe so this failure surfaces as a structured `[FAIL] embedding-runtime` line instead of an opaque error on first use.

- **`?? ~/` showing up in `git status` inside this repo.**  
  Don't get confused by it — that literal `~` directory is `fold_db` writing to a config path of `~/.folddb` without expanding the tilde, leaving a real `./~/` subtree in whatever cwd it ran from. The contents are safe to delete (`rm -rf ./~`). It's also gitignored (`/~/` in `.gitignore`) so it won't be staged.

When in doubt, `fbrain doctor` will tell you exactly which check is failing and what to do.

## Tests

```bash
bun test           # runs unit + integration tests
bun run typecheck  # strict tsc --noEmit
```

Integration tests spawn a real `fold_db_node` against a unique tmpdir and point it at the dev cloud schema-service Lambda (us-west-2). At test start the harness runs a one-shot bootability probe (cloud schema-service reachable + one real `run.sh` boot with early-child-exit detection) — if `FOLD_NODE_DIR` (defaults to `/Users/tomtang/code/edgevector/fold/fold_db_node`) isn't present, the cloud Lambda isn't reachable, or `run.sh` can't boot a node, every integration file skips cleanly in seconds with a single notice and only the unit subset runs. Set `FBRAIN_SKIP_INTEGRATION=1` to force-skip even when the node dir is present (offline dev). Override the dev Lambda URL via `FBRAIN_TEST_SCHEMA_URL` and the node URL via `FBRAIN_TEST_NODE_URL`.

## Quality / eval

`scripts/eval-retrieval.ts` is the retrieval eval harness — a hard prerequisite for shipping G5 (`fbrain ask`) per [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md) G3b. Without a baseline, every retrieval tuning change is guesswork.

```bash
bun scripts/eval-retrieval.ts                  # seed missing pairs, evaluate, soft-delete seeded
bun scripts/eval-retrieval.ts --no-seed        # evaluate against the live corpus only
bun scripts/eval-retrieval.ts --keep           # don't soft-delete after (debugging)
bun scripts/eval-retrieval.ts --limit 5        # consider only the top-5 (default 10)
bun scripts/eval-retrieval.ts --out report.json
```

The pair set lives at [`eval/retrieval/pairs.json`](eval/retrieval/pairs.json) — 20+ hand-labeled `(query, expected_slug, expected_type)` triples, each with a `seed` block so the harness can materialise the record on demand. Slugs are prefixed `eval-retrieval-` so seeding/teardown can't collide with real records. The runner:

1. For each pair, checks whether the seeded record already exists. If not, `put`s it from the seed block.
2. Issues the query through `searchCmd` programmatically (no shelling out) and captures the top-K slugs.
3. Computes precision@1 / @3 / @5 and mean reciprocal rank across all pairs.
4. Emits a JSON report (`schema_version: 1`) plus an optional human-readable table.
5. Soft-deletes anything it seeded unless `--keep` is passed.

CI runs the harness as a **non-blocking** step (`continue-on-error: true`) — the build logs the numbers but doesn't fail on them. The runner self-skips when `~/.fbrain/config.json` is absent or the node is unreachable, so CI prints "skipping" today; once an ephemeral node is wired into CI the numbers will start flowing. TODO: once we have ≥7 days of runs, gate on a P@1 floor (see the G3b plan).

A typical baseline reading against a polluted homebrew daemon (the H2 case the Phase 7 spike documents) hovers around P@1 ≈ 0.4 — most queries either rank the seeded record first or get drowned by phantom/orphan-schema fragments. That number is the artifact this harness exists to track.

## Replacement direction

fbrain is the planned replacement for [gbrain](https://github.com/garrytan/gbrain) at EdgeVector. The 2026-05-24 gap-consolidation review locked the replacement direction. **Status:** v0+ prototype, NOT shipped — readiness-gate criteria are defined, **10 of 11 items green**. Only the dogfood-shaped items remain: #5 mirror-flip 7-day, #6 second-user, #8 rollback rehearsal. The G5 `fbrain ask` ship (PR #23) closed the last code-shaped gap. See [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md) for the workflow inventory, eval numbers, and the 2026-08-23 archive-review deadline.

The second-user dogfood (gate item #6) has a ready-to-execute playbook + 7-day monitor at [`docs/dogfood-g14-second-user-playbook.md`](docs/dogfood-g14-second-user-playbook.md) and [`scripts/dogfood-monitor.sh`](scripts/dogfood-monitor.sh) — the human onboarding step is unblocked, awaiting teammate selection.

Until the readiness gate ships, both gbrain and fbrain coexist; the `gbrain put` → fbrain mirror hook keeps writes flowing to both.

## Out of scope for v0

- Not E2E-encrypted (Phase 3 sharing probes the surface, doesn't build a product)
- Not running new fold_db core code
- No git-to-brain sync
- No published binaries (`bun link` for local install)
