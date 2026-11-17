/**
 * Keyed read operations: `list`, `get`, `query`, `queryBatch`, and `queryAll`.
 */
import { type ClientContext } from './databases.js';
import type { KeyValue, ListOptions, ListResult, QueryAllOptions, QueryBatchItem, QueryBatchOutcome, QueryFilter, QueryResult, QueryRow, RecordKeyInput } from './types.js';
/** Normalize a point-lookup or blob key input into a non-empty {@link KeyValue}. */
export declare function normalizeRecordKeyInput(key: RecordKeyInput, verb: string): KeyValue;
/** `GET /api/list` — return one page of live primary or alternate keys. */
export declare function executeList(ctx: ClientContext, schemaName: string, opts?: ListOptions): Promise<ListResult>;
/** Point lookup of a single record by primary `HashKey` or `HashRangeKey`. */
export declare function executeGet(ctx: ClientContext, schemaName: string, key: RecordKeyInput): Promise<QueryRow | null>;
/** `POST /api/query` — keyed point, multi-get, or range read under one hash. */
export declare function executeQuery(ctx: ClientContext, schemaName: string, filter?: QueryFilter): Promise<QueryResult>;
/** `POST /api/queries/batch` — read several independent keyed queries in one request. */
export declare function executeQueryBatch(ctx: ClientContext, items: readonly QueryBatchItem[]): Promise<QueryBatchOutcome[]>;
/** Auto-paginate a keyed query across pages until `hasMore` is false or `maxRows` is reached. */
export declare function executeQueryAll(ctx: ClientContext, schemaName: string, filter?: Omit<QueryFilter, 'limit' | 'offset' | 'cursor'>, opts?: QueryAllOptions): Promise<QueryResult>;
//# sourceMappingURL=readOps.d.ts.map