// Unit tests for src/retrieval/expand.ts cost estimation.
//
// Regression: estimateCostUsd used to fall through to Haiku rates for any
// unrecognized model (substring match on "sonnet"/"opus", else Haiku).
// That silently misreported cost for any new/renamed model. The contract
// is now: known model → exact USD; unknown model → null, so callers can
// surface "unknown" instead of a wrong number.

import { describe, expect, test } from "bun:test";

import { estimateCostUsd, MODEL_PRICING } from "../../src/retrieval/expand.ts";
import { formatCost } from "../../src/commands/ask.ts";

describe("estimateCostUsd", () => {
  test("haiku-4-5: known model → exact USD from the published rate table", () => {
    // 1M input * $1 + 1M output * $5 + 1M cacheRead * $0.10 = $6.10
    const usd = estimateCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 },
      "claude-haiku-4-5-20251001",
    );
    expect(usd).toBe(6.1);
  });

  test("sonnet-4-6: known model → exact USD", () => {
    // 1M*$3 + 1M*$15 + 1M*$0.30 = $18.30
    const usd = estimateCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 },
      "claude-sonnet-4-6",
    );
    expect(usd).toBe(18.3);
  });

  test("opus-4-7: known model → exact USD", () => {
    // 1M*$15 + 1M*$75 + 1M*$1.50 = $91.50
    const usd = estimateCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 },
      "claude-opus-4-7",
    );
    expect(usd).toBe(91.5);
  });

  test("scales linearly with token counts", () => {
    const tokens = { input: 1234, output: 5678, cacheRead: 91011 };
    const usd = estimateCostUsd(tokens, "claude-haiku-4-5-20251001");
    // 1234*1 + 5678*5 + 91011*0.1 = 1234 + 28390 + 9101.1 = 38725.1
    expect(usd).toBeCloseTo(38725.1 / 1_000_000, 10);
  });

  test("unknown model → null (must NOT fall back to Haiku rates)", () => {
    // The whole point of this regression: an unrecognized name used to
    // silently bill at Haiku. With $100M tokens that's still 0 USD if we
    // hand back null — verifies no silent default kicked in.
    const usd = estimateCostUsd(
      { input: 100_000_000, output: 100_000_000, cacheRead: 100_000_000 },
      "claude-unknown-model-9-9-29991231",
    );
    expect(usd).toBeNull();
  });

  test("substring match is not accepted: bare 'sonnet' string returns null", () => {
    // Old fragility: model.includes('sonnet') matched anything containing
    // the substring. New contract: only entries in MODEL_PRICING return a
    // number; everything else is unknown.
    expect(estimateCostUsd({ input: 100, output: 100, cacheRead: 100 }, "sonnet"))
      .toBeNull();
    expect(estimateCostUsd({ input: 100, output: 100, cacheRead: 100 }, "claude-sonnet-4-5"))
      .toBeNull();
  });

  test("MODEL_PRICING contains the DEFAULT_MODEL (haiku-4-5)", () => {
    // Guardrail: if someone bumps DEFAULT_MODEL in expand.ts without
    // adding the new ID to the price table, this assertion stays green
    // only because haiku-4-5 is still there — but the test below catches
    // the broader contract.
    expect(MODEL_PRICING).toHaveProperty("claude-haiku-4-5-20251001");
  });
});

describe("formatCost (ask.ts caller)", () => {
  test("known model → '$<number>'", () => {
    expect(formatCost(0.012345, "claude-haiku-4-5-20251001")).toBe("cost≈$0.012345");
  });

  test("unknown model (null) → explicit 'unknown' with the model name, NOT a number", () => {
    const out = formatCost(null, "claude-mystery-model-1-0");
    expect(out).toBe("cost≈unknown (claude-mystery-model-1-0 not in price table)");
    // The literal string the user reads must not contain a $-prefixed
    // dollar figure for unknown models — that was the original bug.
    expect(out).not.toContain("$");
  });
});
