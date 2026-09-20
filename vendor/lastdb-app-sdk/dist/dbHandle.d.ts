/**
 * Platform DB handle / locator (no org product dependency).
 *
 * Org fills handles (`org` CLI injects `LASTDB_DB`); the SDK forwards them on
 * every data-path request as `X-LastDB-Db`. Mini resolves the locator to a
 * storage_prefix (see design-org-db-handle-platform-gap).
 *
 * Forms:
 * - `lastdb://personal` (default)
 * - `lastdb://org/<org-slug>[/<db-slug>]`
 * - bare `org/db` or `org` shorthand
 * - raw 64-hex `db_hash` / `lastdb://db/<64-hex>`
 */
/** Env var org (and agents) set so apps inherit an explicit DB handle. */
export declare const LASTDB_DB_ENV = "LASTDB_DB";
/** HTTP header Mini reads for multi-DB storage scoping. */
export declare const LASTDB_DB_HEADER = "X-LastDB-Db";
/** Canonical personal home locator. */
export declare const PERSONAL_DB_LOCATOR = "lastdb://personal";
export type PersonalDbHandle = {
    scope: 'personal';
    locator: typeof PERSONAL_DB_LOCATOR;
};
export type OrgDbHandle = {
    scope: 'org';
    orgSlug: string;
    dbSlug?: string;
    locator: string;
};
export type DbHashHandle = {
    scope: 'db_hash';
    dbHash: string;
    locator: string;
};
export type DbHandle = PersonalDbHandle | OrgDbHandle | DbHashHandle;
export declare class DbLocatorError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function personalDb(): PersonalDbHandle;
export declare function orgDb(orgSlug: string, dbSlug?: string): OrgDbHandle;
export declare function parseDbLocator(raw: string): DbHandle;
/**
 * Resolve the DB locator this client should send on `X-LastDB-Db`.
 *
 * Order: explicit option → `process.env.LASTDB_DB` → personal.
 * Always returns a non-empty canonical locator string.
 */
export declare function resolveDbLocator(explicit?: string | null): string;
//# sourceMappingURL=dbHandle.d.ts.map