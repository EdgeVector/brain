/**
 * `ownerClient` — the ergonomic entry point for OWNER / HOST-context apps.
 *
 * Some apps (fbrain, fsituations, and other first-party host tools) run in the
 * node OWNER's own context: they authenticate with an `X-User-Hash` identity
 * header only, never go through the consent/capability flow, and resolve their
 * OWN socket path from their config. For them the async {@link connect} does not
 * fit:
 *
 * - `connect` is async and auto-loads a stored capability from the default OS
 *   keychain — an owner-context app wants neither (no keychain touch, no async
 *   consent load);
 * - `ConnectOptions` accepts EITHER `baseUrl` OR `socketPath`, never a
 *   caller-resolved explicit socket path ALONGSIDE a loopback-gated `baseUrl`
 *   TCP fallback;
 * - `connect`'s `discoverSocket` reads only env + the default data-dir; it
 *   ignores an app-supplied config socket path.
 *
 * So today every owner-context app hand-builds the transport (`udsTransport` /
 * `httpTransport`) and calls the 6-arg `new LastDbClient(...)` positional
 * constructor with a no-op capability store. `ownerClient` collapses that
 * boilerplate into one synchronous, keychain-free factory.
 */
import { LastDbClient } from './client.js';
/** Options for {@link ownerClient}. */
export interface OwnerClientOptions {
    /** Canonical app id this client acts as (e.g. `"fbrain"`). */
    appId: string;
    /**
     * Loopback TCP base URL of the node (e.g. `http://127.0.0.1:9101`), used as
     * the fallback when no socket is available. Optional only when a
     * `socketPath` that exists is supplied — otherwise there is nothing to talk
     * to and the factory throws.
     */
    baseUrl?: string;
    /**
     * A caller-resolved explicit control-socket path (e.g. from the app's
     * `nodeSocketPath` config or a `FOLDDB_SOCKET_PATH` env read). Preferred over
     * `baseUrl` when the file exists AND `baseUrl` is loopback (or absent) — the
     * loopback gate: a socket is only substituted for a LOCAL TCP target, never
     * a remote one. A non-existent path transparently falls back to TCP.
     */
    socketPath?: string;
    /**
     * When `true`, and no explicit `socketPath` resolved, discover the node's
     * data-plane socket from the environment + default data dir (the same
     * `LASTDB_SOCKET_PATH` → `FOLDDB_SOCKET_PATH` → `FOLDDB_SOCK` →
     * `<data_dir>/folddb.sock` order {@link connect} uses), falling back to
     * `baseUrl`'s TCP listener when none exists. Still loopback-gated: discovery
     * only runs when `baseUrl` is loopback (or absent). Default `false` — an
     * owner-context app that resolves its own path leaves this off. Ignored when
     * an explicit `socketPath` is used.
     */
    discoverSocket?: boolean;
    /**
     * Headers attached to EVERY request this client sends. The production node's
     * HTTP server is stateless and resolves the calling user from an
     * `X-User-Hash` header on every request, so an owner-context app passes
     * `{ 'X-User-Hash': '<hash>' }` here. A UDS caller does not strictly need it
     * (the socket carries kernel peer credentials), but passing it is harmless.
     */
    defaultHeaders?: Record<string, string>;
    /**
     * Per-request transport timeout in milliseconds. Defaults to 30_000 so a
     * wedged node cannot leave app requests pending forever.
     */
    timeoutMs?: number;
}
/**
 * Build a capability-less {@link LastDbClient} for an OWNER / HOST-context app.
 *
 * Synchronous and keychain-free: it resolves the transport (an explicit socket
 * path with a loopback-gated TCP fallback — see {@link resolveOwnerTransport}),
 * wires a no-op capability store, and returns a ready client. There is no async
 * consent load and no OS-keychain access — an owner-context app authenticates
 * via its `defaultHeaders` (`X-User-Hash`) and never carries a capability.
 *
 * Use {@link connect} instead for consent/capability apps (async, auto-loads a
 * stored capability, drives the request-consent flow).
 *
 * @example
 * ```ts
 * const client = ownerClient({
 *   appId: 'fsituations',
 *   baseUrl: 'http://127.0.0.1:9101',
 *   socketPath: '/Users/me/.folddb/data/folddb.sock',
 *   defaultHeaders: { 'X-User-Hash': userHash },
 * });
 * const rows = await client.queryAll('MySchema', { fields: ['a', 'b'] });
 * ```
 */
export declare function ownerClient(options: OwnerClientOptions): LastDbClient;
//# sourceMappingURL=ownerClient.d.ts.map