/**
 * Typed error taxonomy for the LastDB app SDK.
 *
 * Every class here maps 1:1 to a discriminated response the node actually
 * returns — there is no catch-all "request failed". The mapping is verified
 * against the on-`main` handlers:
 *
 * - Consent flow (`fold_db_node/src/server/routes/apps.rs`):
 *   - `request-consent`  → `404 {error, app_id}` (unknown app),
 *                          `403 {reason: "app_in_sandbox", app_id, error}`,
 *                          `400 {error}` (invalid scope).
 *   - `consent-status`   → `202 {status: "pending"}`,
 *                          `200 {status: "granted", capability}`,
 *                          `403 {status: "denied"}` / `403 {status: "revoked"}`,
 *                          `408 {status: "expired"}`,
 *                          `404 {status: "unknown"}`.
 * - Data path (`fold_db_node::dev_mode` `app_endpoints.rs`, production
 *   `fold_db_node` operation layer): `403 {kind: "permission_denied",
 *   error: "<discriminated reason>"}` where the reason text distinguishes
 *   namespace-denied / unverified-identity / write-denied / revoked, and
 *   `400 {kind, error}` for a request-shape / schema-state rejection.
 * - Capability verifier (app_identity v3.1,
 *   `fold_db/crates/core/src/access/capability_denial.rs`): a failed
 *   per-write capability check returns `403 {status: 403, reason: "<one of
 *   the eight discriminated reasons>", ...detail}` — see
 *   {@link CapabilityDeniedError}.
 */
/** Base class for every error this SDK raises. */
export class FoldDbError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
        // Restore prototype chain for instanceof across the transpile target.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
// ---------------------------------------------------------------------------
// Transport / protocol
// ---------------------------------------------------------------------------
/** A network/transport failure (socket error, connection refused, DNS, etc.). */
export class TransportError extends FoldDbError {
}
/**
 * The node answered with an HTTP status the SDK has no specific class for.
 * Carries the status and the parsed body so the caller can still react.
 */
export class UnexpectedResponseError extends FoldDbError {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
// ---------------------------------------------------------------------------
// Consent flow
// ---------------------------------------------------------------------------
/**
 * `request-consent` → `404`. The app id is not in the canonical app registry
 * the node knows about (publish the app to schema_service first).
 */
export class UnknownAppError extends FoldDbError {
    appId;
    constructor(appId) {
        super(`app '${appId}' is not registered with the node's schema service`);
        this.appId = appId;
    }
}
/**
 * `request-consent` → `403 {reason: "app_in_sandbox"}`. The app is registered
 * as `sandbox` tier; only the owner-developer (whose dev pubkey matches the
 * app's `owner_dev_pubkey`) may install it. Promote the app to `live` to lift
 * the gate.
 */
export class AppInSandboxError extends FoldDbError {
    appId;
    constructor(appId) {
        super(`app '${appId}' is in sandbox tier; only the owner-developer can install it`);
        this.appId = appId;
    }
}
/** `request-consent` → `400`. The requested scope string was malformed. */
export class InvalidScopeError extends FoldDbError {
}
/**
 * The owner denied the consent request (`consent-status` → `403 {status:
 * "denied"}`). Terminal: do not auto-re-prompt.
 */
export class ConsentDeniedError extends FoldDbError {
    requestId;
    constructor(requestId) {
        super(`consent request '${requestId}' was denied by the node owner`);
        this.requestId = requestId;
    }
}
/**
 * The granted capability was revoked (`consent-status` → `403 {status:
 * "revoked"}`). Per the design's app-side caching table: discard the cached
 * token and surface "access revoked" — do NOT auto-re-prompt.
 */
export class CapabilityRevokedError extends FoldDbError {
    requestId;
    constructor(requestId) {
        super(`the capability for request '${requestId}' was revoked`);
        this.requestId = requestId;
    }
}
/**
 * The consent request passed its 5-minute window (`consent-status` → `408
 * {status: "expired"}`). The app must call `requestConsent` again.
 */
export class ConsentExpiredError extends FoldDbError {
    requestId;
    constructor(requestId) {
        super(`consent request '${requestId}' expired before it was granted`);
        this.requestId = requestId;
    }
}
/** `consent-status` → `404 {status: "unknown"}`. No request with that id. */
export class ConsentRequestNotFoundError extends FoldDbError {
    requestId;
    constructor(requestId) {
        super(`no consent request found for id '${requestId}'`);
        this.requestId = requestId;
    }
}
/**
 * `awaitConsent` gave up before the owner acted on a still-pending request.
 * Distinct from {@link ConsentExpiredError}: the node's record may still be
 * `pending`; this is the SDK's own client-side timeout.
 */
export class ConsentTimeoutError extends FoldDbError {
    requestId;
    timeoutMs;
    constructor(requestId, timeoutMs) {
        super(`gave up waiting for consent on '${requestId}' after ${timeoutMs}ms (still pending)`);
        this.requestId = requestId;
        this.timeoutMs = timeoutMs;
    }
}
export class PermissionDeniedError extends FoldDbError {
    reason;
    category;
    constructor(reason, category) {
        super(reason);
        this.reason = reason;
        this.category = category ?? classifyPermissionReason(reason);
    }
}
/**
 * Best-effort classification of the node's discriminated permission-denied
 * reason string into a {@link PermissionCategory}. The reason text is the
 * stable contract (see `uds_isolation_test.rs` assertions); we match on its
 * documented substrings.
 */
export function classifyPermissionReason(reason) {
    const r = reason.toLowerCase();
    if (r.includes('is not granted') && r.includes('isolated namespace')) {
        return 'namespace_denied';
    }
    if (r.includes('code-signature-verified app identity')) {
        return 'unverified_identity';
    }
    if (r.includes('write denied by namespace isolation')) {
        return 'write_denied';
    }
    return 'unknown';
}
// ---------------------------------------------------------------------------
// Discriminated capability 403 contract (app_identity v3.1, gap #4)
// ---------------------------------------------------------------------------
/**
 * The eight discriminated `reason` values a node's capability verifier can
 * return on a `403` (`app_identity.md#discriminated-403-reasons`, rendered by
 * `fold_db/crates/core/src/access/capability_denial.rs::CapabilityDenial` as
 * `{status: 403, reason: "<reason>", ...detail}`).
 */
export const CAPABILITY_DENIAL_REASONS = [
    /** `capability_id` is on the node's local revocation list. */
    'capability_revoked',
    /** The capability's `expires_at` is in the past. */
    'capability_expired',
    /** The capability's `app_id` is not in the node's cached app registry. */
    'capability_unknown',
    /** The capability's scope / granted ops do not cover this schema. */
    'capability_out_of_scope',
    /** `X-Capability-Ts` is outside the ±60s replay window (or absent). */
    'capability_replay',
    /** The envelope signature / payload hash did not verify on the node. */
    'capability_bad_sig',
    /** The capability's `node_pubkey` is not this node's key. */
    'capability_for_wrong_node',
    /** No capability was presented for a write that required one. */
    'consent_required',
];
/** Type guard: is `s` one of the eight discriminated capability-403 reasons? */
export function isCapabilityDenialReason(s) {
    return CAPABILITY_DENIAL_REASONS.includes(s);
}
/**
 * A data-path `403` whose body carries a discriminated `reason` field — the
 * capability-verifier contract (`{status: 403, reason: "capability_…", …}`).
 *
 * Subclasses {@link PermissionDeniedError} so existing `instanceof
 * PermissionDeniedError` handling keeps working; its `category` is always
 * `'capability_denied'`. `reason` is the node's verbatim discriminator —
 * one of {@link CAPABILITY_DENIAL_REASONS} for the per-write verifier, or
 * another reason-tagged 403 the node emits on the data path (e.g.
 * `/api/app/search`'s `capability_required` for a header-less call). Use
 * {@link isCapabilityDenialReason} to narrow, and
 * {@link capabilityDenialReaction} for the design's contract reaction.
 */
export class CapabilityDeniedError extends PermissionDeniedError {
    detail;
    constructor(reason, detail = {}) {
        super(reason, 'capability_denied');
        this.detail = detail;
    }
    /** `reason` narrowed to the eight-reason contract, or `null`. */
    get denialReason() {
        return isCapabilityDenialReason(this.reason) ? this.reason : null;
    }
}
/**
 * The design's contract reaction for each discriminated capability-403
 * reason. Pure data — the SDK does not act on it automatically; an app (or a
 * session layer above the client) applies it. `detail` refines the surfaced
 * message where the node provided one.
 */
export function capabilityDenialReaction(reason, detail = {}) {
    switch (reason) {
        case 'capability_revoked':
            // Discard, but DO NOT auto-re-prompt — the owner revoked deliberately.
            return {
                reason,
                discardToken: true,
                reacquire: false,
                retryOnce: false,
                surface: 'this app’s access to the node was revoked by the owner; ' +
                    'ask them to re-grant consent',
            };
        case 'capability_expired':
        case 'capability_unknown':
        case 'consent_required':
            // Expired / stale-client-state / nothing presented: discard + silently
            // re-acquire via the consent handshake.
            return { reason, discardToken: true, reacquire: true, retryOnce: false };
        case 'capability_for_wrong_node':
            // The connection moved nodes — discard + re-acquire against this node.
            return { reason, discardToken: true, reacquire: true, retryOnce: false };
        case 'capability_out_of_scope':
            // Declared scope and attempted operation disagree — a developer bug;
            // re-prompting would not fix it.
            return {
                reason,
                discardToken: false,
                reacquire: false,
                retryOnce: false,
                surface: `the granted capability does not cover ${detail.schema ?? 'this schema'} — ` +
                    'the declared consent scope and the attempted operation disagree',
            };
        case 'capability_replay':
            // Clock skew — retry once; the retry attaches a fresh X-Capability-Ts.
            return {
                reason,
                discardToken: false,
                reacquire: false,
                retryOnce: true,
                surface: 'the capability timestamp was rejected as a replay' +
                    (detail.timestampSkewSecs !== undefined
                        ? ` (skew ${detail.timestampSkewSecs}s)`
                        : '') +
                    '; check this machine’s clock',
            };
        case 'capability_bad_sig':
            // The stored token is malformed — discard and surface; replaying it
            // can only 403 again.
            return {
                reason,
                discardToken: true,
                reacquire: false,
                retryOnce: false,
                surface: 'the capability signature failed verification on the node — the ' +
                    'stored token is malformed',
            };
    }
}
/**
 * A capability blob failed client-side verification (gap #4) at a point where
 * the SDK must not adopt it: the consent-grant path under
 * `ConnectOptions.verifyCapability`. `problem` discriminates: `malformed`
 * (not base64 JSON in the CapabilityToken shape), `audience_mismatch` (the
 * token is bound to a different `app_id`), or `integrity_mismatch`
 * (`envelope.payload_hash != sha256(JCS(token-minus-envelope))`).
 */
export class CapabilityVerificationError extends FoldDbError {
    problem;
    appId;
    tokenAppId;
    constructor(problem, appId, tokenAppId) {
        super(problem === 'audience_mismatch'
            ? `capability is bound to app '${tokenAppId ?? '?'}', not '${appId}'`
            : problem === 'integrity_mismatch'
                ? `capability for app '${appId}' failed the JCS integrity check ` +
                    '(envelope.payload_hash != sha256(JCS(token-minus-envelope)))'
                : `capability for app '${appId}' did not decode as a CapabilityToken`);
        this.problem = problem;
        this.appId = appId;
        this.tokenAppId = tokenAppId;
    }
}
/**
 * The node rejected the request shape or schema state (`400 {kind:
 * "query_failed" | "mutation_rejected" | "invalid_request" | ...}`). Carries
 * the node's `kind` discriminator and message, plus the raw parsed response
 * `body` — production 400s are not uniform (`{kind, error}` from the dev
 * mirror, `{error}` / `{message}` / richer envelopes from production
 * handlers), and dropping everything but `kind` + one text field lost the
 * node's detail (e.g. its `message` field). The body is surfaced verbatim,
 * the same way the 403 {@link CapabilityDeniedError} surfaces its `detail`.
 */
export class RequestRejectedError extends FoldDbError {
    kind;
    body;
    constructor(kind, message, 
    /** The raw parsed 400 response body, verbatim (`null` when none). */
    body = null) {
        super(message);
        this.kind = kind;
        this.body = body;
    }
}
// ---------------------------------------------------------------------------
// Capability storage
// ---------------------------------------------------------------------------
/** No capability is stored under the requested app id (`loadCapability`). */
export class CapabilityNotFoundError extends FoldDbError {
    appId;
    constructor(appId) {
        super(`no stored capability for app '${appId}'`);
        this.appId = appId;
    }
}
//# sourceMappingURL=errors.js.map