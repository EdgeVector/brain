// Unit tests for doctor. Inject mock SchemaServiceClient + NodeClient
// factories so we can exercise each drift dimension and the verdict logic
// without touching the network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifySchemaDrift,
  diffSchemas,
  doctor,
  schemaServiceFixHint,
  validateConfigShape,
} from "../../src/commands/doctor.ts";
import {
  RECORDS,
  designSchema,
  projectSchema,
  type AddSchemaRequest,
} from "../../src/schemas.ts";
import { type Config } from "../../src/config.ts";
import {
  FbrainError,
  type NativeIndexHit,
  type NodeClient,
  type QueryResponse,
  type QueryRow,
  type RegisteredSchema,
  type SchemaServiceClient,
} from "../../src/client.ts";
import { TOMBSTONE_TAG } from "../../src/record.ts";
import {
  type CapabilityStore,
  type CapabilityToken,
} from "../../src/capability.ts";
import { inMemoryCapabilityStore } from "../../src/keychain.ts";
import { canonicalize, type JsonValue } from "../../src/jcs.ts";
import { sha256Hex } from "../../src/hash.ts";
import type { WriteNodeClient, WriteNodeClientOptions } from "../../src/write-context.ts";
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

// Drift overrides keyed by `key` from UNIQUE_SCHEMAS — design, task,
// plus the six per-kind Phase 6 schemas.
type DriftKey =
  | "design"
  | "task"
  | "concept"
  | "preference"
  | "reference"
  | "agent"
  | "project"
  | "spike";
type DriftOverrides = Partial<Record<DriftKey, RegisteredSchema | null>>;

function mockSchemaClient(opts: {
  drift?: DriftOverrides;
  listSchemasOk?: boolean;
}): SchemaServiceClient {
  // Per-hash mapping covering all 8 UNIQUE_SCHEMAS entries: 2 baseline
  // (design/task) + 6 per-kind (concept/preference/reference/agent/project/spike).
  const dispatch: Array<{ hash: string; driftKey: DriftKey; schema: AddSchemaRequest }> = [
    { hash: TEST_HASHES.design, driftKey: "design", schema: RECORDS.design.schema },
    { hash: TEST_HASHES.task, driftKey: "task", schema: RECORDS.task.schema },
    { hash: TEST_HASHES.concept, driftKey: "concept", schema: RECORDS.concept.schema },
    { hash: TEST_HASHES.preference, driftKey: "preference", schema: RECORDS.preference.schema },
    { hash: TEST_HASHES.reference, driftKey: "reference", schema: RECORDS.reference.schema },
    { hash: TEST_HASHES.agent, driftKey: "agent", schema: RECORDS.agent.schema },
    { hash: TEST_HASHES.project, driftKey: "project", schema: RECORDS.project.schema },
    { hash: TEST_HASHES.spike, driftKey: "spike", schema: RECORDS.spike.schema },
  ];
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
      const match = dispatch.find((d) => d.hash === hash);
      if (!match) return null;
      const override = opts.drift?.[match.driftKey];
      if (override !== undefined) return override;
      return asRegistered(match.schema, hash);
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
  // Per-schema-hash store used by queryAll.
  store?: Record<string, FbrainStoreRow[]>;
  // Captures every mutation issued through this client.
  mutations?: RecordedMutation[];
  // When set, every `search()` call rejects with this error. Used to
  // exercise the embedding-runtime probe's failure path.
  searchThrows?: Error;
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
    async requestConsent() {
      return { status: 202, body: { request_id: "r" } };
    },
    async consentStatus() {
      return { status: 200, body: { status: "granted" } };
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
      if (opts.searchThrows) throw opts.searchThrows;
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

function conceptRow(slug: string, tags: string[] = []): FbrainStoreRow {
  return {
    slug,
    fields: {
      slug,
      title: slug,
      body: "",
      status: "active",
      tags,
      created_at: "2026-05-24T00:00:00.000Z",
      updated_at: "2026-05-24T00:00:00.000Z",
    },
  };
}

function selfHit(slug: string, schemaHash: string, score: number): NativeIndexHit {
  return {
    schema_name: schemaHash,
    schema_display_name: "Concept",
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
    schema_display_name: "Concept",
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

// classifySchemaDrift was added (PR landed alongside this test) because
// doctor's old extras-only behavior reported FAIL with a `fbrain init` hint
// that couldn't recover — the schema service expands schemas of the same
// descriptive_name (often colliding with Schema.org starter_seeds) and
// never shrinks them, so re-registering returns the same hash. Extras-only
// is now WARN; everything else stays real_drift.
describe("classifySchemaDrift", () => {
  test("identical schemas → kind=none", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    expect(classifySchemaDrift(designSchema, reg)).toEqual({ kind: "none" });
  });

  test("registered has extra field only → kind=extras_only", () => {
    const reg = asRegistered(projectSchema, TEST_HASHES.project);
    reg.fields.push("identifier");
    reg.field_types["identifier"] = "String";
    const c = classifySchemaDrift(projectSchema, reg);
    expect(c.kind).toBe("extras_only");
    if (c.kind === "extras_only") {
      expect(c.extras).toEqual(["identifier"]);
    }
  });

  test("registered has multiple extras → kind=extras_only carries all of them", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.fields.push("owner", "deadline");
    reg.field_types["owner"] = "String";
    reg.field_types["deadline"] = "String";
    const c = classifySchemaDrift(designSchema, reg);
    expect(c.kind).toBe("extras_only");
    if (c.kind === "extras_only") {
      expect(new Set(c.extras)).toEqual(new Set(["owner", "deadline"]));
    }
  });

  test("registered missing a field → kind=real_drift (not extras-only)", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.fields = reg.fields.filter((f) => f !== "tags");
    delete reg.field_types["tags"];
    const c = classifySchemaDrift(designSchema, reg);
    expect(c.kind).toBe("real_drift");
  });

  test("mixed drift (extras + missing) → kind=real_drift", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.fields = reg.fields.filter((f) => f !== "tags");
    delete reg.field_types["tags"];
    reg.fields.push("owner");
    reg.field_types["owner"] = "String";
    const c = classifySchemaDrift(designSchema, reg);
    expect(c.kind).toBe("real_drift");
  });

  test("descriptive_name mismatch is real_drift even with extras", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.descriptive_name = "DesignRenamed";
    reg.fields.push("owner");
    reg.field_types["owner"] = "String";
    const c = classifySchemaDrift(designSchema, reg);
    expect(c.kind).toBe("real_drift");
  });

  test("field_types mismatch is real_drift", () => {
    const reg = asRegistered(designSchema, DESIGN_HASH);
    reg.field_types["body"] = { Array: "String" };
    const c = classifySchemaDrift(designSchema, reg);
    expect(c.kind).toBe("real_drift");
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
    // Eight unique schemas: Design, Task, and six Phase 6 kinds.
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Design]"))).toBe(true);
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Task]"))).toBe(true);
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Concept]"))).toBe(true);
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Spike]"))).toBe(true);
    // FbrainKindNote is no longer registered.
    expect(lines.some((l) => l.includes("FbrainKindNote"))).toBe(false);
    // G0 gate item #9 disclosure WARNs — always emitted, never flip exit.
    const smsLine = lines.find((l) => l.startsWith("[WARN] single-machine-slice"));
    const ntsLine = lines.find((l) => l.startsWith("[WARN] no-team-sync"));
    expect(smsLine).toBeDefined();
    expect(ntsLine).toBeDefined();
    // Pin the post-PR-#33 framing: transport is deployed, fbrain hasn't
    // wired/signed-in yet. Guards against regressing to "not yet built"
    // or "until fold_db cloud sync transport lights up".
    expect(smsLine!).toContain("deployed but not yet wired up from fbrain");
    expect(smsLine!).not.toContain("not yet built");
    expect(ntsLine!).toContain("no team-sync transport");
    expect(ntsLine!).toContain("signed in and validated end-to-end");
    expect(ntsLine!).not.toContain("lights up");
  });

  test("missing config → exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-empty-"));
    const lines: string[] = [];
    const code = await doctor({
      configPath: join(dir, "config.json"),
      print: (l) => lines.push(l),
      // Stub the publish-gate probe so this test stays a unit test (no
      // network). The probe's own behavior is covered by the two tests
      // below; here we just confirm the no-config FAIL still surfaces.
      schemaClientFactory: () => ({
        baseUrl: "mock",
        async registerSchema() {
          return { canonicalHash: "x", status: 200, replacedSchema: null };
        },
        async listSchemas() {
          return { ok: true };
        },
        async getSchemaByHash() {
          return null;
        },
        async rawCall() {
          return { status: 200, headers: new Headers(), body: "", json: null };
        },
      }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("FAIL"))).toBe(true);
    expect(lines.some((l) => l.includes("fbrain init"))).toBe(true);
  });

  test("missing config + schema service returns cert_required → FAIL schema-publish-gate with remedy", async () => {
    // Init↔doctor dead-end regression. Pre-this-PR, when init's step 3 kept
    // failing with `401 cert_required`, no config was ever written and
    // doctor stopped at "no ~/.fbrain/config.json → run `fbrain init`",
    // bouncing the user back to the command that can't succeed. Doctor now
    // probes the schema-service publish gate independently so the real
    // cause surfaces with an actionable remedy.
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-cert-"));
    const lines: string[] = [];
    const code = await doctor({
      configPath: join(dir, "config.json"),
      print: (l) => lines.push(l),
      schemaClientFactory: () => ({
        baseUrl: "mock",
        async registerSchema() {
          throw new FbrainError({
            code: "schema_cert_required",
            message:
              "Schema service /v1/schemas rejected publish with 401 cert_required — " +
              "registering fbrain's namespaced schemas requires a one-time DevCert " +
              "publish by a maintainer (this is expected for a fresh consumer) — " +
              "run `fbrain doctor` for a full diagnosis.",
            hint: "see CERT_REQUIRED_HINT",
          });
        },
        async listSchemas() {
          return { ok: true };
        },
        async getSchemaByHash() {
          return null;
        },
        async rawCall() {
          return { status: 200, headers: new Headers(), body: "", json: null };
        },
      }),
    });
    expect(code).toBe(1);
    // No config FAIL line stays.
    expect(lines.some((l) => l.includes("[FAIL] config"))).toBe(true);
    // New publish-gate FAIL surfaces the real cause.
    const gateLine = lines.find((l) => l.includes("[FAIL] schema-publish-gate"));
    expect(gateLine).toBeDefined();
    expect(gateLine!).toContain("cert_required");
    expect(gateLine!).toContain("DevCert");
    // The fix hint names a concrete remedy, not "re-run fbrain init".
    expect(lines.some((l) => l.includes("FBRAIN_APP_IDENTITY_ENFORCE=off"))).toBe(true);
    expect(lines.some((l) => l.includes("maintainer"))).toBe(true);
  });

  test("missing config + schema service unreachable → WARN schema-publish-gate", async () => {
    // Inconclusive probes (network down, unexpected 5xx, …) must not become
    // a FAIL — that'd flip the verdict to red on a transient connectivity
    // issue. WARN keeps the no-config FAIL as the sole verdict driver.
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-warn-"));
    const lines: string[] = [];
    const code = await doctor({
      configPath: join(dir, "config.json"),
      print: (l) => lines.push(l),
      schemaClientFactory: () => ({
        baseUrl: "mock",
        async registerSchema() {
          throw new FbrainError({
            code: "service_unreachable",
            message: "schema service not reachable at https://example/v1 — run `fbrain doctor` for a full diagnosis.",
          });
        },
        async listSchemas() {
          return { ok: true };
        },
        async getSchemaByHash() {
          return null;
        },
        async rawCall() {
          return { status: 200, headers: new Headers(), body: "", json: null };
        },
      }),
    });
    expect(code).toBe(1); // still 1 because of the no-config FAIL
    const warnLine = lines.find((l) => l.includes("[WARN] schema-publish-gate"));
    expect(warnLine).toBeDefined();
    // Circular doctor tip is stripped from the WARN detail.
    expect(warnLine!).not.toContain("fbrain doctor");
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

  // Regression: connectionError() in client.ts appends a DOCTOR_TIP suffix
  // ("— run `fbrain doctor` for a full diagnosis") so non-doctor commands
  // (list/put/etc.) point users here. Doctor must NOT echo that tip back
  // — telling someone running `fbrain doctor` to run `fbrain doctor` is
  // circular and confusing.
  test("service_unreachable from node → FAIL detail omits circular doctor tip", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const unreachable = new FbrainError({
      code: "service_unreachable",
      message:
        "node not reachable at http://127.0.0.1:9001 — run `fbrain doctor` for a full diagnosis.",
    });
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ identityThrows: unreachable }),
    });
    expect(code).toBe(1);
    const failLine = lines.find((l) => l.includes("[FAIL] node-reachable"));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain("fbrain doctor");
    expect(failLine).toContain("node not reachable at http://127.0.0.1:9001");
  });

  // Regression: the `--usage` short-circuit (doctor.ts:149) used to propagate
  // err.message verbatim — including connectionError()'s DOCTOR_TIP suffix —
  // so `fbrain doctor --usage` with no node running printed "run `fbrain
  // doctor` for a full diagnosis" inside doctor's own output. PR #38 fixed
  // the default flow; this pins the --usage path to the same shape.
  test("service_unreachable during --usage → printed failure omits circular doctor tip", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const unreachable = new FbrainError({
      code: "service_unreachable",
      message:
        "node not reachable at http://127.0.0.1:9001 — run `fbrain doctor` for a full diagnosis.",
    });
    const baseNode = mockNodeClient({});
    const node: NodeClient = {
      ...baseNode,
      async queryAll() {
        throw unreachable;
      },
    };
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => node,
      usage: true,
    });
    expect(code).toBe(1);
    const usageLine = lines.find((l) => l.startsWith("usage report failed:"));
    expect(usageLine).toBeDefined();
    expect(usageLine).not.toContain("fbrain doctor");
    expect(usageLine).toContain("node not reachable at http://127.0.0.1:9001");
  });

  // Regression: PR #40 added doctorReachabilityDetail() and used it in the
  // --usage catch block, but only the service_unreachable branch synthesized
  // a clean detail — every other FbrainError code (node_not_provisioned,
  // missing_user_context, schema_http_*, …) still propagated err.message
  // verbatim, which carries the DOCTOR_TIP suffix from client.ts. So
  // `fbrain doctor --usage` against a daemon up-but-not-provisioned still
  // printed "usage report failed: Node not set up — run `fbrain doctor` for
  // a full diagnosis." This pins the fallthrough path to stripDoctorTip().
  test("node_not_provisioned during --usage → printed failure omits circular doctor tip", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const notProvisioned = new FbrainError({
      code: "node_not_provisioned",
      message: "Node not set up — run `fbrain doctor` for a full diagnosis.",
    });
    const baseNode = mockNodeClient({});
    const node: NodeClient = {
      ...baseNode,
      async queryAll() {
        throw notProvisioned;
      },
    };
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => node,
      usage: true,
    });
    expect(code).toBe(1);
    const usageLine = lines.find((l) => l.startsWith("usage report failed:"));
    expect(usageLine).toBeDefined();
    expect(usageLine).not.toContain("fbrain doctor");
    expect(usageLine).toBe("usage report failed: Node not set up.");
  });

  test("service_unreachable from schema service → FAIL detail omits circular doctor tip", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const unreachable = new FbrainError({
      code: "service_unreachable",
      message:
        "schema service not reachable at http://127.0.0.1:8080 — run `fbrain doctor` for a full diagnosis.",
    });
    const mockSchema: SchemaServiceClient = {
      ...mockSchemaClient({}),
      async listSchemas() {
        throw unreachable;
      },
    };
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchema,
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    const failLine = lines.find((l) => l.includes("[FAIL] schema-service-reachable"));
    expect(failLine).toBeDefined();
    expect(failLine).not.toContain("fbrain doctor");
    expect(failLine).toContain("schema service not reachable at");
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

  test("embedding-runtime probe → PASS when the one-token search succeeds", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[PASS] embedding-runtime"))).toBe(true);
  });

  test("embedding-runtime probe → FAIL surfaces daemon-restart fix when search rejects with embedding_model_unavailable", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          searchThrows: new FbrainError({
            code: "embedding_model_unavailable",
            message:
              "Semantic search is unavailable — the fold_db node failed to load its embedding model.",
            hint:
              "Restart the node so it re-fetches the ONNX file from the embedding cache " +
              "(homebrew: `folddb daemon stop && folddb daemon start`).",
          }),
        }),
    });
    expect(code).toBe(1);
    // The probe must surface as a distinct, structured FAIL — not blended
    // into schema-drift. The fix line carries the user-actionable
    // daemon-restart command verbatim.
    const failLine = lines.find((l) => l.startsWith("[FAIL] embedding-runtime"));
    expect(failLine).toBeDefined();
    expect(failLine!).toContain("Semantic search is unavailable");
    const fixLine = lines[lines.indexOf(failLine!) + 1] ?? "";
    expect(fixLine).toContain("folddb daemon stop && folddb daemon start");
  });

  test("schema drift on a Phase 6 per-kind schema → drift FAIL", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const driftedConcept = asRegistered(RECORDS.concept.schema, TEST_HASHES.concept);
    driftedConcept.fields = driftedConcept.fields.filter((f) => f !== "tags");
    delete driftedConcept.field_types["tags"];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () =>
        mockSchemaClient({ drift: { concept: driftedConcept } }),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] schema-drift[Concept]"))).toBe(true);
  });

  // Regression for the Project + Schema.org starter_seed collision documented
  // in the task that introduced this test. POSTing the canonical Project
  // schema to the schema service expanded against an existing schema that
  // had `identifier`, so the registered schema carried an extra field
  // schemas.ts did not. The old code FAILed and pointed at `fbrain init`,
  // but init kept returning the same hash (the service expands schemas, it
  // doesn't shrink them). Now: WARN, exit 0, and the hint names the real
  // recovery (bump descriptive_name in src/schemas.ts).
  test("extras-only drift → WARN with expansion-aware hint, doctor exits 0", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const expanded = asRegistered(RECORDS.project.schema, TEST_HASHES.project);
    expanded.fields.push("identifier");
    expanded.field_types["identifier"] = "String";
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () =>
        mockSchemaClient({ drift: { project: expanded } }),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(0);
    const warnLine = lines.find((l) => l.includes("schema-drift[Project]"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.startsWith("[WARN]")).toBe(true);
    expect(warnLine!).toContain("identifier");
    // The fix-hint must NOT push the user back at `fbrain init` as if that
    // would clear the warning — that's the original bug. It must name the
    // real recovery: bump descriptive_name in src/schemas.ts.
    const fixLine = lines.find(
      (l, i) =>
        l.trim().startsWith("fix:") &&
        i > 0 &&
        (lines[i - 1] ?? "").includes("schema-drift[Project]"),
    );
    expect(fixLine).toBeDefined();
    expect(fixLine!).toContain("descriptive_name");
    expect(fixLine!).toContain("src/schemas.ts");
    expect(fixLine!).toContain("expansion");
  });

  // Locks the comparison input. doctor's drift check must fetch the
  // schema at the hash stored in cfg.schemaHashes[entry.key] — not a
  // cached, stale, or recomputed hash. The bonus on this PR's task asked
  // for a guard against this. If a future refactor introduces a different
  // hash source (e.g. recomputing from schemas.ts), this test catches it.
  test("drift check fetches the schema at the config's stored hash", async () => {
    const customProjectHash = "9".repeat(63) + "a";
    const cfg = makeCfg({
      schemaHashes: { ...TEST_HASHES, project: customProjectHash },
    });
    const configPath = writeCfg(cfg);
    const lines: string[] = [];
    const lookups: string[] = [];
    const baseSchema = mockSchemaClient({});
    const wrapped: SchemaServiceClient = {
      ...baseSchema,
      async getSchemaByHash(hash) {
        lookups.push(hash);
        if (hash === customProjectHash) {
          return asRegistered(RECORDS.project.schema, customProjectHash);
        }
        return baseSchema.getSchemaByHash(hash);
      },
    };
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => wrapped,
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(0);
    expect(lookups).toContain(customProjectHash);
    expect(lines.some((l) => l.includes("[PASS] schema-drift[Project]"))).toBe(true);
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

  test("freshness probe writes only per-kind Concept fields (no legacy kind/v1_marker_a/v1_marker_b)", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const mutations: RecordedMutation[] = [];
    const conceptHash = TEST_HASHES.concept;
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "shape",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          mutations,
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.9),
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(0);
    const create = mutations.find((m) => m.kind === "create");
    expect(create).toBeDefined();
    const fields = create!.fields;
    // Phase-E Concept schema's exact 7-field shape — the legacy discriminator
    // and structural markers must NOT be written, or fold rejects the mutation.
    expect(Object.keys(fields).sort()).toEqual([
      "body",
      "created_at",
      "slug",
      "status",
      "tags",
      "title",
      "updated_at",
    ]);
    expect("kind" in fields).toBe(false);
    expect("v1_marker_a" in fields).toBe(false);
    expect("v1_marker_b" in fields).toBe(false);
  });

  test("freshness probe degrades gracefully when search throws (e.g. missing model.onnx) and still cleans up", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const mutations: RecordedMutation[] = [];
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 3,
      nonceFn: () => "model-missing",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          mutations,
          searchThrows: new Error("native-index unavailable: model.onnx not found"),
        }),
    });
    expect(code).toBe(1);
    expect(
      lines.some(
        (l) =>
          l.startsWith("[FAIL] freshness-probe") &&
          l.includes("native-index search failed") &&
          l.includes("model.onnx"),
      ),
    ).toBe(true);
    // Probe breaks after the first failed search, so exactly one create
    // happens — and that one record is still tombstoned in the finally block.
    const creates = mutations.filter((m) => m.kind === "create");
    expect(creates.length).toBe(1);
    const cleanupUpdates = mutations.filter(
      (m) =>
        m.kind === "update" &&
        Array.isArray(m.fields["tags"]) &&
        (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(cleanupUpdates.length).toBe(1);
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

// Write-readiness probe: doctor used to be all read-path checks, so a node
// with a cold app registry / missing grant / revoked capability reported
// all-PASS while every write 4xx'd. These tests pin the new probe's three
// verdicts: PASS only when both a valid cached capability exists AND the
// node's app registry recognises fbrain (request-consent → 202); FAIL with
// an actionable hint when either is missing; WARN (never silent PASS) when
// the probe can't determine the state.
describe("doctor write-readiness probe", () => {
  // test/setup.ts forces FBRAIN_APP_IDENTITY_ENFORCE=false for the suite so
  // command tests can run without standing up the consent path. The probe's
  // very first branch checks that env var and emits a WARN if enforcement
  // is off — masking every PASS/FAIL/WARN case below. Flip it back ON
  // around this describe so the probe runs its full registration + cached
  // capability + status-code logic.
  let prevEnforce: string | undefined;
  beforeEach(() => {
    prevEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
  });
  afterEach(() => {
    if (prevEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
    else process.env.FBRAIN_APP_IDENTITY_ENFORCE = prevEnforce;
  });

  // Build a real capability blob whose JCS payload_hash matches. The probe
  // runs the same tokenIntegrityValid() check the write path uses, so a
  // synthetic blob with the wrong hash would always FAIL — defeating the
  // PASS test.
  async function mintBlob(opts: { appId?: string; corruptHash?: boolean } = {}): Promise<string> {
    const token: CapabilityToken = {
      envelope: {
        version: 1,
        purpose: "capability_grant",
        alg: "Ed25519",
        key_id: "a".repeat(64),
        issued_at: "2026-06-04T12:00:00Z",
        env: "dev",
        payload_hash: "",
        sig: "cGxhY2Vob2xkZXItc2lnbmF0dXJl",
      },
      capability_id: "cap-doctor",
      app_id: opts.appId ?? "fbrain",
      scope: { Wildcard: "fbrain/*" },
      granted_ops: ["Read", "Write"],
      granted_at: "2026-06-04T12:00:00Z",
      node_pubkey: "bm9kZS1wdWJrZXktYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
    };
    const payload = { ...(token as unknown as Record<string, JsonValue>) };
    delete payload.envelope;
    token.envelope.payload_hash = opts.corruptHash
      ? "deadbeef".repeat(8)
      : await sha256Hex(canonicalize(payload as JsonValue));
    return Buffer.from(JSON.stringify(token), "utf8").toString("base64");
  }

  async function withCachedCapability(
    nodeUrl: string,
    opts: { appId?: string; corruptHash?: boolean } = {},
  ): Promise<CapabilityStore> {
    const store = inMemoryCapabilityStore();
    const blob = await mintBlob(opts);
    await store.save({
      appId: opts.appId ?? "fbrain",
      nodeUrl,
      nodePubkey: "bm9kZS1wdWJrZXktYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
      capabilityId: "cap-doctor",
      blob,
    });
    return store;
  }

  function nodeWithConsent(consent: { status: number; body?: unknown }): NodeClient {
    const base = mockNodeClient({});
    return {
      ...base,
      async requestConsent() {
        return { status: consent.status, body: consent.body ?? {} };
      },
    };
  }

  test("PASS: capability cached + consent dry-run 202", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const store = await withCachedCapability(cfg.nodeUrl);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: store,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => nodeWithConsent({ status: 202, body: { request_id: "r-1" } }),
    });
    expect(code).toBe(0);
    const pass = lines.find((l) => l.startsWith("[PASS] write-ready"));
    expect(pass).toBeDefined();
    expect(pass!).toContain("capability cached");
  });

  test("FAIL: app not registered (request-consent → 404) reports write-blocked with cold-registry hint", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const store = await withCachedCapability(cfg.nodeUrl);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: store,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        nodeWithConsent({ status: 404, body: { error: "not_a_developer" } }),
    });
    expect(code).toBe(1);
    const fail = lines.find((l) => l.startsWith("[FAIL] write-blocked"));
    expect(fail).toBeDefined();
    expect(fail!).toContain("does not recognise app");
    expect(fail!).toContain("fbrain");
    // The fix line names BOTH the symptom every write hits AND a real
    // next step (restart / publish), not a circular "run init" loop.
    const fix = lines[lines.indexOf(fail!) + 1] ?? "";
    expect(fix).toContain("app_not_registered");
    expect(fix.toLowerCase()).toContain("restart");
  });

  test("FAIL: no capability cached (consent dry-run 202) reports write-blocked with init hint", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => nodeWithConsent({ status: 202, body: { request_id: "r-1" } }),
    });
    expect(code).toBe(1);
    const fail = lines.find((l) => l.startsWith("[FAIL] write-blocked"));
    expect(fail).toBeDefined();
    expect(fail!).toContain("no capability stored");
    const fix = lines[lines.indexOf(fail!) + 1] ?? "";
    expect(fix).toContain("fbrain init");
  });

  test("FAIL: stored capability fails JCS integrity check is treated as absent", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const store = await withCachedCapability(cfg.nodeUrl, { corruptHash: true });
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: store,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => nodeWithConsent({ status: 202, body: { request_id: "r-1" } }),
    });
    expect(code).toBe(1);
    const fail = lines.find((l) => l.startsWith("[FAIL] write-blocked"));
    expect(fail).toBeDefined();
    expect(fail!).toContain("JCS integrity check");
  });

  test("WARN: consent dry-run returns 5xx → fail closed (WARN, exit stays 0)", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const store = await withCachedCapability(cfg.nodeUrl);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: store,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => nodeWithConsent({ status: 500, body: { error: "boom" } }),
    });
    expect(code).toBe(0);
    const warn = lines.find((l) => l.startsWith("[WARN] write-ready"));
    expect(warn).toBeDefined();
    expect(warn!).toContain("HTTP 500");
    expect(warn!).toContain("cannot determine");
  });

  test("WARN: consent dry-run throws → fail closed (WARN, never silent PASS)", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const store = await withCachedCapability(cfg.nodeUrl);
    const lines: string[] = [];
    const base = mockNodeClient({});
    const throwingNode: NodeClient = {
      ...base,
      async requestConsent() {
        throw new Error("consent endpoint exploded");
      },
    };
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: store,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => throwingNode,
    });
    expect(code).toBe(0);
    const warn = lines.find((l) => l.startsWith("[WARN] write-ready"));
    expect(warn).toBeDefined();
    expect(warn!).toContain("consent endpoint exploded");
  });

  test("WARN: client enforcement OFF → declare the limitation (exit 0)", async () => {
    // beforeEach forced enforcement ON; this test flips it back OFF.
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(0);
    const warn = lines.find((l) => l.startsWith("[WARN] write-ready"));
    expect(warn).toBeDefined();
    expect(warn!).toContain("enforcement is OFF");
  });

  test("regression: with no flag the probe runs (catches the pre-PR all-green-while-writes-blocked case)", async () => {
    // Plain `fbrain doctor` (no --freshness, no --write, no --usage) — the
    // 2026-06-04 dogfood that motivated this PR. With consent returning 404,
    // doctor MUST exit non-zero and surface write-blocked; pre-PR it printed
    // all-PASS.
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        nodeWithConsent({ status: 404, body: { error: "not_a_developer" } }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] write-blocked"))).toBe(true);
  });
});

describe("doctor --write round-trip probe", () => {
  // The probe destructures `{ node }` only — `session` is never touched —
  // so a stubbed session object cast through `unknown` is sufficient for
  // the WriteNodeClient shape these tests pass in.
  function stubWriteClient(node: NodeClient): WriteNodeClient {
    return { node, session: {} as unknown as WriteNodeClient["session"] };
  }

  // Match the write-readiness describe block: force enforcement ON so the
  // write-ready probe in front of the round-trip behaves the same way it
  // does in production. Without this, the suite-wide enforcement-off
  // default makes write-ready emit a WARN that mixes into the expected
  // exit codes below.
  let prevEnforce: string | undefined;
  beforeEach(() => {
    prevEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
  });
  afterEach(() => {
    if (prevEnforce === undefined) delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
    else process.env.FBRAIN_APP_IDENTITY_ENFORCE = prevEnforce;
  });

  function captureWriteClient(opts: {
    mutations: RecordedMutation[];
    onCreate?: (slug: string) => void | Promise<void>;
    nodeOverrides?: Partial<NodeClient>;
  }): (wnOpts: WriteNodeClientOptions) => WriteNodeClient {
    return (_wnOpts) => {
      const base = mockNodeClient({ mutations: opts.mutations });
      const node: NodeClient = {
        ...base,
        async createRecord(args) {
          await base.createRecord(args);
          if (opts.onCreate) await opts.onCreate(args.keyHash);
        },
        ...(opts.nodeOverrides ?? {}),
      };
      return stubWriteClient(node);
    };
  }

  test("PASS: put → get → soft-delete round-trip, cleanup tombstone written", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const mutations: RecordedMutation[] = [];
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      write: true,
      nonceFn: () => "rt1",
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      // Write-ready probe also runs in this codepath; give it a passable
      // 202 so its WARN/FAIL doesn't mask the round-trip PASS we're testing.
      nodeClientFactory: () => mockNodeClient({}),
      writeNodeFactory: captureWriteClient({ mutations }),
    });
    expect(code).toBe(1); // write-ready FAILs (no cached capability) but the round-trip itself PASSes
    const pass = lines.find((l) => l.startsWith("[PASS] write-roundtrip"));
    expect(pass).toBeDefined();
    expect(pass!).toContain("doctor-write-roundtrip-rt1");
    // One create + one tombstone update — same shape as the freshness probe.
    const creates = mutations.filter((m) => m.kind === "create" && m.schemaHash === conceptHash);
    expect(creates.length).toBe(1);
    expect(creates[0]!.slug).toBe("doctor-write-roundtrip-rt1");
    const tombstones = mutations.filter(
      (m) =>
        m.kind === "update" &&
        Array.isArray(m.fields["tags"]) &&
        (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(tombstones.length).toBe(1);
    expect(tombstones[0]!.slug).toBe("doctor-write-roundtrip-rt1");
  });

  test("FAIL: create throws → exit 1, no cleanup needed (nothing landed)", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const mutations: RecordedMutation[] = [];
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      write: true,
      nonceFn: () => "rt2",
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      writeNodeFactory: (_wnOpts) => {
        const base = mockNodeClient({ mutations });
        return stubWriteClient({
          ...base,
          async createRecord() {
            throw new FbrainError({
              code: "capability_consent_required",
              message: "fbrain write rejected: consent_required.",
            });
          },
        });
      },
    });
    expect(code).toBe(1);
    const fail = lines.find((l) => l.startsWith("[FAIL] write-roundtrip"));
    expect(fail).toBeDefined();
    expect(fail!).toContain("consent_required");
    // No creates landed → nothing to tombstone.
    expect(mutations.filter((m) => m.kind === "create").length).toBe(0);
    expect(mutations.filter((m) => m.kind === "update").length).toBe(0);
  });

  test("FAIL: create succeeds but readback returns null → tombstone STILL written in finally", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const mutations: RecordedMutation[] = [];
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      write: true,
      nonceFn: () => "rt3",
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      writeNodeFactory: (_wnOpts) => {
        const base = mockNodeClient({ mutations });
        // Override queryAll so the readback finds nothing — simulates a
        // node that 200s the create but can't surface the row.
        return stubWriteClient({
          ...base,
          async queryAll() {
            return { ok: true, results: [], total_count: 0, returned_count: 0 };
          },
        });
      },
    });
    expect(code).toBe(1);
    const fail = lines.find((l) => l.startsWith("[FAIL] write-roundtrip"));
    expect(fail).toBeDefined();
    expect(fail!).toContain("subsequent read returned null");
    // The create happened, so the finally MUST still tombstone — same
    // contract as the freshness probe's cleanup guarantee.
    const tombstones = mutations.filter(
      (m) =>
        m.kind === "update" &&
        Array.isArray(m.fields["tags"]) &&
        (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(tombstones.length).toBe(1);
  });

  test("not run when --write is omitted (regression: no surprise writes from plain doctor)", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const mutations: RecordedMutation[] = [];
    const lines: string[] = [];
    let writeFactoryCalled = false;
    await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ mutations }),
      writeNodeFactory: (_wnOpts) => {
        writeFactoryCalled = true;
        return stubWriteClient(mockNodeClient({ mutations }));
      },
    });
    expect(writeFactoryCalled).toBe(false);
    expect(lines.some((l) => l.includes("write-roundtrip"))).toBe(false);
    expect(mutations.length).toBe(0);
  });

  test("skipped if schemas-loaded failed", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      write: true,
      capabilityStore: inMemoryCapabilityStore(),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ failedSchemas: ["BrokenSchema"] }),
    });
    expect(code).toBe(1);
    expect(
      lines.some((l) => l.includes("[FAIL] write-roundtrip") && l.includes("skipped")),
    ).toBe(true);
  });
});

// schemaServiceFixHint branches: the schema-service-reachable fix line was
// originally hard-wired to "--local-schema", which is only right for fold
// contributors. For fbrain users on a deployed Lambda we want a hint that
// either points at the alternate env or names both dev/prod URLs.
describe("schemaServiceFixHint", () => {
  const DEV_URL = "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";
  const PROD_URL = "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

  test("localhost URL → keep the original --local-schema hint", () => {
    expect(schemaServiceFixHint("http://localhost:9102")).toBe(
      "start fold's schema service (e.g. `./run.sh --local --local-schema`)",
    );
    expect(schemaServiceFixHint("http://127.0.0.1:9999")).toBe(
      "start fold's schema service (e.g. `./run.sh --local --local-schema`)",
    );
  });

  test("dev Lambda URL → suggest prod / check network", () => {
    const hint = schemaServiceFixHint(DEV_URL);
    expect(hint).toContain("check your network");
    expect(hint).toContain("prod");
    expect(hint).toContain(PROD_URL);
    expect(hint).not.toContain("--local-schema");
  });

  test("prod Lambda URL → suggest dev / check network", () => {
    const hint = schemaServiceFixHint(PROD_URL);
    expect(hint).toContain("check your network");
    expect(hint).toContain("dev");
    expect(hint).toContain(DEV_URL);
    expect(hint).not.toContain("--local-schema");
  });

  test("unknown URL → set schemaServiceUrl, naming both dev + prod", () => {
    const hint = schemaServiceFixHint("https://wrong.example.com");
    expect(hint).toContain("schemaServiceUrl");
    expect(hint).toContain(DEV_URL);
    expect(hint).toContain(PROD_URL);
    expect(hint).not.toContain("--local-schema");
  });
});
