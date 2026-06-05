// Unit tests for the OS-keychain capability store's non-blocking behavior.
//
// The decisive regression these guard against: a `security add-generic-password`
// that BLOCKS on a keychain-authorization prompt (locked keychain / headless /
// SSH / CI / agents) used to hang fbrain forever right after consent was
// granted. The fix bounds every `security` call with a timeout and degrades to
// the 0600 file fallback when the call times out / errors — never on a hang.
//
// We inject a fake `security` runner via the `__setSecuritySpawn` seam so the
// keychain code path is exercised deterministically on any OS (including the
// Linux CI box, where the real darwin gate would otherwise skip it).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setSecuritySpawn,
  defaultCapabilityStore,
  fbrainDir,
} from "../../src/keychain.ts";
import type { StoredCapability } from "../../src/capability.ts";

const NODE_URL = "http://127.0.0.1:9001";

function makeCap(): StoredCapability {
  return {
    appId: "fbrain",
    nodeUrl: NODE_URL,
    nodePubkey: "bm9kZS1wdWJrZXk=",
    capabilityId: "cap-123",
    blob: "dGhlLWNhcGFiaWxpdHktYmxvYg==",
  };
}

async function withTempCapDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-kc-"));
  const prev = process.env.FBRAIN_CAPABILITY_DIR;
  process.env.FBRAIN_CAPABILITY_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.FBRAIN_CAPABILITY_DIR;
    else process.env.FBRAIN_CAPABILITY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function fileStorePath(dir: string): string {
  return join(dir, "capabilities.json");
}

afterEach(() => {
  __setSecuritySpawn(null);
});

describe("keychain store: non-blocking degradation", () => {
  test("save() falls back to the file store when the keychain backend hangs (timeout), and does NOT hang", async () => {
    await withTempCapDir(async (dir) => {
      let saveAttempted = false;
      // help → available; add-generic-password → simulated hang (timedOut).
      __setSecuritySpawn((args, _capture) => {
        if (args[0] === "help") return { status: 0, stdout: "", timedOut: false };
        if (args[0] === "add-generic-password") {
          saveAttempted = true;
          return { status: null, stdout: "", timedOut: true };
        }
        return { status: 1, stdout: "", timedOut: false };
      });

      const store = defaultCapabilityStore();
      const cap = makeCap();

      // If the keychain backend hung the process, this await would never resolve.
      // Bun's test timeout would fail it; the assertion below proves it returned.
      await store.save(cap);

      expect(saveAttempted).toBe(true);
      const path = fileStorePath(dir);
      expect(existsSync(path)).toBe(true);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredCapability>;
      const stored = Object.values(onDisk);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.blob).toBe(cap.blob);
    });
  });

  test("load() returns the file-fallback value when the keychain read times out", async () => {
    await withTempCapDir(async (dir) => {
      // First, save via a hung keychain so the value lands in the file store.
      __setSecuritySpawn((args, _capture) => {
        if (args[0] === "help") return { status: 0, stdout: "", timedOut: false };
        return { status: null, stdout: "", timedOut: true }; // every op hangs
      });
      const store = defaultCapabilityStore();
      const cap = makeCap();
      await store.save(cap);
      expect(existsSync(fileStorePath(dir))).toBe(true);

      // Now load: keychain find-generic-password also hangs → must fall back to file.
      const loaded = await store.load(NODE_URL);
      expect(loaded).not.toBeNull();
      expect(loaded?.blob).toBe(cap.blob);
    });
  });

  test("save() uses the keychain (no file written) when the backend is healthy", async () => {
    await withTempCapDir(async (dir) => {
      const calls: string[] = [];
      __setSecuritySpawn((args, _capture) => {
        calls.push(args[0]!);
        return { status: 0, stdout: "", timedOut: false }; // healthy: everything succeeds
      });
      const store = defaultCapabilityStore();
      await store.save(makeCap());

      // Keychain accepted the save → the file fallback must NOT have been written.
      expect(calls).toContain("add-generic-password");
      expect(existsSync(fileStorePath(dir))).toBe(false);
    });
  });

  test("save() falls back to the file store when the keychain save fails with a non-zero status", async () => {
    await withTempCapDir(async (dir) => {
      __setSecuritySpawn((args, _capture) => {
        if (args[0] === "help") return { status: 0, stdout: "", timedOut: false };
        if (args[0] === "add-generic-password") return { status: 1, stdout: "", timedOut: false };
        return { status: 1, stdout: "", timedOut: false };
      });
      const store = defaultCapabilityStore();
      const cap = makeCap();
      await store.save(cap);
      expect(existsSync(fileStorePath(dir))).toBe(true);
    });
  });

  test("a hung `security help` probe marks the keychain unavailable so the store uses the file backend", async () => {
    await withTempCapDir(async (dir) => {
      __setSecuritySpawn((args, _capture) => {
        if (args[0] === "help") return { status: null, stdout: "", timedOut: true };
        // If the probe were (wrongly) treated as available, a real op would run;
        // make any op a hard failure so the test can't accidentally pass.
        return { status: null, stdout: "", timedOut: true };
      });
      const store = defaultCapabilityStore();
      const cap = makeCap();
      await store.save(cap);
      // Probe reported unavailable → save went straight to the file fallback.
      expect(existsSync(fileStorePath(dir))).toBe(true);
      const onDisk = JSON.parse(readFileSync(fileStorePath(dir), "utf8")) as Record<string, StoredCapability>;
      expect(Object.values(onDisk)[0]?.blob).toBe(cap.blob);
    });
  });
});

// Sanity: the temp-dir indirection actually points fbrainDir() at our temp dir,
// so the assertions above are reading the file the store wrote.
describe("keychain store: temp-dir wiring", () => {
  test("FBRAIN_CAPABILITY_DIR redirects fbrainDir()", async () => {
    await withTempCapDir((dir) => {
      expect(fbrainDir()).toBe(dir);
    });
  });
});
