// Unit tests for the payload-scaled WRITE deadline (`writeTimeoutMs`). A write's
// node-side cost is O(payload) because the node chunk-embeds the whole body, so
// a large-record `put` blew past the flat 30s deadline and hard-failed
// `service_timeout` — the only workarounds were a magic env var or fragmenting
// the record. These pin that the deadline now scales with body size: a tiny
// body keeps the fast 30s deadline (so a wedged node still surfaces quickly),
// a large body gets enough headroom to finish, the ceiling bounds a runaway,
// and an explicit FBRAIN_HTTP_TIMEOUT_MS still wins unchanged.

import { afterEach, describe, expect, test } from "bun:test";

import { writeTimeoutMs } from "../../src/client.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_WRITE_TIMEOUT_MS = 240_000;

afterEach(() => {
  delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
});

describe("writeTimeoutMs", () => {
  test("a zero-byte body (read / bodyless write) gets exactly the default deadline", () => {
    delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
    expect(writeTimeoutMs(0)).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("a tiny body still gets ~the default deadline (one KB of scaling, not more)", () => {
    delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
    // 100 bytes → ceil(100/1024) = 1 KB → 30s + 1*300ms. Stays right at the
    // floor — a small record must not get a slow fail-on-wedged-node deadline.
    expect(writeTimeoutMs(100)).toBe(DEFAULT_TIMEOUT_MS + 300);
    expect(writeTimeoutMs(100)).toBeLessThan(31_000);
  });

  test("a ~219KB body scales well above 60s and stays under the ceiling", () => {
    delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
    const ms = writeTimeoutMs(219_724);
    // Comfortably above the measured ~30s+ embed cost for a 219KB record, and
    // never above the 240s ceiling.
    expect(ms).toBeGreaterThan(60_000);
    expect(ms).toBeLessThanOrEqual(MAX_WRITE_TIMEOUT_MS);
    // ceil(219724/1024) = 215 KB → 30000 + 215*300 = 94500ms.
    expect(ms).toBe(30_000 + 215 * 300);
  });

  test("a runaway body is clamped to the max write deadline", () => {
    delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
    // 100 MB would scale to ~30M ms uncapped; the ceiling pins it.
    expect(writeTimeoutMs(100 * 1024 * 1024)).toBe(MAX_WRITE_TIMEOUT_MS);
  });

  test("FBRAIN_HTTP_TIMEOUT_MS overrides scaling unchanged, regardless of body size", () => {
    process.env.FBRAIN_HTTP_TIMEOUT_MS = "5000";
    // Explicit user intent is authoritative — neither scaled up for a big body
    // nor floored to the default.
    expect(writeTimeoutMs(0)).toBe(5000);
    expect(writeTimeoutMs(219_724)).toBe(5000);
    expect(writeTimeoutMs(100 * 1024 * 1024)).toBe(5000);
  });

  test("an invalid FBRAIN_HTTP_TIMEOUT_MS is ignored and scaling applies", () => {
    process.env.FBRAIN_HTTP_TIMEOUT_MS = "not-a-number";
    expect(writeTimeoutMs(0)).toBe(DEFAULT_TIMEOUT_MS);
    expect(writeTimeoutMs(219_724)).toBe(30_000 + 215 * 300);
  });
});
