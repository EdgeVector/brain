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
export declare class FoldDbError extends Error {
    constructor(message: string);
}
/** A network/transport failure (socket error, connection refused, DNS, etc.). */
export declare class TransportError extends FoldDbError {
}
/**
 * The node answered with an HTTP status the SDK has no specific class for.
 * Carries the status and the parsed body so the caller can still react.
 */
export declare class UnexpectedResponseError extends FoldDbError {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown);
}
/**
 * The node's paginated `/api/query` response stopped making forward progress
 * or could not produce the unique row count it advertised. This is an SDK-side
 * guard around the known-unstable offset pagination path; callers should retry
 * later or narrow the query instead of trusting a partial drain.
 */
export declare class QueryPaginationError extends FoldDbError {
    readonly reason: 'stalled_page' | 'total_count_mismatch';
    readonly detail: {
        totalCount?: number;
        collectedCount: number;
        returnedCount?: number;
        pageSize?: number;
        offset?: number;
    };
    constructor(reason: 'stalled_page' | 'total_count_mismatch', detail: {
        totalCount?: number;
        collectedCount: number;
        returnedCount?: number;
        pageSize?: number;
        offset?: number;
    });
}
/**
 * `queryAll()` was called with no `filter.filter` (a full unfiltered schema
 * drain — a "scan" in LastDB's DynamoDB-style access model) and without the
 * explicit `{ allowFullScan: true }` opt-in. Scans are deprecated for product
 * apps (`brain design-lastdb-scan-deprecation-path`): they are the dominant
 * cause of node load under `lastdb ops`. Use a point read (`filter: {
 * HashKey: id }`) or a partition read (HashRange) instead, or pass
 * `allowFullScan: true` when a full drain is genuinely required (admin/offline
 * tooling, migrations).
 */
export declare class FullScanNotAllowedError extends FoldDbError {
    readonly schemaName: string;
    constructor(schemaName: string);
}
/**
 * `request-consent` → `404`. The app id is not in the canonical app registry
 * the node knows about (publish the app to schema_service first).
 */
export declare class UnknownAppError extends FoldDbError {
    readonly appId: string;
    constructor(appId: string);
}
/**
 * `request-consent` → `403 {reason: "app_in_sandbox"}`. The app is registered
 * as `sandbox` tier; only the owner-developer (whose dev pubkey matches the
 * app's `owner_dev_pubkey`) may install it. Promote the app to `live` to lift
 * the gate.
 */
export declare class AppInSandboxError extends FoldDbError {
    readonly appId: string;
    constructor(appId: string);
}
/** `request-consent` → `400`. The requested scope string was malformed. */
export declare class InvalidScopeError extends FoldDbError {
}
/**
 * The owner denied the consent request (`consent-status` → `403 {status:
 * "denied"}`). Terminal: do not auto-re-prompt.
 */
export declare class ConsentDeniedError extends FoldDbError {
    readonly requestId: string;
    constructor(requestId: string);
}
/**
 * The granted capability was revoked (`consent-status` → `403 {status:
 * "revoked"}`). Per the design's app-side caching table: discard the cached
 * token and surface "access revoked" — do NOT auto-re-prompt.
 */
export declare class CapabilityRevokedError extends FoldDbError {
    readonly requestId: string;
    constructor(requestId: string);
}
/**
 * The consent request passed its 5-minute window (`consent-status` → `408
 * {status: "expired"}`). The app must call `requestConsent` again.
 */
export declare class ConsentExpiredError extends FoldDbError {
    readonly requestId: string;
    constructor(requestId: string);
}
/** `consent-status` → `404 {status: "unknown"}`. No request with that id. */
export declare class ConsentRequestNotFoundError extends FoldDbError {
    readonly requestId: string;
    constructor(requestId: string);
}
/**
 * `awaitConsent` gave up before the owner acted on a still-pending request.
 * Distinct from {@link ConsentExpiredError}: the node's record may still be
 * `pending`; this is the SDK's own client-side timeout.
 */
export declare class ConsentTimeoutError extends FoldDbError {
    readonly requestId: string;
    readonly timeoutMs: number;
    constructor(requestId: string, timeoutMs: number);
}
/**
 * The node refused the read/write under the caller's posture
 * (`{kind: "permission_denied"}`). The discriminated `reason` text from the
 * node is preserved verbatim, and `category` classifies it where the reason
 * is recognizable (namespace-denied / unverified-identity / write-denied).
 */
export type PermissionCategory = 'namespace_denied' | 'unverified_identity' | 'write_denied'
/** A discriminated capability 403 — see {@link CapabilityDeniedError}. */
 | 'capability_denied' | 'unknown';
export declare class PermissionDeniedError extends FoldDbError {
    readonly reason: string;
    readonly category: PermissionCategory;
    constructor(reason: string, category?: PermissionCategory);
}
/**
 * Best-effort classification of the node's discriminated permission-denied
 * reason string into a {@link PermissionCategory}. The reason text is the
 * stable contract (see `uds_isolation_test.rs` assertions); we match on its
 * documented substrings.
 */
export declare function classifyPermissionReason(reason: string): PermissionCategory;
/**
 * The eight discriminated `reason` values a node's capability verifier can
 * return on a `403` (`app_identity.md#discriminated-403-reasons`, rendered by
 * `fold_db/crates/core/src/access/capability_denial.rs::CapabilityDenial` as
 * `{status: 403, reason: "<reason>", ...detail}`).
 */
export declare const CAPABILITY_DENIAL_REASONS: readonly ["capability_revoked", "capability_expired", "capability_unknown", "capability_out_of_scope", "capability_replay", "capability_bad_sig", "capability_for_wrong_node", "consent_required"];
/** One of the eight discriminated capability-403 reasons. */
export type CapabilityDenialReason = (typeof CAPABILITY_DENIAL_REASONS)[number];
/** Type guard: is `s` one of the eight discriminated capability-403 reasons? */
export declare function isCapabilityDenialReason(s: string): s is CapabilityDenialReason;
/**
 * Detail fields a discriminated capability 403 may carry alongside its
 * `reason`, per the `CapabilityDenial` variant payloads.
 */
export interface CapabilityDenialDetail {
    /** `capability_revoked` / `capability_expired` / `capability_unknown`. */
    capabilityId?: string;
    /** `capability_out_of_scope`. */
    schema?: string;
    /** `capability_replay`. */
    timestampSkewSecs?: number;
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
export declare class CapabilityDeniedError extends PermissionDeniedError {
    readonly detail: CapabilityDenialDetail;
    constructor(reason: string, detail?: CapabilityDenialDetail);
    /** `reason` narrowed to the eight-reason contract, or `null`. */
    get denialReason(): CapabilityDenialReason | null;
}
/**
 * What a client should do in response to a discriminated capability-403
 * reason, per the design's "403 handling (contract)" table.
 * `discardToken` → drop the cached capability; `reacquire` → silently run the
 * consent handshake again; `retryOnce` → retry the same request once (a fresh
 * `X-Capability-Ts` is attached automatically); `surface` → propagate to the
 * user/developer instead of silently re-prompting.
 */
export interface CapabilityDenialReaction {
    reason: CapabilityDenialReason;
    discardToken: boolean;
    reacquire: boolean;
    retryOnce: boolean;
    /** A user/developer-facing explanation, when the contract says "surface". */
    surface?: string;
}
/**
 * The design's contract reaction for each discriminated capability-403
 * reason. Pure data — the SDK does not act on it automatically; an app (or a
 * session layer above the client) applies it. `detail` refines the surfaced
 * message where the node provided one.
 */
export declare function capabilityDenialReaction(reason: CapabilityDenialReason, detail?: CapabilityDenialDetail): CapabilityDenialReaction;
/**
 * A capability blob failed client-side verification (gap #4) at a point where
 * the SDK must not adopt it: the consent-grant path under
 * `ConnectOptions.verifyCapability`. `problem` discriminates: `malformed`
 * (not base64 JSON in the CapabilityToken shape), `audience_mismatch` (the
 * token is bound to a different `app_id`), or `integrity_mismatch`
 * (`envelope.payload_hash != sha256(JCS(token-minus-envelope))`).
 */
export declare class CapabilityVerificationError extends FoldDbError {
    readonly problem: 'malformed' | 'audience_mismatch' | 'integrity_mismatch';
    readonly appId: string;
    readonly tokenAppId?: string | undefined;
    constructor(problem: 'malformed' | 'audience_mismatch' | 'integrity_mismatch', appId: string, tokenAppId?: string | undefined);
}
export type AuthenticationRequiredReason = 'session_expired' | 'auth_failed';
/**
 * The node rejected a data-path request before capability evaluation because
 * the caller's authenticated session/API credential is no longer valid
 * (`401`, commonly `{code:"AUTH_FAILED", error:"Session token expired"}`).
 *
 * Apps should catch this separately from capability-denied errors and start
 * their re-authentication flow instead of treating it as an unexpected crash.
 */
export declare class AuthenticationRequiredError extends FoldDbError {
    readonly reason: AuthenticationRequiredReason;
    /** The raw parsed 401 response body, verbatim (`null` when none). */
    readonly body: unknown;
    constructor(reason: AuthenticationRequiredReason, message: string, 
    /** The raw parsed 401 response body, verbatim (`null` when none). */
    body?: unknown);
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
export declare class RequestRejectedError extends FoldDbError {
    readonly kind: string;
    /** The raw parsed 400 response body, verbatim (`null` when none). */
    readonly body: unknown;
    constructor(kind: string, message: string, 
    /** The raw parsed 400 response body, verbatim (`null` when none). */
    body?: unknown);
}
/**
 * The detail fields the node carries on a `409 {error:"cas_conflict"}` body,
 * surfaced as typed accessors on {@link CasConflictError}. All are optional on
 * the wire — the node fills what it knows about the failed precondition.
 */
export interface CasConflictDetail {
    /** The schema the conflicting write targeted. */
    schema?: string;
    /** The field the CAS precondition was checked against. */
    field?: string;
    /** The row key (rendered) the write targeted. */
    key?: string;
    /** The value the write EXPECTED the field to hold (the precondition). */
    expected?: string;
    /** The field's ACTUAL current value the node observed (`null` when absent). */
    actual?: string | null;
    /** A human-readable message, when the node supplied one. */
    message?: string;
}
/**
 * A compare-and-set (CAS) precondition on a {@link import('./types.js').MutationOp}
 * (its `expected` field) did not hold: the node rejected the write with
 * `409 {error:"cas_conflict", schema?, field?, key?, expected?, actual?, message?}`.
 *
 * The row changed since the caller's expected precondition (or was already
 * present when `{type:"absent"}` was required), so the write was NOT applied.
 * The typed fields (`schema` / `field` / `key` / `expected` / `actual`) let an
 * app re-read the current value and retry without re-parsing free text or
 * re-serializing a generic error body. The verbatim parsed 409 `body` is also
 * carried for anything the node added beyond the modeled fields.
 *
 * A CAS conflict is a normal, expected outcome of contended writes — it is a
 * distinct class (NOT a {@link RequestRejectedError} or an
 * {@link UnexpectedResponseError}) precisely so an app can branch on it and
 * retry rather than treat it as a hard failure.
 */
export declare class CasConflictError extends FoldDbError {
    /** The raw parsed 409 response body, verbatim (`null` when none). */
    readonly body: unknown;
    /** The schema the conflicting write targeted, or `null`. */
    readonly schema: string | null;
    /** The field the CAS precondition was checked against, or `null`. */
    readonly field: string | null;
    /** The row key (rendered) the write targeted, or `null`. */
    readonly key: string | null;
    /** The value the write EXPECTED the field to hold, or `null`. */
    readonly expected: string | null;
    /** The field's ACTUAL current value the node observed, or `null`. */
    readonly actual: string | null;
    constructor(detail?: CasConflictDetail, 
    /** The raw parsed 409 response body, verbatim (`null` when none). */
    body?: unknown);
}
/** No capability is stored under the requested app id (`loadCapability`). */
export declare class CapabilityNotFoundError extends FoldDbError {
    readonly appId: string;
    constructor(appId: string);
}
//# sourceMappingURL=errors.d.ts.map