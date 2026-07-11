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
import { verifyCapabilityBlob } from './capabilityToken.js';
import { AppInSandboxError, CapabilityDeniedError, CapabilityRevokedError, CapabilityVerificationError, ConsentDeniedError, ConsentExpiredError, ConsentRequestNotFoundError, ConsentTimeoutError, InvalidScopeError, PermissionDeniedError, RequestRejectedError, UnexpectedResponseError, UnknownAppError, } from './errors.js';
import { discoverTransport, httpTransport, udsTransport, } from './transport.js';
/** The HTTP header carrying `base64(JSON CapabilityToken)`. */
const CAPABILITY_HEADER = 'X-App-Capability';
/** The HTTP header carrying the per-request capability timestamp (epoch secs). */
const CAPABILITY_TS_HEADER = 'X-Capability-Ts';
/** Design-mandated poll cadence for `consent-status` (~2s). */
const DEFAULT_POLL_INTERVAL_MS = 2000;
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
    const defaultHeaders = options.defaultHeaders ?? {};
    const discoverSocket = options.discoverSocket ?? true;
    let transport;
    if (socketPath) {
        // An explicit socket: use it verbatim, no discovery.
        transport = udsTransport(socketPath, defaultHeaders);
    }
    else if (discoverSocket) {
        // Local-node case: prefer the data-plane socket, fall back to the
        // supplied TCP base URL when no socket file exists.
        transport = discoverTransport({
            fallbackBaseUrl: baseUrl,
            defaultHeaders,
        });
    }
    else {
        transport = httpTransport(baseUrl, defaultHeaders);
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
    return new LastDbClient(appId, transport, store, capability, storeKey, nodeTarget, { verifyCapability });
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
        const res = await this.transport.send('POST', '/api/apps/request-consent', {
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
        const res = await this.transport.send('GET', `/api/apps/consent-status/${encodeURIComponent(requestId)}`);
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
    async query(schemaName, filter = {}) {
        const body = { schema_name: schemaName };
        if (filter.fields !== undefined) {
            body.fields = filter.fields;
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
        const res = await this.transport.send('POST', '/api/query', {
            headers: this.capabilityHeaders(),
            body,
        });
        if (res.status === 200) {
            return parseQueryResponse(res.body);
        }
        throw this.mapDataError('query', res.status, res.body);
    }
    /**
     * Drain a query past the node's page cap: issues `query()` repeatedly with
     * `limit`/`offset` until the node reports no more rows, and returns every
     * row as one {@link QueryResult}.
     *
     * Termination is two-signal: the node's own `page.hasMore` when it reports
     * pagination metadata (production), else a short page
     * (`rows.length < pageSize`). `opts.maxRows` (default 100k) is the safety
     * ceiling — when hit, the result's `page.hasMore` is `true` so the
     * truncation stays visible.
     *
     * Works against both node kinds: production `fold_db_node` and the dev node
     * (`fold_db_node::dev_mode`) both paginate `/api/query` with the same default/clamp
     * and `page` metadata, so the drain follows `page.hasMore` identically on
     * either.
     */
    async queryAll(schemaName, filter = {}, opts = {}) {
        const pageSize = opts.pageSize ?? 100;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
            // Production clamps limit to MAX_QUERY_LIMIT (1000); a clamped page
            // would silently desync the offset arithmetic, so reject up front.
            throw new Error(`queryAll pageSize must be an integer in [1, 1000], got ${pageSize}`);
        }
        const maxRows = opts.maxRows ?? 100_000;
        const rows = [];
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
            });
            schema = page.schema || schema;
            lastPage = page.page;
            rows.push(...page.rows);
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
            cursor = page.page?.nextCursor ?? null;
            if (cursor === null) {
                offset += page.rows.length;
            }
            if (page.rows.length === 0) {
                // Defensive: a node claiming hasMore while returning an empty page
                // would otherwise loop forever.
                break;
            }
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
        const body = {
            type: 'mutation',
            schema: schemaName,
            fields_and_values: op.fields,
            key_value: op.key,
            mutation_type: op.mutationType,
        };
        const res = await this.transport.send('POST', '/api/mutation', {
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
        const res = await this.transport.send('POST', '/api/app/search', {
            headers: this.capabilityHeaders(),
            body,
        });
        if (res.status === 200) {
            return parseSearchResponse(res.body);
        }
        throw this.mapDataError('search', res.status, res.body);
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
    /** Map a non-200 data-path response to a typed error. */
    mapDataError(verb, status, body) {
        const b = (body ?? {});
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
/**
 * @deprecated Renamed to {@link LastDbClient}. Kept as an exported value + type
 * alias so mid-port consumers keep compiling (`new FoldDbClient(...)` and
 * `: FoldDbClient` both resolve to `LastDbClient`); removed at the adoption
 * capstone.
 */
export const FoldDbClient = LastDbClient;
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
/** Promise-based sleep (used between consent polls). */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=client.js.map