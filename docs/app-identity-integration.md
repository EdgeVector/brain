# App-identity integration (fbrain client) — for the next app developer

This is the integration story for app_identity v3.1 as implemented in fbrain
(Lane D, client half). The next app — kanban, in Rust — can use this as a
reference for the consent acquisition, capability storage, and 403-handling
contract. The authoritative spec is
`exemem-workspace/docs/designs/app_identity.md` ("Client contract",
"Fold_db_node contract").

## What changed

fbrain is now an **app** under app_identity. Its 8 schemas live in the
`fbrain/*` namespace, and every write attaches a node-signed capability token
proving the node owner consented to fbrain acting on their data.

| Area | Before | After |
|---|---|---|
| Schema identity | `descriptive_name` + fields | `owner_app_id` (`fbrain`) folded into the identity hash → canonical name `fbrain/<Name>` |
| Writes | `X-User-Hash` only | `X-User-Hash` + `X-App-Capability` + `X-Capability-Ts` |
| First run | nothing | consent handshake: request → owner grants via `folddb consent grant fbrain` → poll → store |
| Reads | `X-User-Hash` only | unchanged — reads are NOT gated by capability |

## Where the code lives

As of the `@folddb/app-sdk` port, the capability PRIMITIVES (JCS, token
decode/verify, the eight-reason 403 table + reaction flags, the keychain
store, and the consent + mutation wire client) come from the SDK; the fbrain
modules below adapt them and own the UX/orchestration on top.

| File | Responsibility |
|---|---|
| `src/jcs.ts` | Re-exports the SDK's RFC 8785 JCS canonicalizer. Still byte-matched against the Rust `app_identity_crypto` golden vectors (`test/unit/jcs.test.ts`). |
| `src/hash.ts` | Re-exports the SDK's lowercase-hex SHA-256. |
| `src/capability.ts` | Re-exports the SDK token decode/verify + 403-reason list; fbrain-worded `surface` messages over the SDK reaction flags (`reactionFor`); per-write header builder; and `acquireCapability` (the consent handshake UX: prints, inline-grant hook, non-TTY fast-fail). |
| `src/keychain.ts` | Adapter over the SDK's keychain-with-file-fallback store (service `com.edgevector.fbrain.capability`, file fallback under `~/.fbrain/capabilities/`), with the one-shot migration of pre-SDK entries (legacy keychain account / `~/.fbrain/capabilities.json`). |
| `src/capability-session.ts` | `CapabilitySession`: load-or-acquire (cache validated via the SDK's `verifyCapabilityBlob`), the `provider()` wired into the node client, and `runWrite` (applies the 403 contract). |
| `src/write-context.ts` | `newWriteNodeClient` — a capability-aware NodeClient that write commands use in place of `newNodeClient`. Honors the `FBRAIN_APP_IDENTITY_ENFORCE` kill switch. |
| `src/client.ts` | Header constants, the `CapabilityProvider` hook on `newNodeClient`, the SDK `FoldDbClient` glue (consent endpoints + `/api/mutation` ride the SDK client over a fetch-backed Transport; SDK typed errors translate back into the FbrainError registry), and the 403-reason parsing in `mapNodeError`. |

## Consent acquisition (first run)

1. On the first **write**, `CapabilitySession.ensureCapability()` checks the
   keychain for a capability for `(fbrain, this node)`. If present and valid
   (see "Validity" below) it's reused — no prompt.
2. Otherwise `POST /api/apps/request-consent {app_id:"fbrain", scope:"wildcard"}`
   → `202 {request_id, expires_at}`.
3. fbrain prints the single actionable instruction:
   `First-run setup — run: \`folddb consent grant fbrain\` in your terminal.`
4. fbrain polls `GET /api/apps/consent-status/{request_id}` every 2s.
   - `202 pending` → keep polling (until the node's 5-min TTL).
   - `200 granted` → store the returned base64 capability blob in the keychain,
     keyed per `(app_id, node URL)`.
   - `403 denied` / `408 expired` / `404 unknown` → surface a clear error.

## Validity of a cached token

fbrain is a **token carrier** — the node mints + signs the token; fbrain
stores the opaque base64 blob and replays it verbatim. It does NOT re-sign.

Before reusing a cached token, fbrain runs a JCS-based **integrity check**
(`tokenIntegrityValid`): recompute `sha256(JCS(token-minus-envelope))` and
confirm it equals the envelope's `payload_hash`. This is exactly fold_db_node's
`signature_is_valid` minus the Ed25519 step (which needs the node's private
key). It catches a corrupt / truncated / tampered cache so fbrain never replays
a token guaranteed to 403. The node still verifies the Ed25519 signature on
every write — the integrity check is defense-in-depth, not a substitute.

This is the JCS-load-bearing path, which is why `src/jcs.ts` must reproduce the
Rust golden vectors byte-for-byte.

## Per-write attach

Every mutation (`create` / `update` / `delete` → `POST /api/mutation`) attaches:

```
X-App-Capability: <verbatim base64 CapabilityToken blob>
X-Capability-Ts:  <unix epoch seconds, recomputed per request>
```

`X-Capability-Ts` is recomputed on every call so a token cached for hours still
lands inside the node's ±60s replay window. Reads send neither header.

## 403 handling (the contract)

The node renders a capability rejection with the body **verbatim** (not in
fbrain's `{ok,error}` envelope): `{"status":403,"reason":"<reason>", ...}`.
`mapNodeError` reads `body.reason` and carries it on `FbrainError.capabilityReason`
(+ `capabilityDetail`). `CapabilitySession.runWrite` then applies:

| reason | behavior |
|---|---|
| `capability_revoked` | discard cached token; surface "access revoked"; **do NOT auto-re-prompt** |
| `capability_expired` | discard; silently re-acquire; retry the write |
| `capability_unknown` | discard; re-acquire; retry |
| `consent_required` | same as `capability_unknown` |
| `capability_for_wrong_node` | discard (per-node cache); re-acquire against the new node; retry |
| `capability_out_of_scope` | surface to developer (scope/write spec mismatch) — no re-prompt |
| `capability_replay` | retry once with a fresh `X-Capability-Ts`; if it persists, surface clock-skew |
| `capability_bad_sig` | discard; surface to developer (malformed token) |

Re-acquire and retry each fire **at most once** per write to avoid an infinite
loop against a node that keeps rejecting.

## Wrong-node detection

Capabilities are stored per `(app_id, node URL)`. When the user switches nodes,
the node returns `capability_for_wrong_node` (its own pubkey ≠ the token's
`node_pubkey`); the session discards the per-node cache and re-acquires against
the new node. Covered by `test/unit/capability.test.ts` ("wrong-node detection").

## Kill switch

`FBRAIN_APP_IDENTITY_ENFORCE` (client side) mirrors the node's
`APP_IDENTITY_ENFORCE`. Defaults **ON**. Set it to `false`/`0`/`no`/`off` and
fbrain skips consent acquisition and sends no capability headers — writes land
as NodeOwner on a node that also has enforcement off (dogfood / local-dev / the
unit test suite, which defaults it off via `test/setup.ts`).

## For a Rust app (kanban)

The Rust SDK should mirror this with `rust-keyring` for storage and the
`app_identity_crypto` crate directly for JCS + signature checks (it already has
`canonicalize`, `compute_payload_hash`, `verify_envelope`). The wire contract
(endpoints, headers, 403 reasons) is identical; only the storage + crypto
bindings differ.

## Operational dependency (Half 1, the destructive reset)

The client code here is inert until:
1. The **schema_service** dev (and prod) Lambdas carry the app_identity code
   (`/v1/apps`, snapshot `apps[]`/`version`, `owner_app_id` in `/v1/schemas`)
   — i.e. the schema-infra submodule is bumped past the first app_identity
   commit and redeployed.
2. The **fold_db_node** the user runs carries the consent endpoints
   (`/api/apps/*`) and the capability verifier.
3. The destructive reset + republish runbook (Half 1) has run: schema registries
   wiped in both envs, fbrain published via `folddb-dev app publish`, and the 8
   schemas republished under `fbrain/*`.

Until then, fbrain runs with `FBRAIN_APP_IDENTITY_ENFORCE=false` (or against a
node with enforcement off) and behaves exactly as before.
