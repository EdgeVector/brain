# brain

A CLI named `brain` that uses LastDB as the storage engine for a personal brain. Ten record types — **design**, **task**, **concept**, **preference**, **reference**, **agent**, **project**, **spike**, **sop**, **decision** — with semantic search, an `ask` answer command, and an MCP agent surface.

## Prerequisites

Use LastDB API 29 or later and Bun 1.3.10 or later. Brain connects to the
configured owner Unix socket. Check it with `lastdb status`. The default socket
is `~/.lastdb/data/folddb.sock`. Set `LASTDB_HOME` or `BRAIN_FOLDDB_SOCKET`
when selecting another node.

## Quick start

Install Brain from the signed app registry, then initialize its schemas and config.

```bash
lastdb app install brain --accept-install
brain --version
brain init
```

Local initialization confirms access through the owner socket. Local writes
and search use that connection. Existing callers may keep passing
`brain init --grant-consent` or `--yes`.

Remote nodes retain their capability protocol. Their owner approves access
through the target node's supported approval flow. A cached capability can be
reused by subsequent remote commands.

Brain prefers LastSeek for semantic search and reads the ranked records from
LastDB. Use `lastseek status` and `lastseek doctor` to inspect that index.

```bash
# 3. drive it
brain design new my-first-design --title "First design" --tag spike --body "the body that gets embedded"
brain task new t1 --design my-first-design --title "first task" --body "what this task covers"
# Note: with no --body, `<TYPE> new` reads the body from stdin only when stdin is piped/redirected (non-TTY); in an interactive terminal it creates an empty body. Prefer --body, pipe a body in, or set BRAIN_NO_STDIN=1 to skip the stdin read.

# Or pipe a markdown note with frontmatter (idempotent upsert — re-put updates in place):
cat <<'NOTE' | brain put my-second-design
---
type: design
title: Piped via put
tags: [via-stdin, dogfood]
---
the body becomes the indexed body
NOTE

brain list
brain ask "body that gets embedded"      # hybrid (BM25 + vector) — catches the write you just made, immediately
brain search "body that gets embedded"   # pure-vector; a brand-new write may take ~1s to land — use `ask` for immediate retrieval
brain doctor                             # confirms everything is wired
```

A global `--verbose` flag echoes every HTTP request and response — including the canonical schema hash being targeted, per the Phase 0 spike's debugging guidance.

## Commands

`<TYPE>` below is one of: `design | task | concept | preference | reference | agent | project | spike | sop | decision`.

| Command | What it does |
|---|---|
| `brain init` | Bootstraps the node + registers schemas + writes `~/.brain/config.json` with canonical hashes |
| `brain <TYPE> new <slug> [--title T] [--tag T]… [--body STR] [--force]` | Creates a record of type `design`, `task`, `concept`, `preference`, `reference`, `agent`, `project`, `spike`, `sop`, or `decision`. Status defaults to the type's first enum value |
| `brain task new <slug> [--design D] …` | Extra: `--design <slug>` links the new task to a parent design (rejects a dangling slug) |
| `brain put <slug> [--type T]` | Upserts a record from stdin (YAML frontmatter aware). One of frontmatter `type:` or `--type` is required — there is NO silent default. `--type` overrides absent frontmatter and errors on disagreement. Re-puts update in place — no `--force`, no 409 |
| `brain get <slug> [--type T] [--field PATH]…` | Prints a record by slug. Without `--type`, queries every type; on an ambiguous slug it picks a deterministic read precedence (reference before project) so common agent reads do not need a retry. `--field` projects plain values without JSON parsing |
| `brain list [--type T] [--status S] [--tag T] [-n N] [--field PATH]…` | Lists records, newest-first. `--field` projects one TSV row per record |
| `brain status <slug> [<new>] [--type T]` | Reads or updates a record's status (per-type enum validation) |
| `brain link <from-slug> <to-slug> [--from-type T] [--to-type T]` | Links records. Defaults to legacy Task → Design (`task.design_slug`); non-legacy pairs store a generic explicit link tag on the source |
| `brain backlinks <slug> [--type T]` | Lists records linking to a slug through explicit edges or `[[slug]]` body references; reads the backlink secondary index instead of scanning every schema |
| `brain attach <slug> <file> [--type T] [--name N] [--force]` | Attaches a file to a record. Bytes are the LastDB file of one `BrainAttachmentFile` record, keyed by SHA-256. Attachment content never enters search indexes; only the filename is searchable metadata. Identical content dedupes (see [Attachments](#attachments)) |
| `brain attachments <slug> [--type T]` | Lists a record's attachments (name, size, media type, blob ref, added_at) |
| `brain detach <slug> <name-or-ref> [--type T]` | Removes one attachment by filename or `sha256:<hex>` ref. The content-addressed blob remains (fold_db is append-only) |
| `brain attachment get <slug> <name-or-ref> [-o PATH] [--force]` | Materializes an attachment's bytes to disk (or stdout with `-o -`), verifying the SHA-256 before writing — a hash mismatch is a hard error, never silent corruption |
| `brain search <query> [-n N \| --limit N] [--exact] [--min-score F] [--type T]…` | Semantic search; dedupes fragments per record, skips stale hits. Repeatable `--type` scopes results to one or more record types (e.g. `--type design --type task` to exclude noisy concept streams). `-n` and `--limit` are aliases. Pure-vector, so a brand-new write may take ~1s to land in the index — reach for `ask` when you need to retrieve something you just wrote |
| `brain ask <query> [-n N \| --limit N] [--expand\|--llm] [--explain] [--type T]… [--field PATH]…` | Hybrid retrieval: BM25 + vector fused via Reciprocal Rank Fusion. **No LLM call by default.** LLM query expansion is opt-in via `--expand` (alias `--llm`). The default path needs no API key. Wider recall than `search` — paraphrase via vector, rare-token / acronym matches via BM25. Repeatable `--type` narrows both the BM25 corpus and the vector schemas filter. `--field` projects plain values from result rows. `-n` and `--limit` are aliases; `--no-llm` is accepted as a back-compat no-op |
| `brain doctor [--freshness] [--write] [--mcp] [--json] [--usage]` | Live health check: reachability, provisioning, schemas-loaded, schema drift. `--freshness` adds the G3 freshness + pollution probes; `--write` adds an idempotent `put → get → soft-delete` round-trip that proves writes actually land; `--mcp` boots the `brain-mcp` compatibility entrypoint and asserts the full 10-tool agent surface (the strongest agent-integration check — see [MCP](#mcp)); `--json` emits machine-readable output; `--usage` prints team-adoption write counts by userHash over the last 7 days (see [Doctor](#doctor)) |
| `brain raw <method> <path> [body]` | Authenticated passthrough to node (`/api/…`) or schema service (`/v1/…`) |
| `brain admin-snapshot publish [--dry-run] [--json]`<br>`brain admin-snapshot deliver [--approve] …` | Publish a privacy-safe Brain admin rollup on Mini, then stage/approve a LastDB deliver to the existing admin kanban-consumer (see [Admin snapshot deliver](#admin-snapshot-deliver)) |
| `brain delete <slug> [--type T]`<br>`brain delete --tag T [--type T] [--status S] [--yes]` | Deletes a record (or, in filter mode, every live record matching the `list`-style selector — dry-run by default, `--yes` to apply). LastDB native Delete converges tip absence. The CLI also stamps a tombstone tag so older read paths hide the row (see [Delete](#delete)) |
| `brain reindex --target <hash> --source-hash <type> --slug <slug>` | Repairs the named list-page keys. One call names one target, one source type, and at most 25 slugs (see [Recovery](#recovery)) |
| `brain mcp` | Start a Model Context Protocol server over stdio. Exposes 10 tools to MCP clients (Claude Code, Codex, …) — read: `brain_search`, `brain_ask`, `brain_get`, `brain_list`, `brain_backlinks`; write: `brain_put`, `brain_status`, `brain_append`, `brain_delete`, `brain_link` — so agents can read and mutate the brain in-process (see [MCP](#mcp)) |

Run `brain help <command>` for per-command usage.

### Field projection

The read commands `get`, `list`, and `ask` accept `--field PATH` when a script
or agent needs one or a few values and should not parse `--json` inline. Repeat
the flag or pass comma-separated paths for TSV rows:

```bash
brain get my-note --field status
brain get my-note --field slug,status
brain list --type task --field slug,status
brain ask "release gate" --field slug,type,title
```

Paths use the command's existing JSON payload shape, with dot paths and array
indexes such as `tags[0]`, `extra_fields.program`, or `linked_from[0].slug`.
Scalar arrays print as comma-joined values; missing paths print as empty cells.

## Record types

Not sure which type to reach for? The **Use it for** column is the one-line
answer for each — the same strings the bare `brain` help prints, sourced from
the single `RECORD_PURPOSES` map in `src/schemas.ts` (which itself derives the
six Phase 6 rows from each schema's canonical `purpose_statement`), so the CLI
and this table can't drift.

| Type | Use it for | Status enum | Schema (in fold_db) |
|---|---|---|---|
| `design` | An architecture or plan you intend to build | `draft \| reviewed \| approved \| implemented \| archived` | dedicated `Design` schema |
| `task` | A unit of work; links to a parent design via --design | `open \| in_progress \| blocked \| done \| cancelled` | dedicated `Task` schema (carries `design_slug` for `link`) |
| `concept` | Reusable framework, pattern, or protocol recorded for cross-session reuse | `active \| archived` | dedicated `Concept` schema |
| `preference` | User-stated directive applied across future decisions | `active \| superseded` | dedicated `Preference` schema |
| `reference` | Pointer to an external resource useful for future lookup | `active \| broken \| archived` | dedicated `Reference` schema |
| `agent` | Persistent assistant identity with role and behavior conventions | `active \| archived` | dedicated `Agent` schema |
| `project` | Active in-flight feature work tracked over its lifecycle | `planning \| in_progress \| done \| archived` | dedicated `Project` schema |
| `spike` | Time-boxed investigation or exploration with a defined conclusion | `active \| concluded` | dedicated `Spike` schema |
| `sop` | Standard operating procedure: a repeatable step-by-step process an agent follows to perform a recurring task | `active \| superseded \| archived` | dedicated `Sop` schema |
| `decision` | A call a human made — the choice, its rationale, and outcome — kept as an auditable trail | `proposed \| go \| hold \| done \| moot \| superseded` | dedicated `Decision` schema |

Each of the six Phase 6 types gets its own dedicated schema with a distinct `descriptive_name` + `purpose_statement`. We originally landed a single combined schema (`BrainKindNote`) plus a `kind` discriminator as a workaround for fold_db's structural canonicalization (the node merged schemas with overlapping field positions during `/api/schemas/load`, making the second schema's data inaccessible). As of Phase E (PR #63, dual-signal canonicalization cutover) the schema service consults the purpose-statement embedding alongside the structural signal, so distinct purpose statements veto the merge and all six can share the same 7-field shape without colliding onto one canonical hash. The combined-schema workaround was retired; the consolidation migration moved every pre-Phase-E row into its per-kind canonical, and the legacy `BrainKindNote` schema is no longer registered or read.

Slug uniqueness is now per-type — a `concept` and a `preference` can share the slug `foo`. `brain get` is read-only, so when invoked without `--type` on a slug that resolves in more than one schema it returns a deterministic winner by type precedence (starting with `reference`, then `project`); pass `--type` to override. Mutating or destructive flows (`brain status`, `brain delete`) still error with `Slug "X" exists in multiple schemas (concept, preference). Specify --type.` so you re-issue with `--type` before changing anything.

Default status on create (used when frontmatter omits `status:`): first value of each enum (so `active` for most types, `planning` for project, `draft` for design, `open` for task).

Every type has an ergonomic `<type> new` verb:

```bash
brain concept new idempotency --title "Idempotency" --body "mutations are keyed by canonical hash"
brain preference new no-emojis --title "No emojis in code" --body "keep code comment-free of emojis"
brain spike new vectors-eval --title "Evaluating vector ranker quality" --body "measure ranker precision/recall"
brain sop new pr-merge-flow --title "Driving a PR to merged" --body "the step-by-step we follow on every PR"
# …same shape for reference / agent / project / spike / sop
```

Or pipe a body (with optional YAML frontmatter) through `brain put`:

```bash
cat <<'NOTE' | brain put my-concept
---
type: concept
title: Idempotency in fold
tags: [fold, concept]
---
mutations are keyed by canonical hash; re-POST of the same body is a no-op.
NOTE
```

## Doctor

`brain doctor` runs a fixed sequence of live checks and exits non-zero if any fail.

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
[WARN] single-machine-slice  — you're on this daemon; record set is local — multi-machine reads require brain to drive fold_db's sync transport (deployed but not yet wired up from brain; tracked as G16)

OK
```

The `[WARN]` line at the bottom is always emitted. It is disclosure, not detection. It says the record set is local to this daemon. WARN does not flip the exit code (same pattern as the pollution-probe WARN).

**Red example** (drift detected after schemas.ts was edited but `brain init` wasn't re-run):

```
[PASS] config  — nodeUrl=http://127.0.0.1:9001 schemaServiceUrl=https://axo709qs11.execute-api.us-east-1.amazonaws.com
[PASS] schema-service-reachable
[PASS] node-reachable
[PASS] node-provisioned  — user_hash=dd616fa8…
[PASS] schemas-loaded  — 932/932 loaded
[FAIL] schema-drift[Design]  — fields missing from registered schema: owner
       fix:   re-run `brain init` so the config picks up the current canonical hash; otherwise reconcile schemas.ts with the registered schema
[PASS] schema-drift[Task]  — Task @ c0352ec0c453…
[PASS] schema-drift[Concept]  — Concept @ 57df5c3fe50c…
[PASS] schema-drift[Preference]  — Preference @ 9b1f04ac7e21…
[PASS] schema-drift[Reference]  — Reference @ a3d2cc18f9b5…
[PASS] schema-drift[Agent]  — Agent @ 42e7b6815ac0…
[PASS] schema-drift[Project]  — Project @ 7c5a90def142…
[PASS] schema-drift[Spike]  — Spike @ 1f8b3e6d24a7…
[WARN] single-machine-slice  — you're on this daemon; record set is local — multi-machine reads require brain to drive fold_db's sync transport (deployed but not yet wired up from brain; tracked as G16)

FAIL: 1 issue
```

### `--freshness` (retrieval-quality probes)

`brain doctor --freshness` appends two probes that surface the retrieval-quality issues documented in [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md):

- **freshness-probe** — 5 trials of `put → search`. Each trial writes a `doctor-freshness-probe-<nonce>-N` concept with a unique marker word and asserts the fresh record appears at score ≥ 0.5 in a search for that marker. Probes are soft-deleted in cleanup. FAILs (exit 1) if any trial misses.
- **pollution-probe** — issues one broad query (`brain`) and classifies every returned hit as live, stale (record gone or tombstoned but its embedding remains), or orphan-schema (a non-brain schema sharing the same daemon). Tagged PASS at <25% polluted, **WARN** at 25–50%, **FAIL** above 50%. WARN does not flip the exit code; FAIL does.

```
[PASS] freshness-probe  — 5/5 trials passed (min score ≥ 0.5; avg observed score 0.912)
[FAIL] pollution-probe  — query "brain" → 13 hits: live 2, stale 10 (77%), orphan 1 (8%) — pollution 85%
       fix:   see docs/phase-7-search-latency-spike.md — upstream fixes are G3d (schema-scoped search) and G3e (purge embeddings on tombstone)
```

A polluted result is informative, not a bug in brain — it tells you the homebrew daemon's native index is sharing slots with tombstoned embeddings and other schemas. The fix lives upstream in fold_db (G3d / G3e).

### `--usage` (adoption telemetry)

`brain doctor --usage` skips the health checks and prints a write-count report over the last 7 days, broken down by record type. A LastDB record names no writer, so the report has no per-user split.

```
brain usage (last 7 days):
  130 writes  (45 today)  types: concept(83) task(30) design(10) preference(7)
total: 130 writes
```

The command also appends/updates a daily-summary line in `~/.brain/usage.jsonl`, one record per UTC date, so adoption can be plotted as a time series:

```jsonl
{"date":"2026-05-22","total":18}
{"date":"2026-05-23","total":13}
{"date":"2026-05-24","total":45}
```

Re-running on the same day updates that date's line in-place (the report is a snapshot). Flags:

  - `--usage-window N` — override the rolling window (default 7)
  - `--usage-path PATH` — override the daily-summary file

Read writes are not counted — only new records (filtered by `created_at`) — because adoption is about people capturing knowledge, not querying it.

## Admin snapshot deliver

`brain admin-snapshot` dogfoods the same Mini → Exemem → admin path as kanban /
routines deliver. It publishes a **privacy-safe** rollup (never full brain
bodies or secrets) into the internal `BrainAdminSnapshot` schema, then stages
and optionally approve-sends a `delivery_slice` to the **existing admin
kanban-consumer** identity (no second consumer enroll).

Payload fields:

- `type_counts_json` — live record counts by type
- `open_decisions_json` — live open-decisions ledger lines (slug + short title only)
- `active_programs_head_json` — short head of the active-programs rollup
- `recent_heartbeats_json` — recent routine heartbeats as `{slug, ts, ok}`
- `captured_at`, `source_app`, `schema_version`

```sh
# 1. Publish the slim snapshot on Mini (declares schema on first run)
brain admin-snapshot publish --json
brain admin-snapshot publish --dry-run --json

# 2. Stage a delivery to the admin kanban-consumer (public keys only)
export BRAIN_ADMIN_RECIPIENT_PUBKEY=...          # ed25519 from kanban-consumer bundle
export BRAIN_ADMIN_MESSAGING_PUBLIC_KEY=...      # x25519
export BRAIN_ADMIN_MESSAGING_PSEUDONYM=...

brain admin-snapshot deliver --dry-run --json
brain admin-snapshot deliver --max-records 5
brain admin-snapshot deliver --approve --max-records 5
```

Recipient flags may also use the `ROUTINES_ADMIN_*` aliases shared with
`routines deliver-status`. Without `--approve`, the command stages only and
prints the pending `delivery_id`. With `--approve`, Mini seals and sends a
`delivery_slice`; evidence is non-secret (`delivery_id`, shared count,
message type, schema hash). Mailbox poll + `openDelivery` stay on the admin
SPA / consumer tooling (same as kanban).

## Attachments

Records can point at things three ways, in increasing order of weight:

1. **`[[slug]]` wiki links** in the body — cheap, brain-internal, indexed by
   `backlinks`.
2. **Cross-app URIs** in the body (e.g. `lastsecrets://<slug>`,
   `http://localhost:3300/EdgeVector/.git<repo>`) — pointers into sibling apps that own the data.
3. **Real attachments** — the file's bytes live in the brain, content-addressed
   and cloud-synced with the rest of the node's data.

`brain attach <slug> <file>` stores the file as the LastDB file of one
`BrainAttachmentFile` record, keyed by the SHA-256 of the bytes, and appends a
`{name, blob_ref, size, media_type, added_at}` entry to the record's
`BrainAttachmentIndex`.

- **Additive.** The attachment schemas are internal, so attach changes no knowledge schema.
- **Content is never searchable.** The file bytes are not a field. The only word-indexed attachment surface is `filenames`.
- **Content-addressed.** Identical bytes are stored once. Re-attaching the same file is a no-op. `attachment get` re-verifies the SHA-256 before writing bytes to disk.
- **Detach removes the index entry.** The file record stays, because another record may name the same content.
- 32 MiB per-file cap (the socket transport caps request bodies at 64 MiB).

```bash
brain attach projects-edge-vector-labs-structure ./operating-agreement.pdf
brain attachments projects-edge-vector-labs-structure
brain attachment get projects-edge-vector-labs-structure operating-agreement.pdf -o /tmp/oa.pdf
brain detach projects-edge-vector-labs-structure operating-agreement.pdf
```

See [docs/attachments.md](docs/attachments.md) for the storage model.

## Delete

LastDB native `MutationType::Delete` removes the record at its key. A later `brain get` misses the row. Restart does not resurrect it.

`brain delete`:

1. Resolves `--type` the same way `brain get` does (probes both schemas if omitted; errors on ambiguous slug).
2. Fires an `update` mutation that overwrites every user field with sentinel values (`title="(deleted)"`, `body=""`, `status="archived"|"cancelled"`, `tags=["__brain_deleted__"]`, `design_slug=""` for tasks) so older brain read paths hide the row.
3. Fires the fold_db `delete` mutation (native Delete).
4. Verifies by reading the record back. Success is a miss or a row that still carries the tombstone tag. If the row is still visible without the tag, errors with `delete_not_applied`.

Every brain read path (`get`, `list`, `status`, `link`, `search`) treats the slug as gone. The slug is reusable: `brain design new <same-slug>` (no `--force`) recreates it.

### Bulk delete (filter mode)

To purge a batch of throwaway records in one command, `brain delete` also accepts the SAME `--tag`/`--type`/`--status` selectors `brain list` does, as an alternative to a positional `<slug>`:

```bash
brain delete --tag dogfood                 # DRY-RUN: preview what would be deleted
brain delete --tag dogfood --yes           # actually delete every match
brain delete --tag probe --type concept --status archived --yes
```

- **Dry-run by default.** Without `--yes`, filter mode lists the records that *would* be deleted (`type · slug · title`) plus a count and exits without mutating — so you can confirm the set before committing. Re-run with `--yes` to actually delete.
- **Same set as `list`.** Filter mode resolves matches via the identical path `brain list --tag/--type/--status` uses, so already-tombstoned records are excluded and a `list` preview matches what `delete` will remove.
- **Bounded selector required.** A bare `brain delete` (no slug *and* no filter) is refused — it would otherwise select every record. A `<slug>` and a filter together is also rejected (pick one mode).
- **Per-record referential integrity.** The design-with-live-tasks guard is honored per record: a linked design is skipped with a warning (the rest of the batch proceeds) unless you pass `--force`.
- **`--json`** in filter mode emits `{ok, deleted: [{type, slug}], dryRun}` so scripts and agents can consume the result.

`brain raw POST /api/query` is the escape hatch — it returns the raw fold_db state including tombstoned rows.

## Recovery

`brain reindex` repairs named list-page keys. It does not walk the corpus.

```bash
brain reindex --target all --source-hash concept --slug my-slug
brain reindex --target tag#dogfood --source-hash concept --slug my-slug
```

One call names one target, one source type, and at most 25 slugs. It reads those product records by key and writes the page with a conditional write. The cursor advances after that write succeeds.

What it does not do:

- It does not walk every record.
- It does not purge embeddings left behind by `brain delete`.
- It does not change tombstone semantics.

Run with the global `--verbose` flag to print the node calls. Pollution measurement stays on `brain doctor --freshness`. See [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md).

## MCP

brain ships an MCP (Model Context Protocol) server so AI agents — Claude Code, Codex, and any other MCP client — can read **and write** the brain in-process without shelling out. Ten tools across G6 read + G6-write scope: `brain_search`, `brain_ask`, `brain_get`, `brain_list`, `brain_backlinks`, `brain_put`, `brain_status`, `brain_append`, `brain_delete`, `brain_link`.

> **Heads up — the agent surface (`brain-mcp`) graduates to a scoped app.** This
> README's install (`bun add -g github:EdgeVector/brain` today; `npm i -g brain`
> once published) covers the
> **human** `brain` CLI, whose `init`/consent run as the node *owner* under any
> app model. The steady-state *agent* surface (`brain-mcp`) is moving to a
> sandboxed, scoped app (**model C**, tracked by the *brain sandboxed-app
> design* in brain) — its distribution + connection path is governed by that
> migration, not by this CLI install. Until that lands, the `brain-mcp` bin
> ships alongside the CLI (so the wiring below works today), but treat its
> distribution as provisional. Look it up with
> `brain search "brain sandboxed scoped app model C"` for the current design.

```bash
# One-shot agent wiring (one-time, after installing brain in the Quick start):
brain mcp install        # verifies the entrypoint, registers brain with
                          # Claude Code, appends the agent-instructions block,
                          # and installs the SessionStart hook — safe to re-run

# Or run the server standalone (useful for testing with @modelcontextprotocol/inspector):
brain-mcp
```

`brain mcp install` (alias `brain mcp setup`) collapses the manual setup into one command — it's the recommended path. Pass `--yes` to skip the confirmation prompt (e.g. in scripts), `--claude-md <path>` to target a different instructions file, or `--claude-settings <path>` to target a different Claude Code settings file for the SessionStart hook. If `claude` isn't on your `PATH` it prints the exact `claude mcp add` command for you to run; if `brain-mcp` isn't on `PATH` yet it tells you to (re)install brain (`bun add -g github:EdgeVector/brain`, or `bun link` from a contributor checkout) first. Verify with `brain doctor --mcp`.

Prefer to wire it by hand (or already have part of it set up)? The main manual steps `install` runs for you are:

```bash
claude mcp add brain brain-mcp       # register the MCP server with Claude Code
brain mcp instructions >> CLAUDE.md   # tell your agent to USE it (see below)
# add this to .claude/settings.json hooks.SessionStart:
# { "matcher": "startup", "hooks": [{ "type": "command", "command": "brain hook session-start" }] }
```

Installing brain (Quick start step 1 — `bun add -g github:EdgeVector/brain`, or `bun link` from a contributor checkout) put `brain-mcp` on your `PATH` alongside `brain`, so this command works from any directory and survives moving or deleting any clone. `brain doctor` verifies this for you — its `mcp-entrypoint` check PASSes with the resolved path when `brain-mcp` is on `PATH`, and WARNs (without failing the verdict) with a re-link hint when it isn't, so a silently-broken agent integration is visible instead of surfacing only at agent-call time.

**"My agent can't reach brain"? Run `brain doctor --mcp` first.** The default `mcp-entrypoint` check only *resolves* `brain-mcp` on `PATH` — it PASSes even if the server crashes on boot, hangs, or serves the wrong tool set. `brain doctor --mcp` actually *boots* the resolved entrypoint, completes the JSON-RPC handshake, and asserts the full agent surface, printing e.g. `[PASS] mcp-boot — brain-mcp booted + served the full agent surface — tools=10`. That is the end-to-end proof your agent integration works; it's the recommended first troubleshooting step (resolve vs. boot), ahead of the manual smoketest below.

> **From a source checkout without `bun link`?** Use the path-based form from the repo root: `claude mcp add brain bun "$(realpath src/mcp/main.ts)"`. This bakes an absolute path to the clone into the MCP config — move or delete the clone and the registration breaks.

The server speaks MCP over stdio, reads `~/.brain/config.json` at startup, and re-uses the CLI's existing command functions in-process. See [`docs/mcp-smoketest.md`](docs/mcp-smoketest.md) for end-to-end verification (ask Claude to search, put, delete, link).

**Registered, but is your agent actually *using* it?** The ten tools sit idle unless your agent knows when to reach for them. Wire the brain into your agent in one step — `brain mcp instructions` prints the copy-paste `CLAUDE.md` block (the agent usage-loop + the record-type table) to stdout, nothing else, so you can append it straight in:

```bash
brain mcp instructions >> CLAUDE.md   # append to your agent's instructions
brain mcp instructions | pbcopy       # or copy it to the clipboard
```

The block instructs the agent to recall before answering (`brain_ask`), checkpoint settled decisions as it goes (`brain_put`), and pick the right record type. One command closes the "installed but unused" gap. (The same block is rendered in [`docs/agent-instructions.md`](docs/agent-instructions.md) with extra context; a drift test keeps the two in sync.)

| Tool | Input | What it does |
|---|---|---|
| `brain_search` | `query` + `type?` + `limit?` + `exact?` + `min_score?` | Pure-vector semantic search; same dedupe + stale-skip as `brain search`. Description points agents to `brain_ask` for hybrid recall |
| `brain_ask` | `query`/`question` + `type?` + `limit?` | Hybrid retrieval (BM25 + vector fused via RRF) — the eval-winning recall primitive; mirrors `brain ask`. `question` is accepted as an alias for `query` (the param agents naturally guess). No API key needed (LLM query expansion off by default) |
| `brain_get` | `slug` + `type?` | Print one record; ambiguous bare slugs use the same deterministic read precedence as `brain get` |
| `brain_list` | `type?` + `status?` + `tag?` + `limit?` | Newest-first list with filters |
| `brain_backlinks` | `slug` + `type?` | List records linking to a slug through explicit stored edges or `[[slug]]` body references. Does not require the target to exist |
| `brain_put` | `slug` + `type?` + `title?` + `body?`/`body_path?`/`body_b64?` + `status?` + `tags?` + `frontmatter?` + `allow_shrink?` | Upsert a record (FULL replace). Synthesizes frontmatter from structured args or passes through raw `frontmatter`. One of `type` or a `type:` field in `frontmatter` is required — no silent default (matches CLI `put`). Unless the body is a short single line, pass `body_path` (a staged file) or `body_b64` instead of inlining `body` — an inline `body` with newlines, quotes, or emoji can fail to parse (an opaque `could not be parsed as JSON` error) or be dropped before reaching the server at ANY size (seen as small as ~250 bytes), not just large bodies; the recovery hint on a dropped call explicitly names `body_path`. Guarded against data loss: a re-put that would shrink an existing body dramatically (or clear it to empty) is refused unless `allow_shrink: true` — use `brain_append`/`brain_status` instead |
| `brain_status` | `slug?` + `status?` + `type?` | Two modes keyed on `slug`. With NO `slug` → returns the node/overall status (reachable? provisioned? version/uptime) as a READ — a bare `brain_status {}` is a node health check. With `slug` + `status` → changes ONLY that record's status without a full re-put (validated against the type's enum, preserves the body). Without `type`, errors on ambiguous slug |
| `brain_append` | `slug` + `chunk?`/`chunk_path?`/`chunk_b64?` (or put-style aliases `body?`/`body_path?`/`body_b64?`) + `type?` + `raw?` | Append a chunk to a record's body without a full rewrite. `text` and `body` are accepted as aliases for `chunk`, and `body_path`/`body_b64` alias `chunk_path`/`chunk_b64`; `chunk*` remains canonical. Reads the full body server-side (no get-window truncation) and can only GROW it, so it never trips the shrink guard. Without `type`, errors on ambiguous slug |
| `brain_delete` | `slug` + `type?` | Soft-delete a record (tombstone tag). Without `type`, errors on ambiguous slug |
| `brain_link` | `from_slug` + `to_slug` + `from_type?` + `to_type?` | Link records. Pass just `{from_slug, to_slug}` for the legacy task → design pair; `from_type`/`to_type` default to `task`/`design`. Other pairs store a generic explicit link tag on the source |

Single-user trust at stdio — no MCP auth layer. The server inherits the CLI's `~/.brain/config.json` credentials (your `userHash`), so every write is attributed to you. If you put brain behind a remote MCP transport one day, you'll want a real auth story first.

## Performance

Every brain call funnels into one of a few fold_db access patterns, each with
a different cost curve. The table below maps each call to its complexity,
current as of the fold_db bench baseline captured 2026-06-29/06-30
(`fold/fold_db/crates/core/benches/baseline/baseline.json` in the `fold`
monorepo — the source of truth the CI regression guard compares against).

| Call | Underlying access | Complexity | Measured (M4 Max) |
|---|---|---|---|
| `brain get` / `brain_get` (known slug) | per-key Sled read via the canonical-key secondary index | O(1) | ~35–100µs, flat from 1K to 100K+ records |
| `brain list --type/--tag/--status` / `brain_list` (filtered) | schema-keyed secondary index scan | O(result size) | ~550µs, flat regardless of corpus size (the prior full O(corpus) scan was retired by fold #1026) |
| `brain list` (no filter) | secondary-index scan whose result is the whole corpus | O(corpus) | ~1ms @1K, ~11ms @10K — linear by design, since you asked for every record |
| `brain ask` / `brain_ask`, `brain search` / `brain_search` — unscoped (no `--type`) | ANN/HNSW traversal over the full embedding pool | O(log N) | ~4ms @120K fragments, vs ~46ms for the exact brute-force scan it replaced |
| `brain ask` / `brain_ask`, `brain search` / `brain_search` — scoped to one or more `--type` | exact cosine scoring over the scoped subset only (HNSW is only built over the unscoped pool) | O(scoped subset size) | fast in practice since a type-scoped subset is normally a small slice of the full brain |
| `brain put` / `brain_put` (create or update) | per-key write; only changed fields are re-serialized | O(changed fields) | tens of µs to low ms; does not grow with corpus size |
| `brain delete --tag` (bulk) | filter-mode scan over a `list`-style selector | O(matches) | scales with the filtered set, not the whole brain |

Headline fixes behind these numbers: keyed reads moved from O(field
cardinality) to O(1) (fold #905), the per-schema record listing gained a
secondary index (fold #1026), and the embedding sidecar gained an HNSW path for
unscoped search (landed 2026-06-26) that's roughly 10x faster than the exact
scan it replaced at 120K fragments. This table is a translation of those
numbers into brain's call surface, not a re-derivation — see
`fold/fold_db/crates/core/benches/baseline/README.md` for the bench
methodology and the regression-guard CI job that keeps these numbers honest.

**Practical guidance:**
- Prefer a known-slug `get` over `search`/`ask` whenever you have the slug — it's the cheapest call by a wide margin and never gets slower as the brain grows.
- `ask`/`search` stay in the single-digit-millisecond range well past 100K records, so there's no need to economize on retrieval calls — recall first, as the agent loop above recommends.
- The one pattern that gets more expensive as a brain grows is an unfiltered `list` — scope it with `--type`/`--tag`/`--status` (or the equivalent MCP filters) unless you actually want the entire corpus back.

## Architecture

`brain` is a thin **two-service client** that splits across local + cloud:

```
brain CLI (TypeScript / Bun)
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
dev is targeted by `brain init --schema-service-url <dev URL>` and the
integration test harness. brain holds only the schemas, the CLI parsing, and
the error-message layer.

Power users contributing to fold itself can still point at a worktree-local
schema service with `--node-url` / `--schema-service-url` on `brain init`
(e.g. when running `./run.sh --local --local-schema` from a fold checkout).

## Troubleshooting

Top errors you'll hit and the fix:

- **Remote writes require approval**
  Ask the target node owner to approve access, then run `brain init`.
  Local writes authenticate through the configured owner socket.

- **First write is slow (~5s) the first time on a headless / SSH / locked-keychain box, then fast after**  
  brain stores its capability in the macOS login keychain (best protection against co-resident exfiltration). When there's no GUI to answer a keychain-authorization prompt (SSH, CI, an automation agent, or a never-unlocked login keychain), the `security` call can't complete — every keychain call is bounded by a short timeout (via the `@lastdb/app-sdk` capability store) and transparently falls back to a `0600` file under `~/.brain/capabilities/` instead of hanging (a pre-SDK `~/.brain/capabilities.json` entry is still read and migrated). You'll see a one-time ~5s pause on that first write; subsequent writes read the cached file and are fast. To skip the keychain entirely on such hosts, set `BRAIN_FORCE_FILE_KEYCHAIN=1`.

- **The local node socket is unreachable**
  Run `lastdb status` and check the configured LastDB service.
  Set `LASTDB_HOME` or `BRAIN_FOLDDB_SOCKET` to select the intended owner socket.

- **`error: Node not set up — run \`brain doctor\` for a full diagnosis.`**  
  The node is running but not provisioned. Run `brain init`.

- **`error: Node rejected /api/mutation: schema collision (canonical hashes …); brain config out of date — run \`brain init\` — run \`brain doctor\` for a full diagnosis.`**  
  Schema definitions have moved on since your config was written (likely because `schemas.ts` changed). Re-run `brain init` — it's idempotent and refreshes the canonical hashes.

- **`error: Config not found at ~/.brain/config.json. Run \`brain init\` first.`**  
  You haven't initialised brain yet. Run `brain init`.

- **`error: Node rejected POST /api/setup/bootstrap with 410 — already provisioned …`**  
  The daemon is in a contradictory state — `/api/system/auto-identity` says "not provisioned" but `/api/setup/bootstrap` says "already provisioned". This typically happens on a second-user dogfood machine where the node's `config/` carries over from a previous install. Recovery: (a) if you still have `~/.brain/config.json` from when this node was working, re-run `brain init` — it reuses the saved `userHash` and continues; (b) follow the node's own message (POST `/api/auth/restore` with the recovery phrase, if you have one); (c) for a clean slate, stop the daemon, `rm -rf ~/.lastdb/config/` (or `$LASTDB_HOME/config/`), restart, then re-run `brain init`. (The error hint itself prints the resolved path for your node.)

- **Semantic search is unavailable**
  Run `lastseek status` and `lastseek doctor` to inspect the index and model.
  Use `brain search "<query>" --verbose` to inspect the selected search path.

When in doubt, `brain doctor` will tell you exactly which check is failing and what to do.

## Tests

The tests were deleted on 2026-10-09. The merge gate runs the shell syntax check, a frozen install, and the typecheck.

```bash
bun run typecheck  # strict tsc --noEmit
```

## Graph adjacency boost

Phase 3 of the knowledge graph adds a second ranking signal to `brain ask`: a
record adjacent in the typed edge graph to a record the text rankers already
ranked highly gets a bounded score increment. It answers the query class the
hybrid ranker cannot — the decision a design settled, the proof a task
produced — because those records answer a question about a topic while using
almost none of that topic's words.

It is **off by default**. The synthetic evaluation scripts and datasets were
deleted on 2026-10-09 under the no-tests policy. The default remains unchanged.

```bash
brain ask "<query>" --graph-boost              # turn it on for one query
brain ask "<query>" --graph-boost --explain    # ...and show what the graph moved
BRAIN_GRAPH_BOOST=1 brain ask "<query>"        # ...or for a whole shell
```

Cost and safety, by construction:

- **Bounded reads.** Only the top `--graph-boost-seeds` hits (default 3) seed
  the walk, and the walk is exactly one hop, so the boost adds at most two
  keyed range reads per seed no matter how large the graph is.
- **Ranking, not recall.** A neighbour that no ranker retrieved is never
  injected — the boost only re-orders candidates that already matched.
- **A ceiling.** A boosted record is clamped to the score of the best-ranked
  seed that vouched for it, so the graph can lift a record to just under its
  seed but never above it.

## Project status

Brain is the LastDB knowledge CLI. CRUD across all record types, multi-type schemas, semantic/hybrid retrieval (`search` + `ask`), soft delete, `doctor`, and the MCP agent surface are shipped.

## Out of scope for v0

- Not E2E-encrypted
- Not running new fold_db core code
- No git-to-brain sync
- No compiled standalone binaries — brain runs as a Bun-runtime CLI (`bun add -g github:EdgeVector/brain` today; `npm i -g brain` / `bunx brain` once published to npm)

<!-- lastgit-era-3 cutover proof commit, lastgit-era-3-builder run 34, 2026-09-27 -->

## Standard canonical vocabulary

`src/canonical-fields.json` defines the standard names, descriptions, and types for schema publication.
The app keeps its local command field names.
A schema-specific field map translates those names for the stored canonical identity.
The map leaves values, record keys, cursors, and file references intact.

A fresh home submits these definitions through normal schema declarations.
The schema service checks names, definitions, types, and concept reuse for every caller.
No special vocabulary key or operator approval path exists.
An existing config without a field map keeps its current schema identities and declaration path.
An explicit data migration must precede a change to those identities.
This change does not perform that migration.

Date fields use `DateTime` when the current wire value is an RFC 3339 instant.
Decimal text and optional date text keep explicit text definitions.
This change does not infer value conversions from a field name.

Current Mini stores attachment bytes through the local file command.
A separate mapped mutation stores the complete native pointer in its `Any` field.
This path needs no cloud account. Legacy configs use it on current Mini.
Older nodes without this command keep their previous attachment command.
