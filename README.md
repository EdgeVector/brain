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
| 2 | Search + doctor + polish | ⏳ Pending |
| 3 | Sharing spike | ⏳ Pending Phase 2 |

## Plans

- [`FBRAIN_PROTOTYPE_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PROTOTYPE_PLAN.md) — this prototype (v0)
- [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) — the 9–11 month production vision (separate from this prototype)

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

All persistence, indexing, and embedding live in fold_db. fbrain holds only the schemas, the CLI parsing, and the error-message layer.

## Getting started

Phase 1 ships `init`, `design new`, `task new`, `get`, `list`, `status`, `link`, and a `doctor` stub. `search` and full `doctor` land in Phase 2.

```bash
# 1. start a local fold node + schema service (one-time first build is slow)
cd /path/to/fold/fold_db_node
./run.sh --local --local-schema --empty-db --home /tmp/fbrain-node

# 2. in another shell, from this repo
bun install
bun src/cli.ts init   # writes ~/.fbrain/config.json with canonical schema hashes

# 3. drive it
bun src/cli.ts design new my-first-design --title "first" --tag spike
bun src/cli.ts task new t1 --design my-first-design --title "do the thing"
bun src/cli.ts list
bun src/cli.ts get my-first-design --type design
bun src/cli.ts status my-first-design reviewed
bun src/cli.ts link t1 my-first-design
```

A global `--verbose` flag echoes every HTTP request and response — including the canonical schema hash being targeted, per the Phase 0 spike's debugging guidance.

`bun link` instructions for a system-wide `fbrain` binary are coming up in Phase 2.

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
