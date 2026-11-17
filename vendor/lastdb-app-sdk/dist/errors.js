/**
 * Typed error taxonomy for the LastDB app SDK.
 *
 * Every class maps to a discriminated response the node returns — there is no
 * catch-all "request failed".
 */
/** Base class for every error this SDK raises. */
export class LastDbError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
/** A network/transport failure (socket error, connection refused, timeout, etc.). */
export class TransportError extends LastDbError {
    kind;
    status;
    constructor(message, kind = 'connect', options = {}) {
        super(message);
        this.kind = kind;
        this.status = options.status;
    }
}
/** The node answered with an HTTP status the SDK has no specific class for. */
export class UnexpectedResponseError extends LastDbError {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
/** Retry the same body with this UUID when the Share upload outcome is uncertain. */
export class ShareSubmissionUncertainError extends LastDbError {
    mutationId;
    cause;
    constructor(mutationId, cause) {
        super('Share submission outcome is unavailable. Retry with the same mutation ID and body.');
        this.mutationId = mutationId;
        this.cause = cause;
    }
}
/** The node's paginated `/api/query` stopped making progress or mismatched `total_count`. */
export class QueryPaginationError extends LastDbError {
    reason;
    detail;
    constructor(reason, detail) {
        super(queryPaginationMessage(reason, detail));
        this.reason = reason;
        this.detail = detail;
    }
}
function queryPaginationMessage(reason, detail) {
    if (reason === 'stalled_page') {
        return ('queryAll pagination stalled: the node reported more rows but returned ' +
            'no new record keys on the next page');
    }
    return (`queryAll collected ${detail.collectedCount} unique rows` +
        (detail.totalCount === undefined ? '' : ` but the node reported total_count=${detail.totalCount}`));
}
export class PermissionDeniedError extends LastDbError {
    reason;
    category;
    constructor(reason, category) {
        super(reason);
        this.reason = reason;
        this.category = category ?? classifyPermissionReason(reason);
    }
}
/** Classify the node's `403` permission-denied reason into a {@link PermissionCategory}. */
export function classifyPermissionReason(reason) {
    const r = reason.toLowerCase();
    if (r.includes('is not granted') && r.includes('isolated namespace')) {
        return 'namespace_denied';
    }
    if (r.includes('code-signature-verified app identity')) {
        return 'unverified_identity';
    }
    if (r.includes('write denied by namespace isolation') ||
        r.includes('this share is read-only') ||
        r.includes('permits local read sessions only') ||
        r.includes('unavailable on a received database')) {
        return 'write_denied';
    }
    if (r.includes('database session refused')) {
        return 'session_denied';
    }
    return 'unknown';
}
/** Credential failure (`401`). */
export class AuthenticationRequiredError extends LastDbError {
    reason;
    body;
    constructor(reason, message, body = null) {
        super(message);
        this.reason = reason;
        this.body = body;
    }
}
/** Request shape, target lookup, conflict, or payload-size rejection (`400`/`404`/`409`/`413`). */
export class RequestRejectedError extends LastDbError {
    kind;
    body;
    status;
    constructor(kind, message, body = null, status = 400) {
        super(message);
        this.kind = kind;
        this.body = body;
        this.status = status;
    }
}
/** The one line an operator needs. Same shape from every app. */
export function nodeTooOldMessage(detail) {
    const who = detail.app ?? 'this client';
    const build = detail.build ? ` (build ${detail.build})` : '';
    const remedy = 'Run: brew upgrade lastdb && brew services restart lastdb';
    if (detail.reason === 'unknown_key') {
        const need = detail.required !== undefined ? ` ${who} needs api_version >= ${detail.required}.` : '';
        return (`LastDB node does not know a request key ${who} sent` +
            ` (400 unknown_key)${build}: the client is newer than the node.${need} ${remedy}`);
    }
    const reported = detail.reported === null ? 'no api_version' : `api_version ${detail.reported}`;
    return (`${who} needs LastDB api_version >= ${detail.required ?? '?'}; ` +
        `this node reports ${reported}${build}. ${remedy}`);
}
/** The node is older than this client needs. Subclasses {@link RequestRejectedError}. */
export class NodeTooOldError extends RequestRejectedError {
    detail;
    constructor(detail, body = null) {
        super(detail.reason, nodeTooOldMessage(detail), body, 400);
        this.detail = detail;
    }
}
/** A compare-and-set (CAS) precondition did not hold (`409 {error:"cas_conflict"}`). */
export class CasConflictError extends LastDbError {
    body;
    schema;
    key;
    expected;
    actual;
    constructor(detail = {}, body = null) {
        super(detail.message ?? casConflictMessage(detail));
        this.body = body;
        this.schema = detail.schema ?? null;
        this.key = detail.key ?? null;
        this.expected = detail.expected ?? null;
        this.actual = detail.actual ?? null;
    }
}
function casConflictMessage(detail) {
    const where = detail.schema !== undefined ? ` on schema '${detail.schema}'` : '';
    const values = detail.expected !== undefined || detail.actual !== undefined
        ? ` (expected ${JSON.stringify(detail.expected ?? null)}, actual ${JSON.stringify(detail.actual ?? null)})`
        : '';
    return `CAS conflict${where}: the row changed since the expected precondition${values}`;
}
/** Whether a value is a non-array JSON object. */
export function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function authenticationRequiredReason(body) {
    const text = `${body.code ?? ''} ${body.error ?? ''} ${body.message ?? ''}`.toLowerCase();
    if ((text.includes('session') || text.includes('token')) && text.includes('expired')) {
        return 'session_expired';
    }
    return 'auth_failed';
}
function casConflictDetailOf(body) {
    const detail = {};
    if (!isObject(body))
        return detail;
    if (typeof body['schema'] === 'string')
        detail.schema = body['schema'];
    if (typeof body['key'] === 'string')
        detail.key = body['key'];
    if (typeof body['expected'] === 'string')
        detail.expected = body['expected'];
    if (typeof body['actual'] === 'string' || body['actual'] === null) {
        detail.actual = body['actual'];
    }
    if (typeof body['message'] === 'string')
        detail.message = body['message'];
    return detail;
}
function extractErrorMessage(body, fallback) {
    if (typeof body === 'string' && body.trim().length > 0)
        return body.trim();
    if (isObject(body)) {
        for (const field of ['message', 'reason', 'error']) {
            const candidate = body[field];
            if (typeof candidate === 'string' && candidate.length > 0)
                return candidate;
        }
    }
    return fallback;
}
/** Map a non-200 data-plane response into the SDK's typed error hierarchy. */
export function mapDataError(verb, status, body, appId) {
    const b = (isObject(body) ? body : {});
    if (status === 401) {
        return new AuthenticationRequiredError(authenticationRequiredReason(b), extractErrorMessage(body, `${verb} requires authentication`), body ?? null);
    }
    if (status === 409 && b.error === 'cas_conflict') {
        return new CasConflictError(casConflictDetailOf(body), body ?? null);
    }
    if (status === 403) {
        return new PermissionDeniedError(extractErrorMessage(body, `${verb} permission denied`));
    }
    if (status === 400) {
        if (b.kind === 'unknown_key') {
            return new NodeTooOldError({ reason: 'unknown_key', reported: null, build: null, app: appId }, body ?? null);
        }
        const hasDetail = typeof b.message === 'string' || typeof b.reason === 'string';
        const kind = typeof b.kind === 'string'
            ? b.kind
            : hasDetail && typeof b.error === 'string'
                ? b.error
                : 'invalid_request';
        return new RequestRejectedError(kind, extractErrorMessage(body, `${verb} rejected`), body ?? null, 400);
    }
    if (status === 404) {
        return new RequestRejectedError('not_found', extractErrorMessage(body, `${verb} target not found`), body ?? null, 404);
    }
    if (status === 409) {
        return new RequestRejectedError(typeof b.error === 'string' ? b.error : 'conflict', extractErrorMessage(body, `${verb} conflict`), body ?? null, 409);
    }
    if (status === 413) {
        return new RequestRejectedError(typeof b.error === 'string' ? b.error : 'payload_too_large', extractErrorMessage(body, `${verb} payload too large`), body ?? null, 413);
    }
    return new UnexpectedResponseError(extractErrorMessage(body, `${verb} returned ${status}`), status, body);
}
//# sourceMappingURL=errors.js.map