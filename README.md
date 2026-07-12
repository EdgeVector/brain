# brain

A CLI named `brain` that uses fold_db as the storage engine for a personal brain. Ten record types — **design**, **task**, **concept**, **preference**, **reference**, **agent**, **project**, **spike**, **sop**, **decision** — with semantic search, an `ask` answer command, an MCP agent surface, and a Phase 3 sharing probe. The old `fbrain` binary remains as a compatibility alias during the migration.

## Prerequisites

You only need two things to **download and use** brain — Bun and a running
`fold_db_node`. No Rust toolchain, no building from source.

- **Bun** ≥ 1.3.10 — `bun --version`. brain ships as a Bun-runtime CLI, so Bun is the only thing you install to *run* it — `bun add -g github:EdgeVector/brain` puts the `brain` and `fbrain` bins on your PATH and runs them under Bun, in one command, straight from the public repo (no clone, no Rust, no compile). (A registry one-liner is the future steady-state once the package is published to npm; it's not required to install today. See Quick start step 1.)
- **A running `fold_db_node`** — install the prebuilt daemon from the [`edgevector/lastdb` Homebrew tap](https://github.com/EdgeVector/homebrew-lastdb) (no Rust toolchain, no compile step):
  ```bash
  brew install edgevector/lastdb/lastdb   # taps + installs `lastdb` and `lastdb_server`
  brew services start lastdb              # launchd: runs `lastdb_server --port 9001` with keep_alive
  curl -s http://127.0.0.1:9001/api/health   # verify; expect {"ok":true,...}
  ```
  brain defaults to this daemon at `http://127.0.0.1:9001`. After a `brew upgrade lastdb`, run `brew services restart lastdb` so the new binary takes over the port. (Prefer a foreground daemon for a quick try? `lastdb daemon start` also works — `brew services` is just the keep-alive launchd path that survives crashes and reboots.)
- **Network access to the schema service** — brain registers its schemas with the prod cloud Lambda at `https://axo709qs11.execute-api.us-east-1.amazonaws.com`. There is **no local schema_service to run**. (Iteration/CI uses the dev Lambda at `https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com`.)

> **Contributing to fold_db itself?** Instead of the Homebrew binary you can run a worktree-local node from source with `./run.sh` — that path *does* need a Rust toolchain and a multi-minute cold build the first time (cargo `target/` is shared once warmed). Point fbrain at the auto-slotted port with `fbrain init --node-url http://127.0.0.1:<slot>`; `fbrain init` prints a "compiling Rust — give it a few minutes" hint and retries while the node comes up. Override either endpoint with `--node-url` / `--schema-service-url` on `fbrain init`.

## Quick start

From a clean machine to your first record in a few minutes (most of it is the
one-time installs):

```bash
# 0. install + start lastdb (one-time; prebuilt binary, no Rust)
brew install edgevector/lastdb/lastdb
brew services start lastdb            # launchd: serves :9001, restarts on crash
curl -s http://127.0.0.1:9001/api/health   # verify; expect {"ok":true,...}

# 1. install the brain CLI (one-time) — ONE command, straight from GitHub.
#    No clone, no Rust, no compile; exposes the `brain` + `fbrain` bins.
bun add -g github:EdgeVector/brain
brain --version                       # verify it's on PATH

# 2. bootstrap
brain init                            # 6 steps; writes ~/.brain/config.json
                                      # (auto-heals a stale local-schema config
                                      #  to the new cloud-Lambda default)
```

> **One command, no npm publish.** `bun add -g github:EdgeVector/fbrain` installs
> the CLI directly from the already-public GitHub repo — no registry, no clone, no
> `bun link`. `bunx github:EdgeVector/brain <cmd>` works too for a one-off run.
> (A future registry install is the intended steady-state once the package is on
> npm; tracking: Tom's `npm publish` follow-up. It's not required to install
> today.)
>
> **Contributing to brain itself?** Clone + `bun link` instead, so your edits run
> live: `git clone https://github.com/EdgeVector/brain && cd brain && bun install
> && bun link` puts the `brain` (+ compatibility `fbrain`) bins on your PATH,
> pointed at your checkout. Everything below works the same whichever install
> you used.

### One-time consent grant (handled by `init`)

fbrain is an **app** under fold_db's app-identity model: the node owner (you)
approves fbrain acting on your data with a one-time consent grant. **`fbrain init`
now does this inline as its final step**, so the happy path needs no second
terminal. After registering schemas, `init` prints:

```
[6/6] establishing consent (one-time grant for fbrain's namespace)
fbrain wants read/write access to its namespace on this node. Grant now? [Y/n]
```

Press `y` and `init` shells out to `lastdb consent grant fbrain --yes` for you
(the `lastdb` CLI ships in the same Homebrew formula, so it's already on your
PATH; older installs that only have the `folddb` compat shim still work), then
waits until the capability is cached in your keychain. When `init`
returns you have a ready-to-write capability — your first `fbrain put` /
`design new` lands immediately. Re-running `init` is idempotent: it skips the
prompt when a live capability already exists. (Running a local/dev node with
`APP_IDENTITY_ENFORCE` off? Set `FBRAIN_APP_IDENTITY_ENFORCE=off` to skip
consent entirely; init still resolves the same namespaced `fbrain/*` schema
hashes from the node, and writes land as NodeOwner with no capability headers.)

**Scripted / CI / agent install (no TTY).** Pass `--grant-consent` and `init`
runs the same handshake non-interactively — request-consent, shell out to
`lastdb consent grant fbrain --yes`, poll until the capability is cached —
so the very next `fbrain put` lands without a second terminal:

```bash
brew install edgevector/lastdb/lastdb
brew services start lastdb
bun add -g github:EdgeVector/fbrain              # one-command, registry-free install

fbrain init --grant-consent </dev/null         # ready-to-write in one shot
echo "hello scripted brain" | fbrain put my-first-note --type concept
```

> Once fbrain is published to npm, the install line above can also be written
> `npm i -g fbrain`; the `bun add -g github:` form works today against the public
> repo with no registry.

> **No node up yet? Non-interactive `init` fails fast.** When `init` runs
> without a TTY (the CI / agent / scripted path above) and the node is
> unreachable, it prints the actionable node-down hint on the first probe and
> exits non-zero within a few seconds — it does **not** sit through the long
> retry budget, since an unattended caller can't start the daemon mid-wait.
> (Interactive runs keep the full ~3-minute budget for the from-source
> contributor watching a Rust cold build.) To override the schedule explicitly
> — e.g. extend the wait in CI while an ephemeral node boots, or disable
> retries entirely — set `FBRAIN_INIT_RETRY_DELAYS_MS` to a comma-separated
> list of inter-probe gaps in ms (`FBRAIN_INIT_RETRY_DELAYS_MS=` empty = zero
> retries, fail on the first probe).

The flag is idempotent (no-op when a live capability already exists) and a
friendly no-op under `FBRAIN_APP_IDENTITY_ENFORCE=off` (no capability needed
in that mode — writes land as NodeOwner).

**Fallback — granting from a second terminal.** You'll only hit this if you
declined `init`'s prompt, ran `init` non-interactively without
`--grant-consent`, or your capability was later revoked. In those cases the
next write stalls with:

```
First-run setup — run: `lastdb consent grant fbrain` in your terminal.
Waiting for you to grant access to this node (polling every 2s)…
```

Re-run `fbrain init` and accept the grant, or approve it once in a second
terminal:

```bash
lastdb consent grant fbrain           # review the request, then `y` (or pass --yes)
```

The waiting command then unblocks and the write lands.

```bash
# 3. drive it
fbrain design new my-first-design --title "First design" --tag spike --body "the body that gets embedded"
fbrain task new t1 --design my-first-design --title "first task" --body "what this task covers"
# Note: with no --body, `<TYPE> new` reads the body from stdin only when stdin is piped/redirected (non-TTY); in an interactive terminal it creates an empty body. Prefer --body, pipe a body in, or set FBRAIN_NO_STDIN=1 to skip the stdin read.

# Or pipe a markdown note with frontmatter (idempotent upsert — re-put updates in place):
cat <<'NOTE' | fbrain put my-second-design
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
| `brain <TYPE> new <slug> [--title T] [--tag T]… [--body STR] [--force]` | Creates a record of any of the 10 types: `design`, `task`, `concept`, `preference`, `reference`, `agent`, `project`, `spike`, `sop`, `decision`. Status defaults to the type's first enum value |
| `brain task new <slug> [--design D] …` | Extra: `--design <slug>` links the new task to a parent design (rejects a dangling slug) |
| `brain put <slug> [--type T]` | Upserts a record from stdin (YAML frontmatter aware). One of frontmatter `type:` or `--type` is required — there is NO silent default. `--type` overrides absent frontmatter and errors on disagreement. Re-puts update in place — no `--force`, no 409 |
| `brain get <slug> [--type T] [--field PATH]…` | Prints a record by slug. Without `--type`, queries every type; on an ambiguous slug it picks a deterministic read precedence (reference before project) so common agent reads do not need a retry. `--field` projects plain values without JSON parsing |
| `brain list [--type T] [--status S] [--tag T] [-n N] [--field PATH]…` | Lists records, newest-first. `--field` projects one TSV row per record |
| `brain status <slug> [<new>] [--type T]` | Reads or updates a record's status (per-type enum validation) |
| `brain link <from-slug> <to-slug> [--from-type T] [--to-type T]` | Links records. Defaults to legacy Task → Design (`task.design_slug`); non-legacy pairs store a generic explicit link tag on the source |
| `brain backlinks <slug> [--type T]` | Lists records linking to a slug through explicit edges or `[[slug]]` body references; reads the backlink secondary index instead of scanning every schema |
| `brain search <query> [-n N \| --limit N] [--exact] [--min-score F] [--type T]…` | Semantic search; dedupes fragments per record, skips stale hits. Repeatable `--type` scopes results to one or more record types (e.g. `--type design --type task` to exclude noisy concept streams). `-n` and `--limit` are aliases. Pure-vector, so a brand-new write may take ~1s to land in the index — reach for `ask` when you need to retrieve something you just wrote |
| `brain ask <query> [-n N \| --limit N] [--expand\|--llm] [--explain] [--type T]… [--field PATH]…` | Hybrid retrieval: BM25 + vector fused via Reciprocal Rank Fusion. **No LLM call by default** — the [2026-05-25 labeled eval](docs/g0-replacement-readiness-gate.md#8-status-snapshot--2026-06-06) showed LLM query expansion *reduced* relevance (P@5 0.59 vs 0.73), so it is opt-in via `--expand` (alias `--llm`). The default path is the eval winner, fastest, and needs no API key. Wider recall than `search` — paraphrase via vector, rare-token / acronym matches via BM25. Repeatable `--type` narrows both the BM25 corpus and the vector schemas filter. `--field` projects plain values from result rows. `-n` and `--limit` are aliases; `--no-llm` is accepted as a back-compat no-op |
| `brain doctor [--freshness] [--write] [--mcp] [--json] [--usage]` | Live health check: reachability, provisioning, schemas-loaded, schema drift. `--freshness` adds the G3 freshness + pollution probes; `--write` adds an idempotent `put → get → soft-delete` round-trip that proves writes actually land; `--mcp` boots the `fbrain-mcp` compatibility entrypoint and asserts the full 10-tool agent surface (the strongest agent-integration check — see [MCP](#mcp)); `--json` emits machine-readable output; `--usage` prints team-adoption write counts by userHash over the last 7 days (see [Doctor](#doctor)) |
| `brain raw <method> <path> [body]` | Authenticated passthrough to node (`/api/…`) or schema service (`/v1/…`) |
| `brain share` | Placeholder. Prints a pointer to the Phase 3 memo and exits 1 (see [Sharing](#sharing)) |
| `brain delete <slug> [--type T]`<br>`brain delete --tag T [--type T] [--status S] [--yes]` | Soft-deletes a record (or, in filter mode, every live record matching the `list`-style selector — dry-run by default, `--yes` to apply). fold_db is append-only — the workaround stamps a tombstone tag so every brain read path treats the record as gone (see [Delete](#delete)) |
| `brain reindex [--type T] [--dry-run] [--tags] [--backlinks]` | Re-puts every live record so fold_db refreshes its embedding entry, or rebuilds secondary indexes with `--tags` / `--backlinks` (see [Recovery](#recovery)) |
| `brain migrate --add-field <type> <field> <spec> [--default V] [--dry-run]` | Evolves a schema by adding a field: registers the new schema, re-puts every record with the default, atomically swaps `~/.brain/config.json`. Also `--status` (default; list manifests) and `--resume <id>` (continue an interrupted run). See [docs/g15-schema-evolution-playbook.md](docs/g15-schema-evolution-playbook.md) |
| `brain mcp` | Start a Model Context Protocol server over stdio. Exposes 10 tools to MCP clients (Claude Code, Codex, …) — read: `fbrain_search`, `fbrain_ask`, `fbrain_get`, `fbrain_list`, `fbrain_backlinks`; write: `fbrain_put`, `fbrain_status`, `fbrain_append`, `fbrain_delete`, `fbrain_link` — so agents can read and mutate the brain in-process (see [MCP](#mcp)) |

Run `brain help <command>` for per-command usage. `fbrain` remains an alias.

### Field projection

The read commands `get`, `list`, and `ask` accept `--field PATH` when a script
or agent needs one or a few values and should not parse `--json` inline. Repeat
the flag or pass comma-separated paths for TSV rows:

```bash
fbrain get my-note --field status
fbrain get my-note --field slug,status
fbrain list --type task --field slug,status
fbrain ask "release gate" --field slug,type,title
```

Paths use the command's existing JSON payload shape, with dot paths and array
indexes such as `tags[0]`, `extra_fields.program`, or `linked_from[0].slug`.
Scalar arrays print as comma-joined values; missing paths print as empty cells.

## Record types

Not sure which type to reach for? The **Use it for** column is the one-line
answer for each — the same strings the bare `fbrain` help prints, sourced from
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

Each of the six Phase 6 types gets its own dedicated schema with a distinct `descriptive_name` + `purpose_statement`. We originally landed a single combined schema (`FbrainKindNote`) plus a `kind` discriminator as a workaround for fold_db's structural canonicalization (the node merged schemas with overlapping field positions during `/api/schemas/load`, making the second schema's data inaccessible). As of Phase E (PR #63, dual-signal canonicalization cutover) the schema service consults the purpose-statement embedding alongside the structural signal, so distinct purpose statements veto the merge and all six can share the same 7-field shape without colliding onto one canonical hash. The combined-schema workaround was retired; the consolidation migration moved every pre-Phase-E row into its per-kind canonical, and the legacy `FbrainKindNote` schema is no longer registered or read.

Slug uniqueness is now per-type — a `concept` and a `preference` can share the slug `foo`. `fbrain get` is read-only, so when invoked without `--type` on a slug that resolves in more than one schema it returns a deterministic winner by type precedence (starting with `reference`, then `project`); pass `--type` to override. Mutating or destructive flows (`fbrain status`, `fbrain delete`) still error with `Slug "X" exists in multiple schemas (concept, preference). Specify --type.` so you re-issue with `--type` before changing anything.

Default status on create (used when frontmatter omits `status:`): first value of each enum (so `active` for most types, `planning` for project, `draft` for design, `open` for task).

Every type has an ergonomic `<type> new` verb:

```bash
fbrain concept new idempotency --title "Idempotency" --body "mutations are keyed by canonical hash"
fbrain preference new no-emojis --title "No emojis in code" --body "keep code comment-free of emojis"
fbrain spike new vectors-eval --title "Evaluating vector ranker quality" --body "measure ranker precision/recall"
fbrain sop new pr-merge-flow --title "Driving a PR to merged" --body "the step-by-step we follow on every PR"
# …same shape for reference / agent / project / spike / sop
```

Or pipe a body (with optional YAML frontmatter) through `fbrain put`:

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
[WARN] single-machine-slice  — you're on this daemon; record set is local — multi-machine reads require fbrain to drive fold_db's sync transport (deployed but not yet wired up from fbrain; tracked as G16)
[WARN] no-team-sync  — no team-sync transport — `fbrain share` is a placeholder until cloud sync is signed in and validated end-to-end

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
[WARN] single-machine-slice  — you're on this daemon; record set is local — multi-machine reads require fbrain to drive fold_db's sync transport (deployed but not yet wired up from fbrain; tracked as G16)
[WARN] no-team-sync  — no team-sync transport — `fbrain share` is a placeholder until cloud sync is signed in and validated end-to-end

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

**This is a sign-in gap, not a missing-infra gap.** Both halves of the transport are built and deployed: fold_db's sync engine (`fold_db/crates/core/src/sync/engine.rs` — `local Sled → SyncEngine → Auth Lambda → S3`) and the exemem cloud stack (`exemem-infra/lambdas/` — auth, discovery, storage, etc., live in dev us-west-2 and prod us-east-1). The homebrew daemon at `:9001` reports `GET /api/sharing/exemem-status → {"connected": false}` because nobody has signed it in yet; the sync engine has somewhere to talk to as soon as a cloud session exists. See [`docs/cloud-signin-spike-plan.md`](docs/cloud-signin-spike-plan.md) for what it would take to light up the positive end-to-end test.

`fbrain share` is currently a placeholder: it prints a pointer to the memo and exits non-zero. A real implementation drives `POST /api/sharing/rules` + `POST /api/sharing/invite` + `POST /api/sharing/accept`, gated on `exemem-status.connected == true`.

Read [`docs/phase-3-sharing-memo.md`](docs/phase-3-sharing-memo.md) for the full evidence: every endpoint with its captured request/response JSON, what worked, what didn't, and exactly what a real two-device test would require.

## Delete

fold_db's mutation pipeline is documented as append-only — `MutationType::Delete` writes a sync-log marker but does not remove molecule entries on local storage. `POST /api/mutation` with `mutation_type=delete` therefore returns `{ok: true, success: true}` but the record is still present on every read path. **This is documented behavior, not a bug** (see fold_db's own `apple_consolidation.rs`).

`fbrain delete` works around this at the fbrain layer:

1. Resolves `--type` the same way `fbrain get` does (probes both schemas if omitted; errors on ambiguous slug).
2. Fires an `update` mutation that overwrites every user field with sentinel values (`title="(deleted)"`, `body=""`, `status="archived"|"cancelled"`, `tags=["__fbrain_deleted__"]`, `design_slug=""` for tasks).
3. Fires the fold_db `delete` mutation for forward-compat (when fold_db ever grows a real hard-delete, this call starts mattering).
4. Verifies by reading the record back and asserting the tombstone tag is present. If verification fails, errors with `delete_not_applied`.

Every fbrain read path (`get`, `list`, `status`, `link`, `search`) filters tombstoned records via `findBySlug`, so the user-visible behavior matches a hard delete. The slug is also reusable: `fbrain design new <same-slug>` (no `--force`) recreates it cleanly.

### Bulk delete (filter mode)

To purge a batch of throwaway records in one command, `fbrain delete` also accepts the SAME `--tag`/`--type`/`--status` selectors `fbrain list` does, as an alternative to a positional `<slug>`:

```bash
fbrain delete --tag dogfood                 # DRY-RUN: preview what would be deleted
fbrain delete --tag dogfood --yes           # actually soft-delete every match
fbrain delete --tag probe --type concept --status archived --yes
```

- **Dry-run by default.** Without `--yes`, filter mode lists the records that *would* be deleted (`type · slug · title`) plus a count and exits without mutating — so you can confirm the set before committing. Re-run with `--yes` to actually delete.
- **Same set as `list`.** Filter mode resolves matches via the identical path `fbrain list --tag/--type/--status` uses, so already-tombstoned records are excluded and a `list` preview matches what `delete` will remove.
- **Bounded selector required.** A bare `fbrain delete` (no slug *and* no filter) is refused — it would otherwise select every record. A `<slug>` and a filter together is also rejected (pick one mode).
- **Per-record referential integrity.** The design-with-live-tasks guard is honored per record: a linked design is skipped with a warning (the rest of the batch proceeds) unless you pass `--force`.
- **`--json`** in filter mode emits `{ok, deleted: [{type, slug}], dryRun}` so scripts and agents can consume the result.

`fbrain raw POST /api/query` is the escape hatch — it returns the raw fold_db state including tombstoned rows.

Read [`docs/phase-5-delete-spike.md`](docs/phase-5-delete-spike.md) for the full source-code references, probe transcripts, and the fold_db follow-up that's been filed.

## Recovery

If `fbrain search` starts returning stale or empty results — most often after a batch of `fbrain delete` calls, or when the homebrew daemon hosts non-fbrain schemas alongside fbrain — run:

```bash
fbrain reindex             # all record types
fbrain reindex --type concept --dry-run   # preview what would be touched
fbrain reindex --backlinks # rebuild the backlink secondary index
```

`fbrain reindex` walks every live (non-tombstoned) record and re-issues an `update` mutation. fold_db's mutation pipeline re-runs `index_record` synchronously, which refreshes the record's embedding entry in the native index. The fresh embeddings then survive the top-50 budget even when tombstoned-but-not-purged phantoms still sit in the index alongside them.

`fbrain reindex --backlinks` is a secondary-index rebuild, not an embedding refresh. It scans the live corpus once and writes backlink membership rows so `fbrain get` / `fbrain backlinks` can answer `linked_from` from keyed index reads instead of walking every schema on each lookup. Re-run `fbrain init` first if your local config predates the internal index schema.

What it does **not** do:

- It does not purge phantom embeddings left behind by `fbrain delete`. The native index has no per-record purge API today; that fix is filed upstream as G3e against fold_db.
- It does not change tombstone semantics — tombstoned records stay tombstoned and are reported as `skipped-tombstone`.
- It does not change the search resolver's top-K logic.

Per-record outcomes (`kept | reindexed | skipped-tombstone`) are printed with the global `--verbose` flag. Pollution-ratio measurement (before/after) is intentionally deferred to `fbrain doctor freshness` (G3a). For the full root-cause analysis and the chain of recommended follow-ups, see [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md).

## Verifying

`scripts/parity-smoketest.sh` is the one-command round-trip check that backs gate item #1 in [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md). It walks hand-picked fixtures from `test/fixtures/parity/` — covering record types with frontmatter-shape and body variety — `put`s each, `get`s each back, and diffs title/body/tags/status for identity. Exits 0 on full parity; non-zero with a count of mismatches otherwise.

```bash
./scripts/parity-smoketest.sh                 # uses `fbrain` on PATH
FBRAIN="bun src/cli.ts" ./scripts/parity-smoketest.sh   # from a worktree
```

Re-running is idempotent — `fbrain put` upserts via Phase 4 semantics, so the second run re-asserts the same parity against records the first run created.

The script retries each `get` up to five times (250 ms backoff) to ride out the polluted-daemon read flake documented in [`docs/phase-7-search-latency-spike.md`](docs/phase-7-search-latency-spike.md) — same query, different result count run-to-run. That flake is a fold_db read-consistency concern; the smoketest is scoped to fbrain-side parity.

## MCP

fbrain ships an MCP (Model Context Protocol) server so AI agents — Claude Code, Codex, and any other MCP client — can read **and write** the brain in-process without shelling out. Ten tools across G6 read + G6-write scope: `fbrain_search`, `fbrain_ask`, `fbrain_get`, `fbrain_list`, `fbrain_backlinks`, `fbrain_put`, `fbrain_status`, `fbrain_append`, `fbrain_delete`, `fbrain_link`.

> **Heads up — the agent surface (`fbrain-mcp`) graduates to a scoped app.** This
> README's install (`bun add -g github:EdgeVector/fbrain` today; `npm i -g fbrain`
> once published) covers the
> **human** `fbrain` CLI, whose `init`/consent run as the node *owner* under any
> app model. The steady-state *agent* surface (`fbrain-mcp`) is moving to a
> sandboxed, scoped app (**model C**, tracked by the *fbrain sandboxed-app
> design* in fbrain) — its distribution + connection path is governed by that
> migration, not by this CLI install. Until that lands, the `fbrain-mcp` bin
> ships alongside the CLI (so the wiring below works today), but treat its
> distribution as provisional. Look it up with
> `fbrain search "fbrain sandboxed scoped app model C"` for the current design.

```bash
# One-shot agent wiring (one-time, after installing fbrain in the Quick start):
fbrain mcp install        # verifies the entrypoint, registers fbrain with
                          # Claude Code, appends the agent-instructions block,
                          # and installs the SessionStart hook — safe to re-run

# Or run the server standalone (useful for testing with @modelcontextprotocol/inspector):
fbrain-mcp
```

`fbrain mcp install` (alias `fbrain mcp setup`) collapses the manual setup into one command — it's the recommended path. Pass `--yes` to skip the confirmation prompt (e.g. in scripts), `--claude-md <path>` to target a different instructions file, or `--claude-settings <path>` to target a different Claude Code settings file for the SessionStart hook. If `claude` isn't on your `PATH` it prints the exact `claude mcp add` command for you to run; if `fbrain-mcp` isn't on `PATH` yet it tells you to (re)install fbrain (`bun add -g github:EdgeVector/fbrain`, or `bun link` from a contributor checkout) first. Verify with `fbrain doctor --mcp`.

Prefer to wire it by hand (or already have part of it set up)? The main manual steps `install` runs for you are:

```bash
claude mcp add fbrain fbrain-mcp       # register the MCP server with Claude Code
fbrain mcp instructions >> CLAUDE.md   # tell your agent to USE it (see below)
# add this to .claude/settings.json hooks.SessionStart:
# { "matcher": "startup", "hooks": [{ "type": "command", "command": "fbrain hook session-start" }] }
```

Installing fbrain (Quick start step 1 — `bun add -g github:EdgeVector/fbrain`, or `bun link` from a contributor checkout) put `fbrain-mcp` on your `PATH` alongside `fbrain`, so this command works from any directory and survives moving or deleting any clone. `fbrain doctor` verifies this for you — its `mcp-entrypoint` check PASSes with the resolved path when `fbrain-mcp` is on `PATH`, and WARNs (without failing the verdict) with a re-link hint when it isn't, so a silently-broken agent integration is visible instead of surfacing only at agent-call time.

**"My agent can't reach fbrain"? Run `fbrain doctor --mcp` first.** The default `mcp-entrypoint` check only *resolves* `fbrain-mcp` on `PATH` — it PASSes even if the server crashes on boot, hangs, or serves the wrong tool set. `fbrain doctor --mcp` actually *boots* the resolved entrypoint, completes the JSON-RPC handshake, and asserts the full agent surface, printing e.g. `[PASS] mcp-boot — fbrain-mcp booted + served the full agent surface — tools=10`. That is the end-to-end proof your agent integration works; it's the recommended first troubleshooting step (resolve vs. boot), ahead of the manual smoketest below.

> **From a source checkout without `bun link`?** Use the path-based form from the repo root: `claude mcp add fbrain bun "$(realpath src/mcp/main.ts)"`. This bakes an absolute path to the clone into the MCP config — move or delete the clone and the registration breaks.

The server speaks MCP over stdio, reads `~/.fbrain/config.json` at startup, and re-uses the CLI's existing command functions in-process. See [`docs/mcp-smoketest.md`](docs/mcp-smoketest.md) for end-to-end verification (ask Claude to search, put, delete, link).

**Registered, but is your agent actually *using* it?** The ten tools sit idle unless your agent knows when to reach for them. Wire the brain into your agent in one step — `fbrain mcp instructions` prints the copy-paste `CLAUDE.md` block (the agent usage-loop + the record-type table) to stdout, nothing else, so you can append it straight in:

```bash
fbrain mcp instructions >> CLAUDE.md   # append to your agent's instructions
fbrain mcp instructions | pbcopy       # or copy it to the clipboard
```

The block instructs the agent to recall before answering (`fbrain_ask`), checkpoint settled decisions as it goes (`fbrain_put`), and pick the right record type. One command closes the "installed but unused" gap. (The same block is rendered in [`docs/agent-instructions.md`](docs/agent-instructions.md) with extra context; a drift test keeps the two in sync.)

| Tool | Input | What it does |
|---|---|---|
| `fbrain_search` | `query` + `type?` + `limit?` + `exact?` + `min_score?` | Pure-vector semantic search; same dedupe + stale-skip as `fbrain search`. Description points agents to `fbrain_ask` for hybrid recall |
| `fbrain_ask` | `query`/`question` + `type?` + `limit?` | Hybrid retrieval (BM25 + vector fused via RRF) — the eval-winning recall primitive; mirrors `fbrain ask`. `question` is accepted as an alias for `query` (the param agents naturally guess). No API key needed (LLM query expansion off by default) |
| `fbrain_get` | `slug` + `type?` | Print one record; ambiguous bare slugs use the same deterministic read precedence as `fbrain get` |
| `fbrain_list` | `type?` + `status?` + `tag?` + `limit?` | Newest-first list with filters |
| `fbrain_backlinks` | `slug` + `type?` | List records linking to a slug through explicit stored edges or `[[slug]]` body references. Does not require the target to exist |
| `fbrain_put` | `slug` + `type?` + `title?` + `body?`/`body_path?`/`body_b64?` + `status?` + `tags?` + `frontmatter?` + `allow_shrink?` | Upsert a record (FULL replace). Synthesizes frontmatter from structured args or passes through raw `frontmatter`. One of `type` or a `type:` field in `frontmatter` is required — no silent default (matches CLI `put`). Unless the body is a short single line, pass `body_path` (a staged file) or `body_b64` instead of inlining `body` — an inline `body` with newlines, quotes, or emoji can fail to parse (an opaque `could not be parsed as JSON` error) or be dropped before reaching the server at ANY size (seen as small as ~250 bytes), not just large bodies; the recovery hint on a dropped call explicitly names `body_path`. Guarded against data loss: a re-put that would shrink an existing body dramatically (or clear it to empty) is refused unless `allow_shrink: true` — use `fbrain_append`/`fbrain_status` instead |
| `fbrain_status` | `slug?` + `status?` + `type?` | Two modes keyed on `slug`. With NO `slug` → returns the node/overall status (reachable? provisioned? version/uptime) as a READ — a bare `fbrain_status {}` is a node health check. With `slug` + `status` → changes ONLY that record's status without a full re-put (validated against the type's enum, preserves the body). Without `type`, errors on ambiguous slug |
| `fbrain_append` | `slug` + `chunk?`/`chunk_path?`/`chunk_b64?` (or put-style aliases `body?`/`body_path?`/`body_b64?`) + `type?` + `raw?` | Append a chunk to a record's body without a full rewrite. `text` and `body` are accepted as aliases for `chunk`, and `body_path`/`body_b64` alias `chunk_path`/`chunk_b64`; `chunk*` remains canonical. Reads the full body server-side (no get-window truncation) and can only GROW it, so it never trips the shrink guard. Without `type`, errors on ambiguous slug |
| `fbrain_delete` | `slug` + `type?` | Soft-delete a record (tombstone tag). Without `type`, errors on ambiguous slug |
| `fbrain_link` | `from_slug` + `to_slug` + `from_type?` + `to_type?` | Link records. Pass just `{from_slug, to_slug}` for the legacy task → design pair; `from_type`/`to_type` default to `task`/`design`. Other pairs store a generic explicit link tag on the source |

Single-user trust at stdio — no MCP auth layer. The server inherits the CLI's `~/.fbrain/config.json` credentials (your `userHash`), so every write is attributed to you. If you put fbrain behind a remote MCP transport one day, you'll want a real auth story first.

## Performance

Every fbrain call funnels into one of a few fold_db access patterns, each with
a different cost curve. The table below maps each call to its complexity,
current as of the fold_db bench baseline captured 2026-06-29/06-30
(`fold/fold_db/crates/core/benches/baseline/baseline.json` in the `fold`
monorepo — the source of truth the CI regression guard compares against).

| Call | Underlying access | Complexity | Measured (M4 Max) |
|---|---|---|---|
| `fbrain get` / `fbrain_get` (known slug) | per-key Sled read via the canonical-key secondary index | O(1) | ~35–100µs, flat from 1K to 100K+ records |
| `fbrain list --type/--tag/--status` / `fbrain_list` (filtered) | schema-keyed secondary index scan | O(result size) | ~550µs, flat regardless of corpus size (the prior full O(corpus) scan was retired by fold #1026) |
| `fbrain list` (no filter) | secondary-index scan whose result is the whole corpus | O(corpus) | ~1ms @1K, ~11ms @10K — linear by design, since you asked for every record |
| `fbrain ask` / `fbrain_ask`, `fbrain search` / `fbrain_search` — unscoped (no `--type`) | ANN/HNSW traversal over the full embedding pool | O(log N) | ~4ms @120K fragments, vs ~46ms for the exact brute-force scan it replaced |
| `fbrain ask` / `fbrain_ask`, `fbrain search` / `fbrain_search` — scoped to one or more `--type` | exact cosine scoring over the scoped subset only (HNSW is only built over the unscoped pool) | O(scoped subset size) | fast in practice since a type-scoped subset is normally a small slice of the full brain |
| `fbrain put` / `fbrain_put` (create or update) | per-key write; only changed fields are re-serialized | O(changed fields) | tens of µs to low ms; does not grow with corpus size |
| `fbrain delete --tag` (bulk) | filter-mode scan over a `list`-style selector | O(matches) | scales with the filtered set, not the whole brain |

Headline fixes behind these numbers: keyed reads moved from O(field
cardinality) to O(1) (fold #905), `list_atoms_by_schema` gained a secondary
index (fold #1026), and the embedding sidecar gained an HNSW path for
unscoped search (landed 2026-06-26) that's roughly 10x faster than the exact
scan it replaced at 120K fragments. This table is a translation of those
numbers into fbrain's call surface, not a re-derivation — see
`fold/fold_db/crates/core/benches/baseline/README.md` for the bench
methodology and the regression-guard CI job that keeps these numbers honest.

**Practical guidance:**
- Prefer a known-slug `get` over `search`/`ask` whenever you have the slug — it's the cheapest call by a wide margin and never gets slower as the brain grows.
- `ask`/`search` stay in the single-digit-millisecond range well past 100K records, so there's no need to economize on retrieval calls — recall first, as the agent loop above recommends.
- The one pattern that gets more expensive as a brain grows is an unfiltered `list` — scope it with `--type`/`--tag`/`--status` (or the equivalent MCP filters) unless you actually want the entire corpus back.

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
the error-message layer.

Power users contributing to fold itself can still point at a worktree-local
schema service with `--node-url` / `--schema-service-url` on `fbrain init`
(e.g. when running `./run.sh --local --local-schema` from a fold checkout).

## Troubleshooting

Top errors you'll hit and the fix:

- **Your first write hangs at `First-run setup — run: \`lastdb consent grant fbrain\` … Waiting for you to grant access…`**  
  Rare now that `fbrain init` grants consent inline — you'll only see this if you declined init's consent prompt, ran `init` non-interactively, or your capability was revoked. Easiest fix: re-run `fbrain init` (idempotent) and accept the grant. Otherwise leave the write waiting and, **in a second terminal**, run `lastdb consent grant fbrain` (review, then `y`; or `--yes` to skip the prompt). The original command unblocks and the capability is cached for all later writes. See [One-time consent grant](#one-time-consent-grant-handled-by-init). To opt out on a local/dev node, set `FBRAIN_APP_IDENTITY_ENFORCE=off`.

- **First write is slow (~5s) the first time on a headless / SSH / locked-keychain box, then fast after**  
  fbrain stores its capability in the macOS login keychain (best protection against co-resident exfiltration). When there's no GUI to answer a keychain-authorization prompt (SSH, CI, an automation agent, or a never-unlocked login keychain), the `security` call can't complete — every keychain call is bounded by a short timeout (via the `@lastdb/app-sdk` capability store) and transparently falls back to a `0600` file under `~/.fbrain/capabilities/` instead of hanging (a pre-SDK `~/.fbrain/capabilities.json` entry is still read and migrated). You'll see a one-time ~5s pause on that first write; subsequent writes read the cached file and are fast. To skip the keychain entirely on such hosts, set `FBRAIN_FORCE_FILE_KEYCHAIN=1`.

- **`error: node not reachable at http://127.0.0.1:9001 — run \`fbrain doctor\` for a full diagnosis.`**  
  The homebrew `fold_db_node` daemon isn't running. Check with `brew services list` (look for `lastdb` → `started`) and start it with `brew services start lastdb` (or `lastdb daemon start` if you prefer the foreground path). If you're contributing to fold itself and running a worktree-local `./run.sh --local`, point fbrain at the auto-slotted port with `fbrain init --node-url http://127.0.0.1:<slot>`.

- **`error: Node not set up — run \`fbrain doctor\` for a full diagnosis.`**  
  The node is running but not provisioned. Run `fbrain init`.

- **`error: Node rejected /api/mutation: schema collision (canonical hashes …); fbrain config out of date — run \`fbrain init\` — run \`fbrain doctor\` for a full diagnosis.`**  
  Schema definitions have moved on since your config was written (likely because `schemas.ts` changed). Re-run `fbrain init` — it's idempotent and refreshes the canonical hashes.

- **`error: Config not found at ~/.fbrain/config.json. Run \`fbrain init\` first.`**  
  You haven't initialised fbrain yet. Run `fbrain init`.

- **`error: Node rejected POST /api/setup/bootstrap with 410 — already provisioned …`**  
  The daemon is in a contradictory state — `/api/system/auto-identity` says "not provisioned" but `/api/setup/bootstrap` says "already provisioned". This typically happens on a second-user dogfood machine where the node's `config/` carries over from a previous install. Recovery: (a) if you still have `~/.fbrain/config.json` from when this node was working, re-run `fbrain init` — it reuses the saved `userHash` and continues; (b) follow the node's own message (POST `/api/auth/restore` with the recovery phrase, if you have one); (c) for a clean slate, stop the daemon, `rm -rf ~/.lastdb/config/` (on a current v0.15.1+ node; legacy 0.14.x nodes use `~/.folddb/config/`), restart, then re-run `fbrain init`. (The error hint itself prints the resolved path for your node.)

- **`error: Semantic search is unavailable — the fold_db node failed to load its embedding model …`** (or, on older fbrain versions, the opaque `Bad request: Schema error: Invalid data: Failed to init embedding model: Failed to retrieve model.onnx`).  
  The fold_db_node loads its `model.onnx` lazily on the first `fbrain search` / `fbrain ask` call. After certain restarts (commonly `brew upgrade lastdb`) that cache is partially populated and the node 400s instead of fetching. **Workaround:** `lastdb daemon stop && lastdb daemon start` — the embedding cache repopulates on next search. If the failure persists, run `fbrain doctor --freshness` and capture the node log (the latest file under `~/Library/Logs/Homebrew/lastdb/`); the underlying cache-recovery bug is tracked upstream in `EdgeVector/fold` (fold/fold_db_node/). `fbrain doctor` (no flags) now runs a one-token search probe so this failure surfaces as a structured `[FAIL] embedding-runtime` line instead of an opaque error on first use.

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

## Project status

fbrain is a working prototype, not yet a 1.0. CRUD across all record types, multi-type schemas, semantic/hybrid retrieval (`search` + `ask`), soft delete, `doctor`, and the MCP agent surface are all shipped and exercised end to end. The remaining work is the G0 replacement-readiness gate (a dogfood-shaped checklist) — see [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md) for the ship criteria and outstanding items. Until that gate ships, treat published binaries and APIs as unstable.

## Replacement direction

fbrain is the planned replacement for [gbrain](https://github.com/garrytan/gbrain) at EdgeVector. The 2026-05-24 gap-consolidation review locked the replacement direction. **Status:** v0+ prototype, NOT shipped — readiness-gate criteria are defined, **10 of 10 items green or outstanding**. Only the dogfood-shaped items remain: #5 mirror-flip 7-day, #8 rollback rehearsal. The G5 `fbrain ask` ship (PR #23) closed the last code-shaped gap. See [`docs/g0-replacement-readiness-gate.md`](docs/g0-replacement-readiness-gate.md) for the workflow inventory, eval numbers, and the 2026-08-23 archive-review deadline.

Gate item #6 (the "second-user dogfood") was **retired 2026-06-06** as false-premise: `userHash` is the node's provisioned identity, not a per-human identity, so two installs against one node always produce one hash. fbrain is single-user by design (one daemon, one team, one `userHash`); the "is fbrain usable by someone who isn't Tom?" question now flows through #5 (mirror-flip) and the future G16 cross-node visibility. See [`docs/decisions/g14-second-user-identity-model.md`](docs/decisions/g14-second-user-identity-model.md). Item number preserved for link integrity.

Until the readiness gate ships, both gbrain and fbrain coexist; the `gbrain put` → fbrain mirror hook keeps writes flowing to both.

## Out of scope for v0

- Not E2E-encrypted (Phase 3 sharing probes the surface, doesn't build a product)
- Not running new fold_db core code
- No git-to-brain sync
- No compiled standalone binaries — fbrain runs as a Bun-runtime CLI (`bun add -g github:EdgeVector/fbrain` today; `npm i -g fbrain` / `bunx fbrain` once published to npm)
