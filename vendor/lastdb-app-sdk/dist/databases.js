/**
 * Canonical API routes, database-scope path builders, and owner-socket database
 * catalog, creation, spec binding, and session issuance.
 */
import { RequestRejectedError, UnexpectedResponseError } from './errors.js';
import { isObject, sendJsonObject } from './responseParsers.js';
/** Canonical LastDB runtime API route strings used by the SDK. */
export const LASTDB_API_ROUTES = {
    list: '/api/list',
    query: '/api/query',
    /** Several independent `/api/query` bodies in one request. */
    queryBatch: '/api/queries/batch',
    mutation: '/api/mutation',
    /** Atomic batch of complete conditional record mutations. */
    mutationBatch: '/api/mutations/batch',
    shareSubmissionStatus: '/api/submissions/status',
    /** Create or replace a record's blob, inline, or local-reference file. */
    putBlob: '/api/db/put-blob',
    /** Fetch a record's blob or inline file bytes. */
    fetchBlob: '/api/db/fetch-blob',
    /** Clear a record's blob or inline file via complete replacement. */
    deleteBlob: '/api/db/delete-blob',
    autoIdentity: '/api/system/auto-identity',
    schemas: '/api/schemas',
    /** Single schema lookup prefix (`/api/schema/<encoded-name>`). */
    schemaPrefix: '/api/schema',
    /** Owner socket. The response `definition_id` is the definition the app declared. */
    schemasDeclare: '/api/schemas/declare',
    /** Owner socket database catalog and create endpoint. */
    databases: '/api/databases',
    /** Owner socket owned-database spec binding endpoint. */
    databasesSpec: '/api/databases/spec',
    /** Owner socket signed-log share invitation acceptance endpoint. */
    databasesAccept: '/api/databases/accept',
    /** Owner socket short-lived database session issuance endpoint. */
    databasesSession: '/api/databases/session',
    /** The client↔node compatibility handshake. Admitted on all sessions. */
    version: '/api/version',
};
const DATABASE_SELECTOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** True when `value` matches `lastdbd`'s `valid_selector` grammar (`[A-Za-z0-9_-]{1,64}`). */
function isValidDatabaseSelector(value) {
    return DATABASE_SELECTOR_PATTERN.test(value);
}
/** Validate a database ID or alias against `lastdbd`'s selector grammar. */
export function validateDatabaseSelector(databaseId) {
    if (!isValidDatabaseSelector(databaseId)) {
        throw new RequestRejectedError('database_id', 'Invalid LastDB database ID or alias');
    }
    return databaseId;
}
/** Path prefix (`/api/databases/<selector>`) for a selected database, or `null` for the personal default. */
export function databaseScope(databaseId) {
    return databaseId === undefined
        ? null
        : `${LASTDB_API_ROUTES.databases}/${validateDatabaseSelector(databaseId)}`;
}
/** Resolve an `/api/*` data route against an optional database scope and query string. */
export function scopedApiPath(scope, route, queryString) {
    const base = scope === null
        ? route
        : `${scope}${route.startsWith('/api/') ? route.slice('/api'.length) : route}`;
    return queryString && queryString.length > 0 ? `${base}?${queryString}` : base;
}
/** Build the single-schema metadata route (`/api/schema/<encoded>` or scoped equivalent). */
export function schemaRoute(scope, schemaName) {
    const trimmed = schemaName.trim();
    if (trimmed.length === 0) {
        throw new RequestRejectedError('invalid_request', 'schema name must not be empty');
    }
    return scopedApiPath(scope, `${LASTDB_API_ROUTES.schemaPrefix}/${encodeURIComponent(trimmed)}`);
}
const UUID_HYPHENATED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_SIMPLE = /^[0-9a-fA-F]{32}$/;
/** `GET /api/databases` on the owner socket. */
export async function listNodeDatabases(transport, appId = 'lastdb-sdk') {
    const body = await sendJsonObject(transport, 'GET', LASTDB_API_ROUTES.databases, 'database list', appId);
    if (!Array.isArray(body['databases'])) {
        throw new UnexpectedResponseError('database list returned no databases array', 200, body);
    }
    return body['databases'].map(parseListedDatabase);
}
/** `POST /api/databases` on the owner socket. */
export async function createNodeDatabase(transport, request, appId = 'lastdb-sdk') {
    const body = await sendJsonObject(transport, 'POST', LASTDB_API_ROUTES.databases, 'database create', appId, { body: buildCreateBody(request) });
    return parseListedDatabase(body['database']);
}
/** `POST /api/databases/spec` — bind or clear the versioned spec of an owned database. */
export async function bindNodeDatabaseSpec(transport, databaseId, spec, appId = 'lastdb-sdk') {
    validateDatabaseSelector(databaseId);
    if (spec !== null && !validSpec(spec)) {
        throw new RequestRejectedError('invalid_request', 'invalid spec binding');
    }
    const body = await sendJsonObject(transport, 'POST', LASTDB_API_ROUTES.databasesSpec, 'database bind spec', appId, { body: { id: databaseId, spec } });
    return parseListedDatabase(body['database']);
}
/**
 * `POST /api/databases/session` — issue an owner-approved short-lived session
 * restricted to `databaseId` and `intent` (`'read'` or `'write'`).
 */
export async function issueNodeDatabaseSession(transport, databaseId, intent, appId = 'lastdb-sdk') {
    validateDatabaseSelector(databaseId);
    if (intent !== 'read' && intent !== 'write') {
        throw new RequestRejectedError('invalid_request', 'database session intent must be read or write');
    }
    const body = await sendJsonObject(transport, 'POST', LASTDB_API_ROUTES.databasesSession, 'database session', appId, { body: { databaseId, intent }, redactBody: true });
    const session = body['session'];
    const expiresInSeconds = body['expiresInSeconds'];
    if (typeof session !== 'string' ||
        session.length === 0 ||
        typeof expiresInSeconds !== 'number' ||
        !Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds <= 0) {
        throw new UnexpectedResponseError('database session returned an invalid token envelope', 200, null);
    }
    return { databaseId, intent, session, expiresInSeconds };
}
function buildCreateBody(request) {
    const name = request.name;
    if (!isValidDatabaseSelector(name) || name.toLowerCase() === 'personal' || isUuidName(name)) {
        throw new RequestRejectedError('invalid_request', 'invalid database name');
    }
    const spec = request.spec ?? null;
    if (spec !== null && !validSpec(spec)) {
        throw new RequestRejectedError('invalid_request', 'invalid spec binding');
    }
    const kind = request.kind;
    if (kind !== undefined && kind !== 'personal' && kind !== 'shareable') {
        throw new RequestRejectedError('invalid_request', 'invalid database access policy');
    }
    if (kind === 'personal' && spec !== null) {
        throw new RequestRejectedError('invalid_request', 'private databases cannot bind a share spec');
    }
    const body = kind === undefined ? { name } : { name, kind };
    return spec === null ? body : { ...body, spec };
}
function validSpec(spec) {
    return (isValidDatabaseSelector(spec.name) &&
        Number.isInteger(spec.version) &&
        spec.version >= 1 &&
        spec.version <= 4_294_967_295);
}
function isUuidName(value) {
    return UUID_HYPHENATED.test(value) || UUID_SIMPLE.test(value);
}
function parseListedDatabase(value) {
    if (!isObject(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
        throw new UnexpectedResponseError('database list returned a row with no id', 200, value);
    }
    const name = value['name'];
    if (!(name === null || typeof name === 'string')) {
        throw new UnexpectedResponseError('database list returned a row with no name', 200, value);
    }
    if (typeof value['access'] !== 'string' || typeof value['state'] !== 'string') {
        throw new UnexpectedResponseError('database list returned a row with no access', 200, value);
    }
    const listed = {
        id: value['id'],
        name,
        kind: typeof value['kind'] === 'string' ? value['kind'] : null,
        spec: parseSpec(value['spec']),
        access: value['access'],
        state: value['state'],
    };
    if (typeof value['publisher'] === 'string') {
        listed.publisher = value['publisher'];
    }
    if (value['sharingMode'] === 'whole_database') {
        listed.sharingMode = value['sharingMode'];
    }
    if (value['selfAccess'] !== undefined) {
        listed.selfAccess = parseSharedDatabaseAccess(value['selfAccess']);
    }
    if (value['snapshot'] === null || typeof value['snapshot'] === 'string') {
        listed.snapshot = value['snapshot'];
    }
    if (typeof value['expires_ms'] === 'number') {
        listed.expires_ms = value['expires_ms'];
    }
    return listed;
}
function parseSpec(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (!isObject(value) ||
        typeof value['name'] !== 'string' ||
        typeof value['version'] !== 'number') {
        throw new UnexpectedResponseError('database list returned an invalid spec binding', 200, value);
    }
    return { name: value['name'], version: value['version'] };
}
function decimalOrNull(value) {
    return value === null || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value));
}
function strings(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function parseScope(value) {
    if (value === undefined || value === 'all' || strings(value))
        return value;
    if (isObject(value) && strings(value['names']))
        return { names: value['names'] };
    throw new UnexpectedResponseError('database returned an invalid write scope', 200, null);
}
function parseSharedDatabaseAccess(value) {
    if (isObject(value)) {
        const { state, role, revision, confirmedAtMs, stale, writeSchemas } = value;
        if ((state === 'active' || state === 'revoked' || state === 'absent' || state === 'unknown') &&
            (role === 'read' || role === 'submit' || role === null) &&
            decimalOrNull(revision) &&
            decimalOrNull(confirmedAtMs) &&
            typeof stale === 'boolean') {
            const access = { state, role, revision, confirmedAtMs, stale };
            const scope = parseScope(writeSchemas);
            if (scope !== undefined)
                access.writeSchemas = scope;
            return access;
        }
    }
    throw new UnexpectedResponseError('database returned an invalid recipient grant', 200, null);
}
//# sourceMappingURL=databases.js.map