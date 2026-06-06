# G14 second-user dogfood — playbook

> **🗑️ OBSOLETE (2026-06-06).** This playbook described a dogfood flow that
> cannot work as written — `userHash` is the *node's* provisioned identity,
> not a per-install identity, so two fbrain installs pointed at the same
> already-provisioned node produce **one** `userHash`, not two. The gate
> item this playbook served ([`g0-replacement-readiness-gate.md`](g0-replacement-readiness-gate.md) #6) has been retired
> as false-premise. See [`decisions/g14-second-user-identity-model.md`](decisions/g14-second-user-identity-model.md).
> File retained for history; do not execute the steps below.

**Status:** ~~ready to execute. Teammate TBD.~~ OBSOLETE — see banner above.
**Gate item:** ~~#6 in [`g0-replacement-readiness-gate.md`](g0-replacement-readiness-gate.md).~~ Retired.
**Owner:** Tom Tang (the human onboarding step is not delegable).

## What the gate requires

> One named teammate writes > 0 records to fbrain over **7 consecutive days** under their own `userHash`.

The Phase 1 CEO subagent finding: without a second `userHash` writing, "shipped"
is undefined. Single-user adoption tells us nothing about whether fbrain works
for someone who isn't Tom.

Per `g0-replacement-readiness-gate.md` §6 the dogfood uses **separate fbrain
installs writing to the same node** — not actual cross-node sync (that's G16).
Two distinct `userHash` values land in the same fold_db store and become
visible to `fbrain doctor --usage`.

## Prerequisites (teammate side)

- **Bun ≥ 1.3.10.** `bun --version`.
- **Network reach to Tom's homebrew daemon.** The daemon binds `127.0.0.1:9001`
  by default — see "Pick a node" below for the three ways to expose it.
- **Network reach to the prod schema-service Lambda** at
  `https://axo709qs11.execute-api.us-east-1.amazonaws.com`. Open internet is
  enough; no AWS creds required.
- **Git + a GitHub account with read access to `EdgeVector/fbrain`.**

The teammate does **not** need: Rust, a local `fold_db_node`, AWS credentials,
or any fold-specific tooling. fbrain is a thin client — all heavy lifting
happens on Tom's daemon.

## Pick a node — the central tradeoff

The gate measures two distinct `userHash` values **writing to the same node**.
That means the teammate's `fbrain init` has to point at a daemon Tom can also
see. Three options, recommended order:

### Option A (recommended): SSH tunnel to Tom's homebrew daemon

```bash
# On teammate's machine, in one terminal:
ssh -N -L 9001:127.0.0.1:9001 tom@<tom-laptop-hostname>

# In another terminal:
fbrain init --node-url http://127.0.0.1:9001
```

- ✅ Zero exposure — the daemon stays bound to loopback on Tom's machine.
- ✅ Authenticated by SSH — no fold-side auth required.
- ✅ Writes land in the same Sled store Tom's writes do, so `doctor --usage`
  reports both hashes in one report.
- ❌ Tunnel must be running for every write. Drop the SSH session, drop the
  write path. Acceptable for a 7-day dogfood.

### Option B: bind daemon to LAN (`0.0.0.0:9001`), teammate connects to `http://<tom-laptop-ip>:9001`

- ✅ No per-session tunnel — works as long as both machines share a network.
- ❌ Daemon has zero auth in front of `/api/mutation`. Anyone on the same LAN
  can write. Only acceptable on a trusted home or office network. If using a
  shared coworking network or coffee shop wifi — don't.

### Option C: teammate runs their own daemon

- ❌ **Does not satisfy the gate** — two separate daemons hold two separate
  Sled stores, so the two `userHash` values never appear in the same
  `doctor --usage` report. Per §6 of the gate doc, the dogfood is explicitly
  "separate fbrain installs writing to the same prod node," not cross-node.
- Only useful as a smoke test of the teammate's local setup before they tunnel
  into Tom's daemon. Not the dogfood path.

**Default to Option A** unless there's a specific reason not to. The remainder
of this playbook assumes Option A.

## Step-by-step onboarding

### 1. Clone + link fbrain

```bash
git clone https://github.com/EdgeVector/fbrain
cd fbrain
bun install
bun link              # exposes a global `fbrain` binary on $PATH
```

### 2. Open the tunnel to Tom's daemon

Tom shares his laptop hostname or IP. Teammate runs:

```bash
ssh -N -L 9001:127.0.0.1:9001 tom@<tom-laptop-hostname>
```

Leave that terminal running. If it disconnects, restart it before writing.

### 3. Bootstrap fbrain

```bash
fbrain init --node-url http://127.0.0.1:9001
# Accept the defaults — prod schema-service Lambda is correct.
```

`fbrain init` provisions a brand-new keypair for the teammate (written to
`~/.fbrain/config.json` on their machine) and derives a fresh `userHash`. This
is the value that the gate measures.

### 4. Capture the teammate's `userHash`

The teammate runs:

```bash
fbrain doctor | grep user_hash
# expected output (the prefix matters, not the full hash):
# [PASS] node-provisioned  — user_hash=<8 hex chars>...
```

Or directly:

```bash
jq -r .userHash ~/.fbrain/config.json | cut -c1-8
```

The teammate pastes the 8-char prefix into the kanban ticket / Slack thread
that filed this dogfood. Tom adds it to `scripts/dogfood-monitor.sh`'s tracked
list (see "Monitoring" below).

### 5. Smoke-write one record

Confirms end-to-end works before counting days:

```bash
fbrain put dogfood-day-0 <<'NOTE'
---
type: spike
title: G14 dogfood — day 0
tags: [g14-dogfood]
---
First write from teammate <name>. userHash=<prefix>.
NOTE

fbrain get dogfood-day-0     # confirm round-trip
```

On Tom's side:

```bash
fbrain doctor --usage        # should now show 2 userHash entries
```

If `doctor --usage` shows the teammate's prefix, day 0 is in the bag.

## The 7-day commitment

Each calendar day (UTC) the teammate writes **≥ 1 record** to fbrain. Any
record type counts — a `spike`, a `concept`, a `task`, a frontmatter `put` of
a markdown note. The gate doesn't care what they write, only that the
`userHash` shows up in the daily summary for 7 consecutive days.

Reasonable cadence — the goal is *real* daily use, not synthetic ticks:

- Capture one design decision, one bug repro, or one "things I learned" note
  per day.
- A two-line concept is fine. A 50-line memo is fine. Padding is fine — fold
  has no rate limit.
- If the teammate forgets a day, the 7-day counter resets. The
  `dogfood-monitor.sh` script makes this visible the next time it runs.

The teammate does NOT need to:
- review fbrain code
- file bugs (though if they hit one, please file it)
- read other people's records
- understand fold_db internals

## Monitoring — daily check

`scripts/dogfood-monitor.sh` reads `~/.fbrain/usage.jsonl` (which
`fbrain doctor --usage` updates every time it runs) and reports PASS/FAIL
per tracked `userHash` over the trailing 7-day window:

```bash
./scripts/dogfood-monitor.sh dcf41c3a <teammate-prefix>
```

PASS = the hash has ≥1 write in each of the last 7 calendar dates present in
`usage.jsonl`. FAIL = at least one gap, with the missing dates listed.

Run `fbrain doctor --usage` daily on Tom's machine so the daily summary line
gets recorded — otherwise the monitor only sees the days Tom remembered to
sample. Easiest: add a cron / launchd job that runs `fbrain doctor --usage`
once a day.

## When the 7-day window completes

1. Tom runs `scripts/dogfood-monitor.sh <hash1> <hash2>` and captures the PASS
   output (or fixes the gap and waits one more day).
2. Tom updates [`g0-replacement-readiness-gate.md`](g0-replacement-readiness-gate.md)
   gate item #6 row to ✅ green with the date and the teammate's `userHash`
   prefix.
3. Tom opens a follow-up PR (or comment on the original tracker) referencing
   the PASS output as evidence.

## What this dogfood does NOT cover

- **Cross-node sync.** The teammate writes to Tom's node via tunnel. Real
  multi-machine sync is gate item G16, separate and out of scope.
- **Multi-tenant isolation.** Every record on Tom's node is readable by both
  users — no ACL enforcement. The fbrain v0 trust model is "one daemon, one
  team," not multi-tenant.
- **Quality of the teammate's writes.** The gate is "did they write,"
  not "was it good." Telemetry for write quality is a separate concern.
- **Cross-userHash analytics beyond write counts.** Type breakdowns,
  per-hash retrieval quality, etc. are gate item #7 (G13 telemetry).
