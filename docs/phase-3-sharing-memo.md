# Phase 3 sharing spike memo

**Date:** 2026-05-23
**Spike duration:** ~2h (cold Rust build for the second node dominated wall time; active HTTP work was ~20min)
**fold ref:** same monorepo SHA used in Phase 0/1/2 (built locally at `/Users/tomtang/code/edgevector/fold`)
**Spike nodes:** `/tmp/fbrain-share-spike-A` (port 9103, schema 9104, user_hash `b75af16dca4e6406bd10f42aeb215288`) and `/tmp/fbrain-share-spike-B` (port 9105, schema 9106, user_hash `8c83b55e4452d77693aa97c563c33fcb`) — both torn down at end of spike

## VERDICT: MEMO — cross-node data flow is structurally unprovable on a localhost-only spike

The sharing **metadata** primitives — `ShareRule`, `ShareInvite`, `ShareSubscription` — work end-to-end on loopback. Two nodes with distinct identities can create a rule, hand-deliver an invite, and persist a subscription. **But no records ever move between nodes**, because fold_db's cross-node data transport is the cloud sync engine (S3-backed, mediated by an Auth Lambda), and that layer is unreachable from a localhost-only spike. Without the transport, the "negative test" the plan called for — *B cannot read an unshared record* — is moot: B can't read **any** of A's records, shared or not, because B's local sled has neither and there's no path to fetch them.

The "loopback owner-context short-circuit" the plan warned about does **not** exist in the form anticipated: passing A's `X-User-Hash` to B's node simply returns 0 results (B's node has no records for that user). The real structural barrier is different — it's the missing sync transport, not an over-permissive access check.

A real two-device test would require either: (a) configuring fold_db's Auth Lambda + S3 against an Edgevector dev account so both nodes can sync through it, or (b) two physically separate boxes both pointing at that infra. Neither was in spike scope, and the plan explicitly said this would be a valid conclusion.

## fold_db sharing surface (canonical)

Read from `/Users/tomtang/code/edgevector/fold/fold_db_node/src/server/http_server.rs:433-486` (route registration) and the corresponding handlers under `src/handlers/sharing.rs` and `src/server/routes/trust.rs`. Probed live with `curl` against node A on port 9103. Authoritative.

### Identity / auth model

Every `/api/sharing/*` endpoint requires `X-User-Hash`. Missing the header gets `401 MISSING_USER_CONTEXT`. The middleware (`fold_db_node/src/server/middleware/auth.rs:52-77`) runs the request in a task-local user context, so each handler operates against the namespace of the caller's user_hash. The server only binds to loopback (`bind_address_is_loopback()` in `bin/folddb_server.rs`).

### `POST /api/sharing/rules` — create a ShareRule

**Request body:**
```json
{
  "recipient_pubkey": "<base64 Ed25519, must be exactly 32 bytes decoded>",
  "recipient_display_name": "fbrain-B",
  "scope": { "Schema": "Design" }
}
```

`scope` is a tagged enum with three shapes:
- `{ "Schema": "<descriptive_name>" }` — share an entire schema
- `{ "SchemaField": ["<schema>", "<field>"] }` — share a single field
- `"AllSchemas"` — share everything

**Response (200):**
```json
{
  "ok": true,
  "rule": {
    "rule_id": "b3374e44-8745-407d-be24-75cd43b2fc86",
    "recipient_pubkey": "0JgE4ced8l6tBMyLjtFhvMnl2lLWhls+RupSI4vvU6Y=",
    "recipient_display_name": "fbrain-B",
    "scope": { "Schema": "Design" },
    "share_prefix": "share:b75af16dca4e6406bd10f42aeb215288:8c83b55e4452d77693aa97c563c33fcb",
    "share_e2e_secret": [36, 26, 207, 30, /* 32 bytes */],
    "active": true,
    "created_at": 1779551122,
    "writer_pubkey": "wGMj0qkayHDiCwz1qEXh9MZY7WIXbmXzXYh6XBZjVT8=",
    "signature": "zICr9A5LqU80Qx/kM1fdwd4ge7QG5pz9z7oYmhROVeQccXWI8Q5jbJZpbkXfTqSg28CZKfafuEEhlVjytgybDg=="
  },
  "user_hash": "b75af16dca4e6406bd10f42aeb215288"
}
```

**Notable empirical findings:**
- `share_prefix` is `share:{owner_user_hash}:{recipient_user_hash}` — `8c83b55e4452d77693aa97c563c33fcb` here is literally B's bootstrapped user_hash. Two-party invariant baked into the prefix.
- `share_e2e_secret` is a fresh 32-byte symmetric key, freshly minted per rule (not derived from the participants' pubkeys).
- The rule is signed with the owner's Ed25519 key over `rule_id || 0x00 || recipient_pubkey || 0x00 || share_prefix || 0x00 || share_e2e_secret || 0x00 || created_at.to_be_bytes()` (per `fold_db/crates/core/src/sharing/signing.rs:51-55`). `recipient_display_name`, `active`, `scope`, and the signature itself are NOT signed — they're mutable post-creation.
- **Critical: does NOT require the recipient to be in the contact book.** Phase 3 plan and the Rust source's `generate_invite` call site both implied a contact-book gate, but the rule creation itself only validates that `recipient_pubkey` decodes to 32 bytes.
- **Server crash on malformed pubkey.** Sending `"FAKE_PK_FOR_PROBE"` (not valid base64-32) returned `Empty reply from server` (curl exit 52). The node process recovered on its own (subsequent requests succeeded), but the request handler clearly panics or aborts the connection. Out of spike scope to fix; **file in fold's issue tracker.**

### `GET /api/sharing/rules` — list rules

**Response (200):**
```json
{
  "ok": true,
  "rules": [ /* ShareRule[] */ ],
  "user_hash": "..."
}
```

Returns rules created by the calling user_hash. Confirmed empty after fresh bootstrap.

### `DELETE /api/sharing/rules/{id}` — deactivate

**Response (200):** `{"ok": true, "user_hash": "..."}`. The rule's `active` field flips to `false`; it's not deleted (still visible in `list_rules`).
- 404 on unknown rule_id: `{"ok": false, "error": "Not found: Rule not found: <id>"}`

### `POST /api/sharing/invite` — generate ShareInvite + push via bulletin board

**Request body:**
```json
{ "rule_id": "b3374e44-...", "scope_description": "Design schema cross-node share" }
```

**Empirical responses observed:**
- 404 on bad `rule_id`: `{"ok":false,"error":"Not found: Rule not found: 00000000-0000-0000-0000-000000000000"}`
- 400 on valid `rule_id` when the recipient isn't in the contact book: `{"ok":false,"error":"Bad request: No contact found for recipient <pubkey> — connect via discovery first"}`

**This is the discovery-service-gated endpoint.** The handler (`handlers/sharing.rs:225-296`, with the bulletin-board variant at `:358-473`) does this:
1. Looks up the rule by id
2. Fetches the recipient's contact-book entry (must have `messaging_public_key` + `messaging_pseudonym`)
3. If a `DISCOVERY_AUTH_TOKEN` is available (env or keychain), encrypts the invite to the recipient's messaging key and publishes it to the bulletin board via `DiscoveryPublisher`
4. Otherwise, returns the invite as JSON for manual transport

The contact book is populated only via the discovery connection flow between two nodes, which requires the cloud discovery service. **`GET /api/sharing/exemem-status` on a fresh `--local` node confirms this**: `{"connected":false,"reason":"Exemem session expired or not signed in. Re-authenticate in Settings > Cloud Backup to refresh."}`.

### `POST /api/sharing/accept` — accept a ShareInvite, create a ShareSubscription

**Request body:**
```json
{
  "invite": {
    "sender_pubkey": "wGMj0qkayHDiCwz1qEXh9MZY7WIXbmXzXYh6XBZjVT8=",
    "sender_display_name": "fbrain-A",
    "share_prefix": "share:b75af16dca4e6406bd10f42aeb215288:8c83b55e4452d77693aa97c563c33fcb",
    "share_e2e_secret": [36, 26, 207, 30, /* 32 bytes */],
    "scope_description": "Design schema cross-node share"
  }
}
```

**Response (200):**
```json
{
  "ok": true,
  "subscription": {
    "sender_pubkey": "wGMj0qkayHDiCwz1qEXh9MZY7WIXbmXzXYh6XBZjVT8=",
    "share_prefix": "share:b75af16dca4e6406bd10f42aeb215288:8c83b55e4452d77693aa97c563c33fcb",
    "share_e2e_secret": [36, 26, 207, 30, /* 32 bytes */],
    "accepted_at": 1779551151,
    "active": true
  },
  "user_hash": "8c83b55e4452d77693aa97c563c33fcb"
}
```

**Empirical finding:** `accept` does **no validation** of the invite. It accepted a fully synthetic `{sender_pubkey:"FAKE_SENDER", share_e2e_secret:[1,2,3,4,5], ...}` and created a subscription. The endpoint trusts whatever the local caller passes in, on the implicit theory that the only way an invite gets in front of this handler is via the bulletin-board path (signed envelope, sender verification done on decryption upstream). **This makes manual hand-delivery of an invite trivial in spike mode** — but also means the endpoint is structurally unsuitable as a security boundary on its own.

### `GET /api/sharing/pending-invites`

**Response (200):** `{"ok": true, "invites": [<ShareInvite>...], "user_hash": "..."}`. The pending-invites queue is populated by the discovery inbound handler (`handlers/discovery/inbound.rs:613`) when a bulletin-board message arrives. On a local-only spike it stays empty even after manual `accept` (manual accepts don't enqueue to pending).

### `GET /api/sharing/exemem-status`

**Response (200, always):**
```json
{
  "connected": false,
  "reason": "Exemem session expired or not signed in. Re-authenticate in Settings > Cloud Backup to refresh."
}
```
or
```json
{
  "connected": true,
  "discovery_url": "...",
  "token": { "valid": true|false, "expires_in_secs": N, "format": "Bearer" }
}
```

**Always 200**, with `connected:false` on a fresh local node. This is the diagnostic endpoint to check before assuming sharing will work.

### `GET /api/sharing/posture`

**Response (200):**
```json
{
  "ok": true,
  "contacts_per_domain": {},
  "domains": [],
  "schemas_per_domain": { "personal": 13 },
  "total_policy_fields": 0,
  "total_unprotected_fields": 91,
  "user_hash": "..."
}
```

Contact book + domain policy posture. The 13 `personal` schemas are auto-loaded fold-shipped defaults (org/contact/personal-info schemas; fbrain doesn't touch them).

### `GET /api/sharing/roles`

**Response (200):** A dictionary of seven built-in role names mapping to `{description, domain, name, tier}` — `acquaintance`, `close_friend`, `doctor`, `family`, `financial_advisor`, `friend`, `trainer`. fbrain's `Design`/`Task` schemas don't currently use these.

### Other routes (touched but not exercised end-to-end)

| Route | Purpose |
|---|---|
| `POST /api/sharing/assign/{key}` | Assign a contact role |
| `DELETE /api/sharing/remove/{key}/{domain}` | Remove a contact role |
| `POST /api/sharing/apply-defaults` | Bulk-apply default sharing policies |
| `PUT /api/sharing/policy/{schema}/{field}` | Per-field policy |
| `GET /api/sharing/policies/{schema}` | List per-field policies |
| `GET /api/sharing/audit/{key}` | Sharing audit log for a contact |

All require `X-User-Hash`. None are load-bearing for the basic share flow.

## What worked end-to-end on the spike

1. **Two-node setup with distinct identities.** Both nodes booted with separate `--home` dirs, auto-slotted to different ports (9103 + 9105), and `auto-identity` returned distinct `public_key` + `user_hash` values. No keychain sharing or identity bleed.
2. **Schema registration on both nodes.** Same canonical hash (`84d9f350...`) for the Design schema on both nodes' schema services — the canonicalizer is content-addressed and deterministic.
3. **Record creation on A.** Both `shared-doc-1` and `shared-doc-2` Designs created on A, visible via A's `/api/query` (returns both slugs).
4. **Baseline isolation on B.** Before any sharing setup, B's `/api/query` for Design returned `total_count: 0` — confirming separate storage.
5. **ShareRule creation on A with B's pubkey** — succeeded, signed correctly, listed in `/api/sharing/rules`.
6. **Manually synthesized ShareInvite from A's rule** — extracted `share_prefix`, `share_e2e_secret`, `writer_pubkey` from A's rule list, hand-built a `ShareInvite` JSON.
7. **B's `/api/sharing/accept` with that synthesized invite** — succeeded, subscription persisted.

So the metadata flow is fully exercise-able without discovery.

## What didn't work

**The actual cross-node data fetch.** After all the above, B's `/api/query` for Design still returned `total_count: 0`. Even with an active `ShareSubscription` pointing at A's `share_prefix` and clutching A's `share_e2e_secret`, B's node has no mechanism in `/api/query` to consult subscriptions, contact a remote node, fetch encrypted log entries, decrypt them, and apply them locally.

Source-of-truth confirmation (`fold_db/crates/core/src/sync/engine.rs:223-227`):
> The sync engine manages replication of a local Sled database to S3. fold_db (local) ──▶ SyncEngine ──▶ Auth Lambda ──▶ S3 (encrypted blobs)

The `SyncTarget` plumbing in `fold_db_node/src/fold_node/node.rs:984-1020` does configure share-prefix-keyed sync targets for both ShareRules (publish) and ShareSubscriptions (subscribe), but the engine that drives those targets needs S3 + presigned URLs from the Auth Lambda. Searching both nodes' stdout/stderr for "sync", "S3", "presign", "discovery", "exemem" turned up **no output** — the sync engine never even started on a `--local --local-schema` boot.

**Also did not work:**
- `POST /api/sharing/invite` against B's pubkey → 400 "No contact found for recipient ... — connect via discovery first". Discovery is required for the official invite-delivery path; manual transport (used in this spike) bypasses but doesn't replicate what production does.
- A's `X-User-Hash` against B's `/api/query` → 0 results. The "loopback owner-context" risk the plan worried about doesn't manifest at `/api/query`: B's node only has B's data, period.

## Why a positive cross-node test can't be conclusive on one machine

For B to see a record A wrote, all of the following must hold:

1. A's sync engine must serialize the mutation log entry, encrypt it with `share_e2e_secret` (from the matching ShareRule), and PUT it to S3 at a key under the matching `share_prefix`. **Requires an Auth Lambda for presigned-URL minting.**
2. B's sync engine must list keys under `share_prefix` from S3 (also via the Auth Lambda), GET the blobs, decrypt with `share_e2e_secret` (from B's matching ShareSubscription), and apply the log entry to B's local sled.
3. Both nodes must use the **same** S3 bucket + Auth Lambda configuration to see each other's writes.

A `--local --local-schema` boot configures neither side of this. No `EXEMEM_API_URL` is set, no auth token is in the keychain, no S3 credentials exist. The sync engine has nothing to talk to.

That means the only paths to a conclusive positive test are:

1. **Configure fold_db's cloud sync against a real Edgevector dev account.** Set `DISCOVERY_SERVICE_URL` + `DISCOVERY_MASTER_KEY` (or `EXEMEM_API_URL` + a valid token) on both nodes. Verify both can reach the Auth Lambda, run the share flow, watch the data flow through S3. **Out of Phase 3 spike scope** — the plan explicitly framed this as a localhost spike.
2. **Two real devices** each with the cloud sync configured, in two different keychains, on two different machines.

The negative test ("B cannot read an unshared record") becomes meaningful only AFTER the positive test demonstrates that the transport works at all. Without transport, the negative is a tautology — B sees nothing, full stop.

## A loophole that almost works (and why it doesn't)

In principle, you could:
- Tail `/api/query` results on A for a given schema
- Send each row as a `/api/mutation` to B with the same canonical schema hash and key

This sidesteps fold's sync engine entirely — it's basically a hand-rolled bridge. It "works" in the sense that B would now have a copy of the record. But:
- It bypasses **all** of fold_db's access control. B receives the record from a process that has A's `X-User-Hash`; there's no ShareRule check anywhere. The thing being tested isn't sharing-with-access-control; it's a copy script.
- The `share_e2e_secret` is never used; the data is plaintext on the wire (well, loopback, but unencrypted at the application layer).
- It can't model the negative test because, again, B's node has no mechanism to refuse a /api/mutation that the caller is authorized to issue.

So while you can write code that satisfies "B has a record that originated on A", it's not testing fold_db sharing.

## Recommendation for FBRAIN_PLAN.md Workstream

The production sharing plan should be aware that fold_db sharing is **infrastructure-coupled**:

1. **Sharing has two layers, both required.**
   - *Metadata layer* (rules, invites, subscriptions): works locally, fully testable on a single machine without cloud infra. fbrain can implement the metadata side end-to-end without depending on anything remote.
   - *Transport layer* (encrypted log replication via S3 + Auth Lambda + discovery): requires deployed cloud infra. fbrain cannot drive this in tests without standing up — or pointing at — fold's exemem service.

2. **Integration tests for sharing require either** (a) a deployed dev exemem stack, or (b) a hand-rolled S3 emulator + Auth Lambda mock. (a) is probably what production wants anyway; (b) is overkill for a CLI prototype.

3. **The CLI should distinguish "rule created" from "share active".** A naive `fbrain share <slug> --to <user_hash>` that creates a ShareRule and prints "done" misrepresents what happened. The data won't actually move until sync is configured. A real `fbrain share` command should:
   - Check `GET /api/sharing/exemem-status`; require `connected:true` before claiming a share will actually work.
   - Create the ShareRule via `POST /api/sharing/rules`.
   - Attempt `POST /api/sharing/invite` (the discovery-mediated path); fall back to printing the JSON invite for manual delivery on 400.
   - Make clear in its success message that data flow waits on the recipient's `/api/sharing/accept` plus an active sync.

4. **Sharing endpoint quality issues found in this spike:**
   - `POST /api/sharing/rules` with a non-base64 `recipient_pubkey` crashes the request (server returns empty body, panics or aborts connection). Filed mentally as a fold bug; the production plan should expect to file it for real.
   - `POST /api/sharing/accept` does no validation of the invite payload. Any synthetic invite is accepted. This is fine if the bulletin-board upstream is verifying signatures (which it does), but `accept` itself shouldn't be relied on as the security boundary.
   - The `share_prefix` includes the **recipient's user_hash** in plaintext (`share:{owner}:{recipient}`). This leaks the recipient identifier to anyone who can read S3 keys. If S3 is access-controlled to participants only, that's fine; if it's a public bucket with object-level ACLs, it's a metadata leak vector worth thinking about.

5. **The plan's worry about "loopback owner-context short-circuit" was misplaced.** The actual structural barrier is the missing transport, not over-permissive identity. The plan can drop that concern and replace it with "cross-node sharing requires deployed cloud sync infrastructure."

## Spike teardown

- Both nodes killed (`kill <pids>`); confirmed no orphan `folddb_server` processes remain (memory `project_kanban_orphan_folddb_server.md`).
- `~/.folddb-slots/9103.json` and `~/.folddb-slots/9105.json` removed.
- `/tmp/fbrain-share-spike-A` and `/tmp/fbrain-share-spike-B` directories removed.
- Daily node (`/tmp/dogfood-2026-05-23/home` on 9101) untouched.
