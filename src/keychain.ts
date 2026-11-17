// Capability tokens are not used on the LastDB app API. The default store
// keeps nothing on disk, so a restricted app does not write a keychain file.

import { createHash } from "node:crypto";

import type { CapabilityStore, StoredCapability } from "./capability.ts";
import { brainDataDir } from "./config.ts";

/** Directory that used to hold the file store. */
export function brainDir(): string {
  const override = process.env.BRAIN_CAPABILITY_DIR;
  if (override && override.length > 0) return override;
  return brainDataDir();
}

function defaultAppId(): string {
  return "brain";
}

/**
 * A pure in-memory store. The app id replaces capability tokens,
 * so Brain does not persist them.
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

/** The store the data path uses. It does not write outside the process. */
export function defaultCapabilityStore(): CapabilityStore {
  return inMemoryCapabilityStore();
}
