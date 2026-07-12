// File-backed capability store (0600) for app-side capability storage.
//
// Storage is @lastdb/app-sdk's `FileCapabilityStore`: a 0600 file store under
// `~/.brain/capabilities/` (or legacy `~/.fbrain/capabilities/`), keyed `capabilityStoreKey(appId, nodeUrl)` =
// `fbrain@<sha256(nodeUrl)[:16]>` with a `boundNode` envelope, so a capability
// minted by one node is never replayed against another (the SDK's wrong-node
// guard). This module adapts that store to fbrain's `CapabilityStore`
// interface (StoredCapability keyed by node URL) and keeps fbrain's on-disk
// identity: the file fallback lives under the brain data dir (FBRAIN_CAPABILITY_DIR
// honored), at `capabilities/<key>.cap`.

import { createHash } from "node:crypto";
import {
  capabilityStoreKey,
  decodeCapabilityBlob,
  FileCapabilityStore,
  type CapabilityStore as SdkCapabilityStore,
} from "@lastdb/app-sdk";

import type { CapabilityStore, StoredCapability } from "./capability.ts";
import { brainDataDir } from "./config.ts";

/** Directory holding the file store (and the existing config). */
export function fbrainDir(): string {
  const override = process.env.FBRAIN_CAPABILITY_DIR;
  if (override && override.length > 0) return override;
  return brainDataDir();
}

// ---------------------------------------------------------------------------
// Public store
// ---------------------------------------------------------------------------

// The default app id used when load/clear are called without a
// StoredCapability in hand (they only carry a nodeUrl). fbrain is the only
// app today.
function defaultAppId(): string {
  return "fbrain";
}

// Rebuild fbrain's StoredCapability view from an SDK-stored blob. A blob that
// no longer decodes is still surfaced (with empty derived fields) so the
// session's own decode + integrity check decides to discard it — the same
// "corrupt cache is discarded downstream" behavior as before.
function storedFromBlob(appId: string, nodeUrl: string, blob: string): StoredCapability {
  const token = decodeCapabilityBlob(blob);
  return {
    appId,
    nodeUrl,
    nodePubkey: token?.node_pubkey ?? "",
    capabilityId: token?.capability_id ?? "",
    blob,
  };
}

/**
 * Adapt an SDK capability store to fbrain's CapabilityStore interface.
 * Exported for tests (inject any SDK store); production callers use
 * {@link defaultCapabilityStore}.
 */
export function sdkBackedCapabilityStore(
  sdkStore: SdkCapabilityStore,
  appId: string = defaultAppId(),
): CapabilityStore {
  return {
    async load(nodeUrl: string): Promise<StoredCapability | null> {
      const key = capabilityStoreKey(appId, nodeUrl);
      const blob = await sdkStore.load(key, { expectedNode: nodeUrl });
      if (blob !== null) return storedFromBlob(appId, nodeUrl, blob);
      return null;
    },
    async save(cap: StoredCapability): Promise<void> {
      await sdkStore.store(
        capabilityStoreKey(cap.appId, cap.nodeUrl),
        cap.blob,
        cap.nodeUrl,
      );
    },
    async clear(nodeUrl: string): Promise<void> {
      await sdkStore.remove(capabilityStoreKey(appId, nodeUrl));
    },
  };
}

/**
 * Build the default capability store: the SDK's 0600 file store under
 * brain's data directory, adapted to fbrain's interface.
 */
export function defaultCapabilityStore(): CapabilityStore {
  return sdkBackedCapabilityStore(new FileCapabilityStore(fbrainDir()));
}

/**
 * A pure in-memory store — used by unit tests and as an explicit fallback when
 * a caller wants no persistence. Mirrors the CapabilityStore contract exactly.
 */
export function inMemoryCapabilityStore(): CapabilityStore {
  const keyFor = (appId: string, nodeUrl: string): string =>
    createHash("sha256").update(`${appId} ${nodeUrl}`).digest("hex");
  const map = new Map<string, StoredCapability>();
  return {
    async load(nodeUrl) {
      return map.get(keyFor(defaultAppId(), nodeUrl)) ?? null;
    },
    async save(cap) {
      map.set(keyFor(cap.appId, cap.nodeUrl), cap);
    },
    async clear(nodeUrl) {
      map.delete(keyFor(defaultAppId(), nodeUrl));
    },
  };
}
