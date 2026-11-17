/**
 * The LastDB runtime app client facade.
 *
 * Wraps the node's Unix-socket data plane and delegates handshake, schema,
 * keyed read, mutation, blob, and database-session operations to focused
 * domain modules. `read`, `write`, and `changes` call the app API (`/v1`).
 */
import { existsSync } from 'node:fs';
import { LASTDB_SDK_API_VERSION } from './apiVersion.generated.js';
import { executeAppChanges, executeAppRead, executeAppWrite } from './appApi.js';
import { executeDeleteBlob, executeFetchBlob, executePutBlob, } from './blobOps.js';
import { bindNodeDatabaseSpec, createNodeDatabase, databaseScope, issueNodeDatabaseSession, listNodeDatabases, validateDatabaseSelector, } from './databases.js';
import { RequestRejectedError, TransportError } from './errors.js';
import { executeMutate, executeMutateBatch, executeShareSubmissionStatus } from './mutationOps.js';
import { executeGet, executeList, executeQuery, executeQueryAll, executeQueryBatch } from './readOps.js';
import { executeAutoIdentity, executeDeclareSchema, executeGetSchema, executeListSchemas, executeRequireApiVersion, executeResolveSchema, executeVersion, rememberSchemaDefinition, } from './schemaOps.js';
import { openDiscoveredSocket, udsTransport, withDefaultHeaders } from './transport.js';
const DATABASE_SESSION_HEADER = 'X-LastDB-Database-Session';
function resolveSessionHeaders(databaseId, databaseSession) {
    if (databaseSession === undefined)
        return {};
    if (databaseId === undefined) {
        throw new RequestRejectedError('database_session', 'databaseSession requires an explicit databaseId');
    }
    validateDatabaseSelector(databaseId);
    const trimmed = databaseSession.trim();
    if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
        throw new RequestRejectedError('database_session', 'Invalid LastDB database session token');
    }
    return { [DATABASE_SESSION_HEADER]: trimmed };
}
/** Attach `X-LastDB-Client` unless the caller already provided one. */
function buildClientHeaders(appId, clientId, defaultHeaders) {
    const headers = { ...(defaultHeaders ?? {}) };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'x-lastdb-client')) {
        const label = (clientId ?? appId).trim();
        if (label.length > 0)
            headers['X-LastDB-Client'] = label;
    }
    return headers;
}
/** Connect to a LastDB node over its Unix-domain socket and verify protocol compatibility. */
export async function connect(options) {
    const defaultHeaders = buildClientHeaders(options.appId, options.clientId, options.defaultHeaders);
    const transport = options.socketPath
        ? udsTransport(options.socketPath, defaultHeaders, { timeoutMs: options.timeoutMs })
        : openDiscoveredSocket({ defaultHeaders, timeoutMs: options.timeoutMs });
    const client = new LastDbClient(options.appId, transport, {
        databaseId: options.databaseId,
        databaseSession: options.databaseSession,
    });
    const required = options.requireApiVersion ?? LASTDB_SDK_API_VERSION;
    if (required > 0) {
        await client.requireApiVersion(required, options.appLabel ?? options.appId);
    }
    return client;
}
/** A connected LastDB app client. Construct via {@link connect} or `ownerClient`. */
export class LastDbClient {
    appId;
    baseTransport;
    databaseId;
    context;
    constructor(appId, baseTransport, options = {}) {
        this.appId = appId;
        this.baseTransport = baseTransport;
        const databasePath = databaseScope(options.databaseId);
        const sessionHeaders = resolveSessionHeaders(options.databaseId, options.databaseSession);
        this.databaseId = options.databaseId;
        this.context = {
            appId,
            transport: withDefaultHeaders(baseTransport, sessionHeaders),
            databasePath,
            definitionIds: new Map(),
        };
    }
    /** Where this client is pointed (for diagnostics). */
    get target() {
        return this.context.transport.target;
    }
    /** `GET /api/version` — client↔node compatibility handshake. */
    version() {
        return executeVersion(this.context);
    }
    /** Refuse to proceed against a node whose `api_version` is below `required`. */
    requireApiVersion(required, appLabel) {
        return executeRequireApiVersion(this.context, required, appLabel);
    }
    /** `GET /api/system/auto-identity` — resolve the local owner identity. */
    autoIdentity() {
        return executeAutoIdentity(this.context);
    }
    /** `GET /api/list` — return one page of live primary or alternate keys. */
    list(schemaName, opts = {}) {
        return executeList(this.context, schemaName, opts);
    }
    /** Point lookup of a single record by primary `HashKey` or `HashRangeKey`. */
    get(schemaName, key) {
        return executeGet(this.context, schemaName, key);
    }
    /** `POST /api/query` — keyed point, multi-get, or range read under one hash. */
    query(schemaName, filter = {}) {
        return executeQuery(this.context, schemaName, filter);
    }
    /** `POST /api/queries/batch` — read up to 64 keyed queries per request. */
    queryBatch(items) {
        return executeQueryBatch(this.context, items);
    }
    /** Auto-paginate a keyed query across pages until `hasMore` is false or `maxRows` is reached. */
    queryAll(schemaName, filter = {}, opts = {}) {
        return executeQueryAll(this.context, schemaName, filter, opts);
    }
    mutate(schemaName, op, options = {}) {
        return executeMutate(this.context, schemaName, op, options);
    }
    /** `POST /api/mutations/batch` — commit an atomic batch of conditional record mutations. */
    mutateBatch(items, options = {}) {
        return executeMutateBatch(this.context, items, options);
    }
    /** Read the outcome of one submission made by this receiving LastDB node. */
    getShareSubmissionStatus(mutationId) {
        return executeShareSubmissionStatus(this.context, mutationId);
    }
    /**
     * `POST /v1/read` — one result per read, in order.
     * A per-item error is returned, not thrown. Does not use this client's `/api` database path.
     */
    read(reads) {
        return executeAppRead(this.context, reads);
    }
    /** `POST /v1/write` — commit a list of conditional mutations after the write is on disk. */
    write(mutations) {
        return executeAppWrite(this.context, mutations);
    }
    /** `POST /v1/x/changes` — changed record keys after a saved position. */
    changes(options = {}) {
        return executeAppChanges(this.context, options);
    }
    /** `POST /api/db/put-blob` — attach or replace a record's blob, inline, or local-path file. */
    putBlob(schemaName, request) {
        return executePutBlob(this.context, schemaName, request);
    }
    /** `POST /api/db/fetch-blob` — read a record's blob or inline file bytes. */
    fetchBlob(schemaName, key, options = {}) {
        return executeFetchBlob(this.context, schemaName, key, options);
    }
    /** `POST /api/db/delete-blob` — clear a record's blob or inline file via complete replacement. */
    deleteBlob(schemaName, op, options = {}) {
        return executeDeleteBlob(this.context, schemaName, op, options);
    }
    /** Remember the 64-hex `definition_id` returned by `declareSchema` for `schemaName`. */
    rememberDefinition(schemaName, definitionId) {
        rememberSchemaDefinition(this.context.definitionIds, schemaName, definitionId);
    }
    /** `POST /api/schemas/declare` — declare an app-owned schema. */
    declareSchema(request) {
        return executeDeclareSchema(this.context, request);
    }
    /** `GET /api/schemas` — list schemas loaded on the selected database. */
    listSchemas() {
        return executeListSchemas(this.context);
    }
    /** `GET /api/schema/<name>` — fetch a single loaded schema entry, or `null` on `404`. */
    getSchema(schemaName) {
        return executeGetSchema(this.context, schemaName);
    }
    /** Resolve an app-owned schema descriptor against `listSchemas()`. */
    resolveSchema(descriptor) {
        return executeResolveSchema(this.context, descriptor);
    }
    /** `GET /api/databases` — list personal, owned, and received shared databases. */
    listDatabases() {
        return listNodeDatabases(this.baseTransport, this.appId);
    }
    /** `POST /api/databases` — create an owned database on this node. */
    createDatabase(request) {
        return createNodeDatabase(this.baseTransport, request, this.appId);
    }
    /** `POST /api/databases/spec` — bind or clear an owned database's spec. */
    bindDatabaseSpec(databaseId, spec) {
        return bindNodeDatabaseSpec(this.baseTransport, databaseId, spec, this.appId);
    }
    /** `POST /api/databases/session` — issue a short-lived session restricted to `databaseId`. */
    issueDatabaseSession(databaseId, intent) {
        return issueNodeDatabaseSession(this.baseTransport, databaseId, intent, this.appId);
    }
    /** Issue a short-lived database session and return a scoped client bound to it. */
    async openDatabaseSession(databaseId, intent) {
        const session = await this.issueDatabaseSession(databaseId, intent);
        return { session, client: this.select(session.databaseId, { databaseSession: session.session }) };
    }
    /** Return a client bound to `databaseId` (and optional `databaseSession`) without mutating `this`. */
    select(databaseId, options = {}) {
        return new LastDbClient(this.appId, this.baseTransport, {
            databaseId,
            databaseSession: options.databaseSession,
        });
    }
}
/** Build a {@link LastDbClient} synchronously against an existing Unix-domain socket. */
export function ownerClient(options) {
    const { socketPath, timeoutMs } = options;
    if (socketPath.length === 0 || !existsSync(socketPath)) {
        throw new TransportError(`ownerClient requires a socketPath whose file exists, got '${socketPath}'`, 'connect');
    }
    const headers = buildClientHeaders(options.appId, options.clientId, options.defaultHeaders);
    const transport = udsTransport(socketPath, headers, { timeoutMs });
    return new LastDbClient(options.appId, transport, {
        databaseId: options.databaseId,
        databaseSession: options.databaseSession,
    });
}
//# sourceMappingURL=client.js.map