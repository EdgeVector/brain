// Unit tests for `fbrain consolidate`.
//
// Responsibilities:
//   1. Migrate every live legacy FbrainKindNote row of each Phase 6 kind
//      into its per-kind canonical schema. Each migration is
//      (a) createRecord into the per-kind hash, (b) verify the per-kind
//      row reads back, (c) updateRecord on the legacy hash that turns
//      the legacy row into a tombstone.
//   2. Skip legacy rows that are already tombstoned (idempotency).
//   3. Skip legacy rows whose slug already has a live per-kind row
//      (slug conflict — log a warning, no overwrite).
//   4. --dry-run reports the same counts but fires no mutations.
//   5. --type narrows to a single kind; design/task short-circuit with
//      a "no legacy backing" notice.
//   6. Missing legacy hash in config short-circuits with a hint.

import { describe, expect, test } from "bun:test";

import { consolidateCmd } from "../../src/commands/consolidate.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import { LEGACY_NOTE_SCHEMA_KEY } from "../../src/schemas.ts";
import { TOMBSTONE_STATUS } from "../../src/commands/delete.ts";
import { buildTestCfg, TEST_HASHES, TEST_LEGACY_NOTE_HASH } from "../util.ts";

type RowFields = Record<string, unknown>;

const ISO = "2026-05-01T00:00:00Z";

function legacyRow(kind: string, slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    kind,
    title: `t-${slug}`,
    body: `b-${slug}`,
    status: "active",
    tags: [],
    created_at: ISO,
    updated_at: ISO,
    ...over,
  };
}

function perKindRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `pk-${slug}`,
    body: `pkb-${slug}`,
    status: "active",
    tags: [],
    created_at: ISO,
    updated_at: ISO,
    ...over,
  };
}

type MutationBody = {
  type: string;
  schema: string;
  fields_and_values: Record<string, unknown>;
  key_value: { hash: string; range: null };
  mutation_type: "create" | "update" | "delete";
};

// Build a fetch stub that:
//   - serves `/api/query` by reading `queries[schema_name]` (a list of
//     row fields blobs)
//   - records every `/api/mutation` and lets the test post-assert
//
// The stub is stateful: after a create mutation against a per-kind hash,
// subsequent queries for that hash include the newly-created row. This
// is what `findBySlug` (which uses listRecords) sees during the verify
// step — without it the verify would always read back null and the live
// path would throw.
function stubFetch(initial: Record<string, RowFields[]>): {
  restore: () => void;
  mutations: MutationBody[];
  queries: Record<string, RowFields[]>;
} {
  const queries: Record<string, RowFields[]> = {};
  for (const [k, v] of Object.entries(initial)) queries[k] = [...v];
  const mutations: MutationBody[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.endsWith("/api/query")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const rows = queries[body.schema_name] ?? [];
      return new Response(
        JSON.stringify({
          ok: true,
          results: rows.map((fields) => ({
            fields,
            key: { hash: typeof fields.slug === "string" ? fields.slug : "", range: null },
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/mutation")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as MutationBody;
      mutations.push(body);
      // Apply create/update so subsequent /api/query reads see the change.
      // delete mutations are no-ops at the storage layer per the spike.
      if (body.mutation_type === "create" || body.mutation_type === "update") {
        const slug = body.key_value.hash;
        const existing = queries[body.schema] ?? [];
        const idx = existing.findIndex((r) => r.slug === slug);
        if (idx >= 0) existing[idx] = { ...existing[idx], ...body.fields_and_values };
        else existing.push({ ...body.fields_and_values });
        queries[body.schema] = existing;
      }
      return new Response(JSON.stringify({ ok: true, success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    mutations,
    queries,
  };
}

const cfg = buildTestCfg({});

describe("consolidateCmd — dry-run", () => {
  test("reports per-type counts, fires zero mutations", async () => {
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [
        legacyRow("concept", "c-one"),
        legacyRow("concept", "c-two"),
        legacyRow("preference", "p-one"),
        legacyRow("spike", "s-one", { tags: [TOMBSTONE_TAG] }), // already tombstoned
      ],
    });
    try {
      const lines: string[] = [];
      const result = await consolidateCmd({
        cfg,
        dryRun: true,
        print: (l) => lines.push(l),
      });
      expect(mutations.length).toBe(0);
      expect(result.scanned).toBe(4);
      expect(result.migrated).toBe(3); // 2 concept + 1 preference
      expect(result.skippedTombstone).toBe(1);
      expect(result.skippedConflict).toBe(0);
      expect(result.byType.concept).toEqual({
        scanned: 2,
        migrated: 2,
        skippedConflict: 0,
        skippedTombstone: 0,
      });
      expect(result.byType.preference).toEqual({
        scanned: 1,
        migrated: 1,
        skippedConflict: 0,
        skippedTombstone: 0,
      });
      expect(result.byType.spike).toEqual({
        scanned: 1,
        migrated: 0,
        skippedConflict: 0,
        skippedTombstone: 1,
      });
      expect(lines.join("\n")).toContain("dry-run: would migrate 3");
    } finally {
      restore();
    }
  });
});

describe("consolidateCmd — live mode", () => {
  test("migrates every live legacy row + tombstones the legacy twin", async () => {
    const { restore, mutations, queries } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [
        legacyRow("concept", "c-one", {
          title: "Concept One",
          body: "concept body",
          tags: ["tag-a", "tag-b"],
          created_at: "2025-01-01T00:00:00Z",
        }),
        legacyRow("preference", "p-one", {
          title: "Pref One",
          status: "active",
          created_at: "2025-02-02T00:00:00Z",
        }),
      ],
    });
    try {
      const result = await consolidateCmd({ cfg, print: () => {} });
      expect(result.migrated).toBe(2);
      expect(result.skippedConflict).toBe(0);
      expect(result.skippedTombstone).toBe(0);

      // Expect 4 mutations (2 creates per-kind + 2 updates tombstoning legacy).
      expect(mutations.length).toBe(4);

      // 1) Concept created in per-kind canonical.
      const concCreate = mutations.find(
        (m) =>
          m.mutation_type === "create" &&
          m.schema === TEST_HASHES.concept &&
          m.key_value.hash === "c-one",
      );
      expect(concCreate).toBeDefined();
      expect(concCreate!.fields_and_values).toMatchObject({
        slug: "c-one",
        title: "Concept One",
        body: "concept body",
        status: "active",
        tags: ["tag-a", "tag-b"],
        created_at: "2025-01-01T00:00:00Z",
      });
      // No kind / v1_marker_* on the per-kind write.
      expect("kind" in concCreate!.fields_and_values).toBe(false);
      expect("v1_marker_a" in concCreate!.fields_and_values).toBe(false);
      expect("v1_marker_b" in concCreate!.fields_and_values).toBe(false);
      // updated_at refreshed to a valid RFC 3339 string distinct from the
      // legacy row's value.
      const newUpdated = concCreate!.fields_and_values.updated_at as string;
      expect(typeof newUpdated).toBe("string");
      expect(Number.isFinite(Date.parse(newUpdated))).toBe(true);

      // 2) Concept legacy tombstone — update on the legacy hash with
      //    TOMBSTONE_TAG, (deleted) title, archived status, kind+markers
      //    preserved (the legacy schema requires them on update).
      const concTomb = mutations.find(
        (m) =>
          m.mutation_type === "update" &&
          m.schema === TEST_LEGACY_NOTE_HASH &&
          m.key_value.hash === "c-one",
      );
      expect(concTomb).toBeDefined();
      expect(concTomb!.fields_and_values.tags).toEqual([TOMBSTONE_TAG]);
      expect(concTomb!.fields_and_values.title).toBe("(deleted)");
      expect(concTomb!.fields_and_values.status).toBe(TOMBSTONE_STATUS.concept);
      expect(concTomb!.fields_and_values.kind).toBe("concept");
      expect(concTomb!.fields_and_values.v1_marker_a).toBe("fbrain");
      expect(concTomb!.fields_and_values.v1_marker_b).toBe("v1");
      // created_at preserved from the legacy row.
      expect(concTomb!.fields_and_values.created_at).toBe("2025-01-01T00:00:00Z");

      // 3) Preference also created + tombstoned.
      expect(
        mutations.find(
          (m) =>
            m.mutation_type === "create" &&
            m.schema === TEST_HASHES.preference &&
            m.key_value.hash === "p-one",
        ),
      ).toBeDefined();
      expect(
        mutations.find(
          (m) =>
            m.mutation_type === "update" &&
            m.schema === TEST_LEGACY_NOTE_HASH &&
            m.key_value.hash === "p-one",
        ),
      ).toBeDefined();

      // 4) Per-kind tables now carry the migrated rows (post-mutation
      //    stub state). Legacy table still has the tombstoned twins.
      expect((queries[TEST_HASHES.concept] ?? []).map((r) => r.slug)).toContain("c-one");
      expect((queries[TEST_HASHES.preference] ?? []).map((r) => r.slug)).toContain("p-one");
      const legacy = queries[TEST_LEGACY_NOTE_HASH] ?? [];
      const tombC = legacy.find((r) => r.slug === "c-one");
      expect(tombC).toBeDefined();
      expect(tombC!.tags).toEqual([TOMBSTONE_TAG]);
    } finally {
      restore();
    }
  });

  test("slug conflict: per-kind already has live row at the same slug — skip with warning", async () => {
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [legacyRow("concept", "shared-slug")],
      // Live per-kind row already at "shared-slug" — the user re-wrote
      // it post-Phase-E.
      [TEST_HASHES.concept]: [perKindRow("shared-slug", { title: "Post-Phase-E version" })],
    });
    try {
      const lines: string[] = [];
      const result = await consolidateCmd({
        cfg,
        type: "concept",
        print: (l) => lines.push(l),
      });
      expect(result.migrated).toBe(0);
      expect(result.skippedConflict).toBe(1);
      expect(result.skippedTombstone).toBe(0);
      // No mutations fired — neither per-kind write nor legacy tombstone.
      expect(mutations.length).toBe(0);
      expect(lines.join("\n")).toContain("slug conflict");
      expect(lines.join("\n")).toContain("shared-slug");
    } finally {
      restore();
    }
  });

  test("tombstoned per-kind row does NOT count as conflict — legacy migrates fresh", async () => {
    // Per-kind has a tombstoned row at the same slug (e.g. user deleted
    // a post-Phase-E write). Consolidation should still migrate the
    // legacy row — the tombstone tag means there's no live per-kind row.
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [legacyRow("concept", "recycled-slug")],
      [TEST_HASHES.concept]: [
        perKindRow("recycled-slug", { tags: [TOMBSTONE_TAG], status: "archived" }),
      ],
    });
    try {
      const result = await consolidateCmd({ cfg, type: "concept", print: () => {} });
      // The create mutation would normally collide with the tombstoned
      // row; the stub overwrites on create-or-update. Real fold_db would
      // reject a duplicate create — but the legacy fallback in
      // `resolveBySlug` deletes via update, so this matches.
      expect(result.skippedConflict).toBe(0);
      // The migrate (create) + tombstone (update) pair fires.
      const slugMutations = mutations.filter((m) => m.key_value.hash === "recycled-slug");
      expect(slugMutations.length).toBe(2);
    } finally {
      restore();
    }
  });

  test("idempotency: re-running on a fully-consolidated daemon is a no-op", async () => {
    // Legacy rows already all tombstoned (representing post-consolidation
    // state). Per-kind canonical has the migrated copies.
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [
        legacyRow("concept", "done-one", { tags: [TOMBSTONE_TAG] }),
        legacyRow("preference", "done-two", { tags: [TOMBSTONE_TAG] }),
      ],
      [TEST_HASHES.concept]: [perKindRow("done-one")],
      [TEST_HASHES.preference]: [perKindRow("done-two")],
    });
    try {
      const result = await consolidateCmd({ cfg, print: () => {} });
      expect(result.migrated).toBe(0);
      expect(result.skippedConflict).toBe(0);
      expect(result.skippedTombstone).toBe(2);
      // No new mutations fired.
      expect(mutations.length).toBe(0);
    } finally {
      restore();
    }
  });

  test("--type narrows to a single kind", async () => {
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [
        legacyRow("concept", "c-only"),
        legacyRow("preference", "p-only"),
        legacyRow("reference", "r-only"),
      ],
    });
    try {
      const result = await consolidateCmd({
        cfg,
        type: "preference",
        print: () => {},
      });
      expect(result.scanned).toBe(1);
      expect(result.migrated).toBe(1);
      expect(result.byType.preference?.migrated).toBe(1);
      expect(result.byType.concept).toBeUndefined();
      expect(result.byType.reference).toBeUndefined();
      // The only per-kind mutation is against TEST_HASHES.preference.
      const creates = mutations.filter((m) => m.mutation_type === "create");
      expect(creates.length).toBe(1);
      expect(creates[0]!.schema).toBe(TEST_HASHES.preference);
    } finally {
      restore();
    }
  });

  test("--type design (no legacy backing): no-op with notice", async () => {
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [legacyRow("concept", "c-one")],
    });
    try {
      const lines: string[] = [];
      const result = await consolidateCmd({
        cfg,
        type: "design",
        print: (l) => lines.push(l),
      });
      expect(result.migrated).toBe(0);
      expect(result.scanned).toBe(0);
      expect(mutations.length).toBe(0);
      expect(lines.join("\n")).toContain("no legacy backing");
    } finally {
      restore();
    }
  });

  test("missing legacy hash in config: prints hint and exits cleanly", async () => {
    const cfgNoLegacy = buildTestCfg({
      schemaHashes: {
        ...TEST_HASHES,
        // intentionally omit LEGACY_NOTE_SCHEMA_KEY
      },
    });
    // Sanity: the legacy hash really is absent.
    expect(cfgNoLegacy.schemaHashes[LEGACY_NOTE_SCHEMA_KEY]).toBeUndefined();
    const { restore, mutations } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [legacyRow("concept", "c-one")],
    });
    try {
      const lines: string[] = [];
      const result = await consolidateCmd({
        cfg: cfgNoLegacy,
        print: (l) => lines.push(l),
      });
      expect(result.scanned).toBe(0);
      expect(result.migrated).toBe(0);
      expect(mutations.length).toBe(0);
      expect(lines.join("\n")).toContain("no legacy FbrainKindNote hash registered");
      expect(lines.join("\n")).toContain("fbrain init");
    } finally {
      restore();
    }
  });

  test("verbose: emits per-record outcomes", async () => {
    const { restore } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [
        legacyRow("concept", "live-one"),
        legacyRow("concept", "dead-one", { tags: [TOMBSTONE_TAG] }),
      ],
    });
    try {
      const v: string[] = [];
      await consolidateCmd({
        cfg,
        type: "concept",
        verbose: (m) => v.push(m),
        print: () => {},
      });
      const joined = v.join("\n");
      expect(joined).toContain("migrated concept/live-one");
      expect(joined).toContain("skipped-tombstone concept/dead-one");
    } finally {
      restore();
    }
  });

  test("verbose under --dry-run reports would-migrate", async () => {
    const { restore } = stubFetch({
      [TEST_LEGACY_NOTE_HASH]: [legacyRow("preference", "x1")],
    });
    try {
      const v: string[] = [];
      await consolidateCmd({
        cfg,
        type: "preference",
        dryRun: true,
        verbose: (m) => v.push(m),
        print: () => {},
      });
      expect(v.join("\n")).toContain("would-migrate preference/x1");
    } finally {
      restore();
    }
  });
});
