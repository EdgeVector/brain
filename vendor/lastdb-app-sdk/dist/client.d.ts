/**
 * The LastDB runtime app client facade.
 *
 * Wraps the node's Unix-socket data plane and delegates handshake, schema,
 * keyed read, mutation, blob, and database-session operations to focused
 * domain modules. `read`, `write`, and `changes` call the app API (`/v1`).
 */
import { type AppApiChangesOptions, type AppApiChangesResult, type AppApiMutation, type AppApiRead, type AppApiReadResult, type AppApiWriteResult } from './appApi.js';
import { type DeleteBlobOptions, type FetchBlobOptions, type FetchedBlob, type PutBlobRequest, type PutBlobResult } from './blobOps.js';
import { type CreateDatabaseRequest, type DatabaseSpec, type ListedDatabase } from './databases.js';
import { type AutoIdentityResult, type DeclareSchemaRequest, type DeclareSchemaResult, type LoadedSchema, type SchemaDescriptor } from './schemaOps.js';
import { type Transport } from './transport.js';
import type * as Types from './types.js';
/** Connect to a LastDB node over its Unix-domain socket and verify protocol compatibility. */
export declare function connect<DatabaseId extends string | undefined = undefined>(options: Types.ConnectOptions<DatabaseId>): Promise<LastDbClient<DatabaseId>>;
/** Behavior switches for {@link LastDbClient} (set via `ConnectOptions` or `ownerClient`). */
export interface LastDbClientOptions<DatabaseId extends string | undefined = undefined> {
    databaseId?: DatabaseId;
    databaseSession?: string;
}
/** A connected LastDB app client. Construct via {@link connect} or `ownerClient`. */
export declare class LastDbClient<DatabaseId extends string | undefined = undefined> {
    readonly appId: string;
    private readonly baseTransport;
    readonly databaseId: DatabaseId;
    private readonly context;
    constructor(appId: string, baseTransport: Transport, options?: LastDbClientOptions<DatabaseId>);
    /** Where this client is pointed (for diagnostics). */
    get target(): string;
    /** `GET /api/version` — client↔node compatibility handshake. */
    version(): Promise<Types.NodeVersion>;
    /** Refuse to proceed against a node whose `api_version` is below `required`. */
    requireApiVersion(required: number, appLabel?: string): Promise<Types.NodeVersion>;
    /** `GET /api/system/auto-identity` — resolve the local owner identity. */
    autoIdentity(): Promise<AutoIdentityResult>;
    /** `GET /api/list` — return one page of live primary or alternate keys. */
    list(schemaName: string, opts?: Types.ListOptions): Promise<Types.ListResult>;
    /** Point lookup of a single record by primary `HashKey` or `HashRangeKey`. */
    get(schemaName: string, key: Types.RecordKeyInput): Promise<Types.QueryRow | null>;
    /** `POST /api/query` — keyed point, multi-get, or range read under one hash. */
    query(schemaName: string, filter?: Types.QueryFilter): Promise<Types.QueryResult>;
    /** `POST /api/queries/batch` — read up to 64 keyed queries per request. */
    queryBatch(items: readonly Types.QueryBatchItem[]): Promise<Types.QueryBatchOutcome[]>;
    /** Auto-paginate a keyed query across pages until `hasMore` is false or `maxRows` is reached. */
    queryAll(schemaName: string, filter?: Omit<Types.QueryFilter, 'limit' | 'offset' | 'cursor'>, opts?: Types.QueryAllOptions): Promise<Types.QueryResult>;
    /** `POST /api/mutation` — write one complete conditional record into `schemaName`. */
    mutate(schemaName: string, op: Types.MutationOp, options?: DatabaseId extends string ? Types.MutationOptions : never): Promise<Types.MutationResult | (DatabaseId extends string ? Types.ShareSubmissionResult : never)>;
    /** `POST /api/mutations/batch` — commit an atomic batch of conditional record mutations. */
    mutateBatch(items: readonly Types.MutationBatchItem[], options?: Types.MutationBatchOptions): Promise<Types.MutationBatchResult>;
    /** Read the outcome of one submission made by this receiving LastDB node. */
    getShareSubmissionStatus(mutationId: string): Promise<Types.ShareSubmissionStatus>;
    /**
     * `POST /v1/read` — one result per read, in order.
     * A per-item error is returned, not thrown. Does not use this client's `/api` database path.
     */
    read(reads: readonly AppApiRead[]): Promise<AppApiReadResult[]>;
    /** `POST /v1/write` — commit a list of conditional mutations after the write is on disk. */
    write(mutations: readonly AppApiMutation[]): Promise<AppApiWriteResult>;
    /** `POST /v1/x/changes` — changed record keys after a saved position. */
    changes(options?: AppApiChangesOptions): Promise<AppApiChangesResult>;
    /** `POST /api/db/put-blob` — attach or replace a record's blob, inline, or local-path file. */
    putBlob(schemaName: string, request: PutBlobRequest): Promise<PutBlobResult>;
    /** `POST /api/db/fetch-blob` — read a record's blob or inline file bytes. */
    fetchBlob(schemaName: string, key: Types.RecordKeyInput, options?: FetchBlobOptions): Promise<FetchedBlob>;
    /** `POST /api/db/delete-blob` — clear a record's blob or inline file via complete replacement. */
    deleteBlob(schemaName: string, op: Types.ReplaceMutationOp, options?: DeleteBlobOptions): Promise<Types.MutationResult>;
    /** Remember the 64-hex `definition_id` returned by `declareSchema` for `schemaName`. */
    rememberDefinition(schemaName: string, definitionId: string): void;
    /** `POST /api/schemas/declare` — declare an app-owned schema. */
    declareSchema(request: DeclareSchemaRequest): Promise<DeclareSchemaResult>;
    /** `GET /api/schemas` — list schemas loaded on the selected database. */
    listSchemas(): Promise<LoadedSchema[]>;
    /** `GET /api/schema/<name>` — fetch a single loaded schema entry, or `null` on `404`. */
    getSchema(schemaName: string): Promise<LoadedSchema | null>;
    /** Resolve an app-owned schema descriptor against `listSchemas()`. */
    resolveSchema(descriptor: SchemaDescriptor): Promise<LoadedSchema | null>;
    /** `GET /api/databases` — list personal, owned, and received shared databases. */
    listDatabases(): Promise<ListedDatabase[]>;
    /** `POST /api/databases` — create an owned database on this node. */
    createDatabase(request: CreateDatabaseRequest): Promise<ListedDatabase>;
    /** `POST /api/databases/spec` — bind or clear an owned database's spec. */
    bindDatabaseSpec(databaseId: string, spec: DatabaseSpec | null): Promise<ListedDatabase>;
    /** `POST /api/databases/session` — issue a short-lived session restricted to `databaseId`. */
    issueDatabaseSession(databaseId: string, intent: Types.DatabaseSessionIntent): Promise<Types.DatabaseSession>;
    /** Issue a short-lived database session and return a scoped client bound to it. */
    openDatabaseSession(databaseId: string, intent: Types.DatabaseSessionIntent): Promise<{
        session: Types.DatabaseSession;
        client: LastDbClient<string>;
    }>;
    /** Return a client bound to `databaseId` (and optional `databaseSession`) without mutating `this`. */
    select(databaseId: string, options?: Types.SelectDatabaseOptions): LastDbClient<string>;
}
/** Options for {@link ownerClient}. */
export interface OwnerClientOptions<DatabaseId extends string | undefined = undefined> {
    /** Canonical app id this client acts as. */
    appId: string;
    /** Database ID or local alias. Omit for the personal default. */
    databaseId?: DatabaseId;
    /**
     * Short-lived owner-approved database session token (`X-LastDB-Database-Session`).
     * Requires `databaseId`. Keep session tokens out of logs.
     */
    databaseSession?: string;
    /** Best-effort client label (`X-LastDB-Client`). Defaults to `appId`. */
    clientId?: string;
    /** Control-socket path. The file must exist. */
    socketPath: string;
    /** Headers attached to every request this client sends (per-call headers win). */
    defaultHeaders?: Record<string, string>;
    /** Per-request transport timeout in milliseconds (defaults to 30_000). */
    timeoutMs?: number;
}
/** Build a {@link LastDbClient} synchronously against an existing Unix-domain socket. */
export declare function ownerClient<DatabaseId extends string | undefined = undefined>(options: OwnerClientOptions<DatabaseId>): LastDbClient<DatabaseId>;
//# sourceMappingURL=client.d.ts.map