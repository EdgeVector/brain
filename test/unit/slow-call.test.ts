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
    subprocess: [],
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

// ── Subprocess attribution ────────────────────────────────────────────────
//
// The bug these pin: a 30 s `lastseek query` reported as `pre-send 30.7s`, so
// the one instrument that held the fact named brain's own boot as the owner.
// The fix carves the spawn out of whichever segment it fell in, which is why
// every case below asserts the four segments STILL sum to the total — an
// attribution that changes the arithmetic would just be a different lie.
describe("subprocess attribution", () => {
  const sums = (x: {
    preSendMs: number;
    nodeMs: number;
    betweenMs: number;
    afterMs: number;
    subprocessMs: number;
  }) => x.preSendMs + x.nodeMs + x.betweenMs + x.afterMs + x.subprocessMs;

  test("a spawn before the first fetch comes out of pre-send, not out of node", () => {
    // The measured shape: 30 s helper, then six quick requests.
    const s = computeSegments(
      totals({
        firstStartMs: 30_700,
        lastEndMs: 32_400,
        insideMs: 1_700,
        count: 6,
        subprocess: [{ startMs: 100, endMs: 30_100, label: "lastseek query" }],
      }),
      32_400,
    );
    expect(s.subprocessMs).toBe(30_000);
    expect(s.subprocessCount).toBe(1);
    expect(s.preSendMs).toBe(700);
    expect(s.nodeMs).toBe(1_700);
    expect(sums(s)).toBe(32_400);
  });

  test("a spawn between fetches comes out of between-requests", () => {
    const s = computeSegments(
      totals({
        firstStartMs: 100,
        lastEndMs: 10_100,
        insideMs: 200,
        count: 2,
        subprocess: [{ startMs: 1_000, endMs: 9_000, label: "lastseek query" }],
      }),
      10_100,
    );
    expect(s.subprocessMs).toBe(8_000);
    expect(s.betweenMs).toBe(10_000 - 200 - 8_000);
    expect(sums(s)).toBe(10_100);
  });

  test("a spawn straddling the first fetch splits across both segments", () => {
    // Not a corner case for its own sake: this is why the math is an overlap
    // and not a subtraction of one total.
    const s = computeSegments(
      totals({
        firstStartMs: 1_000,
        lastEndMs: 3_000,
        insideMs: 500,
        count: 1,
        subprocess: [{ startMs: 500, endMs: 1_500, label: "lastseek query" }],
      }),
      3_000,
    );
    expect(s.subprocessMs).toBe(1_000);
    expect(s.preSendMs).toBe(500); // 1_000 pre-send window minus 500 of spawn
    expect(s.betweenMs).toBe(2_000 - 500 - 500);
    expect(sums(s)).toBe(3_000);
  });

  test("a call that never reached the socket still names the helper", () => {
    const s = computeSegments(
      totals({ subprocess: [{ startMs: 0, endMs: 40_000, label: "lastseek query" }] }),
      45_000,
    );
    expect(s.preSendMs).toBe(5_000);
    expect(s.subprocessMs).toBe(40_000);
    expect(sums(s)).toBe(45_000);
  });

  test("the slowest spawn is named, and the line omits the clause when none ran", () => {
    const withSpawns = computeSegments(
      totals({
        firstStartMs: 20_000,
        lastEndMs: 21_000,
        insideMs: 1_000,
        count: 1,
        subprocess: [
          { startMs: 0, endMs: 5_000, label: "lastseek query" },
          { startMs: 5_000, endMs: 19_000, label: "lastseek query" },
        ],
      }),
      21_000,
    );
    expect(withSpawns.subprocessCount).toBe(2);
    expect(withSpawns.subprocessSlowestMs).toBe(14_000);
    const line = formatSlowCallReport(withSpawns);
    expect(line).toContain("subprocess 19.0s across 2 spawn(s)");
    expect(line).toContain("slowest 14.0s (lastseek query)");

    const none = formatSlowCallReport(
      computeSegments(totals({ firstStartMs: 10, lastEndMs: 20, insideMs: 10, count: 1 }), 30),
    );
    expect(none).not.toContain("subprocess");
  });
});
