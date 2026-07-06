// Unit tests for `fbrain task new`. Like designNew, the slug-already-
// exists guard must survive a single /api/query miss caused by the
// fold_db_node top-100 truncation. The parent-design lookup for
// --design <slug> needs the same hedge — otherwise a valid parent on a
// >100-row design schema flakes to dangling_design_slug ~40% of the time.

import { afterEach, describe, expect, test } from "bun:test";

import { recordNew, type RecordNewOptions } from "../../src/commands/new.ts";
import { tagIndexSlug } from "../../src/tag-index.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

// `fbrain task new` is a thin `recordNew({ type: "task" })` call (cli.ts
// invokes recordNew directly). Task is the one type carrying an optional
// `--design` parent-link. These tests exercise that path.
const taskNew = (opts: Omit<RecordNewOptions, "type">) =>
  recordNew({ ...opts, type: "task" });

const cfg = buildTestCfg({ userHash: "uh" });
const DESIGN_HASH = TEST_HASHES.design;
const TASK_HASH = TEST_HASHES.task;

// No-op sleep so the post-write vector-index confirmation (which probes a
// native-index URL these mocks 404) doesn't pay real backoff. These tests
// assert the create mutation / parent-link, not search-parity.
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

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("taskNew", () => {
  test("creates a task when no row with the slug exists", async () => {
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
    await taskNew({
      cfg,
      slug: "t-fresh",
      title: "Fresh task",
      body: "body",
      tags: ["a"],
      ...VEC,
    });
    expect(mutations).toHaveLength(2);
    expect(mutations[0]!.mutation_type).toBe("create");
    expect(mutations[0]!.schema).toBe(TASK_HASH);
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.status).toBe("open");
    expect(fields.design_slug).toBe("");
    const indexFields = mutations[1]!.fields_and_values as Record<string, unknown>;
    expect(indexFields.slug).toBe(tagIndexSlug("a"));
    expect(indexFields.members).toEqual(["task:t-fresh"]);
  });

  // Regression: /api/query truncation hides the existing row on the
  // first call, then returns it on retry. Without withReadRetry the
  // slug_already_exists guard fails open and createRecord silently
  // overwrites the row's created_at.
  test("rejects with slug_already_exists when the slug already exists", async () => {
    const existing = {
      fields: {
        slug: "flaky-task",
        title: "Original",
        body: "old",
        status: "open",
        tags: [],
        design_slug: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      key: { hash: "flaky-task", range: null },
    };
    let queryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        queryCalls++;
        return { status: 200, body: { ok: true, results: [existing] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await expect(
      taskNew({
        cfg,
        slug: "flaky-task",
        title: "Replacement",
        body: "",
        tags: [],
      }),
    ).rejects.toMatchObject({ code: "slug_already_exists" });
    // A single keyed point-read finds the existing row — no create attempted.
    expect(queryCalls).toBe(1);
    expect(mutations).toEqual([]);
  });

  // The parent-design existence check for `--design <valid-slug>` resolves via
  // keyed point-reads (no empty-page retry), so a valid parent is found directly.
  test("parent-design lookup finds a valid parent via keyed point-reads", async () => {
    const parentDesign = {
      fields: {
        slug: "parent-design",
        title: "Parent",
        body: "",
        status: "draft",
        tags: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      key: { hash: "parent-design", range: null },
    };
    let designQueryCalls = 0;
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        const schema = querySchema(init);
        if (schema === DESIGN_HASH) {
          designQueryCalls++;
          return { status: 200, body: { ok: true, results: [parentDesign] } };
        }
        // Task slug doesn't exist — every task query returns empty.
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await taskNew({
      cfg,
      slug: "child-task",
      title: "Child",
      body: "",
      tags: [],
      designSlug: "parent-design",
      ...VEC,
    });
    // Two keyed point-reads of the parent (validate + link), no empty-page retry.
    expect(designQueryCalls).toBe(2);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]!.mutation_type).toBe("create");
    const fields = mutations[0]!.fields_and_values as Record<string, unknown>;
    expect(fields.design_slug).toBe("parent-design");
  });

  test("parent-design that genuinely doesn't exist still errors with dangling_design_slug", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    installMock((url, init) => {
      if (url.endsWith("/api/query")) {
        // Every query returns empty — neither the task slug nor the
        // referenced design exist.
        return { status: 200, body: { ok: true, results: [] } };
      }
      if (url.endsWith("/api/mutation")) {
        mutations.push(JSON.parse((init?.body as string) ?? "{}"));
        return { status: 200, body: { ok: true } };
      }
      return { status: 404 };
    });
    await expect(
      taskNew({
        cfg,
        slug: "child-task",
        title: "Child",
        body: "",
        tags: [],
        designSlug: "ghost-design",
      }),
    ).rejects.toMatchObject({ code: "dangling_design_slug" });
    expect(mutations).toEqual([]);
  }, 30_000);
});
