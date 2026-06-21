/**
 * The FoldDB runtime app client.
 *
 * Wraps the node's production `/api/*` dialect: connect → request-consent →
 * poll → query/mutation-with-capability. Every method maps the node's
 * discriminated responses to the typed errors in `errors.ts` — no catch-all.
 *
 * Surface verified against `origin/main`:
 * - consent flow handlers: `fold_db_node/src/server/routes/apps.rs`
 * - data path handlers: `fold_dev_node` `app_endpoints.rs` (the dev mirror of
 *   production `fold_db_node`'s control-socket route table)
 * - capability header: `fold_db_node/src/handlers/caller.rs`
 *   (`X-App-Capability` = base64 JSON CapabilityToken, `X-Capability-Ts` =
 *   unix epoch seconds)
 */
import { type CapabilityStore } from './capabilityStore.js';
import { type Transport } from './transport.js';
import type { ConnectOptions, ConsentScope, MutationOp, MutationResult, QueryAllOptions, QueryFilter, QueryResult, RequestConsentResult, SearchOptions, SearchResult } from './types.js';
/** Options for {@link FoldDbClient.awaitConsent}. */
export interface AwaitConsentOptions {
    /** Hard client-side ceiling. Throws {@link ConsentTimeoutError} past it. */
    timeoutMs?: number;
    /** Poll interval (default 2000ms, per the design). */
    pollIntervalMs?: number;
}
/**
 * Connect to a FoldDB node. Provide exactly one of `baseUrl` (HTTP) or
 * `socketPath` (Unix-domain socket) — the transport is chosen by which is
 * present. Attempts to auto-load a stored capability for `appId` unless one
 * is supplied inline.
 */
export declare function connect(options: ConnectOptions): Promise<FoldDbClient>;
/** Behavior switches for {@link FoldDbClient} (set via {@link ConnectOptions}). */
export interface FoldDbClientOptions {
    /** See `ConnectOptions.verifyCapability`. Default `false`. */
    verifyCapability?: boolean;
}
/** A connected FoldDB app client. Construct via {@link connect}. */
export declare class FoldDbClient {
    readonly appId: string;
    private readonly transport;
    private readonly store;
    private capability;
    /** The node-scoped capability-store key: `capabilityStoreKey(appId, node)`. */
    private readonly storeKey;
    /** The canonical node target this client is bound to (transport `target`). */
    private readonly nodeTarget;
    private readonly verifyCapability;
    constructor(appId: string, transport: Transport, store: CapabilityStore, capability: string | null, 
    /** The node-scoped capability-store key: `capabilityStoreKey(appId, node)`. */
    storeKey: string, 
    /** The canonical node target this client is bound to (transport `target`). */
    nodeTarget: string, options?: FoldDbClientOptions);
    /** Where this client is pointed (for diagnostics). */
    get target(): string;
    /** Whether a capability is currently loaded. */
    get hasCapability(): boolean;
    /**
     * `POST /api/apps/request-consent`. Returns a `requestId` to poll with
     * {@link awaitConsent}. The owner grants via `folddb consent grant <appId>`.
     */
    requestConsent(scope?: ConsentScope): Promise<RequestConsentResult>;
    /**
     * Poll `GET /api/apps/consent-status/{requestId}` until the owner grants the
     * request, then store and return the base64 capability. Throws the matching
     * typed error on denied / revoked / expired, and {@link ConsentTimeoutError}
     * if the request is still pending when `timeoutMs` elapses.
     */
    awaitConsent(requestId: string, options?: AwaitConsentOptions): Promise<string>;
    /**
     * One `consent-status` poll. Returns the base64 capability on `granted`,
     * `null` while still `pending`, and throws the typed terminal error
     * otherwise. Exposed for callers that want to drive their own poll loop.
     */
    pollConsentOnce(requestId: string): Promise<string | null>;
    /**
     * Persist `capability` for this app **on this node** and use it on
     * subsequent calls. The entry is keyed by (appId, node) and records the
     * bound node, so it is never loaded for a different node.
     */
    storeCapability(capability: string): Promise<void>;
    /**
     * Load this app's stored capability **for this node** into the client.
     * Returns it, or `null` if none is stored (including the wrong-node case:
     * a capability bound to a different node is treated as absent). Called
     * automatically by `connect`.
     */
    loadCapability(): Promise<string | null>;
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
     * and the dev node (`fold_dev_node`) honor them with production-parity
     * semantics (default 100, clamp 1000, `total_count`/`has_more` metadata).
     */
    query(schemaName: string, filter?: QueryFilter): Promise<QueryResult>;
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
     * (`fold_dev_node`) both paginate `/api/query` with the same default/clamp
     * and `page` metadata, so the drain follows `page.hasMore` identically on
     * either.
     */
    queryAll(schemaName: string, filter?: Omit<QueryFilter, 'limit' | 'offset'>, opts?: QueryAllOptions): Promise<QueryResult>;
    /**
     * `POST /api/mutation`. Writes one row into `schemaName`. Auto-attaches the
     * capability headers when one is loaded.
     */
    mutate(schemaName: string, op: MutationOp): Promise<MutationResult>;
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
    search(query: string, opts?: SearchOptions): Promise<SearchResult>;
    /** Capability headers, present only when a capability is loaded. */
    private capabilityHeaders;
    /** Map a non-200 data-path response to a typed error. */
    private mapDataError;
    /** Extract an `error` string from a node error body, with a fallback. */
    private errorText;
}
/**
 * Parse a `200` `/api/query` body into a {@link QueryResult}, surfacing the
 * full per-row envelope (gap #3).
 *
 * The node returns its rows under `results` (production `fold_db_node`) or
 * `rows` (the `fold_dev_node` mirror); both carry per-key objects shaped
 * `{ key, fields, metadata, author_pub_key }`. Each row is normalized to a
 * {@link QueryRow}. A bare field-map row (a node that pre-dates the envelope)
 * is still accepted: its `key`/`metadata`/`authorPubKey` come back empty/null
 * and the whole object is its `fields` — so the SDK never throws away an
 * envelope the node sends, nor invents one it doesn't.
 */
export declare function parseQueryResponse(body: unknown): QueryResult;
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
export declare function parseSearchResponse(body: unknown): SearchResult;
//# sourceMappingURL=client.d.ts.map