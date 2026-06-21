/**
 * Wire types for the FoldDB runtime `/api/*` surface.
 *
 * These mirror the JSON the node accepts and returns — confirmed against the
 * handlers on `origin/main`. We do NOT invent fields the node would reject;
 * unknown JSON is carried as `Record<string, JsonValue>` rather than typed.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** The field values of a result row, keyed by field name. */
export type RowFields = Record<string, JsonValue>;
/**
 * A result row — fields keyed by name. Kept as the flattened convenience
 * shape (`QueryRow.fields` is the same data); `query()` also returns the full
 * {@link QueryRow} envelope so the row `key`, `authorPubKey`, and `metadata`
 * are reachable.
 */
export type Row = RowFields;
/**
 * A fold_db row key: a hash component, a range component, or both. This is
 * the node's `KeyValue` wire shape — production `/api/query` returns each
 * row's `key` as this object, and `POST /api/mutation` takes one back as
 * `key_value`. For a Range schema: `{ hash: null, range: "<id>" }`; for a
 * hash-keyed schema: `{ hash: "<id>", range: null }`.
 */
export interface KeyValue {
    hash: string | null;
    range: string | null;
}
/**
 * The full per-row envelope the node returns for `/api/query`. The node's
 * `results` array carries one object per result key shaped
 * `{ key, fields, metadata, author_pub_key }` — see
 * `fold_db_node` `execute_query_json_internal` (the production
 * `/api/query` row builder) and `fold_dev_node` `app_endpoints::api_query`.
 *
 * A real app needs `key` to update/delete a specific row, and typically
 * `authorPubKey` + `metadata` for provenance — flattening to bare `fields`
 * (the pre-gap-#3 behavior) threw these away.
 */
export interface QueryRow {
    /**
     * The row's storage key rendered to a string. Production `fold_db_node`
     * returns `key` as a structured `{hash, range}` object; the SDK renders it
     * the same way fold_db's `KeyValue::Display` does (`"hash:range"`,
     * `"hash"`, or `"range"`). A dev node (`fold_dev_node`) already sends the
     * rendered string, which is kept verbatim. NOTE the rendered form is
     * ambiguous for range values containing `:` — for row addressing prefer
     * the structured {@link QueryRow.keyValue}.
     */
    key: string;
    /**
     * The row's STRUCTURED storage key, when the node sent one (production
     * `/api/query` returns `key` as a `{hash, range}` object). Pass it back
     * verbatim as `MutationOp.key` to update or delete this exact row — unlike
     * the rendered `key` string, it is never ambiguous. `null` when the node
     * sent a pre-rendered string key (the dev-node mirror) or no key at all
     * (bare field-map rows).
     */
    keyValue: KeyValue | null;
    /** The row's field values, keyed by field name. */
    fields: RowFields;
    /**
     * Per-field write metadata as the node stores it (writer pubkey, timestamps,
     * etc.), keyed by field name. Shape is node-defined; left as opaque JSON so
     * the SDK never invents fields. `null`/absent when the node carries none.
     */
    metadata: JsonValue;
    /**
     * The pubkey that authored the row (the first non-empty `writer_pubkey`
     * across the row's field metadata), or `null` when the node reports none.
     */
    authorPubKey: string | null;
}
/**
 * Connection options. Provide exactly ONE of `baseUrl` (HTTP transport) or
 * `socketPath` (Unix-domain-socket transport) — the transport is chosen by
 * which one is present.
 */
export interface ConnectOptions {
    /** Canonical app id this client acts as (e.g. `"fbrain"`). */
    appId: string;
    /** HTTP base URL of the node, e.g. `http://127.0.0.1:9101`. */
    baseUrl?: string;
    /** Path to the node's Unix-domain control socket. */
    socketPath?: string;
    /**
     * Headers attached to EVERY request this client sends (consent flow + data
     * path), under a per-call header of the same name (which wins). The
     * production `fold_db_node` HTTP server is stateless — it resolves the
     * calling user from an `X-User-Hash` header on every request, returning
     * `401 MISSING_USER_CONTEXT` when it is absent — so an app talking to a
     * production node passes `{ 'X-User-Hash': '<hash>' }` here. A dev node
     * (`fold_dev_node`) ignores it (TCP callers run as the node owner), so it is
     * safe to set unconditionally.
     */
    defaultHeaders?: Record<string, string>;
    /**
     * Capability store used by `storeCapability` / `loadCapability` and by an
     * auto-load on `connect`. Defaults to an OS-keychain store with a file
     * fallback (see `capabilityStore.ts`). Entries are keyed by (appId, node),
     * so a capability minted by one node is never replayed against another.
     */
    capabilityStore?: import('./capabilityStore.js').CapabilityStore;
    /**
     * macOS Keychain service label the default store keeps capabilities under
     * (default `com.folddb.app-sdk.capability`). Ignored when a custom
     * `capabilityStore` is supplied. Lets two apps / environments keep their
     * keychain namespaces apart without writing a custom store.
     */
    keychainService?: string;
    /**
     * Pre-loaded capability (base64 CapabilityToken). When omitted, `connect`
     * attempts to load one for `appId` from the capability store; if none is
     * found the client starts un-capable (query/mutate will run owner-context
     * on a dev node, or be refused on an enforcing production node until
     * `awaitConsent` provides one).
     */
    capability?: string;
    /**
     * Verify capability blobs client-side (gap #4). When `true`, the SDK runs
     * decode + audience binding (`token.app_id === appId`) + the RFC 8785 JCS
     * integrity binding (`envelope.payload_hash ==
     * sha256(JCS(token-minus-envelope))`, byte-identical to the node's Rust
     * canonicalizer) at every point a capability is adopted:
     *
     * - a granted token (`awaitConsent`) that fails is REJECTED with
     *   `CapabilityVerificationError` (never stored);
     * - a cached token (`connect` auto-load / `loadCapability`) that fails is
     *   DISCARDED and treated as absent (never replayed into a guaranteed 403);
     * - an inline `capability` that fails makes `connect` throw.
     *
     * Default `false` (verbatim token-carrier behavior, e.g. for a dev node's
     * `app trust` override or a test double whose "capability" is an opaque
     * string). Recommended `true` against a production node.
     */
    verifyCapability?: boolean;
}
/**
 * Consent scope. `"wildcard"` requests `{appId}/*` (one prompt covers the
 * app's whole lifecycle); `{ explicit: [...] }` requests named schemas only.
 * Serialized to the node's `scope` string (`"wildcard"` or
 * `"explicit:a,b"`).
 */
export type ConsentScope = 'wildcard' | {
    explicit: string[];
};
/** `POST /api/apps/request-consent` success body (`202`). */
export interface RequestConsentResult {
    requestId: string;
    /** RFC 3339 timestamp when a still-pending request expires. */
    expiresAt: string;
}
/**
 * Optional query filter. The node's `/api/query` accepts a `fold_db` `Query`
 * — `{schema_name, fields}` plus an optional range filter — alongside
 * top-level `limit`/`offset` pagination fields.
 *
 * Pagination: production `fold_db_node` applies `limit` (default 100 —
 * `DEFAULT_QUERY_LIMIT` — clamped to `MAX_QUERY_LIMIT` 1000) and `offset`
 * after fold_db returns, and reports `total_count`/`has_more` so truncation
 * is detectable (surfaced as {@link QueryResult.page}). Even when you pass NO
 * limit the node still caps the page at its default — use
 * `FoldDbClient.queryAll` to drain a >100-row schema. The dev node
 * (`fold_dev_node`) implements the SAME pagination (default 100, clamp 1000,
 * `total_count`/`has_more` metadata), so `limit`/`offset` and the page
 * metadata behave identically against both.
 */
export interface QueryFilter {
    /**
     * Restrict to these field names. When omitted, the SDK requests every
     * field the schema declares (it cannot know them ahead of time, so a
     * `fields` list is effectively required for a Range schema read — see
     * README). Most callers pass the fields they want back.
     */
    fields?: string[];
    /**
     * A `fold_db` range filter object, passed through verbatim under the
     * query's `filter` key for Range schemas. Shape is node-defined; left
     * opaque so the SDK never invents a filter dialect the node rejects.
     */
    filter?: JsonValue;
    /**
     * Page size. Forwarded verbatim as the request's top-level `limit`; both
     * the production and dev nodes clamp it to `MAX_QUERY_LIMIT` (1000) and
     * default it to `DEFAULT_QUERY_LIMIT` (100) when omitted.
     */
    limit?: number;
    /**
     * Page offset (rows to skip), applied by the node after fold_db returns.
     * Forwarded verbatim as the request's top-level `offset`; defaults to 0 on
     * both node kinds when omitted.
     */
    offset?: number;
}
/**
 * Pagination metadata the node's `/api/query` returns alongside its
 * `results`/`rows` page, surfaced verbatim (snake_case → camelCase). Both
 * production `fold_db_node` and the dev node (`fold_dev_node`) return it. See
 * `fold_db_node/src/handlers/query.rs::QueryResponse` and
 * `fold_dev_node` `app_endpoints::QueryResponse`.
 */
export interface QueryPage {
    /**
     * Total records matching the query before `offset`/`limit` were applied.
     * Capped at the node's internal fetch cap (10k) for unfiltered queries —
     * when `hasMore` is true and `totalCount` equals that cap there may be
     * more records the node did not load.
     */
    totalCount: number;
    /** Number of records actually returned in this page (`rows.length`). */
    returnedCount: number;
    /** Page size the node applied (its default when the request sent none). */
    limit: number;
    /** Page offset the node applied (0 when the request sent none). */
    offset: number;
    /** True when more records exist beyond the returned page. */
    hasMore: boolean;
}
/** `POST /api/query` success body. */
export interface QueryResult {
    schema: string;
    rowCount: number;
    /**
     * The result rows as full envelopes (`key` + `fields` + `metadata` +
     * `authorPubKey`). Use `rows[i].key` to address a specific row for a
     * follow-up update/delete; `rows[i].fields` is the flattened field map.
     */
    rows: QueryRow[];
    /**
     * Pagination metadata, when the node reported it (production `fold_db_node`
     * and the dev node `fold_dev_node` both always do; only an older
     * pre-pagination node omits it — then `null`). When present, `page.hasMore`
     * is the truncation signal: a plain `query()` against a >100-row schema
     * returns only the node's default page.
     */
    page: QueryPage | null;
}
/** Options for `FoldDbClient.queryAll` — the auto-paginating query helper. */
export interface QueryAllOptions {
    /**
     * Page size per request (the `limit` sent on each page). Defaults to 100,
     * production's `DEFAULT_QUERY_LIMIT`; production clamps anything above
     * `MAX_QUERY_LIMIT` (1000), which would wedge the offset arithmetic, so
     * values above 1000 are rejected client-side.
     */
    pageSize?: number;
    /**
     * Safety ceiling on the total rows fetched across pages (default 100_000).
     * `queryAll` stops fetching once reached and returns what it has — it never
     * loops unbounded against a pathological node.
     */
    maxRows?: number;
}
/**
 * Options for {@link FoldDbClient.search} — the node-authoritative scoped
 * search (`POST /api/app/search`, `folddb_app_api.md` operation 5).
 *
 * Deliberately MINIMAL. The app does NOT pass a schema allowlist and cannot
 * widen its scope: the node derives the access-scope set `S(A)` itself from the
 * capability's verified `app_id` against its own grant ledger. The single
 * optional `target` is **intersected** with `S(A)` (never unioned), so naming a
 * schema the app isn't granted simply yields no hits from it — the SDK exposes
 * no way to imply the app controls scope.
 */
export interface SearchOptions {
    /**
     * Number of top hits to return. The node defaults it (currently 20) and
     * clamps it to its maximum (currently 100) when omitted/over the cap; the SDK
     * forwards it verbatim and does not impose its own default.
     */
    k?: number;
    /**
     * OPTIONAL single schema to narrow the search to. The node **intersects** it
     * with the app's access-scope `S(A)` — it can only ever shrink the result
     * set, never widen it. A `target` outside `S(A)` yields zero hits and a
     * normal `200` (no existence-confirming error). This is NOT an allowlist:
     * the app names at most one schema to narrow to, and scope remains
     * node-authoritative.
     */
    target?: string;
}
/**
 * One ranked hit from {@link FoldDbClient.search}. It is a full
 * {@link QueryRow} envelope (`key`, `fields`, `metadata`, `authorPubKey` — the
 * same shape `query()` returns) plus the search-only attribution fields the
 * node adds to each hit:
 *
 * - `score` — the relevance score the node attached (cosine similarity), or
 *   `null` when the node reported none.
 * - `schemaName` — the schema the hit came from (always within the app's
 *   `S(A)`, since forbidden schemas never enter the ranking).
 * - `schemaDisplayName` — the schema's human-readable name, or `null`.
 */
export interface SearchHit extends QueryRow {
    /** Relevance score the node attached (cosine), or `null` when none. */
    score: number | null;
    /** The schema this hit came from (always within the app's access scope). */
    schemaName: string;
    /** The schema's display name, or `null` when the node reported none. */
    schemaDisplayName: string | null;
}
/**
 * `POST /api/app/search` success body, parsed. The hits are returned in the
 * node's relevance order (highest `score` first).
 *
 * **Scope is node-authoritative.** This result contains hits ONLY from schemas
 * the app has been granted (its `S(A)`): the node ranks over that subset by
 * traversal, so the app cannot observe — or infer the existence of — content
 * outside its scope. The app does not (and cannot) widen this.
 */
export interface SearchResult {
    /** Ranked hits, each a full row envelope plus `score` + schema attribution. */
    hits: SearchHit[];
}
/**
 * A mutation operation. Mirrors the node's `Operation::Mutation` envelope
 * (`{type:"mutation", schema, fields_and_values, key_value, mutation_type}`).
 * The SDK fills `type` and `schema`; the caller supplies the rest.
 */
export interface MutationOp {
    /** `"create" | "update" | "delete"` — the node's `mutation_type`. */
    mutationType: 'create' | 'update' | 'delete';
    /** Field name → value for the row being written. */
    fields: Record<string, JsonValue>;
    /**
     * The row key. For a Range schema: `{ hash: null, range: "<id>" }`. For a
     * hash-keyed schema: `{ hash: "<id>", range: null }`. Passed through as the
     * node's `key_value`. A {@link QueryRow.keyValue} from a previous query can
     * be passed back verbatim to address that exact row.
     */
    key: KeyValue;
}
/** `POST /api/mutation` success body. */
export interface MutationResult {
    written: number;
    mutationIds: string[];
    firingsObserved: number;
}
//# sourceMappingURL=types.d.ts.map