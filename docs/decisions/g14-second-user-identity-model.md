# Decision — G14 "second-user" gate item retired (false-premise)

**Date:** 2026-06-06
**Owner:** Tom Tang
**Status:** Decided — retired with no replacement instrument. Closes [G0 readiness-gate](../g0-replacement-readiness-gate.md) item #6 (and simplifies #7).

## TL;DR

Gate item #6 ("one named teammate writes > 0 records to fbrain over 7 consecutive days under their own `userHash`") was based on a false model of fbrain's identity layer. **`userHash` is the node's provisioned identity, not a per-install / per-human identity.** Two fbrain installs pointed at the same already-provisioned node produce **one** `userHash`, never two — so the gate's success criterion ("two distinct userHash values land in the same fold_db store") is architecturally unsatisfiable on the shared-node path the supporting playbook itself recommends.

**Decision:** retire #6. **Do not** add per-client identity, author-tag instrumentation, or any other synthetic second-writer machinery to make the metric measurable. Usability proof flows from #5 (mirror-flip 7-day dogfood) and the future G16 (cross-node visibility), not a second-user gate.

## The finding (verified 2026-06-06)

At HEAD `1e91f06` (origin/main; finding originally surfaced at `09ba6f8`, code paths unchanged):

- **`src/commands/init.ts:160-162`** — when `identity.provisioned` is true, init prints `[2/6] node already provisioned (user_hash=…) — skipping bootstrap` and adopts the node's existing hash:
  ```ts
  if (identity.provisioned) {
    userHash = identity.userHash;   // ← node identity, not per-client
  ```
- A fresh keypair is created **only** in the `!identity.provisioned` bootstrap branch (`init.ts:164-168`). Against an already-provisioned shared node, that branch never runs.
- Isolated-HOME repro (recorded in the spawn brief that surfaced this):
  ```
  TMPHOME=$(mktemp -d)
  HOME=$TMPHOME FBRAIN_FORCE_FILE_KEYCHAIN=1 \
    bun run src/cli.ts init --node-url http://127.0.0.1:9001 </dev/null
  jq -r .userHash $TMPHOME/.fbrain/config.json
  # → 33b0e8c029b436ff311894497ce981d8  (IDENTICAL to the existing userHash)
  ```
- **[`docs/dogfood-g14-second-user-playbook.md`](../dogfood-g14-second-user-playbook.md)** (lines 104-106) claimed init "provisions a brand-new keypair for the teammate ... and derives a fresh `userHash`." That sentence is false for the SSH-tunnel-to-one-node flow the playbook itself recommends as Option A.
- The same playbook (lines 209-210) explicitly declares the v0 trust model as **"one daemon, one team — not multi-tenant."** That declaration directly contradicts the per-`userHash` measurement criterion the gate doc inherited from it.

## Why retire, not re-instrument

Three options were on the table when this memo was drafted:

- **A.** Per-client identity in `fbrain init` — generate a per-install keypair even when the node is already provisioned. Lets two installs against one node produce two userHashes. Cost: split node-provisioning from per-client identity in init + write paths; capability-cert export/import flow for the teammate; widens v0 toward multi-tenant-without-ACL.
- **B.** Own-node-per-user + G16 cross-node visibility. Cost: zero fbrain code change, but G14 cannot ship before G16 (which has no committed timeline). Reverses the gate doc's §6 framing that explicitly chose **not** to couple G14 to cross-node sync.
- **C.** Revise the gate measurement — replace "two userHashes" with a per-write author-tag instrument (env var or frontmatter field). Cost: ~50-100 LOC + playbook rewrite.

**Chosen: none of the above. Retire #6 entirely.**

The original CEO-subagent finding (gate doc §4) was "without a second `userHash` writing, 'shipped' is undefined." That finding chose `userHash` as the instrument for "is fbrain usable by someone who isn't Tom." The instrument was wrong on the day it was written — `userHash` measures node identity, not human identity. Adding an author-tag (Option C) would be engineering work to make a metric satisfiable when the underlying question is already answered by other gate items:

- **#5 (mirror-flip 7-day dogfood)** proves fbrain survives daily-driver use.
- **#8 (rollback rehearsal)** proves the failure mode is bounded.
- **G16 (cross-node visibility, separate gate, not in scope here)** is where multi-machine / multi-human usage will get its real proof.

A v0 system whose declared trust model is "one daemon, one team" does not need an additional "second writer" proof. Drop the proxy.

## What changes

This memo updates the gate doc and obsoletes the supporting playbook. **No `src/` changes.**

1. **[`g0-replacement-readiness-gate.md`](../g0-replacement-readiness-gate.md) §4** — drop the "Replacement-readiness target: one named teammate ..." paragraph; replace with a one-line pointer to this memo.
2. **[`g0-replacement-readiness-gate.md`](../g0-replacement-readiness-gate.md) §7 item #6** — rewrite as **🗑️ Retired** with a link to this memo.
3. **[`g0-replacement-readiness-gate.md`](../g0-replacement-readiness-gate.md) §7 item #7** — drop the "(≥ 2 hashes)" sub-criterion. `fbrain doctor --usage` telemetry stays (it's useful for observing single-userHash write volume); the success criterion drops to "flag exists and reports."
4. **[`g0-replacement-readiness-gate.md`](../g0-replacement-readiness-gate.md) §8** — row 6 becomes 🗑️ retired; row 7 drops the "≥ 2-hash criterion tracked under #6" note; tally re-stated as "10 of 10 acceptance items green; one item (#6) retired as false-premise — see this memo." Item numbers preserved for link integrity (PR descriptions, in-flight references).
5. **[`dogfood-g14-second-user-playbook.md`](../dogfood-g14-second-user-playbook.md)** — prepended OBSOLETE banner pointing here. File retained (referenced from gate doc + PR #18 history); body unchanged.

## Future direction (deferred — not v0 work)

Option A (per-client identity in fbrain init) remains interesting if v1+ ever needs real multi-writer-per-daemon. At that point it gets its own design memo and its own gate item; it is **not** being implemented speculatively now. Re-evaluate when (or if) a concrete cross-human-per-daemon use case shows up.
