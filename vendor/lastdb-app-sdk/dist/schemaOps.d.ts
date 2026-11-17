/**
 * Node compatibility handshake, owner identity, and schema catalog operations.
 */
import { type ClientContext } from './databases.js';
import type { NodeVersion } from './types.js';
/** One schema entry from `GET /api/schemas` or `GET /api/schema/<name>`. */
export interface LoadedSchema {
    name: string;
    identityHash: string | null;
    descriptiveName: string | null;
    ownerAppId: string | null;
    fields: string[];
}
/** Descriptor used to resolve an app-owned loaded schema from `/api/schemas`. */
export interface SchemaDescriptor {
    ownerAppId: string;
    descriptiveName: string;
    fields?: readonly string[];
}
/** `GET /api/system/auto-identity` parsed result. */
export type AutoIdentityResult = {
    provisioned: true;
    userHash: string;
    publicKey: string | null;
    userId: string | null;
} | {
    provisioned: false;
    reason: string;
    next: string | null;
};
/** `POST /api/schemas/declare`. */
export interface DeclareSchemaRequest {
    namespace: string;
    schema: Record<string, unknown>;
    intent?: 'catalog_sync' | 'check';
}
/** The definition the declare response named, keyed later by `schemaName`. */
export interface DeclareSchemaResult {
    schemaName: string;
    definitionId: string;
    identityHash: string | null;
    resolution: string | null;
}
/** Record a declared schema's 64-hex `definition_id` for subsequent mutations. */
export declare function rememberSchemaDefinition(definitionIds: Map<string, string>, schemaName: string, definitionId: string): void;
/** `GET /api/version` — client↔node compatibility handshake. */
export declare function executeVersion(ctx: ClientContext): Promise<NodeVersion>;
/** Verify that the connected node reports `api_version >= required`. */
export declare function executeRequireApiVersion(ctx: ClientContext, required: number, appLabel?: string): Promise<NodeVersion>;
/** `GET /api/system/auto-identity` — resolve the local owner identity. */
export declare function executeAutoIdentity(ctx: ClientContext): Promise<AutoIdentityResult>;
/** `POST /api/schemas/declare` (or database-scoped equivalent). */
export declare function executeDeclareSchema(ctx: ClientContext, request: DeclareSchemaRequest): Promise<DeclareSchemaResult>;
/** `GET /api/schemas` (or database-scoped equivalent). */
export declare function executeListSchemas(ctx: ClientContext): Promise<LoadedSchema[]>;
/** `GET /api/schema/<encoded>` (or database-scoped equivalent). Returns `null` on `404`. */
export declare function executeGetSchema(ctx: ClientContext, schemaName: string): Promise<LoadedSchema | null>;
/** Resolve an app-owned schema descriptor against `listSchemas()`. */
export declare function executeResolveSchema(ctx: ClientContext, descriptor: SchemaDescriptor): Promise<LoadedSchema | null>;
//# sourceMappingURL=schemaOps.d.ts.map