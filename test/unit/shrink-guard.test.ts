// Unit tests for the body-shrink guard — the data-loss protection that refuses
// a full-replace `fbrain put` which would truncate an existing body (the
// get(windowed)→edit→re-put loop and the status-only-re-put body-wipe).

import { describe, expect, test } from "bun:test";

import {
  BODY_SHRINK_THRESHOLD,
  ensureNotShrinking,
  wouldShrinkBody,
} from "../../src/record.ts";
import { FbrainError } from "../../src/client.ts";

describe("wouldShrinkBody", () => {
  test("empty existing body never shrinks (a first write / re-put over empty is fine)", () => {
    expect(wouldShrinkBody("", "")).toBe(false);
    expect(wouldShrinkBody("", "anything")).toBe(false);
  });

  test("growing or same-size body never shrinks", () => {
    expect(wouldShrinkBody("abc", "abc")).toBe(false);
    expect(wouldShrinkBody("abc", "abcdef")).toBe(false);
  });

  test("a small trim (under the threshold) is allowed", () => {
    // Drop 1 of 100 chars = 1% < 50% threshold.
    const old = "x".repeat(100);
    expect(wouldShrinkBody(old, "x".repeat(99))).toBe(false);
  });

  test("dropping more than the threshold trips the guard", () => {
    const old = "x".repeat(100);
    // 60 dropped of 100 = 60% > 50%.
    expect(wouldShrinkBody(old, "x".repeat(40))).toBe(true);
  });

  test("clearing a non-empty body to empty trips the guard", () => {
    expect(wouldShrinkBody("some body", "")).toBe(true);
  });

  test("threshold boundary: exactly the threshold is allowed, just over trips", () => {
    const old = "x".repeat(100);
    const atThreshold = "x".repeat(100 - Math.floor(BODY_SHRINK_THRESHOLD * 100)); // keep 50
    expect(wouldShrinkBody(old, atThreshold)).toBe(false); // dropped exactly 50% → not > threshold
    expect(wouldShrinkBody(old, "x".repeat(49))).toBe(true); // 51% dropped
  });
});

describe("ensureNotShrinking", () => {
  test("no-op when the write is safe", () => {
    expect(() =>
      ensureNotShrinking("concept", "s", "body", "body extended", false),
    ).not.toThrow();
  });

  test("no-op when allowShrink is set (deliberate truncation escape hatch)", () => {
    expect(() =>
      ensureNotShrinking("concept", "s", "x".repeat(100), "", true),
    ).not.toThrow();
  });

  test("throws body_shrink_guard on a dramatic shrink, with an actionable hint", () => {
    try {
      ensureNotShrinking("project", "big-tracker", "x".repeat(100), "x".repeat(10), false);
      throw new Error("expected ensureNotShrinking to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const e = err as FbrainError;
      expect(e.code).toBe("body_shrink_guard");
      expect(e.message).toContain("big-tracker");
      // Steers the agent to the right primitives + the escape hatch.
      expect(e.hint).toContain("fbrain_append");
      expect(e.hint).toContain("allow-shrink");
      expect(e.agentHint).toContain("allow_shrink");
    }
  });

  test("throws when clearing a non-empty body to empty (the status-only re-put wipe)", () => {
    expect(() =>
      ensureNotShrinking("design", "d", "the existing body", "", false),
    ).toThrow(FbrainError);
  });
});
