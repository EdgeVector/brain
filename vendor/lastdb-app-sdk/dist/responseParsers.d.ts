/** Parsers that validate node query and record response bodies into typed SDK results. */
import { isObject } from './errors.js';
import type { Transport, TransportSendOptions } from './transport.js';
import type { FileMarker, JsonValue, ListResult, QueryResult } from './types.js';
export { isObject };
export declare function isHex64(value: unknown): value is string;
export declare function isNonEmptyString(value: unknown): value is string;
/** Send a JSON request, map non-200 errors, and require a JSON object reply. */
export declare function sendJsonObject(transport: Transport, method: 'GET' | 'POST', path: string, verb: string, appId: string, options?: TransportSendOptions & {
    redactBody?: boolean;
}): Promise<Record<string, JsonValue>>;
export declare function parseListResponse(body: unknown, expectedKeyName?: string): ListResult;
/** Parse a `200` `/api/query` body into a {@link QueryResult}. */
export declare function parseQueryResponse(body: unknown): QueryResult;
export declare function parseFileMarker(file: Record<string, unknown>, what: string, raw: unknown): FileMarker;
//# sourceMappingURL=responseParsers.d.ts.map