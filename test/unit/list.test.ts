// Unit tests for `fbrain list`.
//
// The list command's read-flake behavior (added 2026-05-26): when the
// caller passes --status or --tag, the per-type sweep is wrapped in
// withReadRetry so a status/tag write immediately followed by a filtered
// list rides out the polluted-daemon flake (docs/phase-7-search-latency
// -spike.md). The retry stops as soon as the sweep surfaces any
// non-tombstoned row — the user filter is applied after, so a sweep that
// returns a row that doesn't match the filter still terminates retry.
//
// When no --status/--tag is set, empty is a legitimate signal and we
// skip retry entirely so unfiltered empty lists don't burn the budget.

import { describe, expect, test } from "bun:test";

import { listCmd } from "../../src/commands/list.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  userHash: "uh",
  schemaHashes: { ...TEST_HASHES },
});

type Fields = Record<string, unknown>;

function spikeRow(slug: string, over: Partial<Fields> = {}): Fields {
  return {
    slug,
    title: `T ${slug}`,
    body: "B",
    status: "exploring",
    tags: [],
    kind: "spike",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-26T00:00:00Z",
    ...over,
  };
}

// Stub `globalThis.fetch` so listCmd's per-type sweep sees the rows the
// test wants. `responsesBySchema[hash]` is the queue of result arrays
// returned for successive /api/query calls against that schema. Anything
// not enqueued returns []. Non-query endpoints (autoIdentity, bootstrap)
// get harmless OKs.
function stubFetch(responsesBySchema: Map<string, Array<Fields[]>>): {
  restore: () => void;
  callsBySchema: Map<string, number>;
} {
  const callsBySchema = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const schema = String(body.schema_name);
      const n = (callsBySchema.get(schema) ?? 0) + 1;
      callsBySchema.set(schema, n);
      const queue = responsesBySchema.get(schema) ?? [];
      const rows = queue.shift() ?? [];
      const results = rows.map((fields) => ({
        fields,
        key: { hash: String(fields.slug ?? "k"), range: null },
      }));
      return new Response(
        JSON.stringify({
          ok: true,
          results,
          total_count: results.length,
          returned_count: results.length,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // Default OK for anything else (identity bootstrap, schema loads).
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { restore: () => void (globalThis.fetch = originalFetch), callsBySchema };
}

describe("listCmd — read-flake retry", () => {
  test("with --status filter: empty sweep then hit prints the row", async () => {
    // First sweep on the spike schema returns nothing; second returns the
    // row with the updated status. Mirrors the 2026-05-26 dogfood repro
    // where a status write was momentarily invisible to a follow-up list.
    const row = spikeRow("retry-target", { status: "concluded" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[], [row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("retry-target");
    expect(lines[0]).toContain("concluded");
  });

  test("with --status filter: first sweep hits → no retry consumed", async () => {
    const row = spikeRow("first-try", { status: "concluded" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("first-try");
  });

  test("with --status filter: every sweep empty → 'no records' after budget spent", async () => {
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, []], // all reads default to []
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    // 5 attempts is the READ_RETRY_ATTEMPTS default — exhausting the
    // budget on a genuinely-empty result is the documented behavior.
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(5);
    expect(lines).toEqual(["no records"]);
  });

  test("with --tag filter (no --status): retries on empty-then-hit", async () => {
    // The retry must trigger for --tag as well, not just --status.
    const row = spikeRow("tag-target", { tags: ["dogfood"] });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[], [row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        tag: "dogfood",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    expect(lines[0]).toContain("tag-target");
    expect(lines[0]).toContain("dogfood");
  });

  test("no --status/--tag filter: empty sweep returns immediately without retry", async () => {
    // Without a user filter, empty is a legitimate signal — the per-type
    // sweep should not burn the retry budget. With --type spike + no
    // status/tag, exactly one /api/query for the spike schema is expected.
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, []],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(1);
    expect(lines).toEqual(["no records"]);
  });

  test("retry budget stops once a non-tombstoned row appears, even if user filter excludes it", async () => {
    // The retry rides out empty-sweep flake, not "no matching row" — once
    // the sweep surfaces ANY non-tombstoned record we trust the per-call
    // result and let the user filter decide. Here the row's status is
    // "exploring" but the caller asked for "concluded": the retry must
    // terminate after the first hit (1 sweep), not keep retrying.
    const row = spikeRow("wrong-status", { status: "exploring" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[row]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(1);
    expect(lines).toEqual(["no records"]);
  });

  test("tombstoned-only sweep keeps retrying (tombstones don't count as a hit)", async () => {
    // If every visible row is tombstoned, the isHit predicate stays false
    // — same as truly empty. This protects against the polluted-daemon
    // case where stale tombstoned rows leak through while the live row
    // is briefly invisible.
    const tomb = spikeRow("ghost", { tags: [TOMBSTONE_TAG] });
    const live = spikeRow("alive", { status: "concluded" });
    const responses = new Map<string, Array<Fields[]>>([
      [TEST_HASHES.spike, [[tomb], [tomb, live]]],
    ]);
    const { restore, callsBySchema } = stubFetch(responses);
    const lines: string[] = [];
    try {
      await listCmd({
        cfg,
        type: "spike",
        status: "concluded",
        print: (l) => lines.push(l),
      });
    } finally {
      restore();
    }
    expect(callsBySchema.get(TEST_HASHES.spike)).toBe(2);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("alive");
  });
});
