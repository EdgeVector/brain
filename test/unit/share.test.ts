// Unit tests for the Phase 3 `fbrain share` placeholder.
//
// The command is a deliberate stub: it prints a pointer to the memo and
// exits non-zero so callers don't mistake a no-op for a successful share.
// This test pins both contracts so a future implementation can't
// silently drop them.

import { describe, expect, test } from "bun:test";

import { shareCmd } from "../../src/commands/share.ts";

describe("shareCmd placeholder", () => {
  test("exits non-zero", () => {
    expect(shareCmd({ print: () => {} })).toBe(1);
  });

  test("prints a pointer to docs/phase-3-sharing-memo.md", () => {
    const lines: string[] = [];
    shareCmd({ print: (line) => lines.push(line) });
    const joined = lines.join("\n");
    expect(joined).toContain("docs/phase-3-sharing-memo.md");
  });

  test("calls print at least once", () => {
    let calls = 0;
    shareCmd({ print: () => calls++ });
    expect(calls).toBeGreaterThan(0);
  });
});
