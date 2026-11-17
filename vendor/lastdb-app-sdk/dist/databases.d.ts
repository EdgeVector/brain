/**
 * Canonical API routes, database-scope path builders, and owner-socket database
 * catalog, creation, spec binding, and session issuance.
 */
import type { Transport } from './transport.js';
import type { DatabaseSession, DatabaseSessionIntent } from './types.js';
/** Canonical LastDB runtime API route strings used by the SDK. */
export declare const LASTDB_API_ROUTES: {
    readonly list: "/api/list";
    readonly query: "/api/query";
    /** Several independent `/api/query` bodies in one request. */
    readonly queryBatch: "/api/queries/batch";
    readonly mutation: "/api/mutation";
    /** Atomic batch of complete conditional record mutations. */
    readonly mutationBatch: "/api/mutations/batch";
    readonly shareSubmissionStatus: "/api/submissions/status";
    /** Create or replace a record's blob, inline, or local-reference file. */
    readonly putBlob: "/api/db/put-blob";
    /** Fetch a record's blob or inline file bytes. */
    readonly fetchBlob: "/api/db/fetch-blob";
    /** Clear a record's blob or inline file via complete replacement. */
    readonly deleteBlob: "/api/db/delete-blob";
    readonly autoIdentity: "/api/system/auto-identity";
    readonly schemas: "/api/schemas";
    /** Single schema lookup prefix (`/api/schema/<encoded-name>`). */
    readonly schemaPrefix: "/api/schema";
    /** Owner socket. The response `definition_id` is the definition the app declared. */
    readonly schemasDeclare: "/api/schemas/declare";
    /** Owner socket database catalog and create endpoint. */
    readonly databases: "/api/databases";
    /** Owner socket owned-database spec binding endpoint. */
    readonly databasesSpec: "/api/databases/spec";
    /** Owner socket signed-log share invitation acceptance endpoint. */
    readonly databasesAccept: "/api/databases/accept";
    /** Owner socket short-lived database session issuance endpoint. */
    readonly databasesSession: "/api/databases/session";
    /** The client↔node compatibility handshake. Admitted on all sessions. */
    readonly version: "/api/version";
};
/** Shared runtime context passed to domain operation modules. */
export interface ClientContext {
    readonly appId: string;
    readonly transport: Transport;
    readonly databasePath: string | null;
    readonly definitionIds: Map<string, string>;
}
/** Validate a database ID or alias against `lastdbd`'s selector grammar. */
export declare function validateDatabaseSelector(databaseId: string): string;
/** Path prefix (`/api/databases/<selector>`) for a selected database, or `null` for the personal default. */
export declare function databaseScope(databaseId: string | undefined): string | null;
/** Resolve an `/api/*` data route against an optional database scope and query string. */
export declare function scopedApiPath(scope: string | null, route: string, queryString?: string): string;
/** Build the single-schema metadata route (`/api/schema/<encoded>` or scoped equivalent). */
export declare function schemaRoute(scope: string | null, schemaName: string): string;
/** Canonical names, legacy definition IDs, or all schemas. An empty list grants reads only. */
export type ShareWriteScope = {
    names: string[];
} | string[] | 'all';
/** The last observed grant for this receiving node. Use it to display available actions. */
export interface SharedDatabaseAccess {
    state: 'unknown' | 'active' | 'revoked' | 'absent';
    role: 'read' | 'submit' | null;
    writeSchemas?: ShareWriteScope;
    revision: string | null;
    confirmedAtMs: string | null;
    stale: boolean;
}
/** Versioned spec binding stored on an owned database. */
export interface DatabaseSpec {
    name: string;
    version: number;
}
/** One row from `GET /api/databases`, including personal and received shares. */
export interface ListedDatabase {
    id: string;
    name: string | null;
    kind: string | null;
    spec: DatabaseSpec | null;
    access: string;
    state: string;
    sharingMode?: 'whole_database';
    selfAccess?: SharedDatabaseAccess;
    publisher?: string;
    snapshot?: string | null;
    expires_ms?: number;
}
/** Body of `POST /api/databases`. Omit `kind` for a shareable database. */
export interface CreateDatabaseRequest {
    name: string;
    kind?: 'personal' | 'shareable';
    spec?: DatabaseSpec | null;
}
/** `GET /api/databases` on the owner socket. */
export declare function listNodeDatabases(transport: Transport, appId?: string): Promise<ListedDatabase[]>;
/** `POST /api/databases` on the owner socket. */
export declare function createNodeDatabase(transport: Transport, request: CreateDatabaseRequest, appId?: string): Promise<ListedDatabase>;
/** `POST /api/databases/spec` — bind or clear the versioned spec of an owned database. */
export declare function bindNodeDatabaseSpec(transport: Transport, databaseId: string, spec: DatabaseSpec | null, appId?: string): Promise<ListedDatabase>;
/**
 * `POST /api/databases/session` — issue an owner-approved short-lived session
 * restricted to `databaseId` and `intent` (`'read'` or `'write'`).
 */
export declare function issueNodeDatabaseSession(transport: Transport, databaseId: string, intent: DatabaseSessionIntent, appId?: string): Promise<DatabaseSession>;
//# sourceMappingURL=databases.d.ts.map