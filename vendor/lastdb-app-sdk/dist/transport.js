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
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TransportError } from './errors.js';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Build a {@link Transport} for a TCP base URL (e.g.
 * `http://127.0.0.1:9101`). Throws on a non-http(s) URL. `defaultHeaders` are
 * attached to every request this transport sends (under a per-call header of
 * the same name, which wins) — used to carry a node-required identity header
 * such as `X-User-Hash` that the production `fold_db_node` reads to resolve the
 * caller (its HTTP server is stateless: identity comes from the header).
 */
export function httpTransport(baseUrl, defaultHeaders = {}, options = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new TransportError(`baseUrl must be http:// or https://, got '${url.protocol}'`);
    }
    const target = {
        kind: 'tcp',
        host: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        protocol: url.protocol,
    };
    return new NodeHttpTransport(target, baseUrl, defaultHeaders, options);
}
/**
 * Build a {@link Transport} that speaks HTTP over a Unix-domain socket. See
 * {@link httpTransport} for the `defaultHeaders` contract.
 */
export function udsTransport(socketPath, defaultHeaders = {}, options = {}) {
    return new NodeHttpTransport({ kind: 'uds', socketPath }, `unix:${socketPath}`, defaultHeaders, options);
}
/** The fixed file name the node binds its data-plane socket under. */
const SOCKET_FILE_NAME = 'folddb.sock';
/** Canonical explicit node-socket override (brand-forward name). */
const LASTDB_SOCKET_PATH_ENV = 'LASTDB_SOCKET_PATH';
/** Legacy alias for {@link LASTDB_SOCKET_PATH_ENV}, still honored. */
const FOLDDB_SOCKET_PATH_ENV = 'FOLDDB_SOCKET_PATH';
/** Deprecated alias for {@link LASTDB_SOCKET_PATH_ENV}. */
const FOLDDB_SOCK_ENV = 'FOLDDB_SOCK';
let warnedLegacySocketEnv = false;
function warnLegacySocketEnv() {
    if (warnedLegacySocketEnv) {
        return;
    }
    warnedLegacySocketEnv = true;
    process.emitWarning(`${FOLDDB_SOCK_ENV} is deprecated; set ${LASTDB_SOCKET_PATH_ENV} for explicit node socket overrides`, 'DeprecationWarning');
}
/**
 * Expand a leading `~` (or `~/...`) against the current user's home directory,
 * mirroring the Rust `expand_tilde` the node uses to resolve env-supplied
 * paths. A non-tilde path is returned unchanged.
 */
function expandTilde(p) {
    if (p === '~') {
        return homedir();
    }
    if (p.startsWith('~/')) {
        return join(homedir(), p.slice(2));
    }
    return p;
}
/**
 * Resolve the node's home directory the same way the Rust `folddb_home()`
 * does, in priority order:
 *
 * 1. `LASTDB_HOME` — the new canonical override.
 * 2. `FOLDDB_HOME` — the legacy override (still honored).
 * 3. an existing `~/.lastdb` — an already-migrated install.
 * 4. an existing `~/.folddb` — an existing install, read in place.
 * 5. `~/.lastdb` — the brand-new-install default.
 *
 * Both env overrides are tilde-expanded, matching the Rust resolver.
 */
function resolveFolddbHome(env) {
    const lastdbHome = env.LASTDB_HOME;
    if (lastdbHome && lastdbHome.length > 0) {
        return expandTilde(lastdbHome);
    }
    const folddbHome = env.FOLDDB_HOME;
    if (folddbHome && folddbHome.length > 0) {
        return expandTilde(folddbHome);
    }
    const home = homedir();
    if (!home) {
        return null;
    }
    const lastdb = join(home, '.lastdb');
    if (existsSync(lastdb)) {
        return lastdb;
    }
    const folddb = join(home, '.folddb');
    if (existsSync(folddb)) {
        return folddb;
    }
    return lastdb;
}
/**
 * Resolve the node's default data-plane socket path, mirroring the Rust
 * client's `resolve_socket_path()` and additionally preferring the
 * brand-forward `LASTDB_SOCKET_PATH`: an explicit `LASTDB_SOCKET_PATH`
 * override (tilde-expanded) wins, then the legacy `FOLDDB_SOCKET_PATH` alias
 * (the Rust client's canonical override), then the deprecated `FOLDDB_SOCK`
 * alias, otherwise `<folddb_home>/data/folddb.sock`.
 * Returns `null` only when neither an env override is set nor a home dir can
 * be resolved.
 */
function resolveSocketPath(env) {
    const lastdbExplicit = env[LASTDB_SOCKET_PATH_ENV];
    if (lastdbExplicit && lastdbExplicit.length > 0) {
        return expandTilde(lastdbExplicit);
    }
    const explicit = env[FOLDDB_SOCKET_PATH_ENV];
    if (explicit && explicit.length > 0) {
        return expandTilde(explicit);
    }
    const legacy = env[FOLDDB_SOCK_ENV];
    if (legacy && legacy.length > 0) {
        warnLegacySocketEnv();
        return expandTilde(legacy);
    }
    const home = resolveFolddbHome(env);
    if (home === null) {
        return null;
    }
    return join(home, 'data', SOCKET_FILE_NAME);
}
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
export function discoverTransport(options) {
    const { fallbackBaseUrl, defaultHeaders = {}, timeoutMs } = options;
    const env = options.env ?? process.env;
    if (process.platform !== 'win32') {
        const resolved = resolveSocketPath(env);
        if (resolved !== null && existsSync(resolved)) {
            return udsTransport(resolved, defaultHeaders, { timeoutMs });
        }
    }
    return httpTransport(fallbackBaseUrl, defaultHeaders, { timeoutMs });
}
/** Node `http`-backed transport shared by the TCP and UDS variants. */
class NodeHttpTransport {
    t;
    target;
    defaultHeaders;
    timeoutMs;
    constructor(t, target, defaultHeaders = {}, options = {}) {
        this.t = t;
        this.target = target;
        this.defaultHeaders = defaultHeaders;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
            throw new TransportError(`transport timeoutMs must be a positive finite number, got ${String(options.timeoutMs)}`);
        }
    }
    send(method, path, options = {}) {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const headers = {
            accept: 'application/json',
            ...this.defaultHeaders,
            ...(options.headers ?? {}),
        };
        if (payload !== undefined) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(Buffer.byteLength(payload));
        }
        const requestOptions = this.t.kind === 'tcp'
            ? {
                host: this.t.host,
                port: this.t.port,
                protocol: this.t.protocol,
                method,
                path,
                headers,
                timeout: this.timeoutMs,
            }
            : {
                socketPath: this.t.socketPath,
                method,
                path,
                headers,
                timeout: this.timeoutMs,
            };
        return new Promise((resolve, reject) => {
            const req = httpRequest(requestOptions, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    const text = Buffer.concat(chunks).toString('utf8');
                    let body = null;
                    if (text.length > 0) {
                        try {
                            body = JSON.parse(text);
                        }
                        catch {
                            // The node always answers JSON on these routes; a non-JSON body
                            // is a transport-level surprise, not a typed protocol error.
                            reject(new TransportError(`non-JSON response (${status}) from ${this.target}${path}: ${text.slice(0, 200)}`));
                            return;
                        }
                    }
                    resolve({ status, body });
                });
            });
            req.on('timeout', () => {
                req.destroy(new TransportError(`request to ${this.target}${path} timed out after ${this.timeoutMs}ms`));
            });
            req.on('error', (err) => {
                if (err instanceof TransportError) {
                    reject(err);
                    return;
                }
                reject(new TransportError(`request to ${this.target}${path} failed: ${err.message}`));
            });
            if (payload !== undefined) {
                req.write(payload);
            }
            req.end();
        });
    }
}
//# sourceMappingURL=transport.js.map