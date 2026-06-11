// CapabilitySession — the glue that turns the low-level capability primitives
// (keychain store + consent acquisition + 403 reaction table) into a single
// object a write command uses.
//
// Lifecycle:
//   1. `ensureCapability()` — load a cached, valid capability for this node,
//      or run the consent handshake (request-consent → poll → store).
//   2. The session exposes `provider()` (a CapabilityProvider) wired into
//      newNodeClient, so every mutation attaches the current blob.
//   3. `runWrite(fn)` wraps a write closure and applies the design's 403
//      contract — discard + re-acquire, retry-once, or surface — transparently.
//
// fbrain remains a token carrier: the session never signs. It verifies a
// cached token's JCS integrity binding (the "or invalid" branch) before reuse,
// and on a wrong-node 403 discards the per-node-keyed cache and re-acquires.

import {
  FBRAIN_APP_ID,
  acquireCapability,
  isCapability403Reason,
  reactionFor,
  verifyCapabilityBlob,
  type CapabilityStore,
  type ConsentTransport,
  type StoredCapability,
} from "./capability.ts";
import { FbrainError, type CapabilityProvider, type NodeClient, type Verbose } from "./client.ts";

export type CapabilitySessionOptions = {
  nodeUrl: string;
  store: CapabilityStore;
  transport: ConsentTransport;
  appId?: string;
  scope?: string;
  print?: (line: string) => void;
  verbose?: Verbose;
  // Tuning hooks (mainly for tests).
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  /**
   * Forwarded to acquireCapability so the in-write consent path fast-fails
   * in a non-interactive shell instead of polling. Default = real TTY check.
   */
  isTty?: () => boolean;
};

export class CapabilitySession {
  private blob: string | null = null;
  private readonly opts: CapabilitySessionOptions;
  private readonly appId: string;

  constructor(opts: CapabilitySessionOptions) {
    this.opts = opts;
    this.appId = opts.appId ?? FBRAIN_APP_ID;
  }

  /** A provider for newNodeClient — always returns the session's current blob. */
  provider(): CapabilityProvider {
    return () => this.blob;
  }

  /** The current capability blob, or null if none acquired yet. */
  current(): string | null {
    return this.blob;
  }

  /**
   * Ensure the session holds a valid capability for this node. Uses a cached
   * one when present + JCS-integrity-valid + bound to this node; otherwise runs
   * the consent handshake. Idempotent — a second call with a live blob is a
   * no-op.
   */
  async ensureCapability(): Promise<void> {
    if (this.blob !== null) return;
    const cached = await this.loadValidCached();
    if (cached !== null) {
      this.blob = cached.blob;
      return;
    }
    await this.acquire();
  }

  // Load the cached capability and validate it. Returns null (discarding the
  // cache) if it's absent, structurally broken, bound to a different app, or
  // fails the JCS integrity check. The validation is the SDK's
  // `verifyCapabilityBlob` — decode + audience binding + the integrity
  // binding (payload_hash == sha256(JCS(token-minus-envelope))) — so a
  // tampered/truncated cache is discarded before we replay a doomed token.
  private async loadValidCached(): Promise<StoredCapability | null> {
    const cached = await this.opts.store.load(this.opts.nodeUrl);
    if (cached === null) return null;
    if (!verifyCapabilityBlob(cached.blob, this.appId).ok) {
      await this.opts.store.clear(this.opts.nodeUrl);
      return null;
    }
    return cached;
  }

  // Run the consent handshake and adopt the granted blob.
  private async acquire(): Promise<void> {
    const acquireOpts: Parameters<typeof acquireCapability>[0] = {
      appId: this.appId,
      nodeUrl: this.opts.nodeUrl,
      transport: this.opts.transport,
      store: this.opts.store,
    };
    if (this.opts.scope !== undefined) acquireOpts.scope = this.opts.scope;
    if (this.opts.print !== undefined) acquireOpts.print = this.opts.print;
    if (this.opts.verbose !== undefined) acquireOpts.verbose = this.opts.verbose;
    if (this.opts.pollIntervalMs !== undefined) acquireOpts.pollIntervalMs = this.opts.pollIntervalMs;
    if (this.opts.sleep !== undefined) acquireOpts.sleep = this.opts.sleep;
    if (this.opts.maxWaitMs !== undefined) acquireOpts.maxWaitMs = this.opts.maxWaitMs;
    if (this.opts.isTty !== undefined) acquireOpts.isTty = this.opts.isTty;
    const stored = await acquireCapability(acquireOpts);
    this.blob = stored.blob;
  }

  /**
   * Run a write closure under the capability contract. The closure receives
   * nothing — it should perform the write through a NodeClient built with
   * `this.provider()`. On a discriminated capability 403, applies the design's
   * reaction:
   *   - discard + re-acquire → clear cache, re-run consent, retry the write
   *   - retry once          → retry the write (a fresh `X-Capability-Ts` is
   *                           generated automatically by the mutation path)
   *   - surface             → rethrow with the contract message
   *
   * Re-acquire and retry-once each happen AT MOST once to avoid an infinite
   * loop against a node that keeps rejecting.
   */
  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureCapability();
    let reacquired = false;
    let retried = false;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const reason = capabilityReasonOf(err);
        if (reason === null) throw err; // not a capability 403 — propagate
        const reaction = reactionFor(
          reason,
          err instanceof FbrainError ? toReactionDetail(err.capabilityDetail) : undefined,
        );

        if (reaction.discardToken) {
          this.blob = null;
          await this.opts.store.clear(this.opts.nodeUrl);
        }

        if (reaction.reacquire && !reacquired) {
          reacquired = true;
          await this.acquire();
          continue;
        }
        if (reaction.retryOnce && !retried) {
          retried = true;
          continue;
        }

        // Surface (or exhausted re-acquire/retry budget): rethrow a clear error.
        throw new FbrainError({
          code: `capability_${reason}`,
          message: reaction.surface ?? `fbrain write rejected: ${reason}.`,
          capabilityReason: reason,
          ...(err instanceof FbrainError && err.capabilityDetail
            ? { capabilityDetail: err.capabilityDetail }
            : {}),
        });
      }
    }
  }
}

/** Build a ConsentTransport from a NodeClient's consent methods. */
export function consentTransportFromNode(node: NodeClient): ConsentTransport {
  return {
    requestConsent: (appId, scope) => node.requestConsent(appId, scope),
    consentStatus: (requestId) => node.consentStatus(requestId),
  };
}

function capabilityReasonOf(err: unknown): ReturnType<typeof reasonOrNull> {
  return reasonOrNull(err);
}

function reasonOrNull(err: unknown) {
  if (err instanceof FbrainError && err.capabilityReason !== undefined) {
    return isCapability403Reason(err.capabilityReason) ? err.capabilityReason : null;
  }
  return null;
}

function toReactionDetail(
  d: FbrainError["capabilityDetail"],
): { schema?: string; capabilityId?: string; timestampSkewSecs?: number } | undefined {
  if (!d) return undefined;
  const out: { schema?: string; capabilityId?: string; timestampSkewSecs?: number } = {};
  if (d.schema !== undefined) out.schema = d.schema;
  if (d.capabilityId !== undefined) out.capabilityId = d.capabilityId;
  if (d.timestampSkewSecs !== undefined) out.timestampSkewSecs = d.timestampSkewSecs;
  return out;
}
