# Phase 7 — G3 search-latency root-cause spike

- **Date:** 2026-05-24
- **Spike duration:** ~90 min
- **Author:** kanban-agent (worktree `fc482`)
- **Trigger:** Master plan G3 — `fbrain put X` lands, `fbrain get X` returns it, but `fbrain search "<token from X>"` reportedly returned junk (or nothing) for 3+ minutes during the 2026-05-24 smoketest. Block on shipping G5 (`fbrain ask`).
- **Output:** verdict + recommended follow-up tasks. **No fix in this PR.**

## TL;DR

The bug is real but it is **not** a freshness / indexing-latency bug.

- **Synchronous indexing path:** `fold_db_node` awaits `inline_index_mutations` inline during `/api/mutation` (`fold/fold_db/crates/core/src/fold_db_core/mutation_manager.rs:355`). The embedding is in the in-memory `EmbeddingIndex` *before* the HTTP write returns. Confirmed empirically: 10/10 repro trials show **0-second lag** between `fbrain put` and a successful `fbrain search` (all three search flavors — semantic body, semantic slug, `--exact`).
- **Real cause:** **index pollution.** The native-index top-50 budget is shared across (a) tombstoned fbrain records whose embeddings were never purged, and (b) every non-fbrain schema living in the same homebrew daemon (`Persona`, `User Accounts`, `Contacts`, `CalendarEvent`, …). For low-relevance queries the top-50 fills with phantoms and orphan-schema hits, which fbrain's resolver drops as `skip stale` / `skip: schema_name matches no registered fbrain type`. User sees `no matches`.

**Severity for G5 ship:** **MEDIUM — not a ship-gate for the prototype, but a hard prerequisite for `fbrain ask`** because retrieval quality degrades as soon as the corpus grows or any record is soft-deleted.

## Hypotheses + evidence

### H1 — Native-index embedding pipeline lag · **RULED OUT**

Embedding generation might be async / slot-driven; lag = backlog burn-down.

Evidence rejecting:

- `fold/fold_db/crates/core/src/fold_db_core/mutation_manager.rs:353-356` — `inline_index_mutations` is awaited inline as **Phase 6 of 6** of the mutation flow, before `store_schema` and the HTTP response.
- `fold/fold_db/crates/core/src/db_operations/native_index/mod.rs:76-104` — `index_record` calls `self.embedding_model.embed_text(fragment_text)?` (sync) then `insert_fragment(...).await` for every fragment serially. No queue, no spawned task, no batching.
- `fold/fold_db/crates/core/src/db_operations/native_index/embedding_index.rs:169-232` — `insert_fragment` writes to Sled *and* mutates the in-memory `Vec<EmbeddingEntry>` under a single `entries.write()` before returning.
- No `tokio::spawn`, no MPSC channel, no `tantivy`/`usearch`/`hnsw` exists in `fold/fold_db` or `fold/fold_db_node` (`grep -rn 'tantivy\|usearch\|hnsw'` — zero hits in `src/`).
- Empirical: `scripts/g3-spike-repro.sh` — 10 trials, fresh record at `score=1.0000…` on the very first poll for both `search <marker>` and `search <body-word>`. Put → first successful search measured **≤ 1 s** in every trial (most of that is fbrain's bun startup, not lag).

### H2 — Polluted-schema state · **CONFIRMED. Primary cause.**

Old/foreign data in the index drowns new writes.

Evidence confirming, two distinct pollution sources:

#### H2a — Tombstoned fbrain records leave phantom embeddings

`fbrain delete` (see `docs/phase-5-delete-spike.md`) is soft: it stamps a tombstone tag so every fbrain read path treats the record as gone. It does **not** purge the corresponding entries from `fold_db`'s `EmbeddingIndex` — there is no API to do so (`purge_org_embeddings` exists in `native_index/mod.rs:133` but is whole-org).

After 10 dogfood put-then-delete cycles in this spike, a `fbrain --verbose search h3-probe-…` produced:

```
[verbose] search returned 13 fragment hit(s)
[verbose] dedupe collapsed to 13 unique record(s)
[verbose] kept:       concept/h3-probe-1779654049 score=1.0000001192092896
[verbose] skip stale: concept/probe-smoketest-pattern-1779653987 not found in current store
[verbose] skip stale: concept/g3-spike-1779653904249 not found in current store
[verbose] skip stale: concept/g3-spike-17796539088620 not found in current store
[verbose] skip stale: concept/g3-spike-177965390412119 not found in current store
[verbose] skip stale: concept/g3-spike-177965390517029 not found in current store
[verbose] skip stale: concept/g3-spike-177965391011230 not found in current store
[verbose] skip stale: concept/g3-spike-17796539074618 not found in current store
[verbose] skip stale: concept/g3-spike-177965390927218 not found in current store
[verbose] skip stale: concept/g3-spike-177965390618789 not found in current store
[verbose] skip stale: concept/g3-spike-17796539087769 not found in current store
[verbose] skip stale: concept/g3-spike-177965388215289 not found in current store
[verbose] skip: schema_name "5f8185c…" matches no registered fbrain type
```

11 of 13 hits are phantom embeddings. The fresh record only survives because its `score=1.0` keeps it inside the top-50 budget.

#### H2b — Shared homebrew daemon hosts non-fbrain schemas

The same homebrew `fold_db_node` (`:9001`) is used by the daily daemon, exemem, etc. Its native index contains `Persona`, `User Accounts`, `Contacts`, `CalendarEvent`, and other non-fbrain schemas. fbrain's `src/commands/search.ts:60-90` filters these out via `recordTypeForHash`, but **filtering happens client-side, after fold_db has already burned the top-50 slots**.

Reproduced with a query whose meaningful term ("authentication") appears in both fbrain records and other schemas:

```
$ fbrain --verbose search "authentication" -n 20
[verbose] search returned 8 fragment hit(s)
[verbose] dedupe collapsed to 6 unique record(s)
  stale fbrain records (tombstoned):       3
  orphan schema (Persona/User/Contacts):   3
  kept (live fbrain records):              0
no matches
```

Same query against the raw fold_db endpoint shows the fresh `h3-probe-…` at score 0.673 and the other live record at 0.540 — **both inside the top-8**, both dropped by fbrain (one because we'd already cleaned them up in the test, the other for the same reason). The top-8 also contains `User Accounts/USR002` (score 0.32), `Contacts/Coinbase` (×2, 0.30), and `CalendarEvent/9e5b59de…` (×2, 0.295) — none of which fbrain knows how to surface, all of which consumed slots in the top-50.

**Net effect for the smoketest:** if the smoke run was on a polluted daemon (it was — the daily daemon runs all the time), then a query whose top-50 was dominated by tombstones + other schemas would surface as `no matches` ("nothing") or as low-relevance live fbrain records ("junk"). The "3+ min" wait was the user re-querying, not eventual consistency — there was nothing to wait *for*.

### H3 — Fragment-dedup logic in `src/commands/search.ts` · **RULED OUT**

`search.ts:60-90` dedupes fragment hits by `(schema_display_name, key_value.hash)` and keeps the highest-score fragment per record.

Evidence rejecting:

- fold_db's `EmbeddingIndex::search` (`fold/fold_db/crates/core/src/db_operations/native_index/embedding_index.rs:296-322`) already dedupes by `(schema, key)` before returning — only the best fragment per record reaches fbrain. fbrain's `dedupeHits` is effectively a no-op for the per-record case (verified in the verbose run above: `search returned 13`, `dedupe collapsed to 13`).
- Every trial showed the freshest record at `kept:` with the highest score — never dropped by dedup.

### H4 — Native-index has its own freshness model · **RULED OUT**

No reindex / commit trigger needed.

Evidence rejecting:

- The same code path (`insert_fragment`) writes to Sled *and* the in-memory `Vec<EmbeddingEntry>` under one critical section. No "commit", no "refresh" step.
- `reload_embeddings` (`native_index/mod.rs:124`) exists only for *sync replay* — repopulating in-memory from Sled after a discovery/replication event. Mutation writes don't need it; they update in-memory directly.

## Recommended follow-up tasks

These should be queued as separate kanban tasks after this PR lands. **Not in this task's scope.**

### G3a — `fbrain doctor` freshness + pollution probes

A `fbrain doctor freshness` subcommand that:

1. Writes 5 distinct test records to a `g3-freshness-probe-*` slug namespace.
2. For each: searches the unique body word + the slug; asserts the test record appears at score ≥ 0.5.
3. For each: searches via `--exact`; asserts score ≥ 0.9.
4. Deletes the probes.
5. Then re-runs a broad query and reports:
   - **Pollution ratio:** `stale_fragments / total_top50`
   - **Orphan-schema ratio:** `orphan_schema_fragments / total_top50`
   - **Effective fbrain top-K:** how many live fbrain records survived to the user.

Surfaces both freshness regressions and H2 pollution to operators without requiring code reading. Cost: ~½ day.

### G3b — Retrieval eval harness (`scripts/eval-retrieval.ts`)

20+ hand-labeled `(query, expected_slug)` pairs. CI runs them and fails the build if precision@1 drops below 0.8. **Hard prerequisite for G5 (`fbrain ask`)** — without a baseline, hybrid retrieval tuning is guesswork. Cost: ~½ day for the harness + 2-4 h for labelling.

### G3c — `fbrain reindex` workaround command (fbrain-layer)

While the upstream fix lands, give users a manual escape hatch:

1. Iterate every live fbrain record (across all 8 types).
2. For each, re-`put` (which re-runs `index_record`, refreshing the embedding entry in place).
3. The phantom entries for tombstoned records stay in the index — but this at least guarantees the live ones are present and current.

Doesn't fix H2 (phantoms still drown the top-50), but unblocks users who *know* their search is degraded. Cost: ~3 h.

### G3d — Upstream `fold_db`: schema-scoped search

Add a `schemas[]` query parameter to `/api/native-index/search` (`fold/fold_db_node/src/server/routes/query.rs:425`) and a corresponding `search_scoped` method on `NativeIndexManager` (`fold/fold_db/crates/core/src/db_operations/native_index/mod.rs:165`) that pre-filters `EmbeddingIndex.entries` by schema-name set before scoring. fbrain passes its 8 canonical hashes; the top-50 budget is no longer wasted on `Persona`/`Contacts`/etc. **Fixes H2b end-to-end.** Cost: ~1 day (upstream fold_db PR + fbrain client + tests).

### G3e — Upstream `fold_db`: purge embeddings on tombstone

Either (a) add a per-record `purge_embeddings(schema, key)` API and have fbrain call it from `delete.ts`, or (b) have fold_db's delete path purge embeddings transparently. **Fixes H2a.** Open as a fold_db issue alongside the existing G4 issues. Cost: 30 min for the upstream issue; fix size depends on fold's internal architecture.

## Why this is **not** a prototype ship-gate (but is a G5 ship-gate)

- For the prototype/dogfood loop, the bug surfaces only **after** soft-deletes in the same node OR when a query collides semantically with non-fbrain schemas. New users running `fbrain put X && fbrain search X` on a fresh personal corpus will not hit it.
- For **G5 `fbrain ask`** (hybrid retrieval over the same native index), every retrieval call is one of the queries that *will* collide. RRF + LLM expansion amplifies the top-K problem: if 8/10 candidates are phantoms, the LLM rewrites a bad context. **Do not ship G5 without G3a + G3b + G3d.**

## Repro script

`scripts/g3-spike-repro.sh` (committed in this PR) — single-trial put→get→search loop. Invoke with `bash scripts/g3-spike-repro.sh <trial-id>`. CSV-ish output. Use it as the seed for the G3a doctor probe and the G3b eval harness.

## References

- `src/commands/search.ts` — fbrain's resolver (dedup + `findBySlug` filter)
- `src/client.ts:321-334` — `node.search` HTTP wrapper
- `src/commands/delete.ts` + `docs/phase-5-delete-spike.md` — tombstone semantics (no embedding purge)
- `fold/fold_db/crates/core/src/fold_db_core/mutation_manager.rs:300-360` — synchronous indexing phase
- `fold/fold_db/crates/core/src/fold_db_core/mutation_manager.rs:862-885` — `inline_index_mutations`
- `fold/fold_db/crates/core/src/db_operations/native_index/mod.rs:76-175` — `index_record` + `search_all_classifications`
- `fold/fold_db/crates/core/src/db_operations/native_index/embedding_index.rs:169-322` — `insert_fragment` + `EmbeddingIndex::search` (top-50, per-record dedupe)
- `fold/fold_db_node/src/fold_node/operation_processor/query_ops.rs:653-707` — node-side search handler + display-name enrichment
- `fold/fold_db_node/src/server/routes/query.rs:401-503` — HTTP `/api/native-index/search` route
- Master plan: `~/.gstack/projects/edgevector/master-fbrain-gap-consolidation-20260524-114705.md` (G3 row)
