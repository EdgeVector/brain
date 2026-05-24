# G0 — fbrain replacement-readiness gate

**Last updated:** 2026-05-24
**Status:** criteria defined; **4 of 11 acceptance items green, 7 outstanding** (see §7 + §8).
**Owner:** Tom Tang.
**Hard deadline:** 2026-08-23 — if the gate isn't green by then, the README's archive-review clause fires.

## 1. Why this doc exists

This is the ship-criteria contract for the fbrain → gbrain replacement decided at the 2026-05-24 `/autoplan` final gate (UC1: reaffirm replacement). It exists because the README claims fbrain replaces gbrain for org deploys, and "replaces" only means something if there's a concrete, measurable definition of what readiness looks like. Without this doc, "shipped" is whatever the loudest voice says it is.

Backfill of the placeholder filed in PR #7. Derived from the master gap plan at `~/.gstack/projects/edgevector/master-fbrain-gap-consolidation-20260524-114705.md` ("Definition of shipped" section, expanded from 5 items to 11).

## 2. Scope — what counts as "a gbrain workflow we must replace"

Not every gbrain command needs an fbrain equivalent. Only workflows that **Tom or an AI agent invokes during real daily work** count toward this gate. Everything else stays on gbrain in parallel — fbrain is **not** trying to be a strict superset of gbrain.

**Explicitly frozen on gbrain — NOT replaced** (users who need these keep calling `gbrain` directly):

`gbrain integrations`, `gbrain dream`, `gbrain autopilot`, `gbrain transcripts`, `gbrain salience / anomalies`, `gbrain files`, `gbrain code-def / code-refs / code-callers / code-callees / reindex-code`, `gbrain publish`, `gbrain check-resolvable`, `gbrain report`, `gbrain extract`, `gbrain lint`, `gbrain orphans`, `gbrain check-backlinks`, `gbrain timeline*`, `gbrain sources / repos`, `gbrain sync` (git-to-brain), `gbrain import / export`, `gbrain migrate`, `gbrain embed`.

Replacement is scoped to the **daily read/write/agent-integration surface** — put, get, list, delete, search, ask, doctor, the agent write-mirror, and MCP. That's it.

## 3. Workflow inventory + fbrain mapping

### Table A — Human daily-use surface (Tom, then teammates)

| gbrain workflow | Who invokes | fbrain equivalent | Green-state (measurable) | Status / task |
|---|---|---|---|---|
| `gbrain put <slug>` (frontmatter, stdin) | Tom, agents | `fbrain put <slug>` | 20 hand-picked slugs round-trip identically through `put` → `get`. | ✅ shipped — Phase 4 |
| `gbrain get <slug>` | Tom, agents | `fbrain get <slug>` | Same 20 slugs return identical title/body/tags/status from both stores. | ✅ shipped — Phase 1 |
| `gbrain list [--type / --tag / -n]` | Tom | `fbrain list [--type / --tag / -n]` | Same filters return overlapping results (mod tombstones). | ✅ shipped — Phase 2 |
| `gbrain delete <slug>` | Tom | `fbrain delete <slug>` (soft tombstone) | Deleted slug invisible to all read paths; slug reusable. **Note: soft, not hard** — fold_db is append-only. | ✅ shipped — Phase 5 ([`phase-5-delete-spike.md`](phase-5-delete-spike.md)) |
| `gbrain search <q>` (tsvector keyword) | Tom | `fbrain search <q>` (vector) | G3a freshness probe green (5/5 trials at score ≥ 0.5) **AND** G3b eval P@5 ≥ vector-only baseline on the 20-pair labeled set. | ✅ shipped — G3a (PR #11), G3b (kanban `c312a`, PR #10) |
| `gbrain query / gbrain ask <q>` (hybrid RRF + LLM expansion) | Tom | `fbrain ask` | G3b/G17 eval shows fbrain `ask` ≥ vector-only baseline on the labeled set. | ❌ **MISSING — G5 (T2), HARD GATE.** Vector-only is a daily-use regression Tom won't ship. |
| `gbrain doctor` | Tom | `fbrain doctor [--freshness]` | doctor green on the same machine where `gbrain doctor` is green. | ✅ shipped — Phase 2 + G3a |
| `gbrain tag / untag / tags <slug>` | Tom (light) | frontmatter `tags:` via `fbrain put` | Round-trip on the same 20 slugs preserves tag set. | ✅ shipped — Phase 4 |
| `gbrain link / backlinks / graph <slug>` | Tom (light), agents (none) | none | Typed-relation parity via a native `relation_link` schema (NOT Markdown regex). | ❌ MISSING — G7/G8 (T3), **gate-OPTIONAL** (deferred; can ship without). |

### Table B — AI-agent integration surface (Claude Code, Codex)

| gbrain workflow | Who invokes | fbrain equivalent | Green-state (measurable) | Status / task |
|---|---|---|---|---|
| Write-mirror via `~/.claude/hooks/gbrain-mirror-to-fbrain.sh` | every Claude/Codex Bash tool call | Flip `~/.claude/brain-config.json` to `primary: fbrain`, `write_mirror: gbrain`. The hook is already bidirectional. | Flip runs for **7 consecutive days** on Tom's machine with zero failed reverse-mirrors in `~/.claude/hooks/gbrain-upsert.ts` logs. | hook + reverse direction exist; flip is a one-line config change ([brain-config.json](../../../.claude/brain-config.json)) |
| MCP read (`search`, `get`, `list`) | agents | `fbrain mcp` (stdio) | A Claude Code skill calls `fbrain_search` / `fbrain_get` / `fbrain_list` and retrieves a known slug. | ✅ shipped — G6 (kanban `95d87`, PR #13), smoketest in [`mcp-smoketest.md`](mcp-smoketest.md) |
| MCP write (`put`, `delete`) | agents | none | `put` and `delete` exposed via `fbrain mcp`; Claude Code skill smoketest writes + reads back. | ❌ MISSING — G6-write (T2), gate-blocking for full agent self-sufficiency post-flip |
| `gbrain jobs submit minion-checkpoint` (kanban-agent skill protocol) | every kanban agent (start / blocker / completion) | none — the kanban-agent skill itself depends on `gbrain jobs` | Minion protocol has a **documented + implemented** disposition: (a) explicitly stays on gbrain post-flip, (b) fbrain grows a `jobs` surface, or (c) the kanban-agent skill moves to a different bus. Decision captured in a follow-up doc/PR. | ❌ MISSING — **HARD GATE item #11 (§7).** Without this, every kanban agent breaks the day gbrain is deprecated. |

## 4. Who uses what — named users and agents

**Primary human user (today):** Tom Tang. One machine. `userHash=dd616fa8…`.

**Primary AI users (today):** Claude Code and Codex sessions running on Tom's machine — writes go through the gbrain mirror hook to both stores; reads go through gbrain (or `fbrain mcp` after G6).

**Replacement-readiness target:** **one named teammate** (TBD — to be identified in the G14 follow-up) with their own `userHash`, writing > 0 records per day for **7 consecutive days**. Per the Phase 1 CEO subagent finding: without a second `userHash` writing, "shipped" is undefined.

**Explicit non-users for v1:** end-users outside engineering; web UI consumers; multi-tenant ACL users; any flow requiring fold_db's cloud sync transport (see §6).

## 5. Rollback procedure — if fbrain breaks for a user mid-migration

The acceptance bar: a user can rollback in **under 2 minutes without help**.

1. **Confirm the current mirror direction.** Read `~/.claude/brain-config.json`. If `write_mirror` is `gbrain` (or null), gbrain still contains every fbrain write from the last N days. No data loss.
2. **Flip back to gbrain-primary.** Edit `~/.claude/brain-config.json` to `primary: gbrain`, `write_mirror: fbrain`. Reload Claude Code. All `gbrain put` calls resume mirroring to fbrain; all daily reads go through gbrain.
3. **Backfill fbrain-only writes** (Phase 6 record types — `concept`, `preference`, `reference`, `agent`, `project`, `spike` — that gbrain doesn't natively schema). One-liner:
   ```bash
   for slug in $(fbrain list --type concept -n 100 | awk '{print $1}'); do
     fbrain get "$slug" --type concept | gbrain put "concepts/$slug"
   done
   ```
   (Run per type. The script is rough — file a real one if rollback ever happens.)
4. **Signal the failure mode.** Open a fbrain issue or a kanban task with the symptom + workaround. Until the doctor disclosure WARN lands (gate item #9), the next user has to discover the breakage themselves.

**Acceptance gate:** a **rollback rehearsal** — perform the flip-back once on Tom's machine *before* declaring replacement-ready. Verify writes land in both stores for 24h post-rehearsal. Logged in this doc on completion.

## 6. Sync story — multi-machine and team-sharing

**Frame:** the gate does **not** require fully solved sync. It requires honest, doctor-surfaced disclosure of the sync limitations so a teammate trying to dogfood gets a WARN, not a silent fork.

| Sync surface | Today | Gate requirement |
|---|---|---|
| Single-machine (Tom's laptop) | Works — `fbrain` on homebrew daemon at `:9001`. | The whole gate is scoped to this slice. ✅ baseline. |
| Multi-machine (Tom's laptop ↔ desktop) | Forked brain — each daemon is local-only. | **NOT a gate prerequisite.** `fbrain doctor` must emit an explicit WARN: "single-machine slice — record set is local to this daemon". G16 owns the future `fbrain pull` over fold_db's sync-log primitives. |
| Team-sharing (Tom ↔ teammate, different machines) | Phase 3 spike memo (`docs/phase-3-sharing-memo.md`) confirmed `/api/sharing/*` metadata wireable on loopback, but cross-node data transport requires fold_db's cloud sync engine (S3-backed, Auth Lambda + discovery), which is **not reachable from a localhost-only spike**. `fbrain share` is a memo-pointing placeholder that exits 1. | **NOT a gate prerequisite.** Doctor WARN: "no team-sync transport — `fbrain share` is a placeholder until cloud sync lights up". The G14 second-user dogfood (gate item #6) uses *separate fbrain installs writing to the same prod node* — not actual cross-node sharing. |

## 7. Org-deploy acceptance tests — the 11-item checklist

Each item is measurable, automatable where possible, and links the kanban task / PR that proved it (or marks outstanding). All 11 must be green before the brain-config mirror flips to `primary: fbrain`.

1. **Round-trip parity** (Table A green-state column). 20 hand-picked slugs put via fbrain → get via fbrain → diff title/body/tags/status. Automated in `scripts/parity-smoketest.sh`. — ❌ outstanding, kanban follow-up.
2. **Retrieval freshness.** `fbrain doctor --freshness` green: 5/5 trials at score ≥ 0.5. — ✅ G3a, PR #11.
3. **Retrieval relevance.** G3b/G17 eval shows fbrain `search` (and `ask`, once G5 ships) P@5 ≥ vector-only baseline on the 20-pair labeled set. — ✅ G3b shipped (kanban `c312a`, PR #10); blocked on G5 for `ask`.
4. **MCP read surface.** Claude Code skill calls `fbrain_search` → retrieves a known slug. — ✅ G6 (kanban `95d87`, PR #13), [`mcp-smoketest.md`](mcp-smoketest.md).
5. **Mirror-flip dogfood.** `~/.claude/brain-config.json` flipped to `primary: fbrain` for **7 consecutive days** on Tom's machine with **zero** failed reverse-mirrors. Logged via `gbrain-upsert.ts`. — ❌ outstanding (cannot start until #1, #10, #11 are green).
6. **Second-user dogfood (G14).** One named teammate writes > 0 records to fbrain over 7 consecutive days under their own `userHash`. — ❌ **OUTSTANDING — playbook ready, teammate TBD.** Onboarding steps + monitor live at [`dogfood-g14-second-user-playbook.md`](dogfood-g14-second-user-playbook.md) and [`../scripts/dogfood-monitor.sh`](../scripts/dogfood-monitor.sh). Human-driven step: Tom picks the teammate and runs the playbook off-band.
7. **Telemetry signal (G13).** `fbrain doctor --usage` shows write count by `userHash` over 7d (≥ 2 hashes). — ❌ outstanding, kanban follow-up.
8. **Rollback rehearsal.** Mirror-flip-back per §5 performed once on Tom's machine; verified writes land in both stores for 24h post-rehearsal. — ❌ outstanding (chained off #5).
9. **Doctor surfaces multi-machine + sharing limits.** `fbrain doctor` emits explicit WARN lines for the single-machine and no-team-sync conditions per §6. — ❌ outstanding, kanban follow-up.
10. **Hybrid `fbrain ask` (G5).** Lands before the flip. Vector-only `fbrain search` is a daily-use regression vs. `gbrain ask`'s RRF + expansion path; **Tom won't ship that regression.** Eval-gated on the G3b/G17 baseline. — ❌ outstanding, T2 in the master plan.
11. **Minion bus path settled.** The kanban-agent skill's `gbrain jobs submit minion-checkpoint` dependency has a documented + implemented disposition before the mirror flips. Without this, every kanban agent breaks on flip day. — ❌ outstanding, kanban follow-up.

**Items 2, 3 (search-half), 4 are green.** Items 1, 5, 6, 7, 8, 9, 10, 11 (and the `ask` half of #3) are outstanding.

## 8. Status snapshot — 2026-05-24

| # | Gate item | State |
|---|---|---|
| 1 | Round-trip parity smoketest | ❌ outstanding (follow-up #3) |
| 2 | Retrieval freshness (G3a) | ✅ |
| 3 | Retrieval relevance — `search` (G3b) | ✅ |
| 3 | Retrieval relevance — `ask` | ❌ outstanding (blocked on #10) |
| 4 | MCP read (G6) | ✅ |
| 5 | Mirror-flip dogfood (7 days) | ❌ outstanding (blocked on #1, #10, #11) |
| 6 | Second-user dogfood (G14) | ❌ outstanding — **playbook + monitor ready, teammate TBD** ([`dogfood-g14-second-user-playbook.md`](dogfood-g14-second-user-playbook.md), [`../scripts/dogfood-monitor.sh`](../scripts/dogfood-monitor.sh)) |
| 7 | Telemetry — write count by userHash (G13) | ❌ outstanding (follow-up #5) |
| 8 | Rollback rehearsal | ❌ outstanding (chained off #5) |
| 9 | Doctor disclosure WARNs | ❌ outstanding (follow-up #2) |
| 10 | Hybrid `fbrain ask` (G5) | ❌ outstanding (T2 in master plan) |
| 11 | Minion bus path settled | ❌ outstanding (follow-up #1, **hard blocker on flip**) |

**Score: 4 / 11 green.** Path to green-state: the 5 follow-ups filed alongside this PR cover gate items 1, 6, 7, 9, 11. Items 5, 8 fall out of #11 + #1 being green. Items 3-ask and 10 are the G5 work in the master plan.
