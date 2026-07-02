// Unit tests for `parseUpdatedSince` (src/cli.ts) — the shared parser behind
// both the `fbrain list --updated-since` CLI flag and the `fbrain_list` MCP
// tool's `updated_since` argument. `now` is injected so relative windows are
// deterministic (no clock dependence).

import { describe, expect, test } from "bun:test";

import { parseUpdatedSince } from "../../src/cli.ts";

const NOW = Date.parse("2026-07-02T12:00:00Z");

describe("parseUpdatedSince — relative windows", () => {
  test("7d → 7 days before now", () => {
    expect(parseUpdatedSince("7d", NOW)).toBe(NOW - 7 * 86_400_000);
  });

  test("24h → 24 hours before now (== 1d)", () => {
    expect(parseUpdatedSince("24h", NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseUpdatedSince("24h", NOW)).toBe(parseUpdatedSince("1d", NOW));
  });

  test("2w / 30m / 45s each resolve to the right offset", () => {
    expect(parseUpdatedSince("2w", NOW)).toBe(NOW - 2 * 604_800_000);
    expect(parseUpdatedSince("30m", NOW)).toBe(NOW - 30 * 60_000);
    expect(parseUpdatedSince("45s", NOW)).toBe(NOW - 45 * 1_000);
  });

  test("unit letter is case-insensitive and tolerates inner whitespace", () => {
    expect(parseUpdatedSince("7D", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseUpdatedSince("  3 h  ", NOW)).toBe(NOW - 3 * 3_600_000);
  });
});

describe("parseUpdatedSince — absolute ISO-8601", () => {
  test("date-only ISO parses to midnight UTC", () => {
    expect(parseUpdatedSince("2026-07-01", NOW)).toBe(
      Date.parse("2026-07-01"),
    );
  });

  test("full ISO timestamp parses exactly", () => {
    expect(parseUpdatedSince("2026-07-01T08:30:00Z", NOW)).toBe(
      Date.parse("2026-07-01T08:30:00Z"),
    );
  });
});

describe("parseUpdatedSince — rejects ambiguous / malformed input", () => {
  test("a bare integer is rejected (would parse as a year, likely a missing-unit typo)", () => {
    expect(() => parseUpdatedSince("7", NOW)).toThrow(/ambiguous/);
  });

  test("garbage throws a usage error naming the accepted forms", () => {
    expect(() => parseUpdatedSince("yesterday", NOW)).toThrow(
      /not a valid ISO-8601 timestamp or relative window/,
    );
  });

  test("an unknown unit is not a relative window and fails as a non-ISO string", () => {
    // `5y` doesn't match the s/m/h/d/w set, and Date.parse("5y") is NaN.
    expect(() => parseUpdatedSince("5y", NOW)).toThrow(/not a valid/);
  });
});
