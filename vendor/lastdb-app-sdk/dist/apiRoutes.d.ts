/** Canonical LastDB runtime API route strings used by the SDK. */
export declare const LASTDB_API_ROUTES: {
    readonly requestConsent: "/api/apps/request-consent";
    readonly consentStatus: (requestId: string) => string;
    readonly query: "/api/query";
    readonly mutation: "/api/mutation";
    readonly appSearch: "/api/app/search";
    readonly autoIdentity: "/api/system/auto-identity";
    readonly schemas: "/api/schemas";
};
/** SDK routes that must stay present in the Rust UDS data router. */
export declare const LASTDB_UDS_SHARED_ROUTES: readonly [readonly ["POST", "/api/query"], readonly ["POST", "/api/mutation"], readonly ["GET", "/api/schemas"], readonly ["GET", "/api/system/auto-identity"]];
//# sourceMappingURL=apiRoutes.d.ts.map