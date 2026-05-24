// Unit tests for doctor. Inject mock SchemaServiceClient + NodeClient
// factories so we can exercise each drift dimension and the verdict logic
// without touching the network.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diffSchemas,
  doctor,
  validateConfigShape,
} from "../../src/commands/doctor.ts";
import {
  RECORDS,
  designSchema,
  type AddSchemaRequest,
} from "../../src/schemas.ts";
import { type Config } from "../../src/config.ts";
import type {
  NativeIndexHit,
  NodeClient,
  QueryResponse,
  QueryRow,
  RegisteredSchema,
  SchemaServiceClient,
} from "../../src/client.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const DESIGN_HASH = TEST_HASHES.design;

function asRegistered(
  schemaDef: AddSchemaRequest,
  canonicalHash: string,
): RegisteredSchema {
  return {
    name: canonicalHash,
    descriptive_name: schemaDef.schema.descriptive_name,
    schema_type: schemaDef.schema.schema_type,
    fields: schemaDef.schema.fields.slice(),
    field_types: { ...schemaDef.schema.field_types },
    identity_hash: canonicalHash,
    source: "user",
  };
}

function makeCfg(over: Partial<Config> = {}): Config {
  return buildTestCfg(over);
}

function writeCfg(cfg: Config): string {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(cfg), "utf8");
  return path;
}

// Drift overrides keyed by `key` from UNIQUE_SCHEMAS (design | task | note).
type DriftOverrides = Partial<Record<"design" | "task" | "note", RegisteredSchema | null>>;

function mockSchemaClient(opts: {
  drift?: DriftOverrides;
  listSchemasOk?: boolean;
}): SchemaServiceClient {
  return {
    baseUrl: "mock",
    async registerSchema() {
      return { canonicalHash: "x", status: 200, replacedSchema: null };
    },
    async listSchemas() {
      if (opts.listSchemasOk === false) throw new Error("schema service down");
      return { ok: true };
    },
    async getSchemaByHash(hash: string) {
      // TEST_HASHES has one entry per RecordType but Phase 6 entries
      // share the same value (note hash). The doctor only ever queries
      // the design / task / note hashes, so dispatch on those.
      if (hash === TEST_HASHES.design) {
        const override = opts.drift?.design;
        if (override !== undefined) return override;
        return asRegistered(RECORDS.design.schema, hash);
      }
      if (hash === TEST_HASHES.task) {
        const override = opts.drift?.task;
        if (override !== undefined) return override;
        return asRegistered(RECORDS.task.schema, hash);
      }
      if (hash === TEST_HASHES.concept) {
        // Same value covers concept/preference/reference/agent/project/spike.
        const override = opts.drift?.note;
        if (override !== undefined) return override;
        return asRegistered(RECORDS.concept.schema, hash);
      }
      return null;
    },
    async rawCall() {
      return { status: 200, headers: new Headers(), body: "", json: null };
    },
  };
}

type FreshnessHook = (slug: string, marker: string) => NativeIndexHit | null;
type PollutionHook = () => NativeIndexHit[];

type RecordedMutation =
  | { kind: "create"; slug: string; schemaHash: string; fields: Record<string, unknown> }
  | { kind: "update"; slug: string; schemaHash: string; fields: Record<string, unknown> }
  | { kind: "delete"; slug: string; schemaHash: string };

function mockNodeClient(opts: {
  provisioned?: boolean;
  loadOk?: boolean;
  failedSchemas?: string[];
  identityThrows?: Error;
  // Freshness probe: receives the slug of the most recently created probe
  // and returns an optional self-hit. Returning null simulates "fresh
  // record not present in top-K".
  onFreshnessSearch?: FreshnessHook;
  // Pollution probe: hits returned for any search NOT matching a freshness
  // marker (markers start with `freshprobe`).
  onPollutionSearch?: PollutionHook;
  // Per-schema-hash store used by queryAll. Rows must carry `kind` to
  // satisfy the listRecords filter for shared-noteSchema types.
  store?: Record<string, FbrainStoreRow[]>;
  // Captures every mutation issued through this client.
  mutations?: RecordedMutation[];
}): NodeClient {
  const store = opts.store ?? {};
  const mutations = opts.mutations ?? [];
  let lastCreated: { slug: string; marker: string } | undefined;
  return {
    baseUrl: "mock",
    userHash: "uh",
    async autoIdentity() {
      if (opts.identityThrows) throw opts.identityThrows;
      if (opts.provisioned === false) return { provisioned: false, reason: "node_not_provisioned" };
      return { provisioned: true, userHash: "uh-real" };
    },
    async bootstrap() {
      return { userHash: "uh-real" };
    },
    async loadSchemas() {
      if (opts.loadOk === false) throw new Error("load failed");
      return {
        available_schemas_loaded: 932,
        schemas_loaded_to_db: 932,
        failed_schemas: opts.failedSchemas ?? [],
      };
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      mutations.push({ kind: "create", slug: keyHash, schemaHash, fields });
      const row = (store[schemaHash] ??= []);
      row.push({ slug: keyHash, fields });
      // Track the freshness probe's most recently created slug so the
      // matching search call can be wired to a self-hit by the test.
      if (keyHash.startsWith("doctor-freshness-probe-")) {
        const body = typeof fields["body"] === "string" ? (fields["body"] as string) : "";
        const m = body.match(/Marker word: ([\w-]+)/);
        lastCreated = { slug: keyHash, marker: m?.[1] ?? "" };
      }
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      mutations.push({ kind: "update", slug: keyHash, schemaHash, fields });
      const row = (store[schemaHash] ??= []);
      const idx = row.findIndex((r) => r.slug === keyHash);
      if (idx >= 0) row[idx] = { slug: keyHash, fields };
      else row.push({ slug: keyHash, fields });
    },
    async deleteRecord({ schemaHash, keyHash }) {
      mutations.push({ kind: "delete", slug: keyHash, schemaHash });
    },
    async queryAll({ schemaHash }): Promise<QueryResponse> {
      const rows = (store[schemaHash] ?? []).map<QueryRow>((r) => ({
        fields: r.fields,
        key: { hash: r.slug, range: null },
      }));
      return { ok: true, results: rows, total_count: rows.length, returned_count: rows.length };
    },
    async search(query: string): Promise<NativeIndexHit[]> {
      // Freshness probe uses marker words starting with "freshprobe". The
      // probe always searches immediately after a create, so the
      // most-recently-created slug pairs 1:1 with the current marker.
      if (query.startsWith("freshprobe") && opts.onFreshnessSearch && lastCreated) {
        const hit = opts.onFreshnessSearch(lastCreated.slug, query);
        return hit === null ? [] : [hit];
      }
      if (opts.onPollutionSearch) return opts.onPollutionSearch();
      return [];
    },
    async rawCall() {
      return { status: 200, headers: new Headers(), body: "", json: null };
    },
  };
}

type FbrainStoreRow = { slug: string; fields: Record<string, unknown> };

// Helper: every Phase 6 record needs `kind` to survive the listRecords
// filter. Wrap a slug/tags pair so tests don't have to repeat the boilerplate.
function conceptRow(slug: string, tags: string[] = []): FbrainStoreRow {
  return {
    slug,
    fields: {
      slug,
      kind: "concept",
      title: slug,
      body: "",
      status: "active",
      tags,
      created_at: "2026-05-24T00:00:00.000Z",
      updated_at: "2026-05-24T00:00:00.000Z",
      v1_marker_a: "fbrain",
      v1_marker_b: "v1",
    },
  };
}

function selfHit(slug: string, schemaHash: string, score: number): NativeIndexHit {
  return {
    schema_name: schemaHash,
    schema_display_name: "FbrainKindNote",
    field: "body",
    key_value: { hash: slug, range: null },
    value: "...",
    metadata: { score, match_type: "semantic" },
  };
}

function orphanHit(slug: string | null): NativeIndexHit {
  return {
    schema_name: "5f8185c0".repeat(8),
    schema_display_name: "Persona",
    field: "name",
    key_value: { hash: slug, range: null },
    value: "...",
    metadata: { score: 0.3, match_type: "semantic" },
  };
}

function fbrainHit(slug: string, schemaHash: string, score: number): NativeIndexHit {
  return {
    schema_name: schemaHash,
    schema_display_name: "FbrainKindNote",
    field: "body",
    key_value: { hash: slug, range: null },
    value: "...",
    metadata: { score, match_type: "semantic" },
  };
}

describe("validateConfigShape", () => {
  test("accepts hex64 hashes for every type", () => {
    expect(validateConfigShape(makeCfg())).toEqual([]);
  });

  test("rejects missing schemaHash for a type", () => {
    const cfg = makeCfg();
    const trimmed: Config = {
      ...cfg,
      schemaHashes: { ...cfg.schemaHashes },
    };
    delete trimmed.schemaHashes.concept;
    const issues = validateConfigShape(trimmed);
    expect(issues.join("\n")).toContain('schemaHashes["concept"]');
  });

  test("rejects non-hex schemaHash", () => {
    const cfg = makeCfg({
      schemaHashes: {
        ...TEST_HASHES,
        task: "z".repeat(64),
      },
    });
    const issues = validateConfigShape(cfg);
    expect(issues.join("\n")).toContain('schemaHashes["task"]');
  });

  test("rejects too-short schemaHash", () => {
    const cfg = makeCfg({
      schemaHashes: {
        ...TEST_HASHES,
        design: "deadbeef",
      },
    });
    const issues = validateConfigShape(cfg);
    expect(issues.join("\n")).toContain('schemaHashes["design"]');
  });
});

describe("diffSchemas", () => {
  test("equal schemas → no issues", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    expect(diffSchemas(designSchema, reg)).toEqual([]);
  });

  test("descriptive_name drift surfaces", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.descriptive_name = "DesignOld";
    const issues = diffSchemas(designSchema, reg);
    expect(issues.some((s) => s.includes("descriptive_name"))).toBe(true);
  });

  test("fields drift — registered missing a field — surfaces", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.fields = reg.fields.filter((f) => f !== "tags");
    delete reg.field_types["tags"];
    const issues = diffSchemas(designSchema, reg);
    expect(issues.some((s) => s.includes("missing"))).toBe(true);
  });

  test("fields drift — extra field in registered — surfaces", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.fields.push("owner");
    reg.field_types["owner"] = "String";
    const issues = diffSchemas(designSchema, reg);
    expect(issues.some((s) => s.includes("present only in registered"))).toBe(true);
  });

  test("field_types drift surfaces", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.field_types["body"] = { Array: "String" };
    const issues = diffSchemas(designSchema, reg);
    expect(issues.some((s) => s.includes("field_types[body]"))).toBe(true);
  });

  test("Array(String) wire format matches schemas.ts", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    // tags is Array(String) in schemas.ts; ensure matching shape returns no diff
    expect(diffSchemas(designSchema, reg)).toEqual([]);
  });
});

describe("doctor verdict logic", () => {
  test("all green → exit 0 and reports drift for every unique schema", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("OK"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("[FAIL]")).length).toBe(0);
    // Three unique schemas: Design, Task, FbrainKindNote.
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Design]"))).toBe(true);
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Task]"))).toBe(true);
    expect(lines.some((l) => l.includes("[PASS] schema-drift[FbrainKindNote]"))).toBe(true);
    // G0 gate item #9 disclosure WARNs — always emitted, never flip exit.
    expect(lines.some((l) => l.startsWith("[WARN] single-machine-slice"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[WARN] no-team-sync"))).toBe(true);
  });

  test("missing config → exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-empty-"));
    const lines: string[] = [];
    const code = await doctor({
      configPath: join(dir, "config.json"),
      print: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("FAIL"))).toBe(true);
    expect(lines.some((l) => l.includes("fbrain init"))).toBe(true);
  });

  test("invalid hash format → reports config FAIL but doctor keeps going", async () => {
    const configPath = writeCfg(
      makeCfg({
        schemaHashes: {
          ...TEST_HASHES,
          design: "not-hex-not-64",
        },
      }),
    );
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] config"))).toBe(true);
  });

  test("schema service down → FAIL on schema-service-reachable", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({ listSchemasOk: false }),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] schema-service-reachable"))).toBe(true);
  });

  test("node not provisioned → FAIL with init hint", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ provisioned: false }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] node-provisioned"))).toBe(true);
    expect(lines.some((l) => l.includes("fbrain init"))).toBe(true);
  });

  test("failed_schemas non-empty → schemas-loaded FAIL", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ failedSchemas: ["BrokenSchema"] }),
    });
    expect(code).toBe(1);
    expect(
      lines.some((l) => l.includes("[FAIL] schemas-loaded") && l.includes("BrokenSchema")),
    ).toBe(true);
  });

  test("schema hash 404s in schema service → drift FAIL with init hint", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () =>
        mockSchemaClient({ drift: { design: null } }), // simulates 404 lookup for Design
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] schema-drift[Design]"))).toBe(true);
    expect(lines.some((l) => l.includes("fbrain init"))).toBe(true);
  });

  test("schema drift in fields → drift FAIL", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const drifted = asRegistered(designSchema, DESIGN_HASH);
    drifted.fields = drifted.fields.filter((f) => f !== "tags");
    delete drifted.field_types["tags"];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({ drift: { design: drifted } }),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] schema-drift[Design]"))).toBe(true);
  });

  test("schema drift on the shared Phase 6 schema → drift FAIL", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const driftedNote = asRegistered(RECORDS.concept.schema, TEST_HASHES.concept);
    driftedNote.fields = driftedNote.fields.filter((f) => f !== "tags");
    delete driftedNote.field_types["tags"];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () =>
        mockSchemaClient({ drift: { note: driftedNote } }),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] schema-drift[FbrainKindNote]"))).toBe(true);
  });
});

describe("doctor --freshness probes", () => {
  test("does not run probes when flag is omitted", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const mutations: RecordedMutation[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ mutations }),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("freshness-probe"))).toBe(false);
    expect(lines.some((l) => l.includes("pollution-probe"))).toBe(false);
    expect(mutations.length).toBe(0); // no writes when --freshness off
  });

  test("all-PASS: 5/5 trials at score ≥ 0.5, pollution clean", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const mutations: RecordedMutation[] = [];
    const conceptHash = TEST_HASHES.concept;
    const code = await doctor({
      configPath,
      freshness: true,
      nonceFn: () => "test1",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          mutations,
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.93),
          onPollutionSearch: () => [
            fbrainHit("alive-1", conceptHash, 0.9),
            fbrainHit("alive-2", conceptHash, 0.8),
          ],
          store: {
            [conceptHash]: [conceptRow("alive-1"), conceptRow("alive-2")],
          },
        }),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[PASS] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("5/5 trials passed"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[PASS] pollution-probe"))).toBe(true);
    // Each trial: 1 create + 1 update (cleanup tombstone). 5 trials = 10 mutations.
    const creates = mutations.filter((m) => m.kind === "create");
    const cleanupUpdates = mutations.filter(
      (m) => m.kind === "update" && Array.isArray(m.fields["tags"]) && (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(creates.length).toBe(5);
    expect(cleanupUpdates.length).toBe(5);
  });

  test("freshness FAIL: search returns nothing for one trial → exit 1, but cleanup still runs", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const mutations: RecordedMutation[] = [];
    const conceptHash = TEST_HASHES.concept;
    let trial = 0;
    const code = await doctor({
      configPath,
      freshness: true,
      nonceFn: () => "test2",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          mutations,
          onFreshnessSearch: (slug) => {
            // Drop the 3rd trial: simulates the fresh record not appearing.
            const idx = trial++;
            if (idx === 2) return null;
            return selfHit(slug, conceptHash, 0.91);
          },
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("4/5 trials passed"))).toBe(true);
    // Cleanup still ran for all 5 creates.
    const cleanupUpdates = mutations.filter(
      (m) => m.kind === "update" && Array.isArray(m.fields["tags"]) && (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(cleanupUpdates.length).toBe(5);
  });

  test("freshness FAIL: score below threshold → exit 1", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 2,
      freshnessMinScore: 0.5,
      nonceFn: () => "test3",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.3), // below threshold
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("0/2 trials passed"))).toBe(true);
  });

  test("pollution WARN: 25-50% polluted → tag WARN but exit 0", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    // 4 hits: 2 live, 1 stale (slug missing from store), 1 orphan. → 50% polluted.
    // Pollution at exactly 50% is NOT > failThreshold (0.5), so it lands as WARN
    // because > 0.25.
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "test4",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.9),
          onPollutionSearch: () => [
            fbrainHit("alive-1", conceptHash, 0.7),
            fbrainHit("alive-2", conceptHash, 0.6),
            fbrainHit("gone-1", conceptHash, 0.5),
            orphanHit("persona-x"),
          ],
          store: {
            [conceptHash]: [conceptRow("alive-1"), conceptRow("alive-2")],
          },
        }),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[WARN] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("pollution 50%"))).toBe(true);
  });

  test("pollution FAIL: >50% polluted → exit 1", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    // 1 live + 3 stale + 1 orphan = 80% polluted.
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "test5",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.9),
          onPollutionSearch: () => [
            fbrainHit("alive-1", conceptHash, 0.7),
            fbrainHit("gone-1", conceptHash, 0.6),
            fbrainHit("gone-2", conceptHash, 0.55),
            fbrainHit("gone-3", conceptHash, 0.5),
            orphanHit("persona-x"),
          ],
          store: {
            [conceptHash]: [conceptRow("alive-1")],
          },
        }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("pollution 80%"))).toBe(true);
  });

  test("pollution PASS: empty index → 0 hits, no tag escalation", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "test6",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.91),
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[PASS] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.includes('returned 0 hits'))).toBe(true);
  });

  test("treats tombstoned records as stale (not live)", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "test7",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.9),
          onPollutionSearch: () => [fbrainHit("tomb-1", conceptHash, 0.7)],
          store: {
            [conceptHash]: [conceptRow("tomb-1", [TOMBSTONE_TAG])],
          },
        }),
    });
    expect(code).toBe(1); // 100% polluted → FAIL
    expect(lines.some((l) => l.includes("stale 1"))).toBe(true);
  });

  test("probes skipped if schemas-loaded failed", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      freshness: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ failedSchemas: ["BrokenSchema"] }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] freshness-probe") && l.includes("skipped"))).toBe(true);
  });
});
