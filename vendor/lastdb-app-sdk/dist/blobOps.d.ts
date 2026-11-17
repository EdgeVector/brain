/**
 * Record file and blob operations (`POST /api/db/put-blob`,
 * `POST /api/db/fetch-blob`, and `POST /api/db/delete-blob`).
 */
import { type ClientContext } from './databases.js';
import type { CreateMutationOp, FileMarker, FilePlacement, MutationResult, RecordKeyInput, ReplaceMutationOp } from './types.js';
/** Mutations eligible for `putBlob` (`create` or complete `replace`). */
export type PutBlobMutationOp = CreateMutationOp | ReplaceMutationOp;
/** Optional inline thumbnail attached alongside a `blob` placement in `putBlob`. */
export interface BlobThumbnailInput {
    bytes: Uint8Array | ArrayBuffer;
    name?: string;
    mediaType?: string;
}
/** Upload raw in-memory bytes for a record's blob or inline file (`POST /api/db/put-blob`). */
export interface PutBlobBytesRequest {
    op: PutBlobMutationOp;
    bytes: Uint8Array | ArrayBuffer;
    localPath?: never;
    name?: string;
    mediaType?: string;
    placement?: FilePlacement;
    thumbnail?: BlobThumbnailInput;
    timeoutMs?: number;
}
/** Reference an existing local file path on an owner node (`POST /api/db/put-blob`). */
export interface PutBlobLocalPathRequest {
    op: PutBlobMutationOp;
    localPath: string;
    bytes?: never;
    name?: string;
    mediaType?: string;
    placement?: 'blob';
    thumbnail?: BlobThumbnailInput;
    timeoutMs?: number;
}
/** Request payload for `LastDbClient.putBlob`. */
export type PutBlobRequest = PutBlobBytesRequest | PutBlobLocalPathRequest;
/** Receipt returned by `POST /api/db/put-blob`. */
export interface PutBlobResult {
    file: FileMarker;
    placement: FilePlacement;
    thumbnail: FileMarker | null;
    mutationId: string;
    recordRevision: string;
    local: boolean;
}
/** Options for `LastDbClient.fetchBlob` (`POST /api/db/fetch-blob`). */
export interface FetchBlobOptions {
    /** Require the record to match this 64-hex revision token when reading. */
    expectedRevision?: string;
    /** Which attached file to read (`'blob'` default, or `'inline'`). */
    placement?: FilePlacement;
    /** Request the JSON envelope so `name` and `mediaType` are populated alongside `bytes`. */
    includeMetadata?: boolean;
    /** Optional per-request timeout override in milliseconds. */
    timeoutMs?: number;
}
/** Plaintext bytes and verified digest returned by `LastDbClient.fetchBlob`. */
export interface FetchedBlob {
    bytes: Uint8Array;
    sha256: string;
    sizeBytes: number;
    name?: string;
    mediaType?: string;
}
/** Options for `LastDbClient.deleteBlob` (`POST /api/db/delete-blob`). */
export interface DeleteBlobOptions {
    /** Which attached file to clear (`'blob'` default, or `'inline'`). */
    placement?: FilePlacement;
    /** Optional per-request timeout override in milliseconds. */
    timeoutMs?: number;
}
/** `POST /api/db/put-blob` — create or replace a record with a blob, inline, or local-path file. */
export declare function executePutBlob(ctx: ClientContext, schemaName: string, request: PutBlobRequest): Promise<PutBlobResult>;
/** `POST /api/db/fetch-blob` — fetch a record's blob or inline file bytes. */
export declare function executeFetchBlob(ctx: ClientContext, schemaName: string, key: RecordKeyInput, options?: FetchBlobOptions): Promise<FetchedBlob>;
/** `POST /api/db/delete-blob` — clear a record's blob or inline file via complete replacement. */
export declare function executeDeleteBlob(ctx: ClientContext, schemaName: string, op: ReplaceMutationOp, options?: DeleteBlobOptions): Promise<MutationResult>;
//# sourceMappingURL=blobOps.d.ts.map