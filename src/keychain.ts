// OS-keychain-backed capability store with a 0600 file fallback.
//
// The design (decision log, 2026-05-27) mandates the OS keychain for
// app-side capability storage — "leverage OS keychain ACL against
// co-resident exfiltration" — with a file fallback only on headless Linux.
//
// As of the @folddb/app-sdk port, the storage IMPLEMENTATION is the SDK's
// (`KeychainWithFileFallbackStore`: macOS `security` CLI, every call bounded
// by a 5s timeout so a locked-keychain prompt can never wedge fbrain — the
// proven #1 first-write hang — degrading to a 0600 file store on any keychain
// failure). This module adapts the SDK store to fbrain's
// `CapabilityStore` interface (StoredCapability keyed by node URL) and keeps
// fbrain's existing on-disk identity:
//
//   - keychain service stays `com.edgevector.fbrain.capability`
//     (via the SDK store's configurable service label), so entries remain in
//     fbrain's keychain namespace;
//   - the file fallback stays under `~/.fbrain/` (FBRAIN_CAPABILITY_DIR
//     honored), at `capabilities/<key>.cap` in the SDK's envelope format;
//   - SDK entries are keyed `capabilityStoreKey(appId, nodeUrl)` =
//     `fbrain@<sha256(nodeUrl)[:16]>` and carry a `boundNode` envelope, so a
//     capability minted by one node is never replayed against another (the
//     SDK's wrong-node guard, same invariant the old per-node account hash
//     enforced).
//
// MIGRATION (one-shot, lossless): pre-SDK fbrain stored a StoredCapability
// JSON under keychain account `sha256("<appId> <nodeUrl>")` (same service) or
// under that account key in `~/.fbrain/capabilities.json`. On an SDK-store
// load miss, we read those legacy locations; on a hit the entry is re-stored
// under the SDK key and used as-is — an existing install keeps its consent
// grant with no re-prompt. `clear()` removes the legacy entries too, so a
// deliberately-discarded token (e.g. revoked) cannot resurrect via migration.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import {
  capabilityStoreKey,
  decodeCapabilityBlob,
  FileCapabilityStore,
  KeychainWithFileFallbackStore,
  type CapabilityStore as SdkCapabilityStore,
} from "@folddb/app-sdk";

import type { CapabilityStore, StoredCapability } from "./capability.ts";

// Keychain service label — unchanged across the SDK port so existing entries
// stay in fbrain's namespace.
const KEYCHAIN_SERVICE = "com.edgevector.fbrain.capability";

/** Directory holding the file-fallback store (and the existing config). */
export function fbrainDir(): string {
  const override = process.env.FBRAIN_CAPABILITY_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".fbrain");
}

// ---------------------------------------------------------------------------
// Legacy (pre-SDK) entry locations
// ---------------------------------------------------------------------------

function legacyFilePath(): string {
  return join(fbrainDir(), "capabilities.json");
}

// The pre-SDK keychain account / file key: a stable hash of (app_id, node URL).
function legacyAccountFor(appId: string, nodeUrl: string): string {
  return createHash("sha256").update(`${appId} ${nodeUrl}`).digest("hex");
}

// `security` can block INDEFINITELY on a keychain-authorization prompt when
// the login keychain is locked or there is no GUI to answer (SSH, headless,
// CI, agents). Bound every legacy-read call with a hard timeout + SIGKILL —
// a timed-out call is treated as "no legacy entry" rather than a hang.
const SECURITY_TIMEOUT_MS = 5000;

type SecurityResult = {
  /** Process exit status, or null when killed / never started. */
  status: number | null;
  /** Captured stdout (empty unless captureStdout was requested). */
  stdout: string;
  /** True when the call timed out, was killed, or failed to spawn. */
  timedOut: boolean;
};

type SecuritySpawn = (args: string[], captureStdout: boolean) => SecurityResult;

function realSecuritySpawn(args: string[], captureStdout: boolean): SecurityResult {
  const res = spawnSync("security", args, {
    encoding: "utf8",
    timeout: SECURITY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: captureStdout ? ["ignore", "pipe", "ignore"] : "ignore",
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    timedOut: Boolean(res.error) || res.status === null,
  };
}

// Indirection point so tests can inject a fake `security` backend for the
// LEGACY reads without spawning the real CLI. When a runner is injected the
// darwin platform gate is skipped so the legacy keychain path is exercised on
// any OS (CI/Linux).
let securitySpawn: SecuritySpawn = realSecuritySpawn;
let securitySpawnInjected = false;

/** Test-only: override the `security` runner (pass null to restore the real one). */
export function __setSecuritySpawn(fn: SecuritySpawn | null): void {
  securitySpawn = fn ?? realSecuritySpawn;
  securitySpawnInjected = fn != null;
}

function legacyKeychainEnabled(): boolean {
  // An injected test runner always wins, so the legacy-migration path is
  // exercisable on any OS without touching a real keychain.
  if (securitySpawnInjected) return true;
  if (process.env.FBRAIN_FORCE_FILE_KEYCHAIN === "1") return false;
  return platform() === "darwin";
}

// Whether the current security session has a usable default keychain.
//
// This mirrors the SDK's own pre-flight (`MacKeychainStore.ensureKeychainAvailable`,
// see node_modules/@folddb/app-sdk/dist/capabilityStore.js): the SDK probes with
// `security default-keychain`, which on a keychain-less session (SSH / CI /
// headless / under an AI agent) returns a NON-zero status WITHOUT popping the
// blocking "Keychain Not Found" SecurityAgent modal — unlike the
// add-/find-generic-password calls. We reuse that exact, GUI-less signal here so
// the CLI can decide UP FRONT whether to hand the SDK its keychain-first store
// (keychain genuinely available) or a file-only store (the fallback was going to
// happen anyway). Building file-only in the latter case means the SDK never
// probes the keychain a second time and so never emits its one-time
// "macOS keychain unavailable…" warning — which, in a fresh CLI process per
// command, would otherwise print on EVERY write.
//
// The probe is bounded by the same SIGKILL timeout as the legacy reads
// (`securitySpawn` → SECURITY_TIMEOUT_MS), so a wedged `security` can never hang
// the CLI; a timeout is conservatively treated as "unavailable" → file store.
//
// We DELIBERATELY do not blanket-force the file store: when this returns true
// the keychain-first store is used exactly as before (no security downgrade on a
// normal GUI-login Mac).
//
// Exported for tests (assert store selection without a real keychain); production
// callers reach it only through {@link defaultCapabilityStore}.
export function keychainAvailable(): boolean {
  // An explicit override always wins: callers asking for the file store get it.
  if (process.env.FBRAIN_FORCE_FILE_KEYCHAIN === "1") return false;
  // Off macOS the SDK is the file store anyway (no keychain to probe). Skip the
  // probe — except when a test runner is injected, so the available/unavailable
  // branch is exercisable on any OS without a real keychain.
  if (!securitySpawnInjected && platform() !== "darwin") return false;
  const res = securitySpawn(["default-keychain"], false);
  return !res.timedOut && res.status === 0;
}

function parseStored(raw: string): StoredCapability | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as StoredCapability).blob === "string" &&
      typeof (parsed as StoredCapability).appId === "string"
    ) {
      return parsed as StoredCapability;
    }
  } catch {
    // fall through
  }
  return null;
}

type LegacyFileStore = Record<string, StoredCapability>;

function legacyFileReadAll(): LegacyFileStore {
  const path = legacyFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LegacyFileStore;
    }
  } catch {
    // corrupt legacy store → treat as empty.
  }
  return {};
}

function legacyFileWriteAll(store: LegacyFileStore): void {
  const path = legacyFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/** Read a pre-SDK entry: keychain first (bounded), then the legacy file. */
function legacyLoad(appId: string, nodeUrl: string): StoredCapability | null {
  const account = legacyAccountFor(appId, nodeUrl);
  if (legacyKeychainEnabled()) {
    const res = securitySpawn(
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      true,
    );
    if (!res.timedOut && res.status === 0) {
      const raw = res.stdout.trim();
      if (raw.length > 0) {
        const parsed = parseStored(raw);
        if (parsed !== null) return parsed;
      }
    }
  }
  return legacyFileReadAll()[account] ?? null;
}

/** Remove a pre-SDK entry from both legacy locations (idempotent). */
function legacyClear(appId: string, nodeUrl: string): void {
  const account = legacyAccountFor(appId, nodeUrl);
  if (legacyKeychainEnabled()) {
    securitySpawn(
      ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
      false,
    );
  }
  const store = legacyFileReadAll();
  if (account in store) {
    delete store[account];
    legacyFileWriteAll(store);
  }
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
 * Adapt an SDK capability store to fbrain's CapabilityStore interface,
 * including the one-shot legacy migration on load and the legacy-aware clear.
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
      // SDK-store miss → one-shot legacy migration. On a hit, re-store under
      // the SDK key so subsequent loads skip this path entirely.
      const legacy = legacyLoad(appId, nodeUrl);
      if (legacy === null) return null;
      await sdkStore.store(key, legacy.blob, nodeUrl);
      return legacy;
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
      // Also remove any pre-SDK copy, so a deliberately-discarded token
      // (revoked / corrupt) cannot resurrect through the migration read.
      legacyClear(appId, nodeUrl);
    },
  };
}

/**
 * Build the default capability store: the SDK's keychain-with-file-fallback
 * store under fbrain's keychain service + `~/.fbrain/` file directory,
 * adapted to fbrain's interface with legacy migration.
 *
 * Store selection:
 *   - `FBRAIN_FORCE_FILE_KEYCHAIN=1`  → file store outright (explicit override).
 *   - keychain genuinely AVAILABLE     → the keychain-first store, used exactly
 *     as before (macOS Keychain; every call timeout-bounded by the SDK; no
 *     security downgrade on a normal GUI-login Mac).
 *   - keychain genuinely UNAVAILABLE   → the file store directly.
 *
 * The third case is the fix for the keychain-less session (SSH / CI / headless /
 * under an AI agent): the SDK's keychain-first store would itself fall back to
 * the file store there, but only AFTER probing the keychain and printing its
 * one-time `[folddb-app-sdk] macOS keychain unavailable…` warning. Because each
 * CLI invocation is a fresh process, that "one-time" note prints on EVERY write
 * command. By detecting the unavailable session up front (with the SDK's own
 * GUI-less, timeout-bounded `security default-keychain` signal — see
 * {@link keychainAvailable}) and constructing the file store directly, we reach
 * the exact same destination the SDK would have — the 0600 file store — but
 * QUIETLY, and only when the fallback was going to happen anyway.
 */
export function defaultCapabilityStore(): CapabilityStore {
  const sdkStore: SdkCapabilityStore = keychainAvailable()
    ? new KeychainWithFileFallbackStore(fbrainDir(), KEYCHAIN_SERVICE)
    : new FileCapabilityStore(fbrainDir());
  return sdkBackedCapabilityStore(sdkStore);
}

/**
 * A pure in-memory store — used by unit tests and as an explicit fallback when
 * a caller wants no persistence. Mirrors the CapabilityStore contract exactly.
 */
export function inMemoryCapabilityStore(): CapabilityStore {
  const map = new Map<string, StoredCapability>();
  return {
    async load(nodeUrl) {
      return map.get(legacyAccountFor(defaultAppId(), nodeUrl)) ?? null;
    },
    async save(cap) {
      map.set(legacyAccountFor(cap.appId, cap.nodeUrl), cap);
    },
    async clear(nodeUrl) {
      map.delete(legacyAccountFor(defaultAppId(), nodeUrl));
    },
  };
}
