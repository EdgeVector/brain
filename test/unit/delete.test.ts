// Unit tests for `fbrain delete`.
//
// The delete command's responsibilities (per docs/phase-5-delete-spike.md):
//   1. Resolve --type (probe both schemas if omitted; ambiguous slug errors).
//   2. Construct the soft-delete mutation body with the tombstone tag,
//      sentinel content fields, and the right per-type status.
//   3. Fire update + fold_db delete (in that order), then verify by
//      re-reading the record and asserting the tombstone tag is present.
//   4. Refuse to claim success if the post-delete read does not show
//      the tombstone (the "delete_not_applied" guard).
//
// These tests pin all four. The mock node mimics fold_db's append-only
// behavior — update writes the supplied row; delete is a no-op at the
// storage layer — so the verification step naturally exercises the
// post-update read path.

import { describe, expect, test } from "bun:test";

import {
  buildTombstoneFields,
  deleteRecord,
  TOMBSTONE_STATUS,
} from "../../src/commands/delete.ts";
import { FbrainError, type NodeClient } from "../../src/client.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import type { RecordType } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  userHash: "uh",
  schemaHashes: {
    ...TEST_HASHES,
    design: "designhash",
    task: "taskhash",
  },
});

type RowFields = Record<string, unknown>;

type MockState = {
  // map of (schemaHash → slug → row.fields)
  store: Map<string, Map<string, RowFields>>;
  updateCalls: Array<{ schemaHash: string; fields: RowFields; keyHash: string }>;
  deleteCalls: Array<{ schemaHash: string; keyHash: string }>;
};

function newMockState(): MockState {
  return { store: new Map(), updateCalls: [], deleteCalls: [] };
}

function seed(state: MockState, schemaHash: string, slug: string, fields: RowFields): void {
  if (!state.store.has(schemaHash)) state.store.set(schemaHash, new Map());
  state.store.get(schemaHash)!.set(slug, fields);
}

function mockNode(state: MockState): NodeClient {
  return {
    baseUrl: "mock",
    userHash: "uh",
    async autoIdentity() {
      return { provisioned: true, userHash: "uh" };
    },
    async bootstrap() {
      return { userHash: "uh" };
    },
    async requestConsent() {
      return { status: 202, body: { request_id: "r" } };
    },
    async consentStatus() {
      return { status: 200, body: { status: "granted" } };
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      if (!state.store.has(schemaHash)) state.store.set(schemaHash, new Map());
      state.store.get(schemaHash)!.set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      state.updateCalls.push({ schemaHash, fields, keyHash });
      if (!state.store.has(schemaHash)) state.store.set(schemaHash, new Map());
      state.store.get(schemaHash)!.set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      // Mimics fold_db's append-only no-op delete (see spike doc).
      state.deleteCalls.push({ schemaHash, keyHash });
    },
    async queryAll({ schemaHash }) {
      const rows = state.store.get(schemaHash);
      if (!rows) return { ok: true, results: [], total_count: 0, returned_count: 0 };
      const results = [...rows.entries()].map(([hash, fields]) => ({
        fields,
        key: { hash, range: null },
      }));
      return { ok: true, results, total_count: results.length, returned_count: results.length };
    },
    async search() {
      return [];
    },
    async rawCall() {
      return { status: 200, headers: new Headers(), body: "", json: null };
    },
  };
}

function designRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: "T",
    body: "B",
    status: "draft",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

function taskRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: "Tt",
    body: "Bt",
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

describe("buildTombstoneFields", () => {
  test("design payload uses (deleted) title, empty body, archived status, tombstone tag", () => {
    const fields = buildTombstoneFields(
      "design",
      "doomed",
      "2026-01-01T00:00:00Z",
      "2026-05-23T10:00:00Z",
    );
    expect(fields).toEqual({
      slug: "doomed",
      title: "(deleted)",
      body: "",
      status: "archived",
      tags: [TOMBSTONE_TAG],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-05-23T10:00:00Z",
    });
  });

  test("task payload uses cancelled status and resets design_slug", () => {
    const fields = buildTombstoneFields(
      "task",
      "doomed-task",
      "2026-01-01T00:00:00Z",
      "2026-05-23T10:00:00Z",
    );
    expect(fields.status).toBe("cancelled");
    expect(fields.design_slug).toBe("");
    expect(fields.tags).toEqual([TOMBSTONE_TAG]);
  });

  test("preserves created_at exactly", () => {
    const original = "2026-02-15T03:04:05.678Z";
    const fields = buildTombstoneFields("design", "s", original, "2026-05-23T10:00:00Z");
    expect(fields.created_at).toBe(original);
  });

  test("Phase 6 payload has no kind or v1_marker fields (per-kind schema)", () => {
    const fields = buildTombstoneFields(
      "concept",
      "concept-x",
      "2026-01-01T00:00:00Z",
      "2026-05-27T10:00:00Z",
    );
    expect(fields.status).toBe("archived");
    expect(fields.kind).toBeUndefined();
    expect(fields.v1_marker_a).toBeUndefined();
    expect(fields.v1_marker_b).toBeUndefined();
  });

  test("TOMBSTONE_STATUS map matches per-type expectation", () => {
    expect(TOMBSTONE_STATUS.design).toBe("archived");
    expect(TOMBSTONE_STATUS.task).toBe("cancelled");
  });
});

// The deleteRecord runtime tests need to inject a mock NodeClient. The
// cleanest path is module-level dependency injection — we override the
// import inside the test file with a tiny shim. Bun's `mock.module` is
// not stable; the simplest approach is to re-import the module under test
// with a globally stubbed `fetch` that satisfies newNodeClient's calls.
// But that's heavy. Instead, we exercise the error/dispatch paths via
// direct calls to a thin runtime that wraps `deleteRecord`'s logic.
describe("deleteRecord — runtime behavior via real client against a mock fetch", () => {
  test("missing slug + --type throws 'No <type>: <slug>'", async () => {
    // No record seeded under any schema; fetch is stubbed below.
    const calls: { url: string; init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      // Return an empty-results query response.
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await expect(
        deleteRecord({ cfg, slug: "ghost", type: "design" }),
      ).rejects.toBeInstanceOf(FbrainError);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  test("missing slug, no --type → 'No record with slug' wording", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await expect(deleteRecord({ cfg, slug: "ghost" })).rejects.toMatchObject({
        code: "not_found",
        message: 'No record with slug "ghost".',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("slug present in both schemas → ambiguous_slug, no mutation fired", async () => {
    const mutationsFired: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const isDesign = body.schema_name === cfg.designSchemaHash;
        const isTask = body.schema_name === cfg.taskSchemaHash;
        if (isDesign) {
          return new Response(
            JSON.stringify({ ok: true, results: [{ fields: designRow("dual"), key: { hash: "dual", range: null } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (isTask) {
          return new Response(
            JSON.stringify({ ok: true, results: [{ fields: taskRow("dual"), key: { hash: "dual", range: null } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      if (url.endsWith("/api/mutation")) {
        mutationsFired.push(init?.body);
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(deleteRecord({ cfg, slug: "dual" })).rejects.toMatchObject({
        code: "ambiguous_slug",
      });
      expect(mutationsFired.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("happy path on design: fires update with tombstone fields, then delete, then verifies via query", async () => {
    const captured: { update?: unknown; delete?: unknown } = {};
    let queryCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        queryCount++;
        // Design schema only — task queries return empty.
        if (body.schema_name === cfg.designSchemaHash) {
          // queryCount: 1 is the initial probe, 2 is the post-update verify.
          if (queryCount === 1) {
            return new Response(
              JSON.stringify({
                ok: true,
                results: [{ fields: designRow("doomed", { title: "alive" }), key: { hash: "doomed", range: null } }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          // post-update verify — return the tombstoned row.
          return new Response(
            JSON.stringify({
              ok: true,
              results: [
                {
                  fields: {
                    ...designRow("doomed"),
                    title: "(deleted)",
                    body: "",
                    status: "archived",
                    tags: [TOMBSTONE_TAG],
                  },
                  key: { hash: "doomed", range: null },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/mutation") && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.mutation_type === "update") captured.update = body;
        if (body.mutation_type === "delete") captured.delete = body;
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await deleteRecord({
        cfg,
        slug: "doomed",
        type: "design",
        print: (l) => lines.push(l),
      });
      // update was fired with tombstone fields.
      expect(captured.update).toBeDefined();
      const u = captured.update as {
        schema: string;
        mutation_type: string;
        fields_and_values: Record<string, unknown>;
        key_value: { hash: string; range: null };
      };
      expect(u.schema).toBe(cfg.designSchemaHash);
      expect(u.mutation_type).toBe("update");
      expect(u.fields_and_values.title).toBe("(deleted)");
      expect(u.fields_and_values.body).toBe("");
      expect(u.fields_and_values.status).toBe("archived");
      expect(u.fields_and_values.tags).toEqual([TOMBSTONE_TAG]);
      expect(u.fields_and_values.created_at).toBe("2026-05-01T00:00:00Z");
      expect(u.key_value).toEqual({ hash: "doomed", range: null });
      // delete was fired with empty fields_and_values (the spike's Probe B).
      expect(captured.delete).toBeDefined();
      const d = captured.delete as {
        mutation_type: string;
        fields_and_values: Record<string, unknown>;
        key_value: { hash: string };
      };
      expect(d.mutation_type).toBe("delete");
      expect(d.fields_and_values).toEqual({});
      expect(d.key_value.hash).toBe("doomed");
      // success line.
      expect(lines.join("\n")).toContain("deleted design doomed");
      expect(lines.join("\n")).toContain("docs/phase-5-delete-spike.md");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("happy path on task: status=cancelled and design_slug reset to empty", async () => {
    let queryCount = 0;
    const captured: { update?: Record<string, unknown> } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        queryCount++;
        if (body.schema_name !== cfg.taskSchemaHash) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (queryCount === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              results: [{ fields: taskRow("doomed-t", { design_slug: "parent" }), key: { hash: "doomed-t", range: null } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            results: [
              {
                fields: {
                  ...taskRow("doomed-t"),
                  title: "(deleted)",
                  body: "",
                  status: "cancelled",
                  tags: [TOMBSTONE_TAG],
                  design_slug: "",
                },
                key: { hash: "doomed-t", range: null },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/mutation")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.mutation_type === "update") captured.update = body;
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await deleteRecord({ cfg, slug: "doomed-t", type: "task", print: () => {} });
      const u = captured.update! as { fields_and_values: Record<string, unknown> };
      expect(u.fields_and_values.status).toBe("cancelled");
      expect(u.fields_and_values.design_slug).toBe("");
      expect(u.fields_and_values.tags).toEqual([TOMBSTONE_TAG]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Regression for #64: current fold_db's `MutationType::Delete` is
  // repurposed as a per-field tombstone write that the default query
  // filter hides — so the post-delete verify read returns [] on a
  // perfectly-successful delete. Pre-fix, delete waited for the row to
  // resurface and then surfaced a false "delete_not_applied" once the
  // retry budget was spent. The fix accepts a missing row as success
  // (purged from the visible set), keeping the "row visible without the
  // tombstone tag" path as the only real failure.
  test("post-delete verify accepts a missing row as success (fold_db filters its own tombstone)", async () => {
    let verifyReads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.designSchemaHash) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        verifyReads++;
        // Initial probe (#1) finds the live row. Every post-update read
        // returns [] — modelling fold_db's filter-out behavior after
        // MutationType::Delete writes its per-field tombstone.
        if (verifyReads === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              results: [{ fields: designRow("purged-delete", { title: "alive" }), key: { hash: "purged-delete", range: null } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/mutation")) {
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await deleteRecord({
        cfg,
        slug: "purged-delete",
        type: "design",
        print: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toContain("deleted design purged-delete");
      // 1 = initial resolve probe, 2 = single post-delete verify; the
      // retry must NOT keep looping while the row is missing — that was
      // the pre-fix false-failure path.
      expect(verifyReads).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Pre-current-fold_db behavior: the row stayed present after delete
  // and only carried our TOMBSTONE_TAG. The verify must still recognise
  // that case as success so older daemons keep working.
  test("post-delete verify accepts a tombstoned row as success (legacy fold_db)", async () => {
    let queryCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.designSchemaHash) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        queryCount++;
        if (queryCount === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              results: [{ fields: designRow("tombstoned-only"), key: { hash: "tombstoned-only", range: null } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            results: [
              {
                fields: {
                  ...designRow("tombstoned-only"),
                  title: "(deleted)",
                  body: "",
                  status: "archived",
                  tags: [TOMBSTONE_TAG],
                },
                key: { hash: "tombstoned-only", range: null },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/mutation")) {
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await deleteRecord({
        cfg,
        slug: "tombstoned-only",
        type: "design",
        print: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toContain("deleted design tombstoned-only");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("post-delete verify failure raises delete_not_applied", async () => {
    // Initial query finds the record; mutation succeeds; verify query
    // returns the record WITHOUT the tombstone tag. The guard should fire.
    let queryCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.designSchemaHash) {
          return new Response(JSON.stringify({ ok: true, results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        queryCount++;
        // Pretend the mutation silently failed: every read returns the
        // un-tombstoned row.
        return new Response(
          JSON.stringify({
            ok: true,
            results: [{ fields: designRow("ghost-fail"), key: { hash: "ghost-fail", range: null } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/mutation")) {
        return new Response(JSON.stringify({ ok: true, success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        deleteRecord({ cfg, slug: "ghost-fail", type: "design", print: () => {} }),
      ).rejects.toMatchObject({ code: "delete_not_applied" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(queryCount).toBeGreaterThanOrEqual(2);
  });
});

// Referential-integrity guard: deleting a design that still has live tasks
// pointing at it is blocked by default (symmetric with `task new --design` /
// `link` rejecting a dangling design), with --force as the escape hatch.
describe("deleteRecord — design linked-task guard", () => {
  const queryResp = (results: unknown[]): Response =>
    new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const mutationResp = (): Response =>
    new Response(JSON.stringify({ ok: true, success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const asRow = (slug: string, fields: RowFields) => ({
    fields,
    key: { hash: slug, range: null },
  });

  test("blocks deleting a design with a live linked task; no mutation fires", async () => {
    const mutationsFired: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === cfg.designSchemaHash) {
          return queryResp([asRow("parent", designRow("parent"))]);
        }
        if (body.schema_name === cfg.taskSchemaHash) {
          return queryResp([asRow("child", taskRow("child", { design_slug: "parent" }))]);
        }
        return queryResp([]);
      }
      if (url.endsWith("/api/mutation")) {
        mutationsFired.push(init?.body);
        return mutationResp();
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        deleteRecord({ cfg, slug: "parent", type: "design", print: () => {} }),
      ).rejects.toMatchObject({
        code: "design_has_linked_tasks",
        message: 'Cannot delete design "parent" — 1 task still links to it: child.',
      });
      expect(mutationsFired.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("blocks with a sorted, pluralized list when several tasks link to the design", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === cfg.designSchemaHash) {
          return queryResp([asRow("parent", designRow("parent"))]);
        }
        if (body.schema_name === cfg.taskSchemaHash) {
          return queryResp([
            asRow("zeta", taskRow("zeta", { design_slug: "parent" })),
            asRow("alpha", taskRow("alpha", { design_slug: "parent" })),
          ]);
        }
        return queryResp([]);
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        deleteRecord({ cfg, slug: "parent", type: "design", print: () => {} }),
      ).rejects.toMatchObject({
        code: "design_has_linked_tasks",
        message: 'Cannot delete design "parent" — 2 tasks still link to it: alpha, zeta.',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--force deletes the design despite linked tasks and warns about the orphans", async () => {
    let designQueryCount = 0;
    const captured: { update?: unknown; delete?: unknown } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === cfg.designSchemaHash) {
          designQueryCount++;
          // #1 = resolve (live row); later = post-delete verify (tombstoned).
          if (designQueryCount === 1) {
            return queryResp([asRow("parent", designRow("parent", { title: "alive" }))]);
          }
          return queryResp([
            asRow("parent", designRow("parent", {
              title: "(deleted)",
              body: "",
              status: "archived",
              tags: [TOMBSTONE_TAG],
            })),
          ]);
        }
        if (body.schema_name === cfg.taskSchemaHash) {
          return queryResp([asRow("child", taskRow("child", { design_slug: "parent" }))]);
        }
        return queryResp([]);
      }
      if (url.endsWith("/api/mutation")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.mutation_type === "update") captured.update = body;
        if (body.mutation_type === "delete") captured.delete = body;
        return mutationResp();
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await deleteRecord({
        cfg,
        slug: "parent",
        type: "design",
        force: true,
        print: (l) => lines.push(l),
      });
      const out = lines.join("\n");
      expect(out).toContain("warning:");
      expect(out).toContain("child");
      expect(out).toContain("deleted design parent");
      expect(captured.update).toBeDefined();
      expect(captured.delete).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deletes a design when no live task links to it (tombstoned + other-design tasks ignored)", async () => {
    let designQueryCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name === cfg.designSchemaHash) {
          designQueryCount++;
          if (designQueryCount === 1) {
            return queryResp([asRow("lonely", designRow("lonely"))]);
          }
          return queryResp([]); // post-delete verify: purged
        }
        if (body.schema_name === cfg.taskSchemaHash) {
          return queryResp([
            // tombstoned task that still names the design — must be ignored
            asRow("ghost", taskRow("ghost", { design_slug: "lonely", tags: [TOMBSTONE_TAG] })),
            // live task pointing at a different design — must be ignored
            asRow("elsewhere", taskRow("elsewhere", { design_slug: "another-design" })),
          ]);
        }
        return queryResp([]);
      }
      if (url.endsWith("/api/mutation")) {
        return mutationResp();
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await deleteRecord({
        cfg,
        slug: "lonely",
        type: "design",
        print: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toContain("deleted design lonely");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);

  test("deleting a task is unaffected by the design guard (no linked-task scan)", async () => {
    let queryCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.endsWith("/api/query")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.schema_name !== cfg.taskSchemaHash) return queryResp([]);
        queryCount++;
        if (queryCount === 1) return queryResp([asRow("solo", taskRow("solo"))]);
        return queryResp([]); // verify: purged
      }
      if (url.endsWith("/api/mutation")) return mutationResp();
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      await deleteRecord({ cfg, slug: "solo", type: "task", print: (l) => lines.push(l) });
      expect(lines.join("\n")).toContain("deleted task solo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Touch the unused mock helpers so the test file doesn't accumulate
// orphan exports as new cases are added.
void newMockState;
void seed;
void mockNode;
