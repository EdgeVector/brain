// Unit tests for newNodeClient().queryAll — pinning the client-side guard
// against fold_db_node's broken /api/query offset pagination (see
// fold_db_node/src/handlers/query.rs: `.skip(offset).take(limit)` over an
// unstably-ordered result set, verified 2026-05-30 to drop ~25% of rows
// silently while returning the same count back via duplicates).
//
// fbrain is safe today only because QUERY_PAGE_SIZE (1000) exceeds every
// current schema's row count, so the second page is never requested. These
// tests prove that once any schema does grow past QUERY_PAGE_SIZE, queryAll
// will EITHER return the correct deduplicated set OR throw a clear error —
// it will NOT return a silently-truncated or duplicate-key list.

import { afterEach, describe, expect, test } from "bun:test";

import { FbrainError, newNodeClient } from "../../src/client.ts";

type MockResponse = { status: number; body?: unknown };

const realFetch = globalThis.fetch;

function installMockSequence(responses: MockResponse[]): { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const rawBody = (init?.body as string | undefined) ?? "";
    const parsed = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    calls.push({ url, body: parsed });
    const next: MockResponse = responses[i++] ?? { status: 500, body: { error: "no_more_mocks" } };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls };
}

function row(slug: string) {
  return {
    fields: { slug },
    key: { hash: slug, range: null },
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("newNodeClient.queryAll pagination guard", () => {
  test("single page with has_more=false returns all rows as-is", async () => {
    installMockSequence([
      {
        status: 200,
        body: {
          ok: true,
          results: [row("a"), row("b"), row("c")],
          total_count: 3,
          has_more: false,
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    const r = await c.queryAll({ schemaHash: "h", fields: ["slug"] });
    expect(r.results.map((x) => (x.fields as { slug: string }).slug)).toEqual(["a", "b", "c"]);
    expect(r.total_count).toBe(3);
    expect(r.returned_count).toBe(3);
  });

  test("disjoint multi-page (simulates a fixed node) returns the full deduped set", async () => {
    // The shape we expect to see when fold_db_node's pagination is fixed:
    // pages are disjoint, has_more=true while more rows remain, and the
    // unique count matches total_count at the end. queryAll must continue
    // to handle this transparently — the guard is for the buggy node only.
    installMockSequence([
      {
        status: 200,
        body: {
          ok: true,
          results: [row("a"), row("b"), row("c")],
          total_count: 5,
          has_more: true,
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          results: [row("d"), row("e")],
          total_count: 5,
          has_more: false,
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    const r = await c.queryAll({ schemaHash: "h", fields: ["slug"] });
    expect(r.results.map((x) => (x.fields as { slug: string }).slug)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(r.returned_count).toBe(5);
    expect(r.total_count).toBe(5);
  });

  test("overlapping pages that terminate short of total_count throw query_pagination_incomplete", async () => {
    // Reproduces the buggy node verified 2026-05-30: paging a 5-row schema
    // returns page 1 with [a,b,c] (has_more=true) and page 2 with [b,c]
    // (has_more=false). The deduped unique count is 3 but the node insists
    // total_count=5 — two rows were silently dropped. queryAll must fail
    // loudly here rather than return the truncated set.
    installMockSequence([
      {
        status: 200,
        body: {
          ok: true,
          results: [row("a"), row("b"), row("c")],
          total_count: 5,
          has_more: true,
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          results: [row("b"), row("c")],
          total_count: 5,
          has_more: false,
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.queryAll({ schemaHash: "h", fields: ["slug"] });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("query_pagination_incomplete");
      expect(fe.message).toContain("total_count");
      // Pin that the user is told what fraction of rows arrived so they can
      // size the impact at a glance.
      expect(fe.message).toContain("3");
      expect(fe.message).toContain("5");
      // The hint points at the root-cause fix (the fold_db_node task) so a
      // future reader can follow the chain.
      expect(fe.hint ?? "").toContain("stable /api/query ordering");
    }
  });

  test("a page that returns only already-seen keys with has_more=true throws query_pagination_stalled", async () => {
    // Defensive case: if the buggy node ever returns has_more=true on a
    // page that's an exact superset of what we've already paged through,
    // looping further can only spin (up to QUERY_PAGE_LIMIT) or duplicate.
    // We throw on the first such page rather than continue.
    installMockSequence([
      {
        status: 200,
        body: {
          ok: true,
          results: [row("a"), row("b"), row("c")],
          total_count: 10,
          has_more: true,
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          results: [row("a"), row("b"), row("c")],
          total_count: 10,
          has_more: true,
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    try {
      await c.queryAll({ schemaHash: "h", fields: ["slug"] });
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FbrainError);
      const fe = err as FbrainError;
      expect(fe.code).toBe("query_pagination_stalled");
      expect(fe.message).toContain("has_more=true");
      expect(fe.message).toContain("previously-seen");
      // The message names the real trigger — tombstoned/deleted keys counted in
      // total_count but omitted from the page — not a >1000-row problem.
      expect(fe.message).toContain("tombstoned");
      // The hint points at the node-side count fix (fold #995) and is actionable
      // for the common single-delete case (NOT "reduce the schema's row count").
      expect(fe.hint ?? "").toContain("fold #995");
      expect(fe.hint ?? "").not.toContain("reduce the schema");
    }
  });

  test("dedupes overlapping pages back to the correct full set when total_count matches", async () => {
    // The "best case" buggy node: pages overlap (page 2 redundantly
    // returns page 1's last row) BUT the union still covers total_count.
    // queryAll must NOT throw here — dedupe quietly collapses the overlap
    // and the user sees the correct row set, no duplicate keys.
    installMockSequence([
      {
        status: 200,
        body: {
          ok: true,
          results: [row("a"), row("b"), row("c")],
          total_count: 5,
          has_more: true,
        },
      },
      {
        status: 200,
        body: {
          ok: true,
          // [c] is a duplicate of page 1; [d,e] are new — net 5 unique.
          results: [row("c"), row("d"), row("e")],
          total_count: 5,
          has_more: false,
        },
      },
    ]);
    const c = newNodeClient({ baseUrl: "http://127.0.0.1:9001", userHash: "u" });
    const r = await c.queryAll({ schemaHash: "h", fields: ["slug"] });
    const slugs = r.results.map((x) => (x.fields as { slug: string }).slug);
    expect(new Set(slugs)).toEqual(new Set(["a", "b", "c", "d", "e"]));
    expect(slugs.length).toBe(5); // no duplicates in the returned list
    expect(r.returned_count).toBe(5);
    expect(r.total_count).toBe(5);
  });
});
