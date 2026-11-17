/**
 * App API: `POST /v1/read`, `POST /v1/write`, and `POST /v1/x/changes`.
 * A non-200 reply throws {@link AppApiError}. A failed read in a list is a result.
 */
import type { ClientContext } from './databases.js';
import { LastDbError } from './errors.js';
import type { KeyValue, RowFields } from './types.js';
/** A non-200 app API reply. `code` is the body's `error.code`. `message` is `Error.message`. */
export declare class AppApiError extends LastDbError {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** A range under one hash: the whole hash, a prefix, or `start` up to `end`. */
export interface AppApiRange {
    hash: string;
    prefix?: string;
    start?: string;
    end?: string;
}
interface AppApiReadBase {
    schema: string;
    database?: string;
    via?: string;
    limit?: number;
    cursor?: string;
    keys_only?: boolean;
    file?: boolean;
}
/** One item of `POST /v1/read`. Names `schema` and exactly one of `key` or `range`. */
export type AppApiRead = (AppApiReadBase & {
    key: KeyValue;
    range?: never;
}) | (AppApiReadBase & {
    range: AppApiRange;
    key?: never;
});
/** File facts on a read record. `path` is set only when the read set `file: true`. */
export interface AppApiFile {
    name: string | null;
    media_type: string | null;
    size: number;
    path?: string | null;
}
export interface AppApiRecord {
    key: KeyValue;
    revision: string;
    record: RowFields;
    file: AppApiFile | null;
}
/** One read that failed. Returned in order. Not thrown. */
export interface AppApiReadError {
    error: {
        code: string;
        message: string;
    };
}
/** One entry of the `results` array from `POST /v1/read`. */
export type AppApiReadResult = {
    records: AppApiRecord[];
    next_cursor: string | null;
} | {
    keys: KeyValue[];
    next_cursor: string | null;
} | AppApiReadError;
/** A path the caller can read. No file bytes go through the app API. */
export interface AppApiFileLink {
    path: string;
    name?: string;
    media_type?: string;
}
interface AppApiMutationBase {
    schema: string;
    database?: string;
    key: KeyValue;
}
export type AppApiCreate = AppApiMutationBase & {
    op: 'create';
    record: RowFields;
    alternates?: Record<string, KeyValue | null>;
    file?: AppApiFileLink;
};
export type AppApiReplace = AppApiMutationBase & {
    op: 'replace';
    revision: string;
    record: RowFields;
    alternates?: Record<string, KeyValue | null>;
    file?: AppApiFileLink;
};
export type AppApiDelete = AppApiMutationBase & {
    op: 'delete';
    revision: string;
};
/** One item of `POST /v1/write`. */
export type AppApiMutation = AppApiCreate | AppApiReplace | AppApiDelete;
/** Receipt from `POST /v1/write`, after the write is on disk. `revisions` follows request order. */
export interface AppApiWriteResult {
    written: number;
    revisions: string[];
}
/** Body of `POST /v1/x/changes`. `after` defaults to the oldest kept entry. `limit` 0 reads `head` only. */
export interface AppApiChangesOptions {
    after?: number;
    limit?: number;
    schemas?: readonly string[];
    database?: string;
}
export interface AppApiChange {
    seq: number;
    schema: string;
    key: KeyValue;
    deleted: boolean;
}
/** Page from `POST /v1/x/changes`. Save `through`. Rebuild when `id` changes or `gap` is true. */
export interface AppApiChangesResult {
    id: string;
    head: number;
    through: number;
    gap: boolean;
    changes: AppApiChange[];
}
export declare function executeAppRead(ctx: ClientContext, reads: readonly AppApiRead[]): Promise<AppApiReadResult[]>;
export declare function executeAppWrite(ctx: ClientContext, mutations: readonly AppApiMutation[]): Promise<AppApiWriteResult>;
export declare function executeAppChanges(ctx: ClientContext, options: AppApiChangesOptions): Promise<AppApiChangesResult>;
export {};
//# sourceMappingURL=appApi.d.ts.map