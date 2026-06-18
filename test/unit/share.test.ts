// Unit tests for the Phase 3 `fbrain share` placeholder.
//
// The command is a deliberate stub: it prints a pointer to the memo and
// exits non-zero so callers don't mistake a no-op for a successful share.
// This test pins both contracts so a future implementation can't
// silently drop them, plus pins the post-PR-#33 framing (transport
// deployed; this daemon hasn't been signed in) so the copy doesn't
// regress back to "not built".

import { describe, expect, test } from "bun:test";

import { shareCmd } from "../../src/commands/share.ts";

describe("shareCmd placeholder", () => {
  test("exits non-zero", () => {
    expect(shareCmd({ print: () => {} })).toBe(1);
  });

  test("does not point users at internal phase/spike/memo docs", () => {
    const lines: string[] = [];
    shareCmd({ print: (line) => lines.push(line) });
    const joined = lines.join("\n");
    expect(joined).not.toContain("docs/phase-");
    expect(joined).not.toContain("-spike");
    expect(joined).not.toContain("-memo");
  });

  test("frames the gap as sign-in, not missing infrastructure", () => {
    const lines: string[] = [];
    shareCmd({ print: (line) => lines.push(line) });
    const joined = lines.join("\n");
    // Affirmative: transport is deployed and the daemon is not signed in.
    expect(joined).toContain("deployed");
    expect(joined).toContain("signed in");
    expect(joined).toContain("connected: false");
    // Negative: must not claim the transport doesn't exist / isn't built /
    // is unreachable. These are the stale framings PR #33 corrected.
    expect(joined).not.toContain("not yet built");
    expect(joined).not.toContain("unreachable");
  });

  test("calls print at least once", () => {
    let calls = 0;
    shareCmd({ print: () => calls++ });
    expect(calls).toBeGreaterThan(0);
  });
});
