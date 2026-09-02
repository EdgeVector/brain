// Unit tests for the slow-call phase accounting (`src/slow-call.ts`).
//
// The properties that matter: the segment math must attribute every
// millisecond of a stalled call to exactly one named owner (pre-send / node /
// between-requests / after-last-response), a call that never reached the
// socket must charge everything to pre-send, and the env gating must be
// impossible to leave silently half-on (threshold 0 disables, the debug flag
// always prints, garbage falls back to the default).

import { describe, expect, test } from "bun:test";

import {
  computeSegments,
  formatSlowCallReport,
  shouldReport,
  slowCallThresholdMs,
  type FetchTotals,
} from "../../src/slow-call.ts";

function totals(overrides: Partial<FetchTotals>): FetchTotals {
  return {
    firstStartMs: null,
    lastEndMs: null,
    insideMs: 0,
    count: 0,
    slowestMs: 0,
    slowestLabel: "",
    ...overrides,
  };
}

describe("computeSegments", () => {
  test("no fetch at all charges the whole call to pre-send", () => {
    const s = computeSegments(totals({}), 90_000);
    expect(s.preSendMs).toBe(90_000);
    expect(s.nodeMs).toBe(0);
    expect(s.betweenMs).toBe(0);
    expect(s.afterMs).toBe(0);
    expect(s.fetchCount).toBe(0);
  });

  test("every millisecond lands in exactly one segment", () => {
    // Two fetches: 1000..2000 and 3000..3500; process reports at 10_000.
    const s = computeSegments(
      totals({
        firstStartMs: 1_000,
        lastEndMs: 3_500,
        insideMs: 1_500,
        count: 2,
        slowestMs: 1_000,
        slowestLabel: "POST /api/query",
      }),
      10_000,
    );
    expect(s.preSendMs).toBe(1_000);
    expect(s.nodeMs).toBe(1_500);
    expect(s.betweenMs).toBe(1_000); // 3_500 - 1_000 span minus 1_500 inside
    expect(s.afterMs).toBe(6_500);
    expect(s.preSendMs + s.nodeMs + s.betweenMs + s.afterMs).toBe(s.totalMs);
  });

  test("the 12-minute stall shape: node small, after-last-response huge", () => {
    const s = computeSegments(
      totals({ firstStartMs: 400, lastEndMs: 900, insideMs: 500, count: 1 }),
      720_000,
    );
    expect(s.nodeMs).toBe(500);
    expect(s.afterMs).toBe(719_100);
  });
});

describe("formatSlowCallReport", () => {
  test("names all four segments and the slowest request", () => {
    const line = formatSlowCallReport(
      computeSegments(
        totals({
          firstStartMs: 1_000,
          lastEndMs: 3_500,
          insideMs: 1_500,
          count: 2,
          slowestMs: 1_000,
          slowestLabel: "POST /api/query",
        }),
        10_000,
      ),
    );
    expect(line).toContain("pre-send 1.0s");
    expect(line).toContain("node 1.5s across 2 request(s)");
    expect(line).toContain("slowest 1.0s (POST /api/query)");
    expect(line).toContain("between-requests 1.0s");
    expect(line).toContain("after-last-response 6.5s");
  });
});

describe("env gating", () => {
  test("default threshold is 10s", () => {
    expect(slowCallThresholdMs({})).toBe(10_000);
    expect(shouldReport(9_999, {})).toBe(false);
    expect(shouldReport(10_000, {})).toBe(true);
  });

  test("FBRAIN_PHASE_TIMING=1 always prints", () => {
    expect(shouldReport(1, { FBRAIN_PHASE_TIMING: "1" })).toBe(true);
  });

  test("threshold 0 disables even a huge stall", () => {
    expect(shouldReport(720_000, { FBRAIN_SLOW_CALL_THRESHOLD_MS: "0" })).toBe(false);
  });

  test("explicit threshold wins; garbage falls back to the default", () => {
    expect(slowCallThresholdMs({ FBRAIN_SLOW_CALL_THRESHOLD_MS: "2500" })).toBe(2_500);
    expect(slowCallThresholdMs({ FBRAIN_SLOW_CALL_THRESHOLD_MS: "soon" })).toBe(10_000);
    expect(slowCallThresholdMs({ FBRAIN_SLOW_CALL_THRESHOLD_MS: "-5" })).toBe(10_000);
  });
});
