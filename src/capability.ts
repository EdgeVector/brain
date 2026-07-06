// App-identity capability acquisition + storage + per-write attach + 403
// handling for fbrain (app_identity v3.1, Lane D client side).
//
// The contract fbrain implements (design doc "Client contract"):
//   1. On startup, check the OS keychain for an existing capability for this
//      app_id + node. If absent or invalid → request consent.
//   2. POST /api/apps/request-consent {app_id:"fbrain", scope:"wildcard"} → request_id.
//   3. Print: "First-run setup — run: `folddb consent grant fbrain` …".
//   4. Poll GET /api/apps/consent-status/{request_id} every 2s.
//   5. On 200 granted → store the base64 capability blob in the keychain.
//   6. On 403 denied / 408 expired → surface; offer retry.
//
// Per write, every mutation attaches:
//   X-App-Capability: <the base64 CapabilityToken blob, replayed verbatim>
//   X-Capability-Ts:  <unix epoch seconds, computed per request, ≤60s old>
//
// fbrain is a TOKEN CARRIER: the node mints + signs the token; fbrain stores
// the opaque base64 blob and replays it. It does NOT re-sign. It DOES run a
// JCS-based integrity check on a cached token (the "or invalid" branch of step
// 1) so a corrupt / tampered cache is discarded rather than replayed into a
// guaranteed `capability_bad_sig`.
//
// As of the @folddb/app-sdk port, the capability PRIMITIVES live in the SDK
// and are re-exported here: token decode (`decodeCapabilityBlob`), the JCS
// integrity binding (`tokenIntegrityValid` / `verifyCapabilityBlob`), the
// eight-reason discriminated-403 list + guard, and the contract reaction
// FLAGS (`capabilityDenialReaction`). What stays fbrain's own is the UX
// orchestration: the consent handshake loop (prints, the inline-grant hook,
// the non-TTY fast-fail), fbrain-worded `surface` messages (they name
// `folddb consent grant fbrain`), and the FbrainError code vocabulary.

import {
  capabilityDenialReaction,
  decodeCapabilityBlob,
  isCapabilityDenialReason,
  tokenIntegrityValid,
  verifyCapabilityBlob,
  type CapabilityDenialReason,
  type CapabilityToken,
  type SignatureEnvelope,
} from "@folddb/app-sdk";

import {
  APP_CAPABILITY_HEADER,
  CAPABILITY_TS_HEADER,
  FbrainError,
  bodyStringField,
  type Verbose,
} from "./client.ts";

export const FBRAIN_APP_ID = "fbrain";

// Re-export the per-write header names (defined in client.ts to avoid a
// circular dependency) so capability consumers have a single import surface.
export { APP_CAPABILITY_HEADER, CAPABILITY_TS_HEADER };

/** Poll interval for consent-status, per the design contract (every 2s). */
export const CONSENT_POLL_INTERVAL_MS = 2000;

// Token wire types + decode + the JCS integrity check come from the SDK — the
// exact same shapes and checks every FoldDB app runs (and the same the Rust
// node mints against). Re-exported so fbrain call sites keep this module as
// their single import surface. NB `tokenIntegrityValid` is synchronous in the
// SDK (node:crypto) where fbrain's old implementation was async; existing
// `await tokenIntegrityValid(...)` call sites are unaffected.
export { decodeCapabilityBlob, tokenIntegrityValid, verifyCapabilityBlob };
export type { CapabilityToken, SignatureEnvelope };

/**
 * What fbrain persists per (app_id, node). The base64 blob is the source of
 * truth replayed in `X-App-Capability`; `nodePubkey` is cached separately so
 * a wrong-node check on load doesn't need to decode the blob.
 */
export type StoredCapability = {
  appId: string;
  /** The node URL this grant was acquired against (for keying). */
  nodeUrl: string;
  /** The node's base64 Ed25519 pubkey the grant is bound to. */
  nodePubkey: string;
  /** Capability id (for diagnostics / matching a revoke). */
  capabilityId: string;
  /** The verbatim base64 CapabilityToken blob — replayed on every write. */
  blob: string;
};

// ---------------------------------------------------------------------------
// Keychain store
// ---------------------------------------------------------------------------

/**
 * Where a capability is stored. The design mandates the OS keychain with a
 * file fallback only on headless Linux. The implementation behind this
 * interface is the @folddb/app-sdk capability store (macOS `security` CLI
 * with a 0600-file fallback, every call timeout-bounded), adapted in
 * `keychain.ts` — which also performs the one-shot migration of pre-SDK
 * entries so an existing install keeps its grant.
 */
export interface CapabilityStore {
  load(nodeUrl: string): Promise<StoredCapability | null>;
  save(cap: StoredCapability): Promise<void>;
  clear(nodeUrl: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 403-reason classification (design "403 handling (contract)" table)
// ---------------------------------------------------------------------------

// The eight-reason list + guard are the SDK's — fbrain keeps its historical
// names as aliases so call sites and tests read unchanged.
export type Capability403Reason = CapabilityDenialReason;

export function isCapability403Reason(s: string): s is Capability403Reason {
  return isCapabilityDenialReason(s);
}

/**
 * What the client must do in response to a discriminated 403 reason, per the
 * design contract table. `discardToken` → drop the cached capability;
 * `reacquire` → silently call request-consent again; `retryOnce` → adjust the
 * local clock view and retry the same write once; `surface` → the verb-level
 * caller should propagate the error rather than re-prompt.
 */
export type Reaction = {
  reason: Capability403Reason;
  discardToken: boolean;
  reacquire: boolean;
  retryOnce: boolean;
  // When set, the operation should surface this developer/user-facing message
  // instead of silently re-acquiring.
  surface?: string;
};

/**
 * The contract reaction for a discriminated 403 reason. The FLAGS
 * (discard / re-acquire / retry-once) come from the SDK's
 * `capabilityDenialReaction` — the canonical port of this table — while the
 * `surface` strings stay fbrain's own: they name fbrain and the exact
 * remediation command (`folddb consent grant fbrain`) a user of THIS app
 * should run, which a generic SDK message cannot.
 */
export function reactionFor(
  reason: Capability403Reason,
  detail?: { schema?: string; capabilityId?: string; timestampSkewSecs?: number },
): Reaction {
  const base = capabilityDenialReaction(reason, detail ?? {});
  const reaction: Reaction = {
    reason,
    discardToken: base.discardToken,
    reacquire: base.reacquire,
    retryOnce: base.retryOnce,
  };
  const surface = fbrainSurfaceFor(reason, detail);
  if (surface !== undefined) reaction.surface = surface;
  return reaction;
}

// fbrain's user/developer-facing wording for the reasons whose contract says
// "surface". Kept app-side deliberately (see the reactionFor docstring). The
// set of reasons that carry a surface message must stay aligned with the
// SDK's table — the flags above are the single source of truth for WHAT to
// do; this is only the wording.
function fbrainSurfaceFor(
  reason: Capability403Reason,
  detail?: { schema?: string; capabilityId?: string; timestampSkewSecs?: number },
): string | undefined {
  switch (reason) {
    case "capability_revoked":
      return (
        "fbrain's access to this node was revoked. Ask the node owner to re-grant: " +
        "`lastdb consent grant fbrain`."
      );
    case "capability_out_of_scope":
      return (
        `fbrain's capability does not cover ${detail?.schema ?? "this schema"} — ` +
        "the declared scope and the attempted write disagree. This is a developer bug."
      );
    case "capability_replay":
      return (
        `fbrain's capability timestamp was rejected as a replay` +
        (detail?.timestampSkewSecs !== undefined
          ? ` (skew ${detail.timestampSkewSecs}s)`
          : "") +
        ". Check this machine's clock."
      );
    case "capability_bad_sig":
      return (
        "fbrain's capability signature failed verification on the node. " +
        "This is a developer bug — the stored token is malformed."
      );
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Idempotency check (used by `fbrain init` to skip the inline consent step
// when a live capability is already on disk)
// ---------------------------------------------------------------------------

/**
 * Read-only: does this store hold a structurally-valid, JCS-integrity-bound
 * capability for `appId` on this `nodeUrl`? Does NOT clear corrupt cache (use
 * CapabilitySession for that lifecycle); intended for `fbrain init`'s
 * idempotency gate so re-running init never re-prompts.
 */
export async function hasValidCachedCapability(
  store: CapabilityStore,
  nodeUrl: string,
  appId: string = FBRAIN_APP_ID,
): Promise<boolean> {
  const cached = await store.load(nodeUrl);
  if (cached === null) return false;
  return verifyCapabilityBlob(cached.blob, appId).ok;
}

// ---------------------------------------------------------------------------
// Consent acquisition (request-consent → poll consent-status)
// ---------------------------------------------------------------------------

export type ConsentTransport = {
  /** POST /api/apps/request-consent. */
  requestConsent(
    appId: string,
    scope: string,
  ): Promise<{ status: number; body: unknown }>;
  /** GET /api/apps/consent-status/{request_id}. */
  consentStatus(requestId: string): Promise<{ status: number; body: unknown }>;
};

/**
 * Hook invoked once `request-consent` has returned 202, before polling
 * begins. The default prints the "First-run setup — run: …" instruction so a
 * second-terminal owner can grant. `fbrain init`'s inline-consent flow
 * overrides this to shell out to `folddb consent grant <app_id> --yes`
 * directly, eliminating the two-terminal dance on the brew happy path.
 */
export type OnConsentRequested = (ctx: {
  appId: string;
  requestId: string;
  print: (line: string) => void;
}) => void | Promise<void>;

export type AcquireOptions = {
  appId?: string;
  scope?: string;
  nodeUrl: string;
  transport: ConsentTransport;
  store: CapabilityStore;
  print?: (line: string) => void;
  verbose?: Verbose;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on polling so a never-granted request doesn't loop forever. */
  maxWaitMs?: number;
  /** See {@link OnConsentRequested}. */
  onConsentRequested?: OnConsentRequested;
  /**
   * Treat this process as interactive. Default: `process.stdin.isTTY`. The
   * manual-fallback branch (no `onConsentRequested`) needs a human in another
   * terminal to run `folddb consent grant`; in a non-interactive shell — the
   * agent/CI install path — the poll would wait the full consent TTL (~5 min)
   * for a grant that can never arrive. When this returns false in the manual
   * fallback, acquireCapability fast-fails with `consent_required_non_interactive`
   * instead. The `onConsentRequested` branch (inline `init --grant-consent`)
   * is unaffected — it has already shelled out to grant.
   */
  isTty?: () => boolean;
};

/**
 * Run the full first-run consent handshake and persist the granted capability.
 * Returns the StoredCapability on success. Throws an FbrainError on denial,
 * expiry, unknown-app, or timeout.
 */
export async function acquireCapability(opts: AcquireOptions): Promise<StoredCapability> {
  const appId = opts.appId ?? FBRAIN_APP_ID;
  const scope = opts.scope ?? "wildcard";
  const print = opts.print ?? ((line: string) => console.error(line));
  const sleep = opts.sleep ?? defaultSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? CONSENT_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000; // matches the node's 5-min consent TTL
  const isTty = opts.isTty ?? defaultIsTty;

  // Manual-fallback fast-fail: with no `onConsentRequested`, this branch's
  // only way to land a grant is "human runs `folddb consent grant` in another
  // terminal" — meaningless in a non-interactive shell (agent / CI / piped
  // stdin). Without this gate, the agent install path freezes for the full
  // 5-min consent TTL on first write. Mirrors the same isTty pin
  // `establishConsentInline` already uses to skip the prompt at init time.
  // The `onConsentRequested` branch (inline `init --grant-consent` shelling
  // out to `folddb consent grant <appId> --yes`) is unaffected — that path
  // can complete the grant without a TTY and the poll is just confirming.
  if (opts.onConsentRequested === undefined && !isTty()) {
    throw new FbrainError({
      code: "consent_required_non_interactive",
      // Channel-neutral message — true on both surfaces. The old wording said
      // "this is a non-interactive shell", which is meaningless to an MCP agent
      // (it isn't a shell, and is *always* non-interactive). State the real
      // fact instead: no write capability is cached and fbrain can't grant one
      // on its own.
      message:
        `No write capability is cached for "${appId}" on this node, ` +
        `and fbrain can't request a grant non-interactively.`,
      // CLI `hint` (human at a terminal) — UNCHANGED. Names the headless
      // one-shot and the local/dogfood enforcement escape hatch, both correct
      // for the human path and only shown when no `agentHint` is set.
      hint:
        `Run \`fbrain init --grant-consent\` once, then retry — it creates the consent request, grants it, and stores the capability in one headless step. ` +
        `(A bare \`lastdb consent grant ${appId}\` only works once a pending request exists, i.e. an interactive write is already polling — it fails with "no pending consent request" on a fresh node.) ` +
        `Set FBRAIN_APP_IDENTITY_ENFORCE=off for local/dogfood stacks with enforcement disabled.`,
      // Agent-voiced remediation (MCP) — names the OWNER action in agent terms,
      // with no "shell" and no FBRAIN_APP_IDENTITY_ENFORCE dogfood note the
      // agent can't act on. This is the first hard wall an agent hits on a
      // fresh owner's node (init headlessly skips the consent prompt).
      agentHint:
        `The node owner must grant fbrain consent before writes land. ` +
        `Ask them to run \`fbrain init --grant-consent\` (or \`lastdb consent grant ${appId} --yes\`) in their terminal, then retry.`,
    });
  }

  // Sibling-error audit (for the agent/MCP write surface): everything below
  // this point is only reached when `onConsentRequested` is set (the inline
  // `init --grant-consent` flow) or `isTty()` is true (a human at a terminal).
  // The MCP write path supplies neither — `CapabilitySession.acquire` calls
  // `acquireCapability` with no `onConsentRequested` and the default (non-TTY)
  // `isTty`, so it ALWAYS fast-fails at the `consent_required_non_interactive`
  // throw above and never reaches `app_not_registered`, the consent poll-loop
  // denials/expiries, or the capability-integrity errors. Those are CLI-/inline-
  // only, so their CLI `hint`s are the right voice and an `agentHint` would be
  // unreachable on the agent channel. The single error an MCP agent can hit on
  // a consent-pending write is the one above — which is why it's the one that
  // carries `agentHint`.
  const req = await opts.transport.requestConsent(appId, scope);
  if (req.status === 404) {
    throw new FbrainError({
      code: "app_not_registered",
      message:
        `Node rejected consent request: app "${appId}" is not registered with schema_service.`,
      hint:
        "The app must be published before it can request consent " +
        "(`folddb-dev app publish --id fbrain`). On a fresh node, run the app_identity " +
        "migration runbook first.",
    });
  }
  if (req.status === 400) {
    throw new FbrainError({
      code: "invalid_scope",
      message: `Node rejected consent request: ${bodyStringField(req.body, "error") ?? "invalid scope"}.`,
    });
  }
  if (req.status !== 202) {
    throw new FbrainError({
      code: `request_consent_http_${req.status}`,
      message: `request-consent returned HTTP ${req.status}.`,
    });
  }
  const requestId = bodyStringField(req.body, "request_id");
  if (!requestId) {
    throw new FbrainError({
      code: "request_consent_no_id",
      message: "request-consent returned 202 but no request_id.",
    });
  }

  // Step 3: tell the user what to do, then frame the polling line to match.
  // The inline flow (used by `fbrain init --grant-consent`) has already shelled
  // out to `folddb consent grant`, so the poll is just confirming the grant
  // landed — printing "Waiting for you to grant access" there would contradict
  // the "Granted access…" line the inline grant just printed. The manual
  // fallback genuinely needs the human to act in another terminal, so it keeps
  // the original wording.
  const pollSeconds = Math.round(pollIntervalMs / 1000);
  if (opts.onConsentRequested) {
    await opts.onConsentRequested({ appId, requestId, print });
    print(`Confirming the grant landed (polling every ${pollSeconds}s)…`);
  } else {
    print(`First-run setup — run: \`lastdb consent grant ${appId}\` in your terminal.`);
    print(`Waiting for you to grant access to this node (polling every ${pollSeconds}s)…`);
  }

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = await opts.transport.consentStatus(requestId);
    if (res.status === 200) {
      const blob = bodyStringField(res.body, "capability");
      if (!blob) {
        throw new FbrainError({
          code: "consent_status_no_capability",
          message: "consent-status returned 200 granted but no capability blob.",
        });
      }
      // The full client-side validation an app must apply before adopting a
      // granted blob — decode, audience binding (the issued token must be
      // bound to the app we asked for), and the JCS integrity binding
      // (envelope.payload_hash == sha256(JCS(token-minus-envelope))) — is the
      // SDK's `verifyCapabilityBlob`. Without these gates, a mis-minted or
      // substituted token would be stored and replayed once before the node's
      // signature check 403'd it as `capability_bad_sig`.
      const verification = verifyCapabilityBlob(blob, appId);
      if (!verification.ok) {
        if (verification.problem === "malformed") {
          throw new FbrainError({
            code: "consent_status_bad_capability",
            message: "consent-status returned a capability that did not decode as a CapabilityToken.",
          });
        }
        if (verification.problem === "audience_mismatch") {
          throw new FbrainError({
            code: "consent_status_app_id_mismatch",
            message:
              `consent-status returned a capability bound to app "${verification.tokenAppId ?? "?"}", ` +
              `but "${appId}" was requested.`,
          });
        }
        throw new FbrainError({
          code: "consent_status_bad_capability_integrity",
          message:
            "consent-status returned a capability that failed JCS integrity check " +
            "(envelope.payload_hash != sha256(JCS(token-minus-envelope))).",
        });
      }
      const token = verification.token;
      const stored: StoredCapability = {
        appId,
        nodeUrl: opts.nodeUrl,
        nodePubkey: token.node_pubkey,
        capabilityId: token.capability_id,
        blob,
      };
      await opts.store.save(stored);
      print(`Access granted. Capability stored.`);
      return stored;
    }
    if (res.status === 403) {
      throw new FbrainError({
        code: "consent_denied",
        message: `The node owner denied fbrain's request for access.`,
        hint: `Retry with another \`lastdb consent grant ${appId}\` once you're ready to allow it.`,
      });
    }
    if (res.status === 408) {
      throw new FbrainError({
        code: "consent_expired",
        message: `The consent request expired before it was granted (5-minute window).`,
        hint: `Re-run the fbrain command to start a fresh request, then \`lastdb consent grant ${appId}\`.`,
      });
    }
    if (res.status === 404) {
      throw new FbrainError({
        code: "consent_request_unknown",
        message: `The node no longer recognises this consent request (it may have restarted).`,
        hint: `Re-run the fbrain command to start a fresh request.`,
      });
    }
    // 202 pending (or any transient) → keep polling until the deadline.
    if (Date.now() >= deadline) {
      throw new FbrainError({
        code: "consent_timeout",
        message: `Timed out after ${Math.round(maxWaitMs / 1000)}s waiting for consent to be granted.`,
        hint: `Run \`lastdb consent grant ${appId}\` and retry the command.`,
      });
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Mirror `defaultIsTty` in src/commands/init-consent.ts so both consent paths
// agree on what "interactive" means. fbrain init's prompt branch and the
// in-write fast-fail branch must trigger on the same shell shape — otherwise
// you'd get an init that silently skips the prompt followed by a first write
// that polls (or vice versa).
function defaultIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}
