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

import { canonicalize, type JsonValue } from "./jcs.ts";
import { sha256Hex } from "./hash.ts";
import {
  APP_CAPABILITY_HEADER,
  CAPABILITY_TS_HEADER,
  FbrainError,
  type Verbose,
} from "./client.ts";

export const FBRAIN_APP_ID = "fbrain";

// Re-export the per-write header names (defined in client.ts to avoid a
// circular dependency) so capability consumers have a single import surface.
export { APP_CAPABILITY_HEADER, CAPABILITY_TS_HEADER };

/** Poll interval for consent-status, per the design contract (every 2s). */
export const CONSENT_POLL_INTERVAL_MS = 2000;

// SignatureEnvelope as it crosses the wire — mirrors
// app_identity_crypto::SignatureEnvelope. fbrain only reads `purpose`,
// `payload_hash`, and `sig` (for the integrity check); the rest is opaque.
export type SignatureEnvelope = {
  version: number;
  purpose: string; // "capability_grant" for a CapabilityToken
  alg: string; // "Ed25519"
  key_id: string;
  issued_at: string;
  expires_at?: string;
  env: string; // "dev" | "prod"
  payload_hash: string; // hex sha256 of JCS(token-minus-envelope)
  sig?: string;
};

// CapabilityToken as it crosses the wire — mirrors
// fold_db/crates/core/src/access/caller_context.rs::CapabilityToken. fbrain
// decodes it only to read `node_pubkey` (wrong-node detection) + `app_id` and
// to run the payload-hash integrity check. Everything else is replayed
// verbatim via the original base64 blob.
export type CapabilityToken = {
  envelope: SignatureEnvelope;
  capability_id: string;
  app_id: string;
  scope: unknown; // CapabilityScope — opaque to the client
  granted_ops: unknown[];
  granted_at: string;
  expires_at?: string;
  node_pubkey: string; // base64 Ed25519 public key the grant is bound to
};

/**
 * What fbrain persists per (app_id, node). The base64 blob is the source of
 * truth replayed in `X-App-Capability`; `nodePubkey` is cached separately so
 * a wrong-node check on load doesn't need to decode the blob.
 */
export type StoredCapability = {
  appId: string;
  /** Base64 of the node URL this grant was acquired against (for keying). */
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
 * file fallback only on headless Linux; in practice fbrain runs on macOS
 * (Tom's dev node) so the primary store is the macOS keychain via the
 * built-in `security` CLI (no native module — works under bun). Other
 * platforms, headless sessions, or a keychain failure fall back to a 0600
 * file under ~/.fbrain/.
 */
export interface CapabilityStore {
  load(nodeUrl: string): Promise<StoredCapability | null>;
  save(cap: StoredCapability): Promise<void>;
  clear(nodeUrl: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Token decode + validity
// ---------------------------------------------------------------------------

/** Decode the base64 CapabilityToken blob to its parsed JSON. */
export function decodeCapabilityBlob(blob: string): CapabilityToken | null {
  let json: unknown;
  try {
    const text = Buffer.from(blob, "base64").toString("utf8");
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isCapabilityToken(json)) return null;
  return json;
}

function isCapabilityToken(v: unknown): v is CapabilityToken {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.capability_id !== "string") return false;
  if (typeof o.app_id !== "string") return false;
  if (typeof o.node_pubkey !== "string") return false;
  const env = o.envelope;
  if (env === null || typeof env !== "object") return false;
  const e = env as Record<string, unknown>;
  return typeof e.payload_hash === "string" && typeof e.purpose === "string";
}

/**
 * Verify the *integrity binding* of a decoded token: the envelope's
 * `payload_hash` must equal `sha256(JCS(token-minus-envelope))`, computed with
 * the same JCS the Rust node uses (this is exactly fold_db_node's
 * `signature_is_valid` minus the Ed25519 step, which needs the node's key).
 *
 * This is the JCS-load-bearing path: a tampered or truncated cached blob fails
 * here and is discarded, so fbrain never replays a token guaranteed to 403.
 * It is NOT a substitute for the node's signature check — the node still
 * verifies the Ed25519 signature on every write.
 */
export async function tokenIntegrityValid(token: CapabilityToken): Promise<boolean> {
  if (token.envelope.purpose !== "capability_grant") return false;
  // Reconstruct signing_payload = the token JSON minus its `envelope` key,
  // exactly as the Rust `CapabilityToken::signing_payload` does.
  const payload = { ...(token as unknown as Record<string, JsonValue>) };
  delete payload.envelope;
  let recomputed: string;
  try {
    recomputed = await sha256Hex(canonicalize(payload as JsonValue));
  } catch {
    return false;
  }
  return recomputed === token.envelope.payload_hash;
}

// ---------------------------------------------------------------------------
// Per-write headers
// ---------------------------------------------------------------------------

/**
 * Build the per-write capability headers. `X-Capability-Ts` is recomputed
 * per call as unix epoch seconds so it stays inside the node's ±60s replay
 * window even if a token sits cached for hours.
 */
export function capabilityHeaders(
  blob: string,
  nowMs: number = Date.now(),
): Record<string, string> {
  return {
    [APP_CAPABILITY_HEADER]: blob,
    [CAPABILITY_TS_HEADER]: String(Math.floor(nowMs / 1000)),
  };
}

// ---------------------------------------------------------------------------
// 403-reason classification (design "403 handling (contract)" table)
// ---------------------------------------------------------------------------

export const CAPABILITY_403_REASONS = [
  "capability_revoked",
  "capability_expired",
  "capability_unknown",
  "capability_out_of_scope",
  "capability_replay",
  "capability_bad_sig",
  "capability_for_wrong_node",
  "consent_required",
] as const;
export type Capability403Reason = (typeof CAPABILITY_403_REASONS)[number];

export function isCapability403Reason(s: string): s is Capability403Reason {
  return (CAPABILITY_403_REASONS as readonly string[]).includes(s);
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

export function reactionFor(
  reason: Capability403Reason,
  detail?: { schema?: string; capabilityId?: string; timestampSkewSecs?: number },
): Reaction {
  switch (reason) {
    case "capability_revoked":
      // Discard, but DO NOT auto-re-prompt — the user revoked deliberately.
      return {
        reason,
        discardToken: true,
        reacquire: false,
        retryOnce: false,
        surface:
          "fbrain's access to this node was revoked. Ask the node owner to re-grant: " +
          "`folddb consent grant fbrain`.",
      };
    case "capability_expired":
      // Discard + silently re-acquire.
      return { reason, discardToken: true, reacquire: true, retryOnce: false };
    case "capability_unknown":
      // Likely client-state bug — discard + re-acquire.
      return { reason, discardToken: true, reacquire: true, retryOnce: false };
    case "consent_required":
      // Same as capability_unknown (no capability presented at all).
      return { reason, discardToken: true, reacquire: true, retryOnce: false };
    case "capability_for_wrong_node":
      // User switched nodes — discard + re-acquire against the new node.
      return { reason, discardToken: true, reacquire: true, retryOnce: false };
    case "capability_out_of_scope":
      // Spec mismatch — surface to the developer, do not re-prompt.
      return {
        reason,
        discardToken: false,
        reacquire: false,
        retryOnce: false,
        surface:
          `fbrain's capability does not cover ${detail?.schema ?? "this schema"} — ` +
          "the declared scope and the attempted write disagree. This is a developer bug.",
      };
    case "capability_replay":
      // Clock skew — retry once with a fresh timestamp.
      return {
        reason,
        discardToken: false,
        reacquire: false,
        retryOnce: true,
        surface:
          `fbrain's capability timestamp was rejected as a replay` +
          (detail?.timestampSkewSecs !== undefined
            ? ` (skew ${detail.timestampSkewSecs}s)`
            : "") +
          ". Check this machine's clock.",
      };
    case "capability_bad_sig":
      // Implementation bug — surface to the developer.
      return {
        reason,
        discardToken: true,
        reacquire: false,
        retryOnce: false,
        surface:
          "fbrain's capability signature failed verification on the node. " +
          "This is a developer bug — the stored token is malformed.",
      };
  }
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
      message: `Node rejected consent request: ${bodyErrorField(req.body) ?? "invalid scope"}.`,
    });
  }
  if (req.status !== 202) {
    throw new FbrainError({
      code: `request_consent_http_${req.status}`,
      message: `request-consent returned HTTP ${req.status}.`,
    });
  }
  const requestId = stringField(req.body, "request_id");
  if (!requestId) {
    throw new FbrainError({
      code: "request_consent_no_id",
      message: "request-consent returned 202 but no request_id.",
    });
  }

  // Step 3: the clear, single, actionable console instruction.
  print(`First-run setup — run: \`folddb consent grant ${appId}\` in your terminal.`);
  print(`Waiting for you to grant access to this node (polling every ${Math.round(pollIntervalMs / 1000)}s)…`);

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = await opts.transport.consentStatus(requestId);
    if (res.status === 200) {
      const blob = stringField(res.body, "capability");
      if (!blob) {
        throw new FbrainError({
          code: "consent_status_no_capability",
          message: "consent-status returned 200 granted but no capability blob.",
        });
      }
      const token = decodeCapabilityBlob(blob);
      if (token === null) {
        throw new FbrainError({
          code: "consent_status_bad_capability",
          message: "consent-status returned a capability that did not decode as a CapabilityToken.",
        });
      }
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
        hint: `Retry with another \`folddb consent grant ${appId}\` once you're ready to allow it.`,
      });
    }
    if (res.status === 408) {
      throw new FbrainError({
        code: "consent_expired",
        message: `The consent request expired before it was granted (5-minute window).`,
        hint: `Re-run the fbrain command to start a fresh request, then \`folddb consent grant ${appId}\`.`,
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
        hint: `Run \`folddb consent grant ${appId}\` and retry the command.`,
      });
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringField(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function bodyErrorField(body: unknown): string | undefined {
  return stringField(body, "error");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
