// Unit tests for `fbrain migrate` (G15). Stubbed fetch — no harness.
//
// Covers:
//   - --add-field on a Phase 6 type re-puts every Phase 6 record under
//     the new hash and swaps all six schemaHashes entries together.
//   - --add-field on Design (non-Phase 6) only touches Design records
//     and only swaps schemaHashes.design.
//   - --dry-run writes a manifest but no records and does not swap.
//   - --resume re-enters after a simulated mid-flight failure and
//     completes the migration (idempotent skip of already-migrated
//     records).
//   - --status prints a tabular listing.
//   - --default validation flows through to the user.
//   - buildMigratedFields preserves user fields and stamps the new
//     field at the default.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateCmd, buildMigratedFields } from "../../src/commands/migrate.ts";
import {
  listManifests,
  versionMarkerField,
  MIGRATION_DIR_ENV,
  type MigrationManifest,
} from "../../src/migration.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";
import { TOMBSTONE_TAG, type FbrainRecord } from "../../src/record.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const NEW_HASH = "d".repeat(64); // synthetic "to_hash" returned by the stubbed schema-service.

let savedEnv: string | undefined;
let tmpMigrations = "";
let tmpConfigDir = "";
let configPath = "";

beforeEach(() => {
  savedEnv = process.env[MIGRATION_DIR_ENV];
  tmpMigrations = mkdtempSync(join(tmpdir(), "fbrain-migrate-test-"));
  tmpConfigDir = mkdtempSync(join(tmpdir(), "fbrain-migrate-cfg-"));
  configPath = join(tmpConfigDir, "config.json");
  process.env[MIGRATION_DIR_ENV] = tmpMigrations;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[MIGRATION_DIR_ENV];
  else process.env[MIGRATION_DIR_ENV] = savedEnv;
  rmSync(tmpMigrations, { recursive: true, force: true });
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

function writeStartingConfig(cfg: Config): void {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function readConfigOnDisk(): Config {
  return JSON.parse(readFileSync(configPath, "utf8")) as Config;
}

type RowFields = Record<string, unknown>;

function conceptRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    kind: "concept",
    title: `c-${slug}`,
    body: `body-${slug}`,
    status: "active",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    v1_marker_a: "fbrain",
    v1_marker_b: "v1",
    ...over,
  };
}

function preferenceRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return { ...conceptRow(slug), kind: "preference", status: "active", ...over };
}

function designRow(slug: string, over: Partial<RowFields> = {}): RowFields {
  return {
    slug,
    title: `d-${slug}`,
    body: `body-${slug}`,
    status: "draft",
    tags: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  };
}

// Build a synthetic fetch stub. Tracks per-schema query results,
// records every mutation, and answers schema-service /v1/schemas POST
// with a fixed `to_hash`. The /v1/schema/<hash> GET (used by migrate's
// post-registration sanity check) returns a schema whose field set
// includes whatever fields the most recent POST registered.
function stubFetch(opts: {
  // Records returned for /api/query keyed by `schema_name` in body.
  queries: Record<string, RowFields[]>;
  // Records already present at the destination (resume idempotency
  // probe). Keyed by `to_hash`. Looked up by slug after each mutation.
  presentAtTarget?: Record<string, Set<string>>;
  newSchemaHash?: string;
  failOnRequest?: (req: { url: string; body: unknown }) => Error | undefined;
  // Force the post-registration sanity check to fail: the schema
  // returned by GET /v1/schema/<hash> will have its fields list set
  // to this. Use to model the fold_db overlap-merge bug.
  postRegisteredFields?: string[];
}): {
  restore: () => void;
  mutations: Array<{ schema: string; mutation_type: string; fields_and_values: Record<string, unknown>; key_value: { hash: string } }>;
  schemaRegistrations: number;
  schemaLoads: number;
} {
  const originalFetch = globalThis.fetch;
  const mutations: Array<{
    schema: string;
    mutation_type: string;
    fields_and_values: Record<string, unknown>;
    key_value: { hash: string };
  }> = [];
  const present = opts.presentAtTarget ?? {};
  let schemaRegistrations = 0;
  let schemaLoads = 0;
  // Track the most recent POST'd schema so the subsequent GET can
  // mirror its fields back (modelling fold_db's normal "returned schema
  // == registered schema" behavior). When opts.postRegisteredFields is
  // set we use that instead to simulate the overlap-merge case.
  let lastPostedFields: string[] = [];

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const failure = opts.failOnRequest?.({ url, body });
    if (failure) throw failure;

    if (url.endsWith("/v1/schemas") && init?.method === "POST") {
      schemaRegistrations++;
      const postedSchema = (body as { schema?: { fields?: string[] } } | undefined)?.schema;
      lastPostedFields = postedSchema?.fields ?? [];
      return new Response(
        JSON.stringify({ schema: { name: opts.newSchemaHash ?? NEW_HASH } }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/schema/") && (init?.method === "GET" || init?.method === undefined)) {
      const hash = url.split("/v1/schema/")[1] ?? "";
      const fields = opts.postRegisteredFields ?? lastPostedFields;
      return new Response(
        JSON.stringify({
          schema: {
            name: hash,
            descriptive_name: "FbrainKindNote_v2",
            schema_type: "Hash",
            fields,
            field_types: Object.fromEntries(fields.map((f) => [f, "String"])),
          },
          system: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/schemas/load")) {
      schemaLoads++;
      return new Response(
        JSON.stringify({
          available_schemas_loaded: 4,
          schemas_loaded_to_db: 4,
          failed_schemas: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/query")) {
      const schema = (body as { schema_name: string }).schema_name;
      // For the resume / idempotency path, the migrate command queries
      // the destination hash via listRecords. We model that by
      // returning rows for to_hash from `presentAtTarget`.
      if (present[schema]) {
        const rows: RowFields[] = [];
        for (const slug of present[schema]) {
          // Minimal shape — just enough that findBySlugRaw finds it.
          rows.push({ slug, kind: "concept", title: slug, body: "", status: "active", tags: [], created_at: "", updated_at: "", v1_marker_a: "fbrain", v1_marker_b: "v1" });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            results: rows.map((f) => ({ fields: f, key: { hash: f.slug, range: null } })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const rows = opts.queries[schema] ?? [];
      return new Response(
        JSON.stringify({
          ok: true,
          results: rows.map((f) => ({ fields: f, key: { hash: f.slug, range: null } })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/mutation")) {
      mutations.push(body as typeof mutations[number]);
      // Track newly-created records under the destination hash so a
      // subsequent /api/query against to_hash sees them (used by resume
      // idempotency).
      if ((body as { mutation_type: string }).mutation_type === "create") {
        const schema = (body as { schema: string }).schema;
        const slug = (body as { key_value: { hash: string } }).key_value.hash;
        present[schema] = present[schema] ?? new Set<string>();
        present[schema].add(slug);
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
      globalThis.fetch = originalFetch;
    },
    mutations,
    get schemaRegistrations() {
      return schemaRegistrations;
    },
    get schemaLoads() {
      return schemaLoads;
    },
  };
}

describe("buildMigratedFields", () => {
  test("Phase 6: preserves body/tags, stamps kind + v1 markers, adds new field at default + version marker, bumps updated_at", () => {
    const rec: FbrainRecord = {
      slug: "c1",
      title: "T",
      body: "Body",
      status: "active",
      tags: ["x", TOMBSTONE_TAG],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
      kind: "concept",
    };
    const out = buildMigratedFields("concept", rec, "urgency", "normal", "2026-05-24T20:00:00Z", "FbrainKindNote_v2");
    expect(out.slug).toBe("c1");
    expect(out.title).toBe("T");
    expect(out.body).toBe("Body");
    expect(out.tags).toEqual(["x", TOMBSTONE_TAG]); // tombstone preserved
    expect(out.kind).toBe("concept");
    expect(out.v1_marker_a).toBe("fbrain");
    expect(out.v1_marker_b).toBe("v1");
    expect(out.created_at).toBe("2026-01-01T00:00:00Z");
    expect(out.updated_at).toBe("2026-05-24T20:00:00Z");
    expect(out.urgency).toBe("normal");
    // Per-migration version marker stamped.
    expect(out[versionMarkerField("FbrainKindNote_v2")]).toBe("FbrainKindNote_v2");
  });

  test("Design: no kind / markers; design_slug omitted for design", () => {
    const rec: FbrainRecord = {
      slug: "d1", title: "T", body: "B", status: "draft", tags: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
    };
    const out = buildMigratedFields("design", rec, "priority", "P0", "2026-05-24T20:00:00Z", "Design_v2");
    expect("kind" in out).toBe(false);
    expect("v1_marker_a" in out).toBe(false);
    expect("design_slug" in out).toBe(false);
    expect(out.priority).toBe("P0");
    expect(out[versionMarkerField("Design_v2")]).toBe("Design_v2");
  });

  test("Array:String default lands as an array", () => {
    const rec: FbrainRecord = {
      slug: "c1", title: "T", body: "B", status: "active", tags: [], created_at: "", updated_at: "", kind: "concept",
    };
    const out = buildMigratedFields("concept", rec, "watchers", ["alice", "bob"], "2026-05-24T20:00:00Z");
    expect(out.watchers).toEqual(["alice", "bob"]);
  });
});

describe("migrateCmd post-registration sanity check", () => {
  test("errors clearly when the schema service overlap-merges our new field away", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);
    const stub = stubFetch({
      queries: {},
      // Simulate the merge bug: the registered schema returns *without*
      // our requested field.
      postRegisteredFields: [
        "slug", "title", "body", "status", "tags", "created_at", "updated_at",
        "old_field_from_prior_run", // <- this is what survived the merge
      ],
    });
    try {
      await expect(
        migrateCmd({
          cfg,
          mode: { kind: "add-field", type: "design", fieldName: "priority", fieldSpec: "String", defaultRaw: "P0" },
          print: () => {},
          migrationsDir: tmpMigrations,
          configPath,
        }),
      ).rejects.toThrow(/Schema service collapsed/);
      // The mutation pipeline never fired (we bailed before re-put).
      expect(stub.mutations.length).toBe(0);
    } finally {
      stub.restore();
    }
  });
});

describe("migrateCmd --add-field", () => {
  test("Phase 6: re-puts every Phase 6 record (regardless of named --type) and swaps all six hashes", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);
    // We model a real setup where all six Phase 6 types share one hash:
    // here we point them at TEST_HASHES.concept so listRecords queries
    // converge. The migrate command reads from_hash = schemaHashes[first
    // affected type] = concept's hash.
    const sharedNoteHash = TEST_HASHES.concept;
    const cfgShared = buildTestCfg({
      schemaHashes: {
        ...cfg.schemaHashes,
        concept: sharedNoteHash,
        preference: sharedNoteHash,
        reference: sharedNoteHash,
        agent: sharedNoteHash,
        project: sharedNoteHash,
        spike: sharedNoteHash,
      },
    });
    writeStartingConfig(cfgShared);

    const stub = stubFetch({
      queries: {
        [sharedNoteHash]: [
          conceptRow("c1"),
          conceptRow("c2"),
          preferenceRow("p1"),
        ],
      },
    });
    try {
      const lines: string[] = [];
      const result = await migrateCmd({
        cfg: cfgShared,
        mode: { kind: "add-field", type: "concept", fieldName: "urgency", fieldSpec: "String", defaultRaw: "normal" },
        print: (l) => lines.push(l),
        migrationsDir: tmpMigrations,
        configPath,
      });
      expect(result.manifest).toBeDefined();
      expect(result.manifest!.status).toBe("complete");
      expect(result.manifest!.scope.affected_types).toEqual([
        "concept", "preference", "reference", "agent", "project", "spike",
      ]);

      // listRecords filters by kind, so only c1, c2, p1 (3 records) are
      // re-put despite the query returning them all under the shared
      // hash for every iteration. Each affected_type iteration walks
      // the shared hash and filters by its own kind.
      const creates = stub.mutations.filter((m) => m.mutation_type === "create");
      expect(creates.length).toBe(3);
      expect(creates.every((m) => m.schema === NEW_HASH)).toBe(true);
      const slugs = new Set(creates.map((m) => m.key_value.hash));
      expect(slugs).toEqual(new Set(["c1", "c2", "p1"]));

      // Schema registration + load fired exactly once.
      expect(stub.schemaRegistrations).toBe(1);
      expect(stub.schemaLoads).toBe(1);

      // Config swap: every Phase 6 type now points at NEW_HASH.
      const swapped = readConfigOnDisk();
      for (const t of ["concept", "preference", "reference", "agent", "project", "spike"] as const) {
        expect(swapped.schemaHashes[t]).toBe(NEW_HASH);
      }
      // Design/Task unaffected.
      expect(swapped.schemaHashes.design).toBe(TEST_HASHES.design);
      expect(swapped.schemaHashes.task).toBe(TEST_HASHES.task);

      // Manifest persisted as complete with the right counts.
      const manifests = listManifests(tmpMigrations);
      expect(manifests.length).toBe(1);
      expect(manifests[0]!.status).toBe("complete");
      expect(manifests[0]!.migrated_count).toBe(3);
      expect(manifests[0]!.field_added).toBe("urgency");
      expect(manifests[0]!.default).toBe("normal");

      // Summary line in stdout.
      const joined = lines.join("\n");
      expect(joined).toContain("migrated 3/3 record(s)");
      expect(joined).toContain("field=urgency=\"normal\"");
      expect(joined).toContain("note: update src/schemas.ts");
    } finally {
      stub.restore();
    }
  });

  test("Design migration: only touches Design records and only swaps schemaHashes.design", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);

    const stub = stubFetch({
      queries: {
        [TEST_HASHES.design]: [designRow("d1"), designRow("d2")],
        [TEST_HASHES.task]: [],
      },
    });
    try {
      await migrateCmd({
        cfg,
        mode: { kind: "add-field", type: "design", fieldName: "priority", fieldSpec: "String", defaultRaw: "P0" },
        print: () => {},
        migrationsDir: tmpMigrations,
        configPath,
      });
      const creates = stub.mutations.filter((m) => m.mutation_type === "create");
      expect(creates.length).toBe(2);
      expect(creates.every((m) => m.schema === NEW_HASH)).toBe(true);

      const swapped = readConfigOnDisk();
      expect(swapped.schemaHashes.design).toBe(NEW_HASH);
      expect(swapped.schemaHashes.task).toBe(TEST_HASHES.task);
      // Phase 6 types untouched.
      expect(swapped.schemaHashes.concept).toBe(TEST_HASHES.concept);
    } finally {
      stub.restore();
    }
  });

  test("--dry-run: registers the schema + writes manifest as dry_run; no record writes, no config swap", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);

    const stub = stubFetch({
      queries: { [TEST_HASHES.design]: [designRow("d1"), designRow("d2")] },
    });
    try {
      await migrateCmd({
        cfg,
        mode: { kind: "add-field", type: "design", fieldName: "priority", fieldSpec: "String", defaultRaw: "P0", dryRun: true },
        print: () => {},
        migrationsDir: tmpMigrations,
        configPath,
      });

      // No create mutations fired.
      const creates = stub.mutations.filter((m) => m.mutation_type === "create");
      expect(creates.length).toBe(0);

      // Config still pointed at the original hash.
      const swapped = readConfigOnDisk();
      expect(swapped.schemaHashes.design).toBe(TEST_HASHES.design);

      // Manifest exists with status=dry_run and total_count reflects what would have been migrated.
      const manifests = listManifests(tmpMigrations);
      expect(manifests.length).toBe(1);
      expect(manifests[0]!.status).toBe("dry_run");
      expect(manifests[0]!.total_count).toBe(2);
      expect(manifests[0]!.migrated_count).toBe(0);
    } finally {
      stub.restore();
    }
  });

  test("--resume: picks up a mid-flight failure and completes the migration idempotently", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);

    // First run: inject a failure after the first create — manifest
    // ends up in_progress, config still unswapped.
    const stub1 = stubFetch({
      queries: { [TEST_HASHES.design]: [designRow("d1"), designRow("d2"), designRow("d3")] },
    });
    try {
      await expect(
        migrateCmd({
          cfg,
          mode: { kind: "add-field", type: "design", fieldName: "priority", fieldSpec: "String", defaultRaw: "P0" },
          print: () => {},
          migrationsDir: tmpMigrations,
          configPath,
          failAfterRecords: 1, // throw after the first create
        }),
      ).rejects.toThrow(/Injected mid-flight failure/);

      // Manifest is in_progress with migrated_count=1.
      const mid = listManifests(tmpMigrations);
      expect(mid.length).toBe(1);
      expect(mid[0]!.status).toBe("in_progress");
      expect(mid[0]!.migrated_count).toBe(1);

      // Config still pointed at the original hash (no swap yet).
      expect(readConfigOnDisk().schemaHashes.design).toBe(TEST_HASHES.design);
    } finally {
      stub1.restore();
    }

    // Second run: --resume completes the remaining writes + swaps.
    // The first record (d1) was already written under NEW_HASH — model
    // that via `presentAtTarget`. The stub's per-create tracking will
    // populate it after each new write.
    const stub2 = stubFetch({
      queries: { [TEST_HASHES.design]: [designRow("d1"), designRow("d2"), designRow("d3")] },
      presentAtTarget: { [NEW_HASH]: new Set(["d1"]) },
    });
    try {
      const manifestId = listManifests(tmpMigrations)[0]!.id;
      const lines: string[] = [];
      await migrateCmd({
        cfg,
        mode: { kind: "resume", manifestId },
        print: (l) => lines.push(l),
        migrationsDir: tmpMigrations,
        configPath,
      });
      // Only 2 new creates (d2, d3) — d1 already present.
      const creates = stub2.mutations.filter((m) => m.mutation_type === "create");
      expect(creates.length).toBe(2);
      const slugs = new Set(creates.map((m) => m.key_value.hash));
      expect(slugs).toEqual(new Set(["d2", "d3"]));

      // Manifest now complete.
      const after = listManifests(tmpMigrations)[0]!;
      expect(after.status).toBe("complete");
      // 1 was already migrated in the first run; 2 more in the resume = 3 total.
      expect(after.migrated_count).toBe(3);

      // Config swapped.
      expect(readConfigOnDisk().schemaHashes.design).toBe(NEW_HASH);
    } finally {
      stub2.restore();
    }
  });

  test("--status with no manifests prints an empty notice; with manifests it tabulates", async () => {
    const cfg = buildTestCfg();
    const lines1: string[] = [];
    await migrateCmd({
      cfg,
      mode: { kind: "status" },
      print: (l) => lines1.push(l),
      migrationsDir: tmpMigrations,
    });
    expect(lines1.join("\n")).toContain("(no migrations recorded");

    // Seed one manifest.
    const seeded: MigrationManifest = {
      id: "2026-05-24T22-30-00-000Z-add-design-priority",
      scope: { schema_key: "design", affected_types: ["design"] },
      from_hash: TEST_HASHES.design,
      to_hash: NEW_HASH,
      descriptive_name_from: "Design",
      descriptive_name_to: "Design_v2",
      field_added: "priority",
      field_type: "String",
      default: "P0",
      applied_at: "2026-05-24T22:30:00.000Z",
      status: "complete",
      migrated_count: 2,
      total_count: 2,
    };
    writeFileSync(join(tmpMigrations, `${seeded.id}.json`), JSON.stringify(seeded, null, 2), "utf8");

    const lines2: string[] = [];
    await migrateCmd({
      cfg,
      mode: { kind: "status" },
      print: (l) => lines2.push(l),
      migrationsDir: tmpMigrations,
    });
    const out = lines2.join("\n");
    expect(out).toContain("add-design-priority");
    expect(out).toContain("complete");
    expect(out).toContain("priority=P0");
    expect(out).toContain("2/2");
  });

  test("--default missing for String surfaces a clear error before touching the network", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);
    const stub = stubFetch({ queries: {} });
    try {
      await expect(
        migrateCmd({
          cfg,
          mode: { kind: "add-field", type: "design", fieldName: "priority", fieldSpec: "String" },
          print: () => {},
          migrationsDir: tmpMigrations,
          configPath,
        }),
      ).rejects.toThrow(/required for String/);
      // No schema registration fired.
      expect(stub.schemaRegistrations).toBe(0);
    } finally {
      stub.restore();
    }
  });

  test("refuses to add a field that already exists on the schema", async () => {
    const cfg = buildTestCfg();
    writeStartingConfig(cfg);
    const stub = stubFetch({ queries: {} });
    try {
      await expect(
        migrateCmd({
          cfg,
          mode: { kind: "add-field", type: "concept", fieldName: "tags", fieldSpec: "Array:String" },
          print: () => {},
          migrationsDir: tmpMigrations,
          configPath,
        }),
      ).rejects.toThrow(/already exists/);
      expect(stub.schemaRegistrations).toBe(0);
    } finally {
      stub.restore();
    }
  });

  test("--resume refuses a dry_run manifest", async () => {
    const seeded: MigrationManifest = {
      id: "2026-05-24T22-30-00-000Z-add-design-priority",
      scope: { schema_key: "design", affected_types: ["design"] },
      from_hash: TEST_HASHES.design,
      to_hash: NEW_HASH,
      descriptive_name_from: "Design",
      descriptive_name_to: "Design_v2",
      field_added: "priority",
      field_type: "String",
      default: "P0",
      applied_at: "2026-05-24T22:30:00.000Z",
      status: "dry_run",
      migrated_count: 0,
      total_count: 0,
    };
    writeFileSync(join(tmpMigrations, `${seeded.id}.json`), JSON.stringify(seeded, null, 2), "utf8");

    const cfg = buildTestCfg();
    await expect(
      migrateCmd({
        cfg,
        mode: { kind: "resume", manifestId: seeded.id },
        print: () => {},
        migrationsDir: tmpMigrations,
      }),
    ).rejects.toThrow(/Cannot --resume a dry-run/);
  });

  test("--resume on an already-complete manifest is a no-op", async () => {
    const seeded: MigrationManifest = {
      id: "2026-05-24T22-30-00-000Z-add-design-priority",
      scope: { schema_key: "design", affected_types: ["design"] },
      from_hash: TEST_HASHES.design,
      to_hash: NEW_HASH,
      descriptive_name_from: "Design",
      descriptive_name_to: "Design_v2",
      field_added: "priority",
      field_type: "String",
      default: "P0",
      applied_at: "2026-05-24T22:30:00.000Z",
      status: "complete",
      migrated_count: 0,
      total_count: 0,
    };
    writeFileSync(join(tmpMigrations, `${seeded.id}.json`), JSON.stringify(seeded, null, 2), "utf8");

    const cfg = buildTestCfg();
    const lines: string[] = [];
    const stub = stubFetch({ queries: {} });
    try {
      await migrateCmd({
        cfg,
        mode: { kind: "resume", manifestId: seeded.id },
        print: (l) => lines.push(l),
        migrationsDir: tmpMigrations,
      });
      expect(lines.join("\n")).toContain("already complete");
      expect(stub.mutations.length).toBe(0);
    } finally {
      stub.restore();
    }
  });
});
