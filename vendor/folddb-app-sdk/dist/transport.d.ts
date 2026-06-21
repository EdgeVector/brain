/**
 * HTTP transport over either a TCP base URL or a Unix-domain socket.
 *
 * Both transports speak the same HTTP/1.1 dialect the node serves on its TCP
 * listener and its control socket (`fold_dev_node` binds both; production
 * `fold_db_node` serves the control-socket route table over its UDS). Node's
 * built-in `http` client handles UDS natively via the `socketPath` request
 * option, so one implementation covers both — the only difference is whether
 * we pass `host`/`port` or `socketPath`.
 */
/** A parsed HTTP response: status + the parsed JSON body (or `null`). */
export interface RawResponse {
    status: number;
    body: unknown;
}
/**
 * The transport contract the client depends on. Tests inject a mock
 * implementation to exercise the error taxonomy without a live node.
 */
export interface Transport {
    /** A short description of where this transport points (for diagnostics). */
    readonly target: string;
    /** Perform one request and return the parsed response. */
    send(method: 'GET' | 'POST', path: string, options?: {
        headers?: Record<string, string>;
        body?: unknown;
    }): Promise<RawResponse>;
}
/**
 * Build a {@link Transport} for a TCP base URL (e.g.
 * `http://127.0.0.1:9101`). Throws on a non-http(s) URL. `defaultHeaders` are
 * attached to every request this transport sends (under a per-call header of
 * the same name, which wins) — used to carry a node-required identity header
 * such as `X-User-Hash` that the production `fold_db_node` reads to resolve the
 * caller (its HTTP server is stateless: identity comes from the header).
 */
export declare function httpTransport(baseUrl: string, defaultHeaders?: Record<string, string>): Transport;
/**
 * Build a {@link Transport} that speaks HTTP over a Unix-domain socket. See
 * {@link httpTransport} for the `defaultHeaders` contract.
 */
export declare function udsTransport(socketPath: string, defaultHeaders?: Record<string, string>): Transport;
//# sourceMappingURL=transport.d.ts.map