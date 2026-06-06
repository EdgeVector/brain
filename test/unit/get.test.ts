// Unit tests for `fbrain get` — focused on the dangling-design annotation
// and the reverse-direction child-tasks listing for designs.
//
// A task's design_slug is validated on write (`task new --design` / `link`),
// so a reference that no longer resolves to a live design means the design
// was deleted out from under the task. `get` surfaces that by tagging the
// `design:` line with "(deleted)" instead of printing a live-looking pointer.
//
// For the reverse direction — `fbrain get <design>` — the record's child
// tasks render on a `tasks:` line so the parent ↔ child link is visible both
// ways from the CLI.

import { afterEach, describe, expect, test } from "bun:test";

import { getRecord } from "../../src/commands/get.ts";
import { EMPTY_PAGE_RETRY_ATTEMPTS } from "../../src/record.ts";
import { TEST_HASHES, buildTestCfg } from "../util.ts";

const cfg = buildTestCfg({ userHash: "uh" });

type RowFields = Record<string, unknown>;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function queryResp(results: unknown[]): Response {
  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function asRow(slug: string, fields: RowFields) {
  return { fields, key: { hash: slug, range: null } };
}

function taskFields(slug: string, over: RowFields = {}): RowFields {
  return {
    slug,
    title: "T",
    body: "",
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function designFields(slug: string): RowFields {
  return {
    slug,
    title: "D",
    body: "",
    status: "draft",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
  };
}

describe("getRecord — dangling design reference", () => {
  test("marks the design line '(deleted)' when the referenced design is gone", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("orphan", taskFields("orphan", { design_slug: "gone-design" }))]);
      }
      // design schema (and the existence probe) return nothing — the parent is gone.
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "orphan", type: "task", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("design:     gone-design (deleted)");
  }, 30_000);

  test("leaves the design line clean when the referenced design is still live", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("child", taskFields("child", { design_slug: "live-design" }))]);
      }
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("live-design", designFields("live-design"))]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "child", type: "task", print: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain("design:     live-design");
    expect(out).not.toContain("(deleted)");
  });

  test("a task with no design reference prints '(none)' and probes no design", async () => {
    let designProbes = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([asRow("freestanding", taskFields("freestanding"))]);
      }
      if (body.schema_name === TEST_HASHES.design) designProbes++;
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "freestanding", type: "task", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("design:     (none)");
    expect(designProbes).toBe(0);
  });
});

// `fbrain get <design>` now mirrors `fbrain get <task>`: the latter has shown
// the parent `design:` line since Phase 1, so the design must symmetrically
// show its children. Without this, a developer who organizes work as a design
// with tasks underneath cannot see that structure back from the CLI — the only
// recourse was `fbrain get <each-task>` one slug at a time.
describe("getRecord — design's child tasks listing", () => {
  test("design with child tasks renders them on a `tasks:` line, newest first", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("auth", designFields("auth"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        return queryResp([
          asRow(
            "wire-oauth",
            taskFields("wire-oauth", {
              design_slug: "auth",
              status: "in_progress",
              updated_at: "2026-05-02T00:00:00Z",
            }),
          ),
          asRow(
            "login-ui",
            taskFields("login-ui", {
              design_slug: "auth",
              status: "open",
              updated_at: "2026-05-03T00:00:00Z",
            }),
          ),
          // A task under a DIFFERENT design must not leak into this design's
          // children — the filter is on `design_slug`, not "any task".
          asRow(
            "unrelated",
            taskFields("unrelated", {
              design_slug: "other-design",
              status: "open",
              updated_at: "2026-05-04T00:00:00Z",
            }),
          ),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "auth", type: "design", print: (l) => lines.push(l) });
    const out = lines.join("\n");
    // login-ui has the newer updated_at, so it sorts first.
    expect(out).toContain("tasks:      login-ui (open), wire-oauth (in_progress)");
    expect(out).not.toContain("unrelated");
  });

  test("childless design renders '(none)' and does NOT burn the full read-retry budget", async () => {
    // Cost-discipline regression: on a fresh node, every type's page is
    // legitimately empty until its first record lands. If the reverse-direction
    // probe used the full 5× read-retry budget, `fbrain get <design>` on a
    // fresh-node design would block ~1.1 s of pure backoff just to confirm
    // "no children" — re-introducing the first-write-of-a-type latency cliff
    // that the forward fast-miss helper already fixed. Pin the cap.
    let taskQueries = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("solo", designFields("solo"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        taskQueries++;
        // Empty page (fresh-node task schema) — the only branch that retries.
        return queryResp([]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "solo", type: "design", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("tasks:      (none)");
    // Worst-case ride-out is EMPTY_PAGE_RETRY_ATTEMPTS task queries — never
    // the 5× READ_RETRY_ATTEMPTS budget. Asserting equality (not <=) pins the
    // contract: the cap is the cap.
    expect(taskQueries).toBe(EMPTY_PAGE_RETRY_ATTEMPTS);
  }, 30_000);

  test("design with populated task page but no matching children renders '(none)' on ONE query", async () => {
    // Populated-page authoritative-miss: if the task schema has rows but none
    // match this design's slug, that is authoritative "no children" — no
    // retry, no burn. Mirrors the forward fast-miss contract.
    let taskQueries = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.design) {
        return queryResp([asRow("standalone", designFields("standalone"))]);
      }
      if (body.schema_name === TEST_HASHES.task) {
        taskQueries++;
        return queryResp([
          asRow("other", taskFields("other", { design_slug: "different-design" })),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "standalone", type: "design", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("tasks:      (none)");
    expect(taskQueries).toBe(1);
  });

  test("non-design records do NOT issue a task-children probe (gating)", async () => {
    // The reverse-direction probe is gated on `found.type === "design"`. A
    // task's `fbrain get` resolves with ONE task query (the type-narrowed
    // sweep); if the gate ever regresses, a second task query (the children
    // probe of the task itself) would land. Pin to exactly one.
    let taskQueries = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.endsWith("/api/query")) return queryResp([]);
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.schema_name === TEST_HASHES.task) {
        taskQueries++;
        return queryResp([
          asRow("loner", taskFields("loner", { design_slug: "" })),
        ]);
      }
      return queryResp([]);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await getRecord({ cfg, slug: "loner", type: "task", print: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("[task] loner");
    expect(taskQueries).toBe(1);
  });
});
