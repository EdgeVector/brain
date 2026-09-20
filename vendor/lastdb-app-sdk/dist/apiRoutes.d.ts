/** Canonical LastDB runtime API route strings used by the SDK. */
export declare const LASTDB_API_ROUTES: {
    readonly requestConsent: "/api/apps/request-consent";
    readonly consentStatus: (requestId: string) => string;
    readonly list: "/api/list";
    readonly query: "/api/query";
    readonly mutation: "/api/mutation";
    readonly appSearch: "/api/app/search";
    readonly appChanges: "/api/app/changes";
    readonly autoIdentity: "/api/system/auto-identity";
    readonly schemas: "/api/schemas";
    /** The client↔node compatibility handshake. Both sockets, no node state. */
    readonly version: "/api/version";
};
/**
 * The node request-grammar version this SDK was written against — the value
 * `GET /api/version` reports as `api_version` on a node that speaks exactly
 * this grammar. Pinned to the Rust `API_VERSION` constant by
 * `test/apiRoutes.test.ts`, so the two cannot drift apart silently.
 *
 * An app declares the version IT needs (usually this one) and passes it as
 * `connect({ requireApiVersion })`; the SDK refuses to run against an older
 * node with one line that names the fix instead of failing on the first write.
 */
export declare const LASTDB_SDK_API_VERSION = 1;
/** SDK routes that must stay present in the Rust UDS data router. */
export declare const LASTDB_UDS_SHARED_ROUTES: readonly [readonly ["GET", "/api/list"], readonly ["POST", "/api/query"], readonly ["POST", "/api/mutation"], readonly ["POST", "/api/app/search"], readonly ["POST", "/api/app/changes"], readonly ["GET", "/api/schemas"], readonly ["GET", "/api/system/auto-identity"]];
//# sourceMappingURL=apiRoutes.d.ts.map