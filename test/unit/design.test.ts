// Unit tests for `fbrain design new`. The interesting cases are around
// the slug-already-exists guard: it must survive a flaky /api/query that
// returns an empty top-100 slice on the first call but the actual row on
// the next. Pre-fix, that first miss let createRecord run and silently
// overwrite the existing row's created_at.

import { afterEach, describe, expect, test } from "bun:test";

import { designNew } from "../../src/commands/design.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });
const DESIGN_HASH = TEST_HASHES.design;

// No-op sleep so the post-write vector-index confirmation (which probes a
// native-index URL these mocks 404) doesn't pay real backoff. These tests
// assert the create mutation, not search-parity (pinned in new.test.ts).
const VEC = { vectorVerifyOptions: { sleep: () => Promise.resolve() } } as const;

const realFetch = globalThis.fetch;

type MockHandler = (url: string, init?: RequestInit) => { status: number; body?: unknown };

function installMock(handler: MockHandler): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const out = handler(url, init);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("designNew", () => {
  test("creates a design when no row with the slug exists", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await designNew({
      cfg,
      slug: "fresh-design",
      title: "Fresh",
      body: "the body",
      tags: ["a", "b"],
      ...VEC,
    });
    expect(mutations).toHaveLength(2);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[0]!.schema).toBe(DESIGN_HASH);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.slug).toBe("fresh-design");
    expect(fields.title).toBe("Fresh");
    expect(fields.tags).toEqual(["a", "b"]);
    expect(fields.status).toBe("draft");
    const indexFields = mutations[1]!.fields_and_values as Record<string, unknown>;
    expect(indexFields.slug).toBe("__fbrain_tag_index__");
  });

  test("rejects with slug_already_exists when the row is on the first query page", async () => {
    const existing = {
      fields: {
        slug: "already-here",
        title: "Original",
        body: "old body",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      key: { hash: "already-here", range: null },
    };
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        return { status: 200, body: { ok: true, results: [existing] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await expect(
      designNew({
        cfg,
        slug: "already-here",
        title: "Replacement",
        body: "",
        tags: [],
      }),
    ).rejects.toMatchObject({ code: "slug_already_exists" });
    expect(mutations).toEqual([]);
  });

  // Regression: /api/query returns a non-deterministic top-100 slice per
  // schema, so on a schema with >100 rows a single findBySlug can miss
  // the row and let designNew fall through to createRecord — destroying
  // the row's created_at. The withReadRetry hedge must re-query until
  // the row surfaces, then raise slug_already_exists without mutating.
  test("rejects with slug_already_exists when /api/query flakes once before returning the row", async () => {
    const existing = {
      fields: {
        slug: "flaky-design",
        title: "Original",
        body: "old body",
        status: "draft",
        tags: ["initial"],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      key: { hash: "flaky-design", range: null },
    };
    let queryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCalls++;
        // First call returns an empty page (the slug fell outside the
        // top-100 slice). Subsequent calls return the row.
        const results = queryCalls === 1 ? [] : [existing];
        return { status: 200, body: { ok: true, results } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await expect(
      designNew({
        cfg,
        slug: "flaky-design",
        title: "Replacement",
        body: "",
        tags: [],
      }),
    ).rejects.toMatchObject({ code: "slug_already_exists" });
    expect(queryCalls).toBeGreaterThanOrEqual(2);
    // Critical assertion: no mutation fired. Pre-fix, the first empty
    // page let createRecord run and silently overwrite the row.
    expect(mutations).toEqual([]);
  });

  test("--force skips the pre-existence check and writes (overwrite)", async () => {
    let queryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCalls++;
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await designNew({
      cfg,
      slug: "forced",
      title: "Forced",
      body: "",
      tags: [],
      force: true,
      ...VEC,
    });
    expect(queryCalls).toBe(1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("create");
  });
});
