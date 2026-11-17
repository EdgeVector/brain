/**
 * HTTP/1.1 JSON and binary transport over the node's Unix-domain socket.
 *
 * `lastdbd` serves its route table (`lastdb_uds::uds_router::route`) on
 * `folddb.sock`. Node's built-in `http` client reaches that socket through
 * the `socketPath` request option.
 */
/**
 * Per-request correlation-ID header read by the node's request-ops telemetry.
 * Minted fresh per request unless supplied per-call or via `defaultHeaders`.
 */
export declare const REQUEST_ID_HEADER = "x-lastdb-request-id";
/** A parsed HTTP response: status + the parsed JSON body (or `null`). */
export interface RawResponse {
    status: number;
    body: unknown;
}
/** A binary HTTP response from routes that stream `application/octet-stream`. */
export interface BinaryResponse {
    status: number;
    /** Lowercase response headers. */
    headers: Record<string, string>;
    /** Raw response bytes on 2xx replies; empty on non-2xx replies. */
    bytes: Uint8Array;
    /** Parsed JSON or plain-text error body on non-2xx replies; `null` on 2xx. */
    errorBody: unknown;
}
export interface TransportSendOptions {
    headers?: Record<string, string>;
    body?: unknown;
    /** Override this transport's timeout for one request. */
    timeoutMs?: number;
}
/** The transport contract the client depends on. */
export interface Transport {
    /** A short description of where this transport points (for diagnostics). */
    readonly target: string;
    /** True when `send` accepts raw `Uint8Array` / `ArrayBuffer` bodies directly. */
    readonly supportsBinaryBody?: boolean;
    /** Perform one request and return the parsed JSON response. */
    send(method: 'GET' | 'POST', path: string, options?: TransportSendOptions): Promise<RawResponse>;
    /** Perform one request expecting a binary `application/octet-stream` 2xx body. */
    sendBinary?(method: 'GET' | 'POST', path: string, options?: TransportSendOptions): Promise<BinaryResponse>;
}
/** Per-request options for the Unix-domain socket transport. */
export interface TransportOptions {
    /** Per-request timeout in milliseconds (defaults to 30_000). */
    timeoutMs?: number;
}
/** Build a {@link Transport} that speaks HTTP over a Unix-domain socket. */
export declare function udsTransport(socketPath: string, defaultHeaders?: Record<string, string>, options?: TransportOptions): Transport;
/**
 * Open the discovered data-plane socket (`LASTDB_SOCKET_PATH`, then
 * `FOLDDB_SOCKET_PATH`, then `<LASTDB_HOME or ~/.lastdb>/data/folddb.sock`).
 */
export declare function openDiscoveredSocket(options: {
    defaultHeaders?: Record<string, string>;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): Transport;
/** Wrap an existing {@link Transport} with additional default headers (per-call headers still win). */
export declare function withDefaultHeaders(transport: Transport, extraHeaders: Record<string, string>): Transport;
//# sourceMappingURL=transport.d.ts.map