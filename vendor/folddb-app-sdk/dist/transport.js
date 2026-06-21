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
import { request as httpRequest } from 'node:http';
import { TransportError } from './errors.js';
/**
 * Build a {@link Transport} for a TCP base URL (e.g.
 * `http://127.0.0.1:9101`). Throws on a non-http(s) URL. `defaultHeaders` are
 * attached to every request this transport sends (under a per-call header of
 * the same name, which wins) — used to carry a node-required identity header
 * such as `X-User-Hash` that the production `fold_db_node` reads to resolve the
 * caller (its HTTP server is stateless: identity comes from the header).
 */
export function httpTransport(baseUrl, defaultHeaders = {}) {
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
    return new NodeHttpTransport(target, baseUrl, defaultHeaders);
}
/**
 * Build a {@link Transport} that speaks HTTP over a Unix-domain socket. See
 * {@link httpTransport} for the `defaultHeaders` contract.
 */
export function udsTransport(socketPath, defaultHeaders = {}) {
    return new NodeHttpTransport({ kind: 'uds', socketPath }, `unix:${socketPath}`, defaultHeaders);
}
/** Node `http`-backed transport shared by the TCP and UDS variants. */
class NodeHttpTransport {
    t;
    target;
    defaultHeaders;
    constructor(t, target, defaultHeaders = {}) {
        this.t = t;
        this.target = target;
        this.defaultHeaders = defaultHeaders;
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
            }
            : { socketPath: this.t.socketPath, method, path, headers };
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
            req.on('error', (err) => reject(new TransportError(`request to ${this.target}${path} failed: ${err.message}`)));
            if (payload !== undefined) {
                req.write(payload);
            }
            req.end();
        });
    }
}
//# sourceMappingURL=transport.js.map