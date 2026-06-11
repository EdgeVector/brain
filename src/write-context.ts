// Capability-aware NodeClient factory for write commands.
//
// `newWriteNodeClient` returns a NodeClient that behaves exactly like
// `newNodeClient` for reads, but transparently:
//   1. acquires a capability (cached → JCS-validated reuse, else consent
//      handshake) on the FIRST mutation, and
//   2. attaches `X-App-Capability` + a fresh `X-Capability-Ts` to every
//      mutation, applying the design's 403-reason contract (discard +
//      re-acquire, retry-once, or surface) around each write.
//
// Write commands (design new / task new / put / link / delete / status update
// / reindex / migrate) use this instead of `newNodeClient` and need no other
// change — the capability lifecycle lives entirely here.
//
// Reads stay on the plain `newNodeClient` (capability provider wired in, but
// reads never call it). Enforcement is per the node's APP_IDENTITY_ENFORCE
// flag; when off, the node ignores the headers and writes land as NodeOwner —
// so attaching them unconditionally is safe.

import {
  newNodeClient,
  type NodeClient,
  type Verbose,
} from "./client.ts";
import { CapabilitySession } from "./capability-session.ts";
import type { Config } from "./config.ts";
import {
  defaultCapabilityStore,
} from "./keychain.ts";
import type { CapabilityStore } from "./capability.ts";

export type WriteNodeClientOptions = {
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  // Override the node's UDS control-socket path for owner-session attestation
  // (app-isolation flip, fold#739). Forwarded verbatim to `newNodeClient`.
  // Unset → the default `${FOLDDB_HOME ?? ~/.folddb}/data/folddb.sock`.
  socketPath?: string;
  // Override the keychain store (tests inject an in-memory / file store).
  store?: CapabilityStore;
  appId?: string;
  scope?: string;
  // Console sink for the first-run consent instruction (default: stderr so it
  // never pollutes stdout the CLI parses).
  print?: (line: string) => void;
  // Tuning hooks (tests).
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  /**
   * Forwarded to the CapabilitySession so the in-write consent path fast-fails
   * in a non-interactive shell instead of polling. Default = real TTY check.
   */
  isTty?: () => boolean;
};

export type WriteNodeClient = {
  /** The capability-aware NodeClient. */
  node: NodeClient;
  /** The underlying session (exposed for tests / advanced callers). */
  session: CapabilitySession;
};

/**
 * Client-side enforcement switch, mirroring the node's `APP_IDENTITY_ENFORCE`.
 * Defaults ON (matching the node, which enforces unless explicitly disabled).
 * Set `FBRAIN_APP_IDENTITY_ENFORCE` to one of false/0/no/off to make fbrain
 * skip consent acquisition and send no capability headers — writes then land
 * as NodeOwner on a node that also has enforcement off (dogfood / local-dev /
 * test stacks). The node is the real enforcement boundary; this is the
 * client-side convenience escape hatch.
 */
export function appIdentityEnforceEnabled(): boolean {
  const raw = process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export function newWriteNodeClient(opts: WriteNodeClientOptions): WriteNodeClient {
  const store = opts.store ?? defaultCapabilityStore();

  // Enforcement off → behave exactly like a plain node client (no consent, no
  // capability headers). The session is still constructed so `.session` stays
  // a valid handle, but its provider returns null so no headers attach and
  // runWrite never acquires.
  if (!appIdentityEnforceEnabled()) {
    const plainOpts: Parameters<typeof newNodeClient>[0] = {
      baseUrl: opts.baseUrl,
      userHash: opts.userHash,
    };
    if (opts.verbose !== undefined) plainOpts.verbose = opts.verbose;
    if (opts.socketPath !== undefined) plainOpts.socketPath = opts.socketPath;
    const plain = newNodeClient(plainOpts);
    const idleSession = new CapabilitySession(buildSessionOpts(opts, store, () => plain));
    return { node: plain, session: idleSession };
  }

  // The base client carries the capability provider; the session owns the
  // current blob and the provider returns it. Reads on `base` ignore it.
  const session: CapabilitySession = new CapabilitySession(buildSessionOpts(opts, store, () => base));
  const baseOpts: Parameters<typeof newNodeClient>[0] = {
    baseUrl: opts.baseUrl,
    userHash: opts.userHash,
    capability: session.provider(),
  };
  if (opts.verbose !== undefined) baseOpts.verbose = opts.verbose;
  if (opts.socketPath !== undefined) baseOpts.socketPath = opts.socketPath;
  const base = newNodeClient(baseOpts);

  // Wrap the three mutation methods so each runs under the capability
  // contract. Everything else delegates straight through.
  const node: NodeClient = {
    ...base,
    async createRecord(args) {
      await session.runWrite(() => base.createRecord(args));
    },
    async updateRecord(args) {
      await session.runWrite(() => base.updateRecord(args));
    },
    async deleteRecord(args) {
      await session.runWrite(() => base.deleteRecord(args));
    },
  };

  return { node, session };
}

// CapabilitySession needs a ConsentTransport, which is built from the base
// node client — but the base client is constructed AFTER the session (so the
// provider can close over the session). `getBase` defers that resolution: the
// transport is only used inside acquire(), long after construction.
function buildSessionOpts(
  opts: WriteNodeClientOptions,
  store: CapabilityStore,
  getBase: () => NodeClient,
): ConstructorParameters<typeof CapabilitySession>[0] {
  const sessionOpts: ConstructorParameters<typeof CapabilitySession>[0] = {
    nodeUrl: opts.baseUrl,
    store,
    transport: {
      requestConsent: (appId, scope) => getBase().requestConsent(appId, scope),
      consentStatus: (requestId) => getBase().consentStatus(requestId),
    },
  };
  if (opts.appId !== undefined) sessionOpts.appId = opts.appId;
  if (opts.scope !== undefined) sessionOpts.scope = opts.scope;
  if (opts.print !== undefined) sessionOpts.print = opts.print;
  if (opts.verbose !== undefined) sessionOpts.verbose = opts.verbose;
  if (opts.pollIntervalMs !== undefined) sessionOpts.pollIntervalMs = opts.pollIntervalMs;
  if (opts.sleep !== undefined) sessionOpts.sleep = opts.sleep;
  if (opts.maxWaitMs !== undefined) sessionOpts.maxWaitMs = opts.maxWaitMs;
  if (opts.isTty !== undefined) sessionOpts.isTty = opts.isTty;
  return sessionOpts;
}

// Thin convenience wrapper: every plain write call site (`status`,
// `reindex`, `<type> new`, `link`, `delete`, `put`, plus migrate's two
// internal phases) was spelling out the same `{ baseUrl: cfg.nodeUrl,
// userHash: cfg.userHash, ...(verbose ? { verbose } : {}) }` literal
// verbatim. Collapse that boilerplate so call sites read as "open a
// write client from this config" in one line. Callers that need to set
// `appId` / `scope` / `store` / consent-poll tuning (`doctor --write`)
// still reach for `newWriteNodeClient` directly.
export function newWriteClientFromCfg(
  cfg: Config,
  verbose?: Verbose,
): WriteNodeClient {
  const opts: WriteNodeClientOptions = {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
  };
  if (verbose !== undefined) opts.verbose = verbose;
  if (cfg.nodeSocketPath !== undefined) opts.socketPath = cfg.nodeSocketPath;
  return newWriteNodeClient(opts);
}
