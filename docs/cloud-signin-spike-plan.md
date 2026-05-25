# Cloud sign-in spike plan — light up exemem on the fbrain daemon

**Status:** DRAFT — no implementation yet.
**Filed:** 2026-05-25
**Why now:** Earlier framing in [`README.md`](../README.md) and [`g0-replacement-readiness-gate.md`](g0-replacement-readiness-gate.md) §6 implied fold_db has no cross-node sync transport. That was a misframe. The transport exists in code and is deployed as cloud infra; the homebrew daemon at `:9001` simply hasn't authenticated against it. This doc captures what it would take to close that gap.

## 1. Ground truth — what's already built

| Layer | Location | State |
|---|---|---|
| Sync engine (Rust) | [`fold/fold_db/crates/core/src/sync/engine.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db/crates/core/src/sync/engine.rs) — `local Sled → SyncEngine → Auth Lambda → S3 (encrypted blobs)` | Built. Drives per-share-prefix sync targets from [`node.rs:984-1020`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/fold_node/node.rs). Doesn't start on `--local --local-schema`. |
| Sharing surface (Rust) | [`fold/fold_db/crates/core/src/sharing/`](https://github.com/EdgeVector/fold/blob/main/fold_db/crates/core/src/sharing/) — `ShareRule`, `ShareInvite`, `ShareSubscription`, signing | Built. All `/api/sharing/*` endpoints in [`fold_db_node/src/handlers/sharing.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/handlers/sharing.rs) work on loopback (Phase 3 memo). |
| Cloud transport (TS Lambdas) | [`exemem-infra/lambdas/`](https://github.com/EdgeVector/exemem-infra/tree/main/lambdas) — `auth_service`, `discovery`, `messaging_service`, `storage_service`, `storage_admin_service`, `storage_counter`, `org_service`, `subscription_service`, `billing_service`, `dashboard_service` | Deployed. Dev: `us-west-2`. Prod: `us-east-1`. Both deploy pipelines green. |
| Cloud-sign-in CLI (Rust) | [`fold/fold_db_node/src/bin/folddb/commands/cloud.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/bin/folddb/commands/cloud.rs) | Built (legacy Tauri-app path also handles it via "Settings > Cloud Backup"). |
| `fbrain share` CLI (TS) | `fbrain/src/commands/share.ts` | **Stub** — prints memo pointer, exits 1. |
| End-to-end cross-node validation | — | **Never run.** Phase 3 was explicit about this being out of scope. |

## 2. Live state on Tom's daemon (probed 2026-05-25)

```bash
$ curl -sS -H "X-User-Hash: dcf41c3a..." http://127.0.0.1:9001/api/sharing/exemem-status
{"connected":false,"reason":"Exemem session expired or not signed in. Re-authenticate in Settings > Cloud Backup to refresh."}

$ curl -sS -H "X-User-Hash: dcf41c3a..." http://127.0.0.1:9001/api/sharing/posture
{"ok":true,"contacts_per_domain":{},"domains":[],"schemas_per_domain":{"personal":25},"total_policy_fields":0,"total_unprotected_fields":214,...}

$ curl -sS -H "X-User-Hash: dcf41c3a..." http://127.0.0.1:9001/api/sharing/pending-invites
{"ok":true,"invites":[],"user_hash":"dcf41c3a..."}
```

Translation: daemon is healthy, single-tenant, **unsigned-into the cloud**, **empty contact book**.

## 3. What "lighting it up" actually means — six concrete steps

Numbered so each can be a separate kanban task / PR if we decide to ship this.

### S1. Sign the homebrew daemon in to the exemem dev stack

The daemon was launched via homebrew (`/opt/homebrew/bin/folddb_server --port 9001`). It needs:

- A valid exemem session token in the system keychain (where [`fold_db_node/src/keychain.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/keychain.rs) looks for it).
- `DISCOVERY_SERVICE_URL` pointing at the deployed discovery lambda.
- An `EXEMEM_API_URL` or equivalent pointing at `auth_service`.

**Probe before doing this:** read [`fold/fold_db_node/src/bin/folddb/commands/cloud.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/bin/folddb/commands/cloud.rs) end-to-end to learn the actual CLI surface — `folddb cloud signin`? `folddb cloud login`? — and what credentials it expects (org-issued? exemem invite code? OAuth?). That research belongs in S1's first commit, before any sign-in attempt.

Acceptance: `GET /api/sharing/exemem-status` returns `{"connected": true, "discovery_url": "...", "token": {"valid": true, ...}}`.

**Risk:** the daemon binary may need a restart-with-env or a per-user keychain entry the homebrew install never sets up. May require packaging changes upstream in `EdgeVector/fold` — out of fbrain repo scope.

### S2. Provision a second identity (laptop ↔ desktop, OR Tom-A ↔ Tom-B)

Two distinct user_hashes signed into the same exemem stack. Easiest cheap path: spin up a second fold_db node on a sibling port (`:9002`) under a separate `--home` dir, sign it into the same dev stack with a second cloud account.

The Phase 3 spike already validated that two nodes have distinct identities (`auto-identity` returns distinct `public_key` + `user_hash`). What changes here is that both have to actually talk to the cloud.

Acceptance: `posture` on each node shows the other as a contact after a discovery handshake.

### S3. Run the discovery handshake

`POST /api/discovery/connect` (or equivalent — confirm exact endpoint in [`fold_db_node/src/discovery/`](https://github.com/EdgeVector/fold/tree/main/fold_db_node/src/discovery)) on both nodes to populate each other's contact book. This is the prerequisite for `/api/sharing/invite` returning 200 instead of `400 No contact found for recipient`.

Acceptance: both nodes' `/api/sharing/posture` shows `contacts_per_domain: {personal: 1}` (or similar), and the recipient's pubkey is listed.

### S4. The positive cross-node test

The thing nobody has actually run yet. From [`docs/phase-3-sharing-memo.md`](phase-3-sharing-memo.md) §"Why a positive cross-node test can't be conclusive on one machine":

1. Node A: `fbrain put shared-doc-1` (a Design with body "alpha bravo").
2. Node A: `POST /api/sharing/rules` with B's pubkey, `scope: {Schema: "Design"}`.
3. Node A: `POST /api/sharing/invite` (cloud-mediated path, not manual).
4. Node B: `GET /api/sharing/pending-invites` — assert invite arrived.
5. Node B: `POST /api/sharing/accept` with the pending invite.
6. **Wait for sync** (TTL TBD — probably tens of seconds; instrument it).
7. Node B: `fbrain get shared-doc-1` (or `fbrain search "alpha bravo"`) — **must return the record**.

Acceptance: step 7 succeeds. Capture timing + S3 object inspection (the encrypted blobs under `share:<owner>:<recipient>/`) as evidence.

### S5. The negative cross-node test

Phase 3 called this "B cannot read an unshared record." With transport working, this becomes meaningful:

1. Node A: `fbrain put private-doc-1` (Task — different schema than the ShareRule).
2. Node B: wait the same sync window.
3. Node B: `fbrain get private-doc-1` and `/api/query` for Task — **must return empty / not-found**.

Acceptance: step 3 finds nothing, confirming `scope: {Schema: "Design"}` actually restricts the share.

### S6. `fbrain share` CLI implementation

Replace the stub at `src/commands/share.ts` with a real implementation:

```
fbrain share <slug> --to <recipient-user-hash-or-pubkey-or-display-name>
  [--scope schema|all]
  [--no-cloud]   # creates the rule but doesn't try /invite (manual transport)
```

Logic:
1. Check `GET /api/sharing/exemem-status`; fail loud if `connected: false` (point at S1).
2. Resolve recipient to a pubkey via contact book lookup; fail loud if not found (point at S3).
3. `POST /api/sharing/rules` with the scope.
4. `POST /api/sharing/invite` (cloud path); fall back to printing the JSON invite on 400.
5. Print a success message that clearly distinguishes "rule created" from "share active" — data flow waits on recipient `accept` + sync window.

Acceptance: green path of S4 reduces to two CLI calls — `fbrain share shared-doc-1 --to fbrain-B` on A, `fbrain share-accept` on B (or auto-accept from pending-invites poll).

## 4. Scope decisions to make before starting

- **Is this part of the G0 gate?** Current §6 framing says NO. Adding it would change the contract — material 5-6 week extension. Recommendation: keep out of G0, schedule as G16-prime / post-flip work, but treat the misframe-correction (this doc + the §6 clarification) as the deliverable for now.
- **Dev or prod exemem stack?** Dev (us-west-2) for the spike. Prod (us-east-1) is for daily-use data, not destructive cross-node probing.
- **Reversibility.** Signing the daemon into the cloud is reversible (`folddb cloud signout`). But any record A writes during the spike that gets pushed to S3 may persist — coordinate with exemem-infra's data-retention story before pushing real fbrain records through.

## 5. Pointers

- [`docs/phase-3-sharing-memo.md`](phase-3-sharing-memo.md) — full evidence of what works on loopback + every `/api/sharing/*` endpoint with captured JSON.
- [`docs/g0-replacement-readiness-gate.md`](g0-replacement-readiness-gate.md) §6 — current gate stance on multi-machine + team-sharing.
- [`exemem-infra/lambdas/`](https://github.com/EdgeVector/exemem-infra/tree/main/lambdas) — deployed cloud transport.
- [`fold/fold_db/crates/core/src/sync/`](https://github.com/EdgeVector/fold/tree/main/fold_db/crates/core/src/sync) — sync engine source.
- [`fold/fold_db_node/src/bin/folddb/commands/cloud.rs`](https://github.com/EdgeVector/fold/blob/main/fold_db_node/src/bin/folddb/commands/cloud.rs) — CLI sign-in surface.

## 6. Status

**No work in flight.** This doc exists so the next person who asks "why is fbrain laptop-only?" gets the honest answer (it isn't, structurally) instead of the misframe.
