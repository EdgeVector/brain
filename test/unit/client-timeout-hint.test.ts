// Unit tests for the load-aware request-timeout hint (timeoutHint). When an
// fbrain node/schema request times out, the hint should name the ACTUAL likely
// cause. Historically every timeout printed one static guess — "the node may be
// cold-initializing its schema index" — even when the node was warm and
// hours-up and the real cause was the developer's OWN machine being
// CPU-saturated (a concurrent `cargo build`, a test/bench sweep). These pin the
// load-aware branch: load >> cores → "node starved, not broken"; normal load →
// the load-agnostic hint that no longer over-claims a cold schema index as a
// certainty. The load source is injected so the test is host-independent.

import { describe, expect, test } from "bun:test";

import { timeoutHint } from "../../src/client.ts";

describe("timeoutHint (load-aware)", () => {
  test("node + high local load → starvation hint with load + core numbers", () => {
    // load 60 on 8 cores → 7.5× over-subscribed, well past the 1.5× factor.
    const hint = timeoutHint("node", () => ({ load1: 60, cores: 8 }));
    expect(hint).toContain("heavy CPU load");
    expect(hint).toContain("load 60.0 on 8 cores");
    expect(hint).toContain("starved, not broken");
    // It still points the dev at awaiting the other work, not restarting the node.
    expect(hint).toContain("other work");
    // The misleading certainty must NOT appear on the starvation path.
    expect(hint).not.toContain("cold-initializing its schema index");
    // Idempotent-retry guidance is preserved (the existing deadline test pins it).
    expect(hint).toContain("re-running the command is safe");
    expect(hint).toContain("FBRAIN_HTTP_TIMEOUT_MS");
  });

  test("node + normal local load → load-agnostic hint, no starvation claim", () => {
    // load 2 on 8 cores → well under the 1.5× factor.
    const hint = timeoutHint("node", () => ({ load1: 2, cores: 8 }));
    expect(hint).not.toContain("heavy CPU load");
    expect(hint).not.toContain("starved");
    // Keeps the idempotent-retry + deadline guidance.
    expect(hint).toContain("re-running the command is safe");
    expect(hint).toContain("FBRAIN_HTTP_TIMEOUT_MS");
    // The old over-specific certainty is gone: "cold-initializing its schema
    // index" is phrased as one possibility ("may be ... cold-initializing"),
    // never asserted outright.
    expect(hint).not.toMatch(/under heavy load \(e\.g\. cold-initializing/);
  });

  test("node + exactly at the factor boundary → not yet starvation", () => {
    // load == cores * 1.5 is the boundary; the check is strictly greater-than,
    // so this stays on the load-agnostic branch.
    const hint = timeoutHint("node", () => ({ load1: 12, cores: 8 }));
    expect(hint).not.toContain("heavy CPU load");
  });

  test("node + unmeasurable load (load1 === 0) → load-agnostic hint", () => {
    // loadavg() returns 0 on some platforms (e.g. Windows). Treat as
    // unmeasurable → never claim starvation off a zero reading.
    const hint = timeoutHint("node", () => ({ load1: 0, cores: 8 }));
    expect(hint).not.toContain("heavy CPU load");
    expect(hint).toContain("re-running the command is safe");
  });

  test("schema service path ignores local load (remote Lambda)", () => {
    // Even under crushing local load, the schema service is a remote Lambda —
    // the host's load is irrelevant, so the schema hint never mentions it.
    const hint = timeoutHint("schema", () => ({ load1: 99, cores: 4 }));
    expect(hint).not.toContain("starved");
    expect(hint).not.toContain("this machine");
    expect(hint.toLowerCase()).toContain("schema service");
    expect(hint).toContain("re-running the command is safe");
  });
});
