/**
 * Typed error taxonomy for the LastDB app SDK.
 *
 * Every class maps to a discriminated response the node returns — there is no
 * catch-all "request failed".
 */
import type { JsonValue } from './types.js';
/** Base class for every error this SDK raises. */
export declare class LastDbError extends Error {
    constructor(message: string);
}
export type TransportErrorKind = 'timeout' | 'protocol' | 'connect';
/** A network/transport failure (socket error, connection refused, timeout, etc.). */
export declare class TransportError extends LastDbError {
    readonly kind: TransportErrorKind;
    readonly status?: number;
    constructor(message: string, kind?: TransportErrorKind, options?: {
        status?: number;
    });
}
/** The node answered with an HTTP status the SDK has no specific class for. */
export declare class UnexpectedResponseError extends LastDbError {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown);
}
/** Retry the same body with this UUID when the Share upload outcome is uncertain. */
export declare class ShareSubmissionUncertainError extends LastDbError {
    readonly mutationId: string;
    readonly cause: unknown;
    constructor(mutationId: string, cause: unknown);
}
/** The node's paginated `/api/query` stopped making progress or mismatched `total_count`. */
export declare class QueryPaginationError extends LastDbError {
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
/** Posture/namespace/session denial category (`403`). */
export type PermissionCategory = 'namespace_denied' | 'unverified_identity' | 'write_denied' | 'session_denied' | 'unknown';
export declare class PermissionDeniedError extends LastDbError {
    readonly reason: string;
    readonly category: PermissionCategory;
    constructor(reason: string, category?: PermissionCategory);
}
/** Classify the node's `403` permission-denied reason into a {@link PermissionCategory}. */
export declare function classifyPermissionReason(reason: string): PermissionCategory;
export type AuthenticationRequiredReason = 'session_expired' | 'auth_failed';
/** Credential failure (`401`). */
export declare class AuthenticationRequiredError extends LastDbError {
    readonly reason: AuthenticationRequiredReason;
    readonly body: unknown;
    constructor(reason: AuthenticationRequiredReason, message: string, body?: unknown);
}
/** Request shape, target lookup, conflict, or payload-size rejection (`400`/`404`/`409`/`413`). */
export declare class RequestRejectedError extends LastDbError {
    readonly kind: string;
    readonly body: unknown;
    readonly status: number;
    constructor(kind: string, message: string, body?: unknown, status?: number);
}
/** Why the SDK decided the node is too old (`api_version_below_required` or `unknown_key`). */
export type NodeTooOldReason = 'api_version_below_required' | 'unknown_key';
/** The facts {@link NodeTooOldError} carries for a one-line remedy. */
export interface NodeTooOldDetail {
    reason: NodeTooOldReason;
    required?: number;
    reported: number | null;
    build: string | null;
    app?: string;
}
/** The one line an operator needs. Same shape from every app. */
export declare function nodeTooOldMessage(detail: NodeTooOldDetail): string;
/** The node is older than this client needs. Subclasses {@link RequestRejectedError}. */
export declare class NodeTooOldError extends RequestRejectedError {
    readonly detail: NodeTooOldDetail;
    constructor(detail: NodeTooOldDetail, body?: unknown);
}
/** The detail fields the node carries on a `409 {error:"cas_conflict"}` body. */
export interface CasConflictDetail {
    schema?: string;
    key?: string;
    expected?: string;
    actual?: string | null;
    message?: string;
}
/** A compare-and-set (CAS) precondition did not hold (`409 {error:"cas_conflict"}`). */
export declare class CasConflictError extends LastDbError {
    readonly body: unknown;
    readonly schema: string | null;
    readonly key: string | null;
    readonly expected: string | null;
    readonly actual: string | null;
    constructor(detail?: CasConflictDetail, body?: unknown);
}
/** Whether a value is a non-array JSON object. */
export declare function isObject(value: unknown): value is Record<string, JsonValue>;
/** Map a non-200 data-plane response into the SDK's typed error hierarchy. */
export declare function mapDataError(verb: string, status: number, body: unknown, appId: string): Error;
//# sourceMappingURL=errors.d.ts.map