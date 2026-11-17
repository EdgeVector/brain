/**
 * HTTP/1.1 JSON and binary transport over the node's Unix-domain socket.
 *
 * `lastdbd` serves its route table (`lastdb_uds::uds_router::route`) on
 * `folddb.sock`. Node's built-in `http` client reaches that socket through
 * the `socketPath` request option.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TransportError } from './errors.js';
const SOCKET_FILE_NAME = 'folddb.sock';
const LASTDB_SOCKET_PATH_ENV = 'LASTDB_SOCKET_PATH';
const FOLDDB_SOCKET_PATH_ENV = 'FOLDDB_SOCKET_PATH';
/**
 * Per-request correlation-ID header read by the node's request-ops telemetry.
 * Minted fresh per request unless supplied per-call or via `defaultHeaders`.
 */
export const REQUEST_ID_HEADER = 'x-lastdb-request-id';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Build a {@link Transport} that speaks HTTP over a Unix-domain socket. */
export function udsTransport(socketPath, defaultHeaders = {}, options = {}) {
    return new NodeHttpTransport(socketPath, `unix:${socketPath}`, defaultHeaders, options);
}
function expandTilde(p) {
    if (p === '~')
        return homedir();
    if (p.startsWith('~/'))
        return join(homedir(), p.slice(2));
    return p;
}
function resolveSocketPath(env) {
    const lastdbExplicit = env[LASTDB_SOCKET_PATH_ENV];
    if (lastdbExplicit && lastdbExplicit.length > 0) {
        return expandTilde(lastdbExplicit);
    }
    const explicit = env[FOLDDB_SOCKET_PATH_ENV];
    if (explicit && explicit.length > 0) {
        return expandTilde(explicit);
    }
    const lastdbHome = env.LASTDB_HOME;
    const home = lastdbHome && lastdbHome.length > 0
        ? expandTilde(lastdbHome)
        : homedir()
            ? join(homedir(), '.lastdb')
            : null;
    return home === null ? null : join(home, 'data', SOCKET_FILE_NAME);
}
/**
 * Open the discovered data-plane socket (`LASTDB_SOCKET_PATH`, then
 * `FOLDDB_SOCKET_PATH`, then `<LASTDB_HOME or ~/.lastdb>/data/folddb.sock`).
 */
export function openDiscoveredSocket(options) {
    const { defaultHeaders = {}, timeoutMs } = options;
    const resolved = resolveSocketPath(options.env ?? process.env);
    if (resolved === null || !existsSync(resolved)) {
        throw new TransportError(`no LastDB socket at ${resolved ?? '(unresolved path)'}; set LASTDB_SOCKET_PATH or pass socketPath`, 'connect');
    }
    return udsTransport(resolved, defaultHeaders, { timeoutMs });
}
/** Case-insensitively merge request header layers (later layers override earlier ones). */
function mergeHeaders(...layers) {
    const merged = {};
    const keyByLower = new Map();
    for (const layer of layers) {
        if (!layer)
            continue;
        for (const [key, value] of Object.entries(layer)) {
            const lower = key.toLowerCase();
            const prior = keyByLower.get(lower);
            if (prior !== undefined && prior !== key) {
                delete merged[prior];
            }
            keyByLower.set(lower, key);
            merged[key] = value;
        }
    }
    return merged;
}
/** Wrap an existing {@link Transport} with additional default headers (per-call headers still win). */
export function withDefaultHeaders(transport, extraHeaders) {
    if (Object.keys(extraHeaders).length === 0) {
        return transport;
    }
    const wrapped = {
        target: transport.target,
        supportsBinaryBody: transport.supportsBinaryBody,
        send(method, path, options = {}) {
            return transport.send(method, path, {
                ...options,
                headers: mergeHeaders(extraHeaders, options.headers),
            });
        },
    };
    if (transport.sendBinary !== undefined) {
        const sendBinary = transport.sendBinary.bind(transport);
        wrapped.sendBinary = (method, path, options = {}) => sendBinary(method, path, {
            ...options,
            headers: mergeHeaders(extraHeaders, options.headers),
        });
    }
    return wrapped;
}
function hasHeader(headers, lowerName) {
    return Object.keys(headers).some((k) => k.toLowerCase() === lowerName);
}
function normalizeResponseHeaders(raw) {
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') {
            out[key.toLowerCase()] = value;
        }
        else if (Array.isArray(value)) {
            out[key.toLowerCase()] = value.join(', ');
        }
    }
    return out;
}
function parseLooseErrorBody(buf) {
    if (buf.byteLength === 0)
        return null;
    const text = buf.toString('utf8');
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
class NodeHttpTransport {
    socketPath;
    target;
    defaultHeaders;
    supportsBinaryBody = true;
    timeoutMs;
    constructor(socketPath, target, defaultHeaders = {}, options = {}) {
        this.socketPath = socketPath;
        this.target = target;
        this.defaultHeaders = defaultHeaders;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
            throw new TransportError(`transport timeoutMs must be a positive finite number, got ${String(options.timeoutMs)}`, 'protocol');
        }
    }
    async send(method, path, options = {}) {
        const { status, buf } = await this.execute(method, path, 'application/json', options);
        if (buf.byteLength === 0)
            return { status, body: null };
        const text = buf.toString('utf8');
        try {
            return { status, body: JSON.parse(text) };
        }
        catch {
            if (status >= 200 && status < 300) {
                throw new TransportError(`non-JSON response (${status}) from ${this.target}${path}: ${text.slice(0, 200)}`, 'protocol', { status });
            }
            return { status, body: text };
        }
    }
    async sendBinary(method, path, options = {}) {
        const { status, headers, buf } = await this.execute(method, path, 'application/octet-stream', options);
        if (status >= 200 && status < 300) {
            return {
                status,
                headers,
                bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
                errorBody: null,
            };
        }
        return { status, headers, bytes: new Uint8Array(0), errorBody: parseLooseErrorBody(buf) };
    }
    execute(method, path, defaultAccept, options) {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return Promise.reject(new TransportError(`request timeoutMs must be a positive finite number, got ${String(timeoutMs)}`, 'protocol'));
        }
        const headers = mergeHeaders({ accept: defaultAccept }, this.defaultHeaders, options.headers);
        if (!hasHeader(headers, REQUEST_ID_HEADER)) {
            headers[REQUEST_ID_HEADER] = randomUUID();
        }
        const payload = encodeRequestBody(options.body, headers);
        return new Promise((resolve, reject) => {
            const req = httpRequest({ socketPath: this.socketPath, method, path, headers, timeout: timeoutMs }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: normalizeResponseHeaders(res.headers),
                        buf: Buffer.concat(chunks),
                    });
                });
            });
            req.on('timeout', () => {
                req.destroy(new TransportError(`request to ${this.target}${path} timed out after ${timeoutMs}ms`, 'timeout'));
            });
            req.on('error', (err) => {
                reject(err instanceof TransportError
                    ? err
                    : new TransportError(`request to ${this.target}${path} failed: ${err.message}`, 'connect'));
            });
            if (payload !== undefined)
                req.write(payload);
            req.end();
        });
    }
}
function encodeRequestBody(body, headers) {
    if (body === undefined)
        return undefined;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        const buf = body instanceof Uint8Array
            ? Buffer.isBuffer(body)
                ? body
                : Buffer.from(body.buffer, body.byteOffset, body.byteLength)
            : Buffer.from(body);
        if (!hasHeader(headers, 'content-type'))
            headers['content-type'] = 'application/octet-stream';
        headers['content-length'] = String(buf.byteLength);
        return buf;
    }
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    if (!hasHeader(headers, 'content-type'))
        headers['content-type'] = 'application/json';
    headers['content-length'] = String(buf.byteLength);
    return buf;
}
//# sourceMappingURL=transport.js.map