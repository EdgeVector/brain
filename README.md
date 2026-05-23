# fbrain

> ⚠️ **PROTOTYPE — archive review by 2026-08-23**
>
> This is a v0 prototype that probes whether [fold_db](https://github.com/EdgeVector/fold) is a viable storage backend for a personal "brain" CLI. If by **2026-08-23** the prototype hasn't graduated into [`FBRAIN_PLAN.md`](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/plans/FBRAIN_PLAN.md) Workstream B, this repo is archived with `ARCHIVED.md` and a `pre-commit` reject hook — the same discipline applied to the four predecessor monorepo predecessors.

A CLI named `fbrain` that uses fold_db as the storage engine for a personal brain that tracks **designs** and **tasks**, with semantic search and a Phase 3 sharing probe.

## Status

| Phase | Description | Status |
|---|---|---|
| 0 | fold_db feasibility spike | ✅ GO (with canonical-hash caveat) — see [spike notes](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/spikes/fbrain-phase-0-spike-notes.md) |
| 1 | Bootstrap + core CRUD (init, design new, task new, get, list, status, link) | 🚧 In progress |
| 2 | Search + doctor + polish | ⏳ Pending Phase 1 |
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

## Getting started (Phase 1+)

Coming up in Phase 1 — until then, run the Phase 0 spike notes against your own scratch fold_db node if you want to play with the raw API.

## Out of scope for v0

- Not a replacement for gbrain
- Not E2E-encrypted (Phase 3 sharing probes the surface, doesn't build a product)
- Not running new fold_db core code
- No git-to-brain sync
- No published binaries (`bun link` for local install)
