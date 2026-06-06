// Unit tests for `fbrain link`. The task and design lookups must survive a
// single /api/query miss caused by fold_db_node's top-100 truncation —
// otherwise `fbrain link <task> <design>` rejects a real task with
// `not_found` (or a real design with `dangling_design_slug`) ~40% of the
// time on a >100-row schema. Same flake guard `task new` / `design new`
// already apply via withReadRetry.

import { afterEach, describe, expect, test } from "bun:test";

import { linkCmd } from "../../src/commands/link.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });
const DESIGN_HASH = TEST_HASHES.design;
const TASK_HASH = TEST_HASHES.task;

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

function querySchema(init?: RequestInit): string | undefined {
  const raw = init?.body;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as { schema_name?: unknown };
    return typeof parsed.schema_name === "string" ? parsed.schema_name : undefined;
  } catch {
    return undefined;
  }
}

const taskRow = {
  fields: {
    slug: "t1",
    title: "Task 1",
    body: "body",
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  key: { hash: "t1", range: null },
};

const designRow = {
  fields: {
    slug: "d1",
    title: "Design 1",
    body: "body",
    status: "draft",
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  key: { hash: "d1", range: null },
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("linkCmd", () => {
  test("links a task to a design when both exist on the first query", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        if (schema === TASK_HASH) return { status: 200, body: { ok: true, results: [taskRow] } };
        if (schema === DESIGN_HASH) return { status: 200, body: { ok: true, results: [designRow] } };
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await linkCmd({ cfg, taskSlug: "t1", designSlug: "d1", print: () => {} });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("update");
    expect(mutations[0]!.schema).toBe(TASK_HASH);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("d1");
  });

  // Regression: /api/query truncation hides the task row on the first call,
  // then returns it on retry. Without withReadRetry the task lookup rejected
  // with `not_found` even though the task exists.
  test("task lookup retries through a flaky page miss", async () => {
    let taskQueryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        if (schema === TASK_HASH) {
          taskQueryCalls++;
          // First task query returns an empty page; retries return the row.
          const results = taskQueryCalls === 1 ? [] : [taskRow];
          return { status: 200, body: { ok: true, results } };
        }
        if (schema === DESIGN_HASH) {
          return { status: 200, body: { ok: true, results: [designRow] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await linkCmd({ cfg, taskSlug: "t1", designSlug: "d1", print: () => {} });
    expect(taskQueryCalls).toBeGreaterThanOrEqual(2);
    expect(mutations).toHaveLength(1);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("d1");
  });

  // Same flake, different lookup: the parent-design existence check must
  // also retry. Without it, `fbrain link <task> <real-design>` rejects with
  // dangling_design_slug whenever the parent is outside the daemon's top-100
  // page on the first call.
  test("design lookup retries through a flaky page miss", async () => {
    let designQueryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        if (schema === DESIGN_HASH) {
          designQueryCalls++;
          // First design query returns an empty page; retries return the row.
          const results = designQueryCalls === 1 ? [] : [designRow];
          return { status: 200, body: { ok: true, results } };
        }
        if (schema === TASK_HASH) {
          return { status: 200, body: { ok: true, results: [taskRow] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await linkCmd({ cfg, taskSlug: "t1", designSlug: "d1", print: () => {} });
    expect(designQueryCalls).toBeGreaterThanOrEqual(2);
    expect(mutations).toHaveLength(1);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("d1");
  });

  test("a task that genuinely doesn't exist still errors with not_found", async () => {
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
    await expect(
      linkCmd({ cfg, taskSlug: "ghost-task", designSlug: "d1", print: () => {} }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mutations).toEqual([]);
  }, 30_000);

  // Reversed-args DX: `link <design> <task>` is the most common first-use
  // mistake. When the slug passed as the task is actually a design, the error
  // must call that out and print the corrected command, not a bare "No task".
  test("reversed args (design passed as task) hints at the correct order", async () => {
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        // No task named "d1"; a design named "d1" exists.
        if (schema === DESIGN_HASH) return { status: 200, body: { ok: true, results: [designRow] } };
        return { status: 200, body: { ok: true, results: [] } };
      }
      return { status: 404 };
    });
    await expect(
      linkCmd({ cfg, taskSlug: "d1", designSlug: "t1", print: () => {} }),
    ).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("is a design, not a task"),
    });
  }, 30_000);

  // Regression: `put`'s slug resolver silently trims surrounding whitespace
  // (put.ts: `resolveSlug` → `.trim()`), so `fbrain put " t1 "` stores the
  // row under slug "t1". Pre-fix, `fbrain link " t1 " " d1 "` then compared
  // the verbatim input against the trimmed stored slugs and errored with
  // `not_found` (or `dangling_design_slug`) on records that genuinely exist
  // — same asymmetric key-normalization #184 just fixed for `delete`.
  // Mirror that fix here: trim both slugs at the top of linkCmd and thread
  // the normalized values through the lookups, the update mutation, and the
  // success line.
  test("trims surrounding whitespace on both slugs to match put's normalization", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        if (schema === TASK_HASH) return { status: 200, body: { ok: true, results: [taskRow] } };
        if (schema === DESIGN_HASH) return { status: 200, body: { ok: true, results: [designRow] } };
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await linkCmd({ cfg, taskSlug: "  t1  ", designSlug: "\td1\n", print: () => {} });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.mutation_type).toBe("update");
    const keyValue = mutations[0]!.key_value as { hash: string };
    expect(keyValue.hash).toBe("t1");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.slug).toBe("t1");
    // The written parent reference is the trimmed design slug, not the
    // padded input — otherwise the task row's design_slug points at a
    // value `findBySlug` (which compares verbatim) will never match.
    expect(fields.design_slug).toBe("d1");
  });

  test("a design that genuinely doesn't exist still errors with dangling_design_slug", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        if (schema === TASK_HASH) {
          return { status: 200, body: { ok: true, results: [taskRow] } };
        }
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await expect(
      linkCmd({ cfg, taskSlug: "t1", designSlug: "ghost-design", print: () => {} }),
    ).rejects.toMatchObject({ code: "dangling_design_slug" });
    expect(mutations).toEqual([]);
  }, 30_000);
});
