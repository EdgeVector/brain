# Design — fbrain's app model: attestation-scoped app (Model C)

**Date:** 2026-06-20
**Owner:** Tom Tang
**Status:** Decided — **Model C (attestation-scoped app, no OS jail).** fbrain
graduates from a trusted owner-process into a scoped folddb *app*, but does
**not** adopt the `folddb app run` OS sandbox. Migration is phased (below);
this doc is the decision record + plan, not the migration itself.

## TL;DR

fbrain runs today as the node **owner** — it connects over the owner control
socket, does owner-session attestation, and `init` calls owner-only verbs. That
is honest for a first-party tool, but fbrain is meant to be *the* reference
third-party app on fold_db, so it should eat the platform's own app-identity dog
food rather than attest as node-owner.

There are three candidate models:

- **(A) owner-process** — today's behavior; trusted first-party, npm/brew distribution.
- **(B) sandboxed app** — `folddb app install` + `folddb app run`, where FoldDB
  applies an **OS jail** before exec'ing the app binary.
- **(C) attestation-scoped app, no jail** — ship a manifest + signed binary +
  registered `code_requirement`; connect to a **per-app restricted socket**; the
  node scopes the app by code-signature attestation + capabilities + at-rest
  encryption. No OS sandbox.

**Decision: (C).** Real isolation does *not* require the OS jail — the privilege
boundary is structural on the node side, namespace scoping is
capability-enforced, and at-rest confidentiality is a crypto property. (C) is
cross-platform (no macOS-Seatbelt dependency) and keeps MCP-over-stdio trivial
(the agent launches the signed binary directly; no `folddb app run` parent). The
one thing (B) adds over (C) — runtime containment of a compromised/RCE'd binary
— is not fbrain's threat model. (B) remains opt-in hardening the platform can
offer high-risk third-party apps; fbrain does not depend on it.

## Where fbrain is today (code-verified, dogfood run 31, 2026-06-16)

fbrain runs as the **node OWNER**, not as a sandboxed app:

- No `folddb.toml` manifest and no `[code_signature]` anywhere in the fbrain repo.
- It connects over the **owner control socket** (`FBRAIN_FOLDDB_SOCKET` →
  `folddb.sock` inside the data dir) and does **owner-session attestation** (the
  app-isolation flip, fold#739 — `src/client.ts:546`, `src/commands/init.ts:332`),
  plus a one-time `folddb consent grant fbrain`.
- `init` calls **owner-only verbs**: `/api/schemas/load` and pairing-code mint
  over the control socket.

Enforcement today is **consent + owner attestation, not the jail.**

## The platform's sandbox path (for contrast)

The OS sandbox is a different mechanism
(`fold_db_node/src/bin/folddb/cli.rs:328`, `AppCommand`):

- `folddb app run` — FoldDB is the parent that applies an **OS jail before
  exec'ing a compiled app binary** (macOS, `--features app-isolation` builds).
  The jail denies the app file + network access to the node data dir; the app
  reaches the node **only** over the **app data-plane socket**
  (`FOLDDB_SOCKET_PATH`, bound OUTSIDE the data dir) as a **scoped per-app
  principal that is denied owner verbs.**
- `folddb app install` — verifies the app binary against the manifest's
  `[code_signature]`, registers the namespace + code requirement, grants consent.

fbrain uses **none** of `app install` / `app run` / the data-plane socket today.

## Rationale — why isolation does not need the jail

The OS jail is **defense-in-depth, not the isolation boundary.** The boundary is
node-side and structural (code-verified):

- **Privilege (no owner verbs) is structural at the router**, independent of any
  jail. The app data-plane socket is served by `SocketKind::App`, whose route
  table *physically omits* the mint/owner verbs
  (`fold_db_node/src/server/uds_router.rs:47-51,130-134`) — "a confined app
  physically cannot mint … regardless [of the jail]"; "even if the jail were
  bypassed the route to the mint verb does not exist there"
  (`app_runtime/mod.rs:19`).
- **Namespace scoping + `[uses]` capabilities** are enforced at query/mutation
  time via the per-app scoped access context keyed off `SocketKind::App`
  (`app_isolation_invariants.rs`; fold#869/#870/#873). App A cannot read App B
  because the node refuses it, not because the OS jailed it.
- **At-rest = AES-256-GCM** → raw file reads yield ciphertext. The jail's
  data-dir deny is redundant with encryption *given master-key locality*
  (fold#857). Disk isolation is a crypto property, not a sandbox property.
- **Identity without containment ("node as verifier").** The node already tracks
  per-app `code_requirement`s (`app_registry.rs::register_app_code_requirement`;
  `app install` verifies the binary `[code_signature]`). An app can be scoped by
  (a) socket-per-app (app_id = which restricted socket), or (b) peer
  code-signature attestation over the UDS audit token. Neither needs a jail.

So real isolation is achieved by (C): the privilege boundary is structural,
namespace isolation is via capabilities, and disk confidentiality is via
encryption.

### Additional reasons (C) is the right destination for fbrain

- **Cross-platform.** (C) has no macOS-Seatbelt dependency. (B)'s jail is
  macOS-only today (Linux is a Phase-3 TODO) and carries the fail-open
  un-canonicalized-subpath trap.
- **MCP-over-stdio stays trivial.** Under (C) the agent's MCP command launches
  the signed binary directly. Under (B) it would become `folddb app run <signed
  fbrain-mcp binary> --data-dir <dir> -- mcp` — folddb is the launching parent,
  the agent pipes JSON-RPC through it → `sandbox-exec` → fbrain-mcp. (MCP *does*
  survive the jail — `folddb app run` inherits stdio straight through,
  `app_runtime/macos.rs:208-219` — but (C) avoids the launcher entirely.)
- **(A) is not the destination.** Staying owner-process keeps fbrain attesting as
  node-owner, which contradicts its purpose as the reference third-party app. (A)
  remains the honest *label* for today's shipped behavior — documented in the
  parallel interim-distribution card — but it is not where fbrain is going.

## What only (B) adds over (C)

(B) adds **runtime containment of a compromised/RCE'd binary** actively trying
to bypass the API — probing other sockets, exfiltrating, reading raw files.
Attestation proves identity *at launch*, not runtime behavior.

Threat-model decision:

- honest-but-overreaching / buggy apps → **(C) suffices** (fbrain: first-party
  authored, honest-but-buggy);
- actively-malicious / exploitable binaries → want **(B)**.

fbrain's threat model is the former, so (C) is the default and (B) is treated as
opt-in hardening the platform *offers* high-risk third-party apps.

## Phased migration plan (C)

Each phase below is filed as a follow-up fkanban card. Implementation spans both
**EdgeVector/fbrain** and **EdgeVector/fold**.

1. **Manifest.** Add `folddb.toml` with `[code_signature]` to the fbrain repo.
2. **Signed binary.** `bun build --compile` → a single signed `fbrain-mcp`
   binary (the jail-free app surface) + signing wiring. The app surface must be a
   compiled binary, not `bun run src/cli.ts`.
3. **Socket split.** `init` / consent stays an **OWNER** step run out-of-band on
   the owner control socket; steady-state reads/writes move to the **app
   data-plane socket** (`FOLDDB_SOCKET_PATH`) as the scoped app principal. Audit
   which verbs are owner-only — `init`'s `/api/schemas/load`, pairing-code mint,
   self-serving consent — vs app-scoped — the `fbrain_*` namespace CRUD, all
   allowed. (fbrain already encodes this split as the `app_in_sandbox` 403,
   `src/client.ts:782`.)
4. **Install + restricted-socket connect.** `folddb app install` wiring (manifest
   + `code_requirement` registration + consent) and a per-app
   restricted-socket connect path in `src/client.ts`.
5. **Docs.** README / quick-start: the agent MCP command becomes launching the
   signed binary directly on the app socket; `init` stays the owner setup step.
6. **Cross-repo deps (EdgeVector/fold).** Per-app restricted-socket availability
   + the `code_requirement` registration surface. **NOT** the `app run` jail —
   (C) skips it.

## Scope of this card

This card delivers the design doc and files the phase cards. There is **no
code/behavior change in fbrain beyond this document.**

## References

- fkanban card: `fbrain-sandboxed-app-design` (the decision + reframe context).
- App-identity integration (client half): [`app-identity-integration.md`](./app-identity-integration.md).
- fold app-isolation invariants: `fold_db_node/src/server/{uds_router.rs,app_isolation_invariants.rs}`,
  `app_runtime/{mod.rs,macos.rs}`, `app_registry.rs`; fold#739/#857/#869/#870/#873.
