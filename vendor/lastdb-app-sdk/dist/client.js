/**
 * The LastDB runtime app client.
 *
 * Wraps the node's production `/api/*` dialect: connect → request-consent →
 * poll → query/mutation-with-capability. Every method maps the node's
 * discriminated responses to the typed errors in `errors.ts` — no catch-all.
 *
 * Surface verified against `origin/main`:
 * - consent flow handlers: `fold_db_node/src/server/routes/apps.rs`
 * - data path handlers: `fold_db_node::dev_mode` `app_endpoints.rs` (the dev mirror of
 *   production `fold_db_node`'s control-socket route table)
 * - capability header: `fold_db_node/src/handlers/caller.rs`
 *   (`X-App-Capability` = base64 JSON CapabilityToken, `X-Capability-Ts` =
 *   unix epoch seconds)
 */
import { capabilityStoreKey, defaultCapabilityStore, } from './capabilityStore.js';
import { LASTDB_API_ROUTES } from './apiRoutes.js';
import { verifyCapabilityBlob } from './capabilityToken.js';
import { AppInSandboxError, AuthenticationRequiredError, CapabilityDeniedError, CapabilityRevokedError, CapabilityVerificationError, CasConflictError, ConsentDeniedError, ConsentExpiredError, ConsentRequestNotFoundError, ConsentTimeoutError, FullScanNotAllowedError, InvalidScopeError, PermissionDeniedError, QueryPaginationError, RequestRejectedError, UnexpectedResponseError, UnknownAppError, } from './errors.js';
import { discoverTransport, httpTransport, udsTransport, } from './transport.js';
/** The HTTP header carrying `base64(JSON CapabilityToken)`. */
const CAPABILITY_HEADER = 'X-App-Capability';
/** The HTTP header carrying the per-request capability timestamp (epoch secs). */
const CAPABILITY_TS_HEADER = 'X-Capability-Ts';
/** Design-mandated poll cadence for `consent-status` (~2s). */
const DEFAULT_POLL_INTERVAL_MS = 2000;
function queryRowDedupKey(row) {
    if (row.keyValue !== null) {
        return `kv:${row.keyValue.hash ?? ''}\u0000${row.keyValue.range ?? ''}`;
    }
    return `rendered:${row.key}`;
}
/** Serialize a {@link ConsentScope} to the node's `scope` string. */
function scopeToString(scope) {
    if (scope === 'wildcard') {
        return 'wildcard';
    }
    return `explicit:${scope.explicit.join(',')}`;
}
/** Current unix epoch seconds, as the `X-Capability-Ts` value. */
function nowEpochSecs() {
    return String(Math.floor(Date.now() / 1000));
}
/**
 * Connect to a LastDB node. Provide exactly one of `baseUrl` (HTTP) or
 * `socketPath` (Unix-domain socket) — the transport is chosen by which is
 * present. Attempts to auto-load a stored capability for `appId` unless one
 * is supplied inline.
 *
 * **Socket-first discovery.** When you pass `baseUrl` (the local-node case),
 * the SDK PREFERS the node's Unix-domain data-plane socket and falls back to
 * the `baseUrl` TCP listener only when no socket file is present. This follows
 * the discovery order the Rust client uses, with the brand-forward
 * `LASTDB_SOCKET_PATH` preferred ahead of the Rust client's
 * `FOLDDB_SOCKET_PATH` (`LASTDB_SOCKET_PATH` → `FOLDDB_SOCKET_PATH` legacy
 * alias → `FOLDDB_SOCK` legacy alias → `<data_dir>/folddb.sock` → TCP),
 * making the
 * socket the normal app path while keeping TCP working mid-migration. Opt out
 * with `connect({ baseUrl, discoverSocket: false })` to force the TCP listener
 * (e.g. against a remote/non-local node, or a browser-style HTTP path). An
 * explicit `socketPath` always uses that socket verbatim with no discovery.
 */
export async function connect(options) {
    const { appId, baseUrl, socketPath } = options;
    if ((baseUrl && socketPath) || (!baseUrl && !socketPath)) {
        throw new Error('connect requires exactly one of { baseUrl } or { socketPath }');
    }
    // Self-reported client label for Mini op telemetry. Prefer explicit
    // clientId; otherwise use appId. Never clobber a caller-supplied header.
    const defaultHeaders = {
        ...(options.defaultHeaders ?? {}),
    };
    if (!Object.keys(defaultHeaders).some((k) => k.toLowerCase() === 'x-lastdb-client')) {
        const clientLabel = (options.clientId ?? appId).trim();
        if (clientLabel.length > 0) {
            defaultHeaders['X-LastDB-Client'] = clientLabel;
        }
    }
    const discoverSocket = options.discoverSocket ?? true;
    let transport;
    if (socketPath) {
        // An explicit socket: use it verbatim, no discovery.
        transport = udsTransport(socketPath, defaultHeaders, {
            timeoutMs: options.timeoutMs,
        });
    }
    else if (discoverSocket) {
        // Local-node case: prefer the data-plane socket, fall back to the
        // supplied TCP base URL when no socket file exists.
        transport = discoverTransport({
            fallbackBaseUrl: baseUrl,
            defaultHeaders,
            timeoutMs: options.timeoutMs,
        });
    }
    else {
        transport = httpTransport(baseUrl, defaultHeaders, {
            timeoutMs: options.timeoutMs,
        });
    }
    // The capability store keys by (appId, nodeTarget) so a capability minted
    // by one node is never replayed against another (gap #2). The transport's
    // `target` is the canonical node string (`http://…` for TCP, `unix:…` for
    // a control socket).
    const nodeTarget = transport.target;
    const store = options.capabilityStore ??
        defaultCapabilityStore(options.keychainService);
    const storeKey = capabilityStoreKey(appId, nodeTarget);
    const verifyCapability = options.verifyCapability ?? false;
    let capability = options.capability ?? null;
    if (capability !== null) {
        // An inline capability the caller passed explicitly: under verification,
        // a bad one is a hard error (fail fast, don't replay a doomed token).
        if (verifyCapability) {
            const v = verifyCapabilityBlob(capability, appId);
            if (!v.ok) {
                throw new CapabilityVerificationError(v.problem, appId, v.tokenAppId);
            }
        }
    }
    else {
        // Wrong-node detection: a stored capability bound to a different node is
        // treated as absent (returns null), never blindly sent.
        capability = await store.load(storeKey, { expectedNode: nodeTarget });
        // Under verification, a cached blob that fails decode / audience / JCS
        // integrity is discarded (treated as absent) rather than replayed into a
        // guaranteed 403 — the "or invalid" branch of the client contract.
        if (verifyCapability &&
            capability !== null &&
            !verifyCapabilityBlob(capability, appId).ok) {
            await store.remove(storeKey);
            capability = null;
        }
    }
    return new LastDbClient(appId, transport, store, capability, storeKey, nodeTarget, { verifyCapability, schemaResolver: options.schemaResolver });
}
/** A connected LastDB app client. Construct via {@link connect}. */
export class LastDbClient {
    appId;
    transport;
    store;
    capability;
    storeKey;
    nodeTarget;
    verifyCapability;
    schemaResolver;
    constructor(appId, transport, store, capability, 
    /** The node-scoped capability-store key: `capabilityStoreKey(appId, node)`. */
    storeKey, 
    /** The canonical node target this client is bound to (transport `target`). */
    nodeTarget, options = {}) {
        this.appId = appId;
        this.transport = transport;
        this.store = store;
        this.capability = capability;
        this.storeKey = storeKey;
        this.nodeTarget = nodeTarget;
        this.verifyCapability = options.verifyCapability ?? false;
        this.schemaResolver = options.schemaResolver ?? null;
    }
    /** Where this client is pointed (for diagnostics). */
    get target() {
        return this.transport.target;
    }
    /** Whether a capability is currently loaded. */
    get hasCapability() {
        return this.capability !== null;
    }
    // -------------------------------------------------------------------------
    // Consent flow
    // -------------------------------------------------------------------------
    /**
     * `POST /api/apps/request-consent`. Returns a `requestId` to poll with
     * {@link awaitConsent}. The owner grants via `folddb consent grant <appId>`.
     */
    async requestConsent(scope = 'wildcard') {
        const res = await this.transport.send('POST', LASTDB_API_ROUTES.requestConsent, {
            body: { app_id: this.appId, scope: scopeToString(scope) },
        });
        if (res.status === 202) {
            const body = res.body;
            return { requestId: body.request_id, expiresAt: body.expires_at };
        }
        if (res.status === 404) {
            throw new UnknownAppError(this.appId);
        }
        if (res.status === 403) {
            // The node discriminates with `reason: "app_in_sandbox"`.
            throw new AppInSandboxError(this.appId);
        }
        if (res.status === 400) {
            throw new InvalidScopeError(this.errorText(res.body, 'invalid scope'));
        }
        throw new UnexpectedResponseError(`request-consent returned ${res.status}`, res.status, res.body);
    }
    /**
     * Poll `GET /api/apps/consent-status/{requestId}` until the owner grants the
     * request, then store and return the base64 capability. Throws the matching
     * typed error on denied / revoked / expired, and {@link ConsentTimeoutError}
     * if the request is still pending when `timeoutMs` elapses.
     */
    async awaitConsent(requestId, options = {}) {
        const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
        const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const capability = await this.pollConsentOnce(requestId);
            if (capability !== null) {
                // Under `verifyCapability`, gate the granted token BEFORE adopting it:
                // audience binding (the token must be bound to THIS app id) and the
                // JCS integrity binding (envelope.payload_hash ==
                // sha256(JCS(token-minus-envelope))). Without the gate, a mis-minted
                // or substituted token would be stored and replayed once before the
                // node's signature check 403'd it as `capability_bad_sig`.
                if (this.verifyCapability) {
                    const v = verifyCapabilityBlob(capability, this.appId);
                    if (!v.ok) {
                        throw new CapabilityVerificationError(v.problem, this.appId, v.tokenAppId);
                    }
                }
                await this.storeCapability(capability);
                return capability;
            }
            if (Date.now() + pollIntervalMs > deadline) {
                throw new ConsentTimeoutError(requestId, timeoutMs);
            }
            await delay(pollIntervalMs);
        }
    }
    /**
     * One `consent-status` poll. Returns the base64 capability on `granted`,
     * `null` while still `pending`, and throws the typed terminal error
     * otherwise. Exposed for callers that want to drive their own poll loop.
     */
    async pollConsentOnce(requestId) {
        const res = await this.transport.send('GET', LASTDB_API_ROUTES.consentStatus(requestId));
        switch (res.status) {
            case 202:
                return null; // pending
            case 200: {
                const body = res.body;
                return body.capability;
            }
            case 403: {
                const body = res.body;
                if (body?.status === 'revoked') {
                    throw new CapabilityRevokedError(requestId);
                }
                throw new ConsentDeniedError(requestId);
            }
            case 408:
                throw new ConsentExpiredError(requestId);
            case 404:
                throw new ConsentRequestNotFoundError(requestId);
            default:
                throw new UnexpectedResponseError(`consent-status returned ${res.status}`, res.status, res.body);
        }
    }
    // -------------------------------------------------------------------------
    // Capability storage
    // -------------------------------------------------------------------------
    /**
     * Persist `capability` for this app **on this node** and use it on
     * subsequent calls. The entry is keyed by (appId, node) and records the
     * bound node, so it is never loaded for a different node.
     */
    async storeCapability(capability) {
        this.capability = capability;
        await this.store.store(this.storeKey, capability, this.nodeTarget);
    }
    /**
     * Load this app's stored capability **for this node** into the client.
     * Returns it, or `null` if none is stored (including the wrong-node case:
     * a capability bound to a different node is treated as absent). Called
     * automatically by `connect`.
     */
    async loadCapability() {
        let cap = await this.store.load(this.storeKey, {
            expectedNode: this.nodeTarget,
        });
        // Under `verifyCapability`, a cached blob that fails decode / audience /
        // JCS integrity is discarded (treated as absent) rather than replayed
        // into a guaranteed 403.
        if (this.verifyCapability &&
            cap !== null &&
            !verifyCapabilityBlob(cap, this.appId).ok) {
            await this.store.remove(this.storeKey);
            cap = null;
        }
        this.capability = cap;
        return cap;
    }
    // -------------------------------------------------------------------------
    // Data path
    // -------------------------------------------------------------------------
    /**
     * `POST /api/query`. Reads fields from `schemaName` (a schema or a view).
     * Auto-attaches the capability headers when one is loaded.
     *
     * Pagination: production `fold_db_node` ALWAYS pages — with no `limit` it
     * still caps the response at its default page size (100,
     * `DEFAULT_QUERY_LIMIT`), so a >100-row schema is silently truncated;
     * check `result.page?.hasMore` or use {@link queryAll} to drain it.
     * `filter.limit`/`filter.offset` are forwarded verbatim as the request's
     * top-level pagination fields, and only when set. Both the production node
     * and the dev node (`fold_db_node::dev_mode`) honor them with production-parity
     * semantics (default 100, clamp 1000, `total_count`/`has_more` metadata).
     */
    async query(schemaName, filter = {}, opts = {}) {
        const resolved = await this.resolveDataPathSchema(schemaName);
        const body = { schema_name: resolved.nodeSchemaName };
        if (filter.fields !== undefined) {
            body.fields = filter.fields.map((field) => mapFieldName(field, resolved.appToNodeFields));
        }
        if (filter.filter !== undefined) {
            body.filter = filter.filter;
        }
        if (filter.limit !== undefined) {
            body.limit = filter.limit;
        }
        if (filter.offset !== undefined) {
            body.offset = filter.offset;
        }
        if (filter.cursor !== undefined) {
            body.cursor = filter.cursor;
        }
        const headers = { ...this.capabilityHeaders() };
        if (opts.allowFullScan === true) {
            // Mini hard-refuses unfiltered product scans without this admin opt-in.
            headers['X-LastDB-Allow-Full-Scan'] = '1';
        }
        const res = await this.transport.send('POST', LASTDB_API_ROUTES.query, {
            headers,
            body,
        });
        if (res.status === 200) {
            return mapQueryResult(parseQueryResponse(res.body), resolved);
        }
        throw this.mapDataError('query', res.status, res.body);
    }
    /**
     * Drain a query past the node's page cap: issues `query()` repeatedly with
     * `limit`/`offset` until the node reports no more rows, and returns every
     * unique row as one {@link QueryResult}.
     *
     * Termination is two-signal: the node's own `page.hasMore` when it reports
     * pagination metadata (production), else a short page
     * (`rows.length < pageSize`). `opts.maxRows` (default 100k) is the safety
     * ceiling — when hit, the result's `page.hasMore` is `true` so the
     * truncation stays visible.
     *
     * Production offset pagination has historically been unstable, so `queryAll`
     * dedupes by row key across pages and throws {@link QueryPaginationError}
     * when a follow-up page makes no unique progress or when a completed drain
     * cannot match the node's `totalCount`.
     */
    async queryAll(schemaName, filter = {}, opts = {}) {
        if (filter.filter === undefined && opts.allowFullScan !== true) {
            // Unfiltered queryAll is a full schema drain — deprecated for product
            // apps (`brain design-lastdb-scan-deprecation-path`). Point reads
            // (`filter: { HashKey: id }`) and partition reads (HashRange) never hit
            // this gate; only a genuinely unfiltered drain does.
            throw new FullScanNotAllowedError(schemaName);
        }
        const pageSize = opts.pageSize ?? 100;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
            // Production clamps limit to MAX_QUERY_LIMIT (1000); a clamped page
            // would silently desync the offset arithmetic, so reject up front.
            throw new Error(`queryAll pageSize must be an integer in [1, 1000], got ${pageSize}`);
        }
        const maxRows = opts.maxRows ?? 100_000;
        const rows = [];
        const seenKeys = new Set();
        let schema = '';
        let lastPage = null;
        let offset = 0;
        let cursor = null;
        let truncatedByMaxRows = false;
        for (;;) {
            const page = await this.query(schemaName, {
                ...filter,
                limit: pageSize,
                ...(cursor === null ? { offset } : { cursor }),
            }, { allowFullScan: opts.allowFullScan === true });
            schema = page.schema || schema;
            lastPage = page.page;
            let newRows = 0;
            for (const row of page.rows) {
                const key = queryRowDedupKey(row);
                if (seenKeys.has(key)) {
                    continue;
                }
                seenKeys.add(key);
                rows.push(row);
                newRows += 1;
            }
            const hasMore = page.page !== null
                ? page.page.hasMore
                : page.rows.length >= pageSize; // no metadata: stop on a short page
            if (!hasMore) {
                break;
            }
            if (rows.length >= maxRows) {
                truncatedByMaxRows = true;
                break;
            }
            if (newRows === 0) {
                throw new QueryPaginationError('stalled_page', {
                    totalCount: page.page?.totalCount,
                    collectedCount: rows.length,
                    returnedCount: page.rows.length,
                    pageSize,
                    offset,
                });
            }
            cursor = page.page?.nextCursor ?? null;
            if (cursor === null) {
                offset += page.rows.length;
            }
        }
        if (!truncatedByMaxRows &&
            lastPage !== null &&
            lastPage.totalCount !== rows.length) {
            throw new QueryPaginationError('total_count_mismatch', {
                totalCount: lastPage.totalCount,
                collectedCount: rows.length,
                returnedCount: lastPage.returnedCount,
                pageSize,
                offset,
            });
        }
        return {
            schema,
            rowCount: rows.length,
            rows,
            page: lastPage === null
                ? null
                : {
                    totalCount: lastPage.totalCount,
                    returnedCount: rows.length,
                    limit: pageSize,
                    offset: 0,
                    hasMore: truncatedByMaxRows,
                    nextCursor: truncatedByMaxRows ? lastPage.nextCursor : null,
                },
        };
    }
    /**
     * `POST /api/mutation`. Writes one row into `schemaName`. Auto-attaches the
     * capability headers when one is loaded.
     */
    async mutate(schemaName, op) {
        const resolved = await this.resolveDataPathSchema(schemaName);
        const body = {
            type: 'mutation',
            schema: resolved.nodeSchemaName,
            fields_and_values: mapFieldRecord(op.fields, resolved.appToNodeFields),
            key_value: op.key,
            mutation_type: op.mutationType,
        };
        // CAS precondition: forward it under the node's `expected` key only when
        // the caller set it (an unconditional write omits it). Its `field` names a
        // schema field, so it is mapped app→node the same way `fields_and_values`
        // keys are — a CAS guard on a renamed field must reference the node name.
        if (op.expected !== undefined) {
            body.expected = mapCasExpectation(op.expected, resolved.appToNodeFields);
        }
        const res = await this.transport.send('POST', LASTDB_API_ROUTES.mutation, {
            headers: this.capabilityHeaders(),
            body,
        });
        if (res.status === 200) {
            const b = res.body;
            return {
                written: b.written,
                mutationIds: b.mutation_ids,
                firingsObserved: b.firings_observed,
            };
        }
        throw this.mapDataError('mutation', res.status, res.body);
    }
    /**
     * `POST /api/app/search` — the **node-authoritative scoped search**
     * (`folddb_app_api.md` operation 5). Embeds `query`, ranks it over the
     * node's native index, and returns the top-k hits **only from schemas the
     * app has been granted** (its access-scope set `S(A)`).
     *
     * Scope is decided by the NODE, not the app. The node derives `S(A)` from the
     * capability's verified `app_id` against its own grant ledger; the app never
     * names its scope and **cannot widen it**. The single optional `opts.target`
     * is *intersected* with `S(A)` (never unioned) — a target outside scope just
     * yields no hits from it, with a normal `200`. There is deliberately no way
     * for the app to pass a schema allowlist.
     *
     * Auto-attaches the capability headers (`X-App-Capability` + `X-Capability-Ts`)
     * the same way `query`/`mutate` do. The node REJECTS a header-less call with
     * `403 {reason: "capability_required"}` (mapped to {@link PermissionDeniedError})
     * rather than handing back the owner's whole-index search.
     *
     * Each hit is a full {@link QueryRow} envelope (`key`, `fields`, `metadata`,
     * `authorPubKey`) plus the relevance `score` and the `schemaName` /
     * `schemaDisplayName` the hit came from.
     */
    async search(query, opts = {}) {
        const body = { query };
        if (opts.k !== undefined) {
            body.k = opts.k;
        }
        // The single node-intersected `target` — NOT an app-controlled allowlist.
        if (opts.target !== undefined) {
            body.target = opts.target;
        }
        const res = await this.transport.send('POST', LASTDB_API_ROUTES.appSearch, {
            headers: this.capabilityHeaders(),
            body,
        });
        if (res.status === 200) {
            return parseSearchResponse(res.body);
        }
        throw this.mapDataError('search', res.status, res.body);
    }
    // -------------------------------------------------------------------------
    // Owner / host node helpers
    // -------------------------------------------------------------------------
    /**
     * `GET /api/system/auto-identity`. Resolves the local owner identity a
     * host-context app uses for `X-User-Hash`. A not-yet-provisioned node returns
     * `{ provisioned: false }` for the node's canonical 503, so callers can pivot
     * to bootstrap without treating it as a transport failure.
     */
    async autoIdentity() {
        const res = await this.transport.send('GET', LASTDB_API_ROUTES.autoIdentity);
        if (res.status === 200) {
            return parseAutoIdentityResponse(res.body);
        }
        if (res.status === 503) {
            const body = isObject(res.body) ? res.body : {};
            return {
                provisioned: false,
                reason: typeof body['error'] === 'string'
                    ? body['error']
                    : 'node_not_provisioned',
                next: typeof body['next'] === 'string' ? body['next'] : null,
            };
        }
        throw new UnexpectedResponseError(`auto-identity returned ${res.status}`, res.status, res.body);
    }
    /**
     * `GET /api/schemas`. Lists schemas loaded in the owner node and normalizes
     * the fields host-context apps use to resolve their own canonical schema hash
     * without hand-parsing raw route JSON.
     */
    async listSchemas() {
        const res = await this.transport.send('GET', LASTDB_API_ROUTES.schemas);
        if (res.status === 200) {
            return parseSchemaListResponse(res.body);
        }
        throw new UnexpectedResponseError(`schemas list returned ${res.status}`, res.status, res.body);
    }
    /**
     * Resolve an app-owned schema descriptor to the loaded canonical schema entry.
     * Matching uses `owner_app_id` + `descriptive_name`, and when `fields` is
     * supplied requires the exact same field set regardless of order.
     */
    async resolveSchema(descriptor) {
        return resolveLoadedSchema(await this.listSchemas(), descriptor);
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    /** Capability headers, present only when a capability is loaded. */
    capabilityHeaders() {
        if (this.capability === null) {
            return {};
        }
        return {
            [CAPABILITY_HEADER]: this.capability,
            [CAPABILITY_TS_HEADER]: nowEpochSecs(),
        };
    }
    /**
     * Resolve an app schema name to the node-facing schema + field maps (the
     * data-path schema mapping used by `query`/`mutate`). Distinct from the
     * public {@link resolveSchema} owner-host helper, which resolves a
     * {@link SchemaDescriptor} to a {@link LoadedSchema}; they were merged from
     * two concurrent PRs that both chose the name `resolveSchema`, so the private
     * data-path one is named `resolveDataPathSchema` to avoid the collision.
     */
    async resolveDataPathSchema(appSchemaName) {
        const result = await this.schemaResolver?.(appSchemaName);
        return normalizeSchemaResolution(appSchemaName, result);
    }
    /** Map a non-200 data-path response to a typed error. */
    mapDataError(verb, status, body) {
        const b = (body ?? {});
        if (status === 401) {
            return new AuthenticationRequiredError(authenticationRequiredReason(b), b.error ?? b.message ?? `${verb} requires authentication`, body ?? null);
        }
        if (status === 409 && b.error === 'cas_conflict') {
            // A CAS precondition (`MutationOp.expected`) did not hold: the node
            // returns `409 {error:"cas_conflict", schema?, field?, key?, expected?,
            // actual?, message?}`. Surface it as the typed CasConflictError so an app
            // can re-read + retry instead of hand-detecting the conflict off a
            // generic error body.
            return new CasConflictError(casConflictDetailOf(body), body ?? null);
        }
        if (status === 403) {
            // Discriminated capability 403 (app_identity v3.1, gap #4): the
            // verifier's body is `{status: 403, reason: "<reason>", ...detail}` —
            // surface the reason VERBATIM plus any detail field, so an app can run
            // the eight-reason contract (`capabilityDenialReaction`). A 403 without
            // a `reason` keeps the legacy `{kind: "permission_denied"}` mapping.
            if (typeof b.reason === 'string') {
                return new CapabilityDeniedError(b.reason, capabilityDetailOf(body));
            }
            return new PermissionDeniedError(b.error ?? `${verb} permission denied`);
        }
        if (status === 400) {
            // Production 400 bodies are not uniform: the dev mirror sends
            // `{kind, error}`, production handlers send `{error}` or `{message}`
            // (or richer envelopes). Prefer `error`, fall back to the node's
            // `message`, and carry the WHOLE body on the error so nothing the node
            // said is lost (mirrors the 403 CapabilityDeniedError's detail).
            return new RequestRejectedError(b.kind ?? 'invalid_request', b.error ?? b.message ?? `${verb} rejected`, body ?? null);
        }
        return new UnexpectedResponseError(`${verb} returned ${status}`, status, body);
    }
    /** Extract an `error` string from a node error body, with a fallback. */
    errorText(body, fallback) {
        const b = (body ?? {});
        return b.error ?? fallback;
    }
}
function authenticationRequiredReason(body) {
    const text = `${body.code ?? ''} ${body.error ?? ''} ${body.message ?? ''}`.toLowerCase();
    if (text.includes('session') && text.includes('expired')) {
        return 'session_expired';
    }
    if (text.includes('token') && text.includes('expired')) {
        return 'session_expired';
    }
    return 'auth_failed';
}
function normalizeSchemaResolution(appSchemaName, result) {
    if (typeof result === 'string') {
        return {
            appSchemaName,
            identity: result,
            nodeSchemaName: result,
            appToNodeFields: {},
            nodeToAppFields: {},
            outcome: null,
        };
    }
    if (isResolveResult(result)) {
        const appToNodeFields = result.adapter?.appToCatalog ?? {};
        return {
            appSchemaName,
            identity: result.identity,
            nodeSchemaName: result.schema ?? result.identity,
            appToNodeFields,
            nodeToAppFields: result.adapter?.catalogToApp ?? reverseFieldMap(appToNodeFields),
            outcome: result.outcome ?? null,
        };
    }
    const appToNodeFields = result?.fields ?? {};
    return {
        appSchemaName,
        identity: result?.nodeSchemaName ?? appSchemaName,
        nodeSchemaName: result?.nodeSchemaName ?? appSchemaName,
        appToNodeFields,
        nodeToAppFields: reverseFieldMap(appToNodeFields),
        outcome: null,
    };
}
function isResolveResult(result) {
    return (typeof result === 'object' &&
        result !== null &&
        'identity' in result &&
        typeof result.identity === 'string');
}
function reverseFieldMap(fields) {
    const reversed = {};
    for (const [appField, nodeField] of Object.entries(fields)) {
        if (reversed[nodeField] === undefined) {
            reversed[nodeField] = appField;
        }
    }
    return reversed;
}
function mapFieldName(field, fields) {
    return fields[field] ?? field;
}
function mapFieldRecord(row, fields) {
    const mapped = {};
    for (const [field, value] of Object.entries(row)) {
        mapped[mapFieldName(field, fields)] = value;
    }
    return mapped;
}
/**
 * Map a CAS {@link CasExpectation}'s `field` app→node (its value, when present,
 * is passed through unchanged — only the field name is a schema field). Used so
 * a `mutate` precondition guards the correct node-side field under a schema map.
 */
function mapCasExpectation(expected, fields) {
    return { ...expected, field: mapFieldName(expected.field, fields) };
}
function mapQueryResult(result, resolved) {
    return {
        ...result,
        schema: resolved.appSchemaName,
        rows: result.rows.map((row) => mapQueryRow(row, resolved.nodeToAppFields)),
    };
}
function mapQueryRow(row, nodeToAppFields) {
    return {
        ...row,
        fields: mapFieldRecord(row.fields, nodeToAppFields),
        metadata: mapFieldKeyedJson(row.metadata, nodeToAppFields),
    };
}
function mapFieldKeyedJson(value, fields) {
    if (!isObject(value)) {
        return value;
    }
    return mapFieldRecord(value, fields);
}
/**
 * Parse a `200` `/api/query` body into a {@link QueryResult}, surfacing the
 * full per-row envelope (gap #3).
 *
 * The node returns its rows under `results` (production `fold_db_node`) or
 * `rows` (the `fold_db_node::dev_mode` mirror); both carry per-key objects shaped
 * `{ key, fields, metadata, author_pub_key }`. Each row is normalized to a
 * {@link QueryRow}. A bare field-map row (a node that pre-dates the envelope)
 * is still accepted: its `key`/`metadata`/`authorPubKey` come back empty/null
 * and the whole object is its `fields` — so the SDK never throws away an
 * envelope the node sends, nor invents one it doesn't.
 */
export function parseQueryResponse(body) {
    const b = (body ?? {});
    const rawRows = Array.isArray(b.results)
        ? b.results
        : Array.isArray(b.rows)
            ? b.rows
            : [];
    const rows = rawRows.map(parseQueryRow);
    const schema = typeof b.schema === 'string' ? b.schema : '';
    const rowCount = typeof b.row_count === 'number' ? b.row_count : rows.length;
    return { schema, rowCount, rows, page: parseQueryPage(body, rows.length) };
}
/**
 * Read production's pagination metadata (`total_count` / `returned_count` /
 * `limit` / `offset` / `has_more`, per `fold_db_node`'s `QueryResponse`) off
 * a 200 `/api/query` body. Returns `null` when the node reported none (the
 * dev-node mirror, pre-pagination nodes) — the SDK never invents pagination
 * the node didn't do.
 */
function parseQueryPage(body, returnedRows) {
    if (!isObject(body)) {
        return null;
    }
    const totalCount = body['total_count'];
    const limit = body['limit'];
    const offset = body['offset'];
    const hasMore = body['has_more'];
    const nextCursor = parseKeyValue(body['next_cursor']);
    if (typeof totalCount !== 'number' ||
        typeof limit !== 'number' ||
        typeof offset !== 'number' ||
        typeof hasMore !== 'boolean') {
        return null;
    }
    const returnedCount = body['returned_count'];
    return {
        totalCount,
        returnedCount: typeof returnedCount === 'number' ? returnedCount : returnedRows,
        limit,
        offset,
        hasMore,
        nextCursor,
    };
}
/** Whether a value is a non-array JSON object. */
function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/**
 * Normalize one raw query row into a {@link QueryRow}. An enveloped row
 * (`{key, fields, metadata, author_pub_key}`) is surfaced faithfully; a bare
 * field-map row is wrapped (its fields are the whole object; key empty,
 * metadata null, author null).
 *
 * The row `key` arrives in one of two node dialects: production
 * `fold_db_node` sends the structured `KeyValue` object (`{hash, range}`),
 * the dev-node mirror sends a pre-rendered string. A structured key is
 * preserved verbatim as `keyValue` (the unambiguous row address) AND rendered
 * to the `key` string the same way fold_db's `KeyValue::Display` does; a
 * string key is kept verbatim with `keyValue: null`. Coercing a structured
 * key to `''` (the pre-fix behavior) lost row addressing and dedup entirely.
 */
function parseQueryRow(raw) {
    if (isObject(raw) && 'fields' in raw && isObject(raw.fields)) {
        const author = raw['author_pub_key'];
        const { key, keyValue } = parseRowKey(raw['key']);
        return {
            key,
            keyValue,
            fields: raw.fields,
            metadata: 'metadata' in raw ? raw['metadata'] : null,
            authorPubKey: typeof author === 'string' && author.length > 0 ? author : null,
        };
    }
    // Bare field-map row (no envelope): the object *is* the fields.
    return {
        key: '',
        keyValue: null,
        fields: isObject(raw) ? raw : {},
        metadata: null,
        authorPubKey: null,
    };
}
/**
 * Parse a row's raw `key` into the (rendered string, structured KeyValue)
 * pair. A string is the dev-node dialect — kept verbatim, no structure to
 * recover (the rendered form is ambiguous, so the SDK never reverse-parses
 * it). A `{hash, range}` object is production's `KeyValue` — preserved
 * structurally and rendered like fold_db's `KeyValue::Display`
 * (`"hash:range"` / `"hash"` / `"range"` / `""`). Anything else (absent,
 * null, unrecognized) yields the empty key.
 */
function parseRowKey(rawKey) {
    const keyValue = parseKeyValue(rawKey);
    if (keyValue !== null) {
        const key = keyValue.hash !== null && keyValue.range !== null
            ? `${keyValue.hash}:${keyValue.range}`
            : (keyValue.hash ?? keyValue.range ?? '');
        return { key, keyValue };
    }
    if (typeof rawKey === 'string') {
        return { key: rawKey, keyValue: null };
    }
    return { key: '', keyValue: null };
}
function parseKeyValue(rawKey) {
    if (!isObject(rawKey)) {
        return null;
    }
    const hash = typeof rawKey['hash'] === 'string' ? rawKey['hash'] : null;
    const range = typeof rawKey['range'] === 'string' ? rawKey['range'] : null;
    return hash !== null || range !== null ? { hash, range } : null;
}
/**
 * Parse a `200` `/api/app/search` body into a {@link SearchResult}.
 *
 * The node wraps the hits in its standard envelope: `{ ok, results: [...],
 * user_hash }` (the `ApiResponse<IndexSearchResponse>` shape). Each element of
 * `results` is a full `/api/query` row envelope (`key`, `fields`, `metadata`,
 * `author_pub_key`) with three search-only fields the node adds per hit:
 * `schema_name`, `schema_display_name`, and `score`. Hits arrive in the node's
 * relevance order and are surfaced verbatim — the SDK preserves it.
 *
 * The row part is parsed by the SAME {@link parseQueryRow} used for `query()`,
 * so the envelope handling (enveloped vs bare row, null author) is identical.
 */
export function parseSearchResponse(body) {
    const b = (body ?? {});
    const rawHits = Array.isArray(b.results) ? b.results : [];
    const hits = rawHits.map(parseSearchHit);
    return { hits };
}
/** Parse `GET /api/system/auto-identity` success JSON. */
export function parseAutoIdentityResponse(body) {
    const b = isObject(body) ? body : {};
    const userHash = b['user_hash'];
    const publicKey = b['public_key'];
    const userId = b['user_id'];
    if (typeof userHash !== 'string' || userHash.length === 0) {
        throw new UnexpectedResponseError('auto-identity returned a provisioned body without user_hash', 200, body);
    }
    return {
        provisioned: true,
        userHash,
        publicKey: typeof publicKey === 'string' ? publicKey : null,
        userId: typeof userId === 'string' ? userId : null,
    };
}
/** Parse `GET /api/schemas` JSON into normalized loaded-schema entries. */
export function parseSchemaListResponse(body) {
    const b = isObject(body) ? body : {};
    const rawSchemas = Array.isArray(b['schemas']) ? b['schemas'] : [];
    return rawSchemas
        .filter((schema) => isObject(schema))
        .map(parseLoadedSchema);
}
/** Resolve a schema descriptor against an already-fetched schema list. */
export function resolveLoadedSchema(schemas, descriptor) {
    const matches = schemas.filter((schema) => {
        if (schema.ownerAppId !== descriptor.ownerAppId) {
            return false;
        }
        if (schema.descriptiveName !== descriptor.descriptiveName) {
            return false;
        }
        if (descriptor.fields !== undefined) {
            return sameFieldSet(schema.fields, descriptor.fields);
        }
        return true;
    });
    if (matches.length === 0) {
        return null;
    }
    if (matches.length > 1) {
        throw new UnexpectedResponseError(`schema descriptor matched ${matches.length} loaded schemas`, 200, matches);
    }
    return matches[0];
}
function parseLoadedSchema(schema) {
    const name = stringOrNull(schema['name']) ?? '';
    const identityHash = stringOrNull(schema['identity_hash']) ?? name;
    return {
        name,
        identityHash,
        descriptiveName: stringOrNull(schema['descriptive_name']),
        ownerAppId: stringOrNull(schema['owner_app_id']),
        fields: stringArray(schema['fields']),
    };
}
function sameFieldSet(actual, expected) {
    if (actual.length !== expected.length) {
        return false;
    }
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    return actualSorted.every((field, i) => field === expectedSorted[i]);
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((field) => typeof field === 'string')
        : [];
}
function stringOrNull(value) {
    return typeof value === 'string' ? value : null;
}
/**
 * Normalize one raw search hit. The row envelope (`key`/`fields`/`metadata`/
 * `authorPubKey`) is parsed by {@link parseQueryRow}; the search-only
 * attribution fields (`score`, `schema_name`, `schema_display_name`) are read
 * off the same object. `score` is `null` when the node reported none.
 */
function parseSearchHit(raw) {
    const row = parseQueryRow(raw);
    const obj = isObject(raw) ? raw : {};
    const score = obj['score'];
    const schemaName = obj['schema_name'];
    const schemaDisplayName = obj['schema_display_name'];
    return {
        ...row,
        score: typeof score === 'number' ? score : null,
        schemaName: typeof schemaName === 'string' ? schemaName : '',
        schemaDisplayName: typeof schemaDisplayName === 'string' ? schemaDisplayName : null,
    };
}
/**
 * Read the optional detail fields off a discriminated capability-403 body
 * (`capability_id` / `schema` / `timestamp_skew_secs`, per the
 * `CapabilityDenial` variant payloads). Unknown fields are ignored; absent
 * ones stay absent.
 */
function capabilityDetailOf(body) {
    const detail = {};
    if (!isObject(body)) {
        return detail;
    }
    if (typeof body['capability_id'] === 'string') {
        detail.capabilityId = body['capability_id'];
    }
    if (typeof body['schema'] === 'string') {
        detail.schema = body['schema'];
    }
    if (typeof body['timestamp_skew_secs'] === 'number') {
        detail.timestampSkewSecs = body['timestamp_skew_secs'];
    }
    return detail;
}
/**
 * Read the modeled detail fields off a `409 {error:"cas_conflict"}` body
 * (`schema` / `field` / `key` / `expected` / `actual` / `message`, per the
 * node's CAS-conflict contract). Unknown fields are ignored; absent ones stay
 * absent. `actual` is passed through as-is (the node may send an explicit
 * `null` when the field had no current value).
 */
function casConflictDetailOf(body) {
    const detail = {};
    if (!isObject(body)) {
        return detail;
    }
    if (typeof body['schema'] === 'string') {
        detail.schema = body['schema'];
    }
    if (typeof body['field'] === 'string') {
        detail.field = body['field'];
    }
    if (typeof body['key'] === 'string') {
        detail.key = body['key'];
    }
    if (typeof body['expected'] === 'string') {
        detail.expected = body['expected'];
    }
    if (typeof body['actual'] === 'string' || body['actual'] === null) {
        detail.actual = body['actual'];
    }
    if (typeof body['message'] === 'string') {
        detail.message = body['message'];
    }
    return detail;
}
/** Promise-based sleep (used between consent polls). */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=client.js.map