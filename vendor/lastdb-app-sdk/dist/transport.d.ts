/**
 * HTTP transport over either a TCP base URL or a Unix-domain socket.
 *
 * Both transports speak the same HTTP/1.1 dialect the node serves on its TCP
 * listener and its control socket (`fold_db_node::dev_mode` binds both; production
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
/**
 * Discover which transport an app should use against a local node. Mirrors the
 * Rust `FoldDbHttpClient` discovery (CLI + MCP) so a TypeScript app and the
 * Rust client agree on where the socket lives, and additionally accepts the
 * brand-forward `LASTDB_SOCKET_PATH` override ahead of the Rust client's
 * `FOLDDB_SOCKET_PATH` (both resolve to the same socket when only one is set).
 *
 * Order (highest priority first):
 * 1. `LASTDB_SOCKET_PATH` — canonical explicit socket-path override
 *    (brand-forward; SDK-preferred).
 * 2. `FOLDDB_SOCKET_PATH` — legacy socket-path alias (the current Rust client's
 *    canonical override), still honored.
 * 3. `FOLDDB_SOCK` — deprecated socket-path alias, still honored.
 * 4. `<data_dir>/folddb.sock` — the default the node binds, resolved via
 *    {@link resolveSocketPath} (honors the `LASTDB_HOME`/`FOLDDB_HOME` →
 *    `~/.lastdb`/`~/.folddb` home order).
 * 5. Loopback TCP at `fallbackBaseUrl` — the fallback when no socket exists.
 *
 * A socket path is only chosen when the file actually EXISTS, so a node that
 * binds no socket (a pre-data-plane node, or one whose bind failed)
 * transparently falls back to TCP. `defaultHeaders` are attached to whichever
 * transport is built (see {@link httpTransport}); a UDS caller does not need
 * the `X-User-Hash` identity header — the socket carries kernel peer
 * credentials — but passing it is harmless.
 *
 * On a non-Unix platform there is no UDS transport, so this always returns the
 * TCP transport (matching the Rust `#[cfg(not(unix))]` discovery).
 */
export declare function discoverTransport(options: {
    fallbackBaseUrl: string;
    defaultHeaders?: Record<string, string>;
    /** Override the environment read for discovery (defaults to `process.env`). */
    env?: NodeJS.ProcessEnv;
}): Transport;
//# sourceMappingURL=transport.d.ts.map