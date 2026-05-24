# Decision — kanban minion-checkpoint bus stays on gbrain

**Date:** 2026-05-24
**Owner:** Tom Tang
**Status:** Decided — option (a). Closes [G0 readiness-gate](../g0-replacement-readiness-gate.md) item #11.
**Filed from:** kanban task `c062c` (follow-up of PR #17).

## TL;DR

The kanban-agent skill's `gbrain jobs submit minion-checkpoint` dependency **stays on gbrain post-flip.** gbrain ships as two things going forward: the *legacy* personal knowledge brain (frozen surface — see the G0 gate §2 list of `gbrain X` workflows we explicitly do not replace) and the *kanban minion-bus infra* (the `jobs` surface, exclusively used as append-only telemetry). The brain side is what fbrain replaces; the bus side is unaffected by the flip.

This unblocks the brain-config mirror flip (G0 item #5) without spending the 1–3 weeks of engineering option (b) would cost. Re-evaluate if the read side of the bus ever grows a real consumer beyond `gbrain jobs list --status waiting | grep`.

## What is the minion bus, mechanically

Per `gbrain get concepts/minion-checkpoint-protocol` (the authoritative page): the minion bus is a **single fixed job name** (`minion-checkpoint`) submitted via `gbrain jobs submit minion-checkpoint --params <JSON>`. The payload is three fields — `task_id`, `kind` (`start | blocker | completion`), `message`. There is no worker. Jobs sit forever in `waiting`. The bus is an append-only telemetry log.

Reads happen exclusively via `gbrain jobs list --status waiting | grep minion-checkpoint` (orchestrator + kanban sidebar). No consumer reads the payload as RPC; no consumer changes state in response. The bus is observability for "which agent is on which step" so a human (or the orchestrator) can babysit parallel kanban runs without `ps`-grepping worktrees.

Submitters: every kanban-agent skill invocation, 3 times per task (start / blocker / completion). On Tom's machine today, that's ~10–30 submissions/day.

## The three options reviewed

### (a) Stay on gbrain forever — *chosen*

gbrain remains installed on every agent machine for one reason: `jobs submit`. The brain-replacement story is unchanged — fbrain is the *knowledge brain*. gbrain becomes the *kanban telemetry infra*, scoped to one CLI surface (`gbrain jobs *`).

- **Engineering cost:** zero.
- **Time to ready:** today.
- **Coupling:** the kanban-agent skill keeps a hard dependency on `gbrain` being on `PATH`. Acceptable — it's already there and not deprecating.
- **What changes:** documentation only. The kanban-agent skill (`~/.claude/skills/kanban-agent/SKILL.md`) gets a one-line note that this gbrain dependency is **intentional post-flip**, not transitional. G0 gate row #11 flips green.

### (b) Port `jobs submit` + read side into fbrain

A new `job_checkpoint` (or `minion_checkpoint`) fold_db schema with `task_id`, `kind`, `message`, `created_at`; a `fbrain jobs submit` / `list --status waiting` / `get` CLI subset; the kanban-agent skill rewrites every `gbrain jobs submit` invocation to `fbrain jobs submit`; the orchestrator's read loop rewires.

- **Engineering cost:** ~200–400 LOC + a new schema register + smoketest. 1–3 days conservative, 1+ week if the schema cycle is contentious. **Plus** rewiring every existing `gbrain jobs list --status waiting | grep minion-checkpoint` reader (the orchestrator and the kanban sidebar both poll this — we'd need to find every grep and dual-source it during cutover).
- **Win on the table today:** none observable. The bus has no remote consumer; both reader and writer live on Tom's machine. fbrain's team-shared-brain win doesn't apply — these are per-machine agent lifecycle events, not knowledge artifacts. A teammate on a different machine reading Tom's minion checkpoints is not a current use case.
- **Future value:** if a second user or a cross-machine orchestrator ever needs to read minion telemetry, *then* option (b) becomes interesting. Until then the port is speculative.
- **Why deferred:** "the proper fix" here is to leave a working bus working, not to rebuild it because gbrain is being deprecated for *unrelated* reasons. The knowledge-brain replacement and the kanban-telemetry concern are separable; conflating them is what creates the hard-gate problem in the first place.

### (c) Move kanban-agent skill to direct kanban API

A `kanban task checkpoint <task-id> --kind --message` command on the kanban CLI (or a comment-on-task approach). Telemetry attaches directly to the task row.

- **Engineering cost:** changes in upstream `cline/kanban` (issue #273 is already the OOM upstream — adding write paths is non-trivial, churn risk). The kanban CLI doesn't expose this surface today.
- **Wins:** semantically cleaner (task telemetry lives on the task). Eliminates the `gbrain` PATH dependency entirely.
- **Why deferred:** depends on an upstream we don't fully control. Hard-gate item #11 needs a disposition *before* 2026-08-23; (c) needs upstream willingness on a timeline we don't set. Re-open if/when the kanban project gains a comment/event surface.

## Why (a) is the right call

1. **The minion bus is append-only telemetry, not knowledge.** It has no semantic overlap with what fbrain replaces (records, search, ask, doctor, MCP, the agent write-mirror). Forcing it into fbrain blurs fbrain's scope.
2. **There is no remote consumer.** Both reader and writer live on the same machine the bus does. The team-shared-brain argument for moving things into fbrain doesn't apply — there is no teammate reading these checkpoints.
3. **gbrain isn't actually being deleted.** The G0 gate §2 already names a frozen-on-gbrain surface (`gbrain dream`, `gbrain integrations`, `gbrain transcripts`, `gbrain code-*`, `gbrain timeline*`, etc.). Adding `gbrain jobs *` to that list is one more well-scoped exception, not a violation of the replacement story.
4. **The flip can't wait on a speculative port.** G0 hard deadline is 2026-08-23. Items #10 (G5 hybrid `ask`), #1 (parity smoketest), #5 (7-day mirror-flip dogfood) all need code. Spending engineering hours on a bus port that delivers nothing user-visible is a poor allocation.
5. **Reversibility is high.** If a real consumer ever materializes — say the orchestrator goes multi-machine, or a teammate wants live visibility into Tom's parallel kanban runs — re-evaluating to (b) is straightforward: the schema is small, the migration is one-shot, and gbrain still works as a dual-write fallback during cutover.

## Implementation steps (all small)

1. **G0 gate row #11** in [`docs/g0-replacement-readiness-gate.md`](../g0-replacement-readiness-gate.md): flip ❌ outstanding → ✅. Update the §8 snapshot score from 4/11 → 5/11. Link this decision.
2. **`gbrain jobs *` joins the frozen-on-gbrain surface.** Extend the G0 §2 frozen list to add `gbrain jobs` so the scoping is explicit. Without this, a future reader will see `gbrain jobs` not in the frozen list and assume it must be replaced.
3. **kanban-agent skill** (`~/.claude/skills/kanban-agent/SKILL.md`, untracked, user-machine-local — flagged separately in the PR description): one-line note in the Iron Laws section that the gbrain dependency is intentional post-flip; one-line note in the Don't section that "Don't try to migrate `gbrain jobs submit minion-checkpoint` to fbrain — it's intentionally a different bus per [this decision]". No structural changes.
4. **No other repo changes.** The orchestrator's read loop, the kanban sidebar's poll, the existing minion-checkpoint job submissions — all keep working unchanged.

## What's *not* in this PR

- No code changes to fbrain, gbrain, the orchestrator, or the kanban CLI.
- No schema registration.
- No new follow-up tasks filed — option (a) closes #11 by itself. (Options (b) and (c) would have spawned chained tasks; (a) doesn't need to.)

## Out-of-scope future triggers — when to revisit

Re-open this decision if any of the following becomes true:

- A second machine or user starts reading minion checkpoints (cross-machine orchestrator, teammate visibility, dashboard).
- gbrain itself is genuinely sunset (binary deleted from `PATH`), not just brain-side frozen — at that point either (b) or (c) becomes forced.
- The kanban project upstream lands a native task-event/comment surface — option (c) gets cheaper.
- The minion bus grows a real worker (e.g., orchestrator picks up jobs and acts on them programmatically rather than just displaying) — at that point the queue semantics matter and the choice between gbrain and a fold_db re-implementation is no longer cosmetic.

Until one of those happens: **option (a). gbrain stays as the minion bus.**
