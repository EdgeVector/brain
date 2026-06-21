// Unit tests for filter-mode (bulk) delete: `fbrain delete --tag T [--type T]
// [--status S]`.
//
// The contract (per the delete-by-tag-bulk-cleanup card):
//   1. Resolve matching LIVE records via the same path `list` uses (tombstones
//      already excluded; --tag/--type/--status applied with list's semantics).
//   2. Dry-run BY DEFAULT — preview the records that WOULD be deleted + a count,
//      and exit WITHOUT firing any mutation. `--yes` flips it to actually delete.
//   3. `--yes` soft-deletes every match via the SAME tombstone path single-slug
//      delete uses (one source of truth — `tombstoneOne`).
//   4. An unbounded selector (no tag/status/type) is refused.
//   5. The design-with-live-tasks referential-integrity guard is honored per
//      record: skip+warn by default, delete+warn under --force — and one linked
//      design never aborts the whole batch.
//   6. `--json` (via onResult) emits {ok, deleted:[{type,slug}], dryRun}.
//
// The mock node mimics fold_db: update writes the row; delete is a storage
// no-op; queryAll serves whatever is in the per-schema store. After an update
// stamps the tombstone tag, the verify read in `tombstoneOne` sees it.

import { describe, expect, test } from "bun:test";

import { deleteByFilter, type DeleteBatchResult } from "../../src/commands/delete.ts";
import { FbrainError, type NodeClient } from "../../src/client.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
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
  // schemaHash → slug → row.fields
  store: Map<string, Map<string, RowFields>>;
  updateCalls: Array<{ schemaHash: string; keyHash: string }>;
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
    async health() {
      return { ok: true, uptime_s: 1 };
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
    async listLoadedSchemas() {
      return [];
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      seed(state, schemaHash, keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      state.updateCalls.push({ schemaHash, keyHash });
      seed(state, schemaHash, keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      // fold_db's append-only no-op delete; the prior update already stamped
      // the tombstone tag, which the verify read picks up.
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
    title: `D ${slug}`,
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
    title: `T ${slug}`,
    body: "Bt",
    status: "open",
    tags: [],
    design_slug: "",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

// deleteByFilter constructs its node from cfg via the real write client, which
// hits `globalThis.fetch`. The unit tests above use a mock NodeClient for shape
// documentation, but the runtime cases stub fetch like delete.test.ts does so
// the real client path is exercised end to end.
function stubFetch(state: MockState): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const schemaHash = body.schema_name as string;
      const rows = state.store.get(schemaHash);
      const results = rows
        ? [...rows.entries()].map(([hash, fields]) => ({ fields, key: { hash, range: null } }))
        : [];
      return new Response(JSON.stringify({ ok: true, results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/mutation")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const schemaHash = body.schema as string;
      const keyHash = body.key_value?.hash as string;
      if (body.mutation_type === "update") {
        state.updateCalls.push({ schemaHash, keyHash });
        seed(state, schemaHash, keyHash, body.fields_and_values);
      }
      if (body.mutation_type === "delete") {
        state.deleteCalls.push({ schemaHash, keyHash });
      }
      return new Response(JSON.stringify({ ok: true, success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("deleteByFilter — dry-run (default)", () => {
  test("lists what WOULD be deleted, fires NO mutation, reports dryRun:true", async () => {
    const state = newMockState();
    seed(state, "designhash", "junk-a", designRow("junk-a", { tags: ["junk"] }));
    seed(state, "taskhash", "junk-b", taskRow("junk-b", { tags: ["junk"] }));
    seed(state, "designhash", "keep-me", designRow("keep-me", { tags: ["real"] }));
    const restore = stubFetch(state);
    try {
      const lines: string[] = [];
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        print: (l) => lines.push(l),
        onResult: (p) => (payload = p),
      });
      const out = lines.join("\n");
      expect(out).toContain("Would delete 2 records matching --tag junk");
      expect(out).toContain("junk-a");
      expect(out).toContain("junk-b");
      expect(out).not.toContain("keep-me");
      expect(out).toContain("Re-run with --yes");
      // The whole point of dry-run: nothing mutated.
      expect(state.updateCalls.length).toBe(0);
      expect(state.deleteCalls.length).toBe(0);
      expect(payload?.dryRun).toBe(true);
      expect(payload?.deleted.map((d) => d.slug).sort()).toEqual(["junk-a", "junk-b"]);
    } finally {
      restore();
    }
  });

  test("no matching live records → clean message, no mutation, empty payload", async () => {
    const state = newMockState();
    seed(state, "designhash", "other", designRow("other", { tags: ["nope"] }));
    const restore = stubFetch(state);
    try {
      const lines: string[] = [];
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        print: (l) => lines.push(l),
        onResult: (p) => (payload = p),
      });
      expect(lines.join("\n")).toContain("no live records match --tag junk");
      expect(state.updateCalls.length).toBe(0);
      expect(payload).toEqual({ ok: true, deleted: [], dryRun: true });
    } finally {
      restore();
    }
  });

  test("excludes already-tombstoned records (same exclusion as list)", async () => {
    const state = newMockState();
    seed(state, "designhash", "live", designRow("live", { tags: ["junk"] }));
    seed(
      state,
      "designhash",
      "dead",
      designRow("dead", { tags: [TOMBSTONE_TAG, "junk"], title: "(deleted)" }),
    );
    const restore = stubFetch(state);
    try {
      const lines: string[] = [];
      await deleteByFilter({ cfg, tag: "junk", print: (l) => lines.push(l) });
      const out = lines.join("\n");
      expect(out).toContain("Would delete 1 record matching --tag junk");
      expect(out).toContain("live");
      expect(out).not.toContain("dead");
    } finally {
      restore();
    }
  });
});

describe("deleteByFilter — --yes (apply)", () => {
  test("deletes every matching record via the tombstone path; payload dryRun:false", async () => {
    const state = newMockState();
    seed(state, "designhash", "junk-a", designRow("junk-a", { tags: ["junk"] }));
    seed(state, "taskhash", "junk-b", taskRow("junk-b", { tags: ["junk"] }));
    seed(state, "designhash", "keep-me", designRow("keep-me", { tags: ["real"] }));
    const restore = stubFetch(state);
    try {
      const lines: string[] = [];
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        yes: true,
        print: (l) => lines.push(l),
        onResult: (p) => (payload = p),
      });
      const out = lines.join("\n");
      expect(out).toContain("deleted design junk-a");
      expect(out).toContain("deleted task junk-b");
      expect(out).toContain("deleted 2 records matching --tag junk");
      // Each match got the update (tombstone) + the fold_db delete.
      expect(state.updateCalls.map((c) => c.keyHash).sort()).toEqual(["junk-a", "junk-b"]);
      expect(state.deleteCalls.map((c) => c.keyHash).sort()).toEqual(["junk-a", "junk-b"]);
      // The non-matching record was untouched.
      expect(state.updateCalls.some((c) => c.keyHash === "keep-me")).toBe(false);
      expect(payload?.dryRun).toBe(false);
      expect(payload?.deleted.map((d) => d.slug).sort()).toEqual(["junk-a", "junk-b"]);
    } finally {
      restore();
    }
  });

  test("--type narrows the batch to one schema", async () => {
    const state = newMockState();
    seed(state, "designhash", "d1", designRow("d1", { tags: ["junk"] }));
    seed(state, "taskhash", "t1", taskRow("t1", { tags: ["junk"] }));
    const restore = stubFetch(state);
    try {
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        type: "task",
        yes: true,
        print: () => {},
        onResult: (p) => (payload = p),
      });
      expect(payload?.deleted).toEqual([{ type: "task", slug: "t1" }]);
      expect(state.updateCalls.some((c) => c.keyHash === "d1")).toBe(false);
    } finally {
      restore();
    }
  });

  test("--status further narrows the batch (list semantics)", async () => {
    const state = newMockState();
    seed(state, "designhash", "open-junk", designRow("open-junk", { tags: ["junk"], status: "draft" }));
    seed(state, "designhash", "done-junk", designRow("done-junk", { tags: ["junk"], status: "archived" }));
    const restore = stubFetch(state);
    try {
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        status: "draft",
        yes: true,
        print: () => {},
        onResult: (p) => (payload = p),
      });
      expect(payload?.deleted).toEqual([{ type: "design", slug: "open-junk" }]);
    } finally {
      restore();
    }
  });
});

describe("deleteByFilter — unbounded selector guard", () => {
  test("no tag/status/type → unbounded_delete_selector, nothing touched", async () => {
    const state = newMockState();
    seed(state, "designhash", "x", designRow("x"));
    const restore = stubFetch(state);
    try {
      await expect(deleteByFilter({ cfg, print: () => {} })).rejects.toMatchObject({
        code: "unbounded_delete_selector",
      });
      expect(state.updateCalls.length).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("deleteByFilter — design referential-integrity guard in batch mode", () => {
  test("skips+warns a design with a live linked task; the rest of the batch proceeds", async () => {
    const state = newMockState();
    // A linked design + a stand-alone junk concept, both tagged junk.
    seed(state, "designhash", "linked-design", designRow("linked-design", { tags: ["junk"] }));
    seed(
      state,
      "taskhash",
      "child-task",
      // The child task points at the design but does NOT carry the junk tag,
      // so it is not itself part of the batch — it only triggers the guard.
      taskRow("child-task", { design_slug: "linked-design" }),
    );
    seed(state, "designhash", "lonely-junk", designRow("lonely-junk", { tags: ["junk"] }));
    const restore = stubFetch(state);
    try {
      const lines: string[] = [];
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        yes: true,
        print: (l) => lines.push(l),
        onResult: (p) => (payload = p),
      });
      const out = lines.join("\n");
      // Linked design skipped with an explanatory warning…
      expect(out).toContain("skipped design linked-design");
      expect(out).toContain("child-task");
      // …but the un-linked junk design WAS deleted (batch didn't abort).
      expect(out).toContain("deleted design lonely-junk");
      expect(payload?.deleted).toEqual([{ type: "design", slug: "lonely-junk" }]);
      expect(state.updateCalls.some((c) => c.keyHash === "linked-design")).toBe(false);
      expect(state.updateCalls.some((c) => c.keyHash === "lonely-junk")).toBe(true);
    } finally {
      restore();
    }
  });

  test("--force deletes a linked design too (and warns about the orphaned task)", async () => {
    const state = newMockState();
    seed(state, "designhash", "linked-design", designRow("linked-design", { tags: ["junk"] }));
    seed(state, "taskhash", "child-task", taskRow("child-task", { design_slug: "linked-design" }));
    const restore = stubFetch(state);
    try {
      const lines: string[] = [];
      let payload: DeleteBatchResult | undefined;
      await deleteByFilter({
        cfg,
        tag: "junk",
        yes: true,
        force: true,
        print: (l) => lines.push(l),
        onResult: (p) => (payload = p),
      });
      const out = lines.join("\n");
      expect(out).toContain("warning:");
      expect(out).toContain("child-task");
      expect(out).toContain("deleted design linked-design");
      expect(payload?.deleted).toEqual([{ type: "design", slug: "linked-design" }]);
    } finally {
      restore();
    }
  });
});

// Touch the documentation-only mock helper so the file doesn't accumulate an
// orphan export (the runtime cases use stubFetch, mirroring delete.test.ts).
void mockNode;

// FbrainError is imported for the type position in the guard assertions above;
// reference it so an unused-import lint never trips.
void FbrainError;
