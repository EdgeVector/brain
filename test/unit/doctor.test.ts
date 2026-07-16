// Unit tests for doctor. Inject mock SchemaServiceClient + NodeClient
// factories so we can exercise each drift dimension and the verdict logic
// without touching the network.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifySchemaDrift,
  diffSchemas,
  doctor,
  runCliEntrypointProbe,
  runMcpBootProbe,
  runMcpEntrypointProbe,
  runRuntimeProbe,
  schemaServiceFixHint,
  validateConfigShape,
  type McpBootInput,
  type McpBootResult,
} from "../../src/commands/doctor.ts";
import { FBRAIN_MCP_TOOL_NAMES } from "../../src/mcp/server.ts";
import {
  RECORDS,
  RECORD_TYPES,
  designSchema,
  projectSchema,
  type AddSchemaRequest,
  type RecordType,
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
import { buildTestCfg, TEST_HASHES, TEST_NODE_URL } from "../util.ts";

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
// the six per-kind Phase 6 schemas, plus sop.
type DriftKey =
  | "design"
  | "task"
  | "concept"
  | "preference"
  | "reference"
  | "agent"
  | "project"
  | "spike"
  | "sop"
  | "decision";
type DriftOverrides = Partial<Record<DriftKey, RegisteredSchema | null>>;

function mockSchemaClient(opts: {
  drift?: DriftOverrides;
  listSchemasOk?: boolean;
}): SchemaServiceClient {
  // Per-hash mapping covering all 9 UNIQUE_SCHEMAS entries: 2 baseline
  // (design/task) + 6 per-kind (concept/preference/reference/agent/project/spike)
  // + sop.
  const dispatch: Array<{ hash: string; driftKey: DriftKey; schema: AddSchemaRequest }> = [
    { hash: TEST_HASHES.design, driftKey: "design", schema: RECORDS.design.schema },
    { hash: TEST_HASHES.task, driftKey: "task", schema: RECORDS.task.schema },
    { hash: TEST_HASHES.concept, driftKey: "concept", schema: RECORDS.concept.schema },
    { hash: TEST_HASHES.preference, driftKey: "preference", schema: RECORDS.preference.schema },
    { hash: TEST_HASHES.reference, driftKey: "reference", schema: RECORDS.reference.schema },
    { hash: TEST_HASHES.agent, driftKey: "agent", schema: RECORDS.agent.schema },
    { hash: TEST_HASHES.project, driftKey: "project", schema: RECORDS.project.schema },
    { hash: TEST_HASHES.spike, driftKey: "spike", schema: RECORDS.spike.schema },
    { hash: TEST_HASHES.sop, driftKey: "sop", schema: RECORDS.sop.schema },
    { hash: TEST_HASHES.decision, driftKey: "decision", schema: RECORDS.decision.schema },
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
  // Record types to OMIT from listLoadedSchemas() — simulates schemas not yet
  // loaded into the node DB, which drives the read-path schemas-loaded FAIL.
  missingFromNode?: RecordType[];
  // Override the identity_hash listLoadedSchemas() reports for a given type —
  // for tests that point a config entry at a non-default hash and need the
  // node to report that same hash as loaded.
  loadedHashOverrides?: Partial<Record<RecordType, string>>;
  // When set, listLoadedSchemas() throws — exercises the check's catch path.
  listSchemasThrows?: Error;
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
  // Version the mock `health()` reports — drives the node-reachable version
  // line. `undefined` (the default) simulates an older node that omits version;
  // an explicit string surfaces `lastdb <version> @ <url>`.
  healthVersion?: string;
  // When set, `health()` rejects with this error — exercises doctor's
  // best-effort path (node-reachable must stay PASS, version omitted).
  healthThrows?: Error;
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
    async health() {
      if (opts.healthThrows) throw opts.healthThrows;
      const result: { ok: boolean; uptime_s?: number; version?: string } = { ok: true, uptime_s: 42 };
      if (opts.healthVersion !== undefined) result.version = opts.healthVersion;
      return result;
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
    async listLoadedSchemas() {
      if (opts.listSchemasThrows) throw opts.listSchemasThrows;
      const omit = new Set<RecordType>(opts.missingFromNode ?? []);
      // Return fbrain's 8 schemas under the same canonical hashes the test
      // config writes against (TEST_HASHES), so the read-path schemas-loaded
      // check sees them as present. Omit any caller-requested types to drive
      // a FAIL.
      return RECORD_TYPES.filter((t) => !omit.has(t)).map((t) => ({
        descriptive_name: t.charAt(0).toUpperCase() + t.slice(1),
        owner_app_id: "fbrain",
        identity_hash: opts.loadedHashOverrides?.[t] ?? TEST_HASHES[t],
      }));
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

  test("missing config + register succeeds → calm PASS schema-publish-gate (fbrain/* already published, the normal prod path)", async () => {
    // On prod, fbrain's 8 schemas are ALREADY published, so the probe's
    // re-register is idempotent and SUCCEEDS — this is the common path for
    // every fresh consumer, not an "unexpected" one. The gate must surface a
    // calm "already published / gate isn't blocking" PASS, and must NOT imply
    // doctor itself published anything to prod. The no-config `[FAIL] config`
    // line stays the sole verdict driver (still exit 1, still tells them to
    // run `fbrain init`).
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-empty-"));
    const lines: string[] = [];
    const code = await doctor({
      configPath: join(dir, "config.json"),
      print: (l) => lines.push(l),
      // Stub the publish-gate probe so this test stays a unit test (no
      // network) — register succeeds, exercising the idempotent-success branch.
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
    // Still red overall, but solely because of the no-config FAIL.
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] config"))).toBe(true);
    expect(lines.some((l) => l.includes("fbrain init"))).toBe(true);
    // The publish-gate line is a calm PASS with accurate "already published"
    // wording — never a FAIL, and never the old alarming "accepted a fbrain/*
    // publish" framing that read as though doctor published to prod.
    expect(lines.some((l) => l.includes("[FAIL] schema-publish-gate"))).toBe(false);
    const gateLine = lines.find((l) => l.includes("schema-publish-gate"));
    expect(gateLine).toBeDefined();
    expect(gateLine!).toContain("[PASS]");
    expect(gateLine!).toContain("already has fbrain/* published");
    expect(gateLine!).toContain("publish gate isn't blocking");
    // The old "unexpected publish" framing must be gone.
    expect(gateLine!).not.toContain("accepted a fbrain/* publish");
  });

  test("missing config + schema service returns cert_required → PASS schema-publish-gate (expected consumer state, not a blocker)", async () => {
    // `cert_required` is the EXPECTED state for a fresh consumer: the schema
    // service gates publishing `fbrain/*` behind a DevCert, but `fbrain init`
    // never publishes — it resolves the already-published canonical hashes
    // from the node (see init.ts "cert_required POST → resolves all 8 hashes,
    // no throw"). Reporting this as a FAIL with "init cannot complete" was a
    // false dead-end that scared fresh adopters away before running init.
    // The no-config `[FAIL] config` line still drives the red verdict and
    // tells them to run `fbrain init` — the publish-gate probe must NOT add
    // a phantom blocker on top of it.
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
    // Still red overall, but solely because of the no-config FAIL.
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] config"))).toBe(true);
    // cert_required is the healthy consumer state — surfaced as a PASS, never
    // a FAIL, and never claims "init cannot complete".
    expect(lines.some((l) => l.includes("[FAIL] schema-publish-gate"))).toBe(false);
    const gateLine = lines.find((l) => l.includes("schema-publish-gate"));
    expect(gateLine).toBeDefined();
    expect(gateLine!).toContain("[PASS]");
    expect(gateLine!).toContain("cert_required");
    expect(gateLine!).toContain("expected for a consumer");
    // The old false dead-end wording must be gone.
    expect(lines.some((l) => l.includes("cannot complete"))).toBe(false);
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
        `node not reachable at ${TEST_NODE_URL} — run \`fbrain doctor\` for a full diagnosis.`,
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
    expect(failLine).toContain(`node not reachable at ${TEST_NODE_URL}`);
  });

  // DX regression (29ced): a node that is REACHABLE but returns an HTTP 500
  // (e.g. it can't decrypt its identity) was told to `brew services start
  // folddb` even though it plainly answered (schema-service + every
  // schema-drift check, same node, PASS). The fix must surface the node's own
  // cause, NOT "start the node".
  test("node up but HTTP 500 → node-reachable fix does NOT say 'start the node'", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    // Shape matches mapNodeError's generic fallthrough for an unmatched 500:
    // code node_http_500, message carrying the node's identity-decrypt text.
    const http500 = new FbrainError({
      code: "node_http_500",
      message:
        "Node /api/system/auto-identity returned HTTP 500: Failed to initialize node identity: Security error: Encrypted node identity exists on disk, but this binary was built without the os-keychain feature. Set FOLDDB_MASTER_KEY=<64-hex-bytes> to decrypt explicitly.",
      hint: "Check the node log; this looks like a node-side bug.",
    });
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ identityThrows: http500 }),
    });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("[FAIL] node-reachable");
    // The node's own message is surfaced as the detail.
    expect(out).toContain("returned HTTP 500");
    // The fix must NOT tell the user to start a node that is plainly up.
    expect(out).not.toContain("brew services start lastdb");
    // Identity-failure heuristic points at the real remedy.
    expect(out).toContain("FOLDDB_MASTER_KEY");
  });

  // The complementary half: a genuinely DOWN node (transport failure) MUST
  // still get a socket-first recovery hint.
  test("node genuinely down (service_unreachable) → node-reachable fix is socket-first", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const unreachable = new FbrainError({
      code: "service_unreachable",
      message: "node not reachable at http://127.0.0.1:9001.",
    });
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ identityThrows: unreachable }),
    });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("[FAIL] node-reachable");
    expect(out).toContain("Unix socket");
    expect(out).toContain("fbrain doctor");
    expect(out).toContain("LastDB.app");
    expect(out).not.toContain("brew services start lastdb");
  });

  // The node-reachable line surfaces the connected node's folddb version
  // (from GET /api/health) so a dev spots a stale node without curl.
  test("node up + health reports version → node-reachable shows `lastdb <ver> @ <url>`", async () => {
    const configPath = writeCfg(makeCfg({ nodeUrl: "http://127.0.0.1:9077" }));
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ healthVersion: "0.14.1" }),
    });
    expect(code).toBe(0);
    const line = lines.find((l) => l.includes("[PASS] node-reachable"));
    expect(line).toBeDefined();
    expect(line).toContain("lastdb 0.14.1 @ http://127.0.0.1:9077");
  });

  test("configured live socket is passed to the node client and named on node-reachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-socket-"));
    const socketPath = join(dir, "folddb.sock");
    writeFileSync(socketPath, "");
    const prevSocketEnv = process.env.FBRAIN_FOLDDB_SOCKET;
    delete process.env.FBRAIN_FOLDDB_SOCKET;
    try {
      const cfg = makeCfg({
        nodeUrl: "http://127.0.0.1:9077",
        nodeSocketPath: socketPath,
      });
      const configPath = writeCfg(cfg);
      const lines: string[] = [];
      let captured:
        | { baseUrl: string; userHash: string; verbose?: unknown; socketPath?: string }
        | undefined;
      const code = await doctor({
        configPath,
        print: (l) => lines.push(l),
        schemaClientFactory: () => mockSchemaClient({}),
        nodeClientFactory: (factoryOpts) => {
          captured = factoryOpts;
          return mockNodeClient({ healthVersion: "0.15.1" });
        },
      });
      expect(code).toBe(0);
      expect(captured?.socketPath).toBe(socketPath);
      const line = lines.find((l) => l.includes("[PASS] node-reachable"));
      expect(line).toBeDefined();
      expect(line).toContain(`lastdb 0.15.1 @ unix:${socketPath}`);
      // fold #1246 collapsed the full-surface socket into the one control
      // socket, so a current single-socket node is fully served (owner routes
      // included) — no TCP fallback and NO "no full-surface socket" deficiency.
      expect(line).not.toContain("TCP fallback");
      expect(line).not.toContain("no full-surface socket");
    } finally {
      if (prevSocketEnv === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
      else process.env.FBRAIN_FOLDDB_SOCKET = prevSocketEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("configured full-surface socket suppresses TCP fallback prose on PASS lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-full-socket-"));
    const socketPath = join(dir, "folddb.sock");
    const fullSocketPath = join(dir, "folddb-full.sock");
    writeFileSync(socketPath, "");
    writeFileSync(fullSocketPath, "");
    const prevSocketEnv = process.env.FBRAIN_FOLDDB_SOCKET;
    delete process.env.FBRAIN_FOLDDB_SOCKET;
    try {
      const cfg = makeCfg({
        nodeUrl: "http://127.0.0.1:9001",
        nodeSocketPath: socketPath,
      });
      const configPath = writeCfg(cfg);
      const lines: string[] = [];
      const code = await doctor({
        configPath,
        print: (l) => lines.push(l),
        schemaClientFactory: () => mockSchemaClient({}),
        nodeClientFactory: () => mockNodeClient({ healthVersion: "0.19.1" }),
      });
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain(`node=unix:${socketPath} full=unix:${fullSocketPath}`);
      expect(out).toContain(`lastdb 0.19.1 @ unix:${socketPath} + unix:${fullSocketPath}`);
      expect(out).not.toContain(":9001");
      expect(out).not.toContain("TCP fallback");
    } finally {
      if (prevSocketEnv === undefined) delete process.env.FBRAIN_FOLDDB_SOCKET;
      else process.env.FBRAIN_FOLDDB_SOCKET = prevSocketEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Older node that doesn't report a version: node-reachable stays PASS and
  // the detail falls back to the node URL alone (no "lastdb undefined").
  test("node up, no version reported → node-reachable falls back to the url alone", async () => {
    const configPath = writeCfg(makeCfg({ nodeUrl: "http://127.0.0.1:9077" }));
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}), // healthVersion undefined
    });
    expect(code).toBe(0);
    const line = lines.find((l) => l.includes("[PASS] node-reachable"));
    expect(line).toBeDefined();
    expect(line).toContain("http://127.0.0.1:9077");
    expect(line).not.toContain("folddb");
  });

  // A health-probe failure is best-effort: node-reachable must stay PASS
  // (auto-identity already proved the node is up) with the version omitted.
  test("node up but health() throws → node-reachable stays PASS, version omitted", async () => {
    const configPath = writeCfg(makeCfg({ nodeUrl: "http://127.0.0.1:9077" }));
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({ healthThrows: new Error("health endpoint 404") }),
    });
    expect(code).toBe(0);
    const line = lines.find((l) => l.includes("[PASS] node-reachable"));
    expect(line).toBeDefined();
    expect(line).toContain("http://127.0.0.1:9077");
    expect(line).not.toContain("folddb");
  });

  test("node down → node-dependent checks SKIP (not vanish, not misleading PASS); single FAIL verdict", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const unreachable = new FbrainError({
      code: "service_unreachable",
      message: "node not reachable at http://127.0.0.1:9399.",
    });
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      // Schema service is up — drift would mislead as [PASS] without the gate.
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ identityThrows: unreachable }),
    });
    const out = lines.join("\n");

    // The four node-dependent checks must appear as explicit SKIP lines with a
    // "node unreachable" reason — not silently dropped.
    expect(out).toContain("[SKIP] node-provisioned  — node unreachable");
    expect(out).toContain("[SKIP] schemas-loaded  — node unreachable");
    expect(out).toContain("[SKIP] embedding-runtime  — node unreachable");
    expect(out).toContain("[SKIP] write-ready  — node unreachable");

    // schema-drift collapses to a single SKIP, NOT eight misleading [PASS].
    expect(out).toContain("[SKIP] schema-drift  — node unreachable");
    expect(out).not.toContain("[PASS] schema-drift");

    // SKIP is neutral — the verdict is still a single node-reachable FAIL.
    expect(out).toContain("[FAIL] node-reachable");
    expect(out).toContain("FAIL: 1 issue");
    expect(code).toBe(1);
  });

  test("node down --json → node-dependent checks carry tag SKIP, ok:true (neutral)", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const unreachable = new FbrainError({
      code: "service_unreachable",
      message: "node not reachable at http://127.0.0.1:9399.",
    });
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ identityThrows: unreachable }),
      json: true,
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(lines.join("\n")) as {
      ok: boolean;
      failures: number;
      checks: { name: string; tag: string; ok: boolean }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toBe(1);
    for (const name of [
      "node-provisioned",
      "schemas-loaded",
      "embedding-runtime",
      "write-ready",
      "schema-drift",
    ]) {
      const entry = parsed.checks.find((c) => c.name === name);
      expect(entry).toBeDefined();
      expect(entry!.tag).toBe("SKIP");
      expect(entry!.ok).toBe(true);
    }
    // The only failing check is node-reachable.
    expect(parsed.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "node-reachable",
    ]);
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
        `node not reachable at ${TEST_NODE_URL} — run \`fbrain doctor\` for a full diagnosis.`,
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
    expect(usageLine).toContain(`node not reachable at ${TEST_NODE_URL}`);
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
    for (const name of ["schemas-loaded", "schema-drift", "embedding-runtime", "write-ready"]) {
      expect(lines.some((l) => l.startsWith(`[SKIP] ${name}`))).toBe(true);
    }
  });

  test("schema absent from the node DB → schemas-loaded FAIL", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({ missingFromNode: ["concept"] }),
    });
    expect(code).toBe(1);
    expect(
      lines.some((l) => l.includes("[FAIL] schemas-loaded") && l.includes("Concept")),
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
              "(homebrew: `lastdb daemon stop && lastdb daemon start`).",
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
    expect(fixLine).toContain("lastdb daemon stop && lastdb daemon start");
  });

  test("embedding-runtime probe → WARN when the native search endpoint is missing", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          searchThrows: new FbrainError({
            code: "node_http_404",
            message: "Node /api/native-index/search returned HTTP 404.",
          }),
        }),
    });
    expect(code).toBe(0);
    const warnLine = lines.find((l) => l.startsWith("[WARN] embedding-runtime"));
    expect(warnLine).toBeDefined();
    expect(warnLine!).toContain("local query fallback");
    const fixLine = lines[lines.indexOf(warnLine!) + 1] ?? "";
    expect(fixLine).toContain("upgrade the LastDB node");
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
      nodeClientFactory: () =>
        mockNodeClient({ loadedHashOverrides: { project: customProjectHash } }),
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

  test("freshness PASS: 4/5 trials pass with a healthy average (variance-tolerant) → exit 0, cleanup still runs", async () => {
    // Variance tolerance (card doctor-freshness-probe-variance-tolerance): a
    // single trial missing the floor while the average stays healthy is normal
    // embedding-score noise on a fresh brain, NOT a failure. 4/5 passing with a
    // healthy avg must PASS so a new dev isn't scared off by a flaky red FAIL.
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
            // 4 trials surface healthily (~0.62); the 3rd dips below the floor
            // by noise. avg over the 5 scored trials ≈ 0.556 (≥ 0.5), 4/5 pass.
            const idx = trial++;
            if (idx === 2) return selfHit(slug, conceptHash, 0.42);
            return selfHit(slug, conceptHash, 0.62);
          },
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[PASS] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("4/5 trials passed"))).toBe(true);
    // The detail line still surfaces the average so a borderline-but-passing
    // brain reports its number.
    expect(lines.some((l) => l.includes("avg observed score"))).toBe(true);
    // Cleanup still ran for all 5 creates.
    const cleanupUpdates = mutations.filter(
      (m) => m.kind === "update" && Array.isArray(m.fields["tags"]) && (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(cleanupUpdates.length).toBe(5);
  });

  test("freshness FAIL: writes don't surface at all (avg null) → exit 1, node-pointing fix (no reindex), cleanup still runs", async () => {
    // A genuine failure: every trial misses its own record. avgScore === null,
    // 0/5 pass. Must FAIL loudly, and the fix must point at the node/embedding
    // runtime — NOT blanket-recommend `fbrain reindex`, which can't help when
    // writes aren't surfacing at all.
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const mutations: RecordedMutation[] = [];
    const code = await doctor({
      configPath,
      freshness: true,
      nonceFn: () => "test2b",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          mutations,
          onFreshnessSearch: () => null, // never surfaces
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("0/5 trials passed"))).toBe(true);
    // Fix points at the node, not a reindex.
    expect(lines.some((l) => l.includes("not surfacing in search at all"))).toBe(true);
    expect(lines.some((l) => l.includes("`fbrain reindex`"))).toBe(false);
    // Cleanup still ran for all 5 creates.
    const cleanupUpdates = mutations.filter(
      (m) => m.kind === "update" && Array.isArray(m.fields["tags"]) && (m.fields["tags"] as string[]).includes(TOMBSTONE_TAG),
    );
    expect(cleanupUpdates.length).toBe(5);
  });

  test("freshness FAIL: low average even with a passing majority → exit 1", async () => {
    // Systematically low retrieval quality: 3/5 trials technically clear the
    // floor at exactly 0.5 but two are very low, pulling the average under the
    // floor. A weak/low-quality index must still FAIL even though >half passed.
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    let trial = 0;
    const code = await doctor({
      configPath,
      freshness: true,
      nonceFn: () => "test2c",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          // scores: 0.5, 0.5, 0.5, 0.1, 0.1 → 3/5 pass but avg 0.34 < 0.5.
          onFreshnessSearch: (slug) => {
            const idx = trial++;
            return selfHit(slug, conceptHash, idx < 3 ? 0.5 : 0.1);
          },
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("3/5 trials passed"))).toBe(true);
    expect(lines.some((l) => l.includes("systematically low"))).toBe(true);
  });

  test("freshness FAIL: only a weak minority passes (2/5) even with a healthy avg → exit 1", async () => {
    // Majority-surfaced gate: a high average carried by a couple of strong
    // trials while most miss is NOT a healthy fresh brain. 2/5 is below the
    // ceil(trials/2) majority, so it must FAIL even though the average across
    // scored trials is ≥ floor.
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    let trial = 0;
    const code = await doctor({
      configPath,
      freshness: true,
      nonceFn: () => "test2d",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          // scores: 0.95, 0.95, 0.45, 0.45, 0.45 → avg 0.65 (≥0.5) but only 2/5 pass.
          onFreshnessSearch: (slug) => {
            const idx = trial++;
            return selfHit(slug, conceptHash, idx < 2 ? 0.95 : 0.45);
          },
          onPollutionSearch: () => [],
        }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith("[FAIL] freshness-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("2/5 trials passed"))).toBe(true);
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
    // because > 0.25. pollutionMinSample:1 keeps this exercising the ratio path
    // (4 hits is below the real default-10 small-sample floor).
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      pollutionMinSample: 1,
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

  test("pollution above fail-threshold → WARN, exit 0, honest hint (no reindex remedy)", async () => {
    // Regression for doctor-pollution-fix-misleads-reindex: a pollution ratio
    // above the old 50% fail-threshold must NOT fail the verdict (exit stays 0)
    // and must NOT recommend `fbrain reindex` (which increases pollution). It
    // surfaces as a WARN with an honest hint pointing at the upstream purge.
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    // 1 live + 3 stale + 1 orphan = 80% polluted. pollutionMinSample:1 keeps
    // this on the ratio path (5 hits is below the real default-10 floor).
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      pollutionMinSample: 1,
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
    // Pollution alone must not fail the verdict.
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[WARN] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[FAIL] pollution-probe"))).toBe(false);
    expect(lines.some((l) => l.includes("pollution 80%"))).toBe(true);
    // The remediation must no longer point at `reindex` anywhere in the output.
    expect(lines.some((l) => l.includes("run `fbrain reindex`"))).toBe(false);
    // The hint is honest about the append-only cause and the upstream purge.
    const hintLine = lines.find((l) => l.includes("does NOT reduce pollution"));
    expect(hintLine).toBeDefined();
    expect(lines.some((l) => l.includes("tracked upstream"))).toBe(true);
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
      pollutionMinSample: 1,
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
    // 100% polluted, but pollution never fails the verdict (it surfaces as a
    // WARN — see doctor-pollution-fix-misleads-reindex). The point of this test
    // is that a tombstoned record is classified as stale, not live.
    // pollutionMinSample:1 keeps the single hit on the ratio path.
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[WARN] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("stale 1"))).toBe(true);
  });

  test("pollution small-sample floor: total < minSample → PASS, no WARN, low-sample note, no fail-threshold framing", async () => {
    // Regression for doctor-pollution-probe-low-n-floor: a brand-new dev's
    // sparse brain (a handful of hits, mostly stale from their own re-put/delete
    // churn) must NOT trip the ratio verdict. Below the default-10 floor the
    // probe PASSes and reports raw counts with an explicit low-sample note —
    // never "above NN% fail-threshold".
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    // 7 hits, 5 stale → 71% by ratio (the dogfooded false signal), but only 7
    // hits is below the default-10 floor, so the % framing is suppressed.
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "lowN",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.9),
          onPollutionSearch: () => [
            fbrainHit("alive-1", conceptHash, 0.7),
            fbrainHit("alive-2", conceptHash, 0.6),
            fbrainHit("gone-1", conceptHash, 0.55),
            fbrainHit("gone-2", conceptHash, 0.5),
            fbrainHit("gone-3", conceptHash, 0.45),
            fbrainHit("gone-4", conceptHash, 0.4),
            fbrainHit("gone-5", conceptHash, 0.35),
          ],
          store: {
            [conceptHash]: [conceptRow("alive-1"), conceptRow("alive-2")],
          },
        }),
    });
    expect(code).toBe(0);
    // PASS, never WARN, at low N.
    expect(lines.some((l) => l.startsWith("[PASS] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[WARN] pollution-probe"))).toBe(false);
    // Explicit low-sample note, raw counts, and NO fail-threshold framing.
    expect(lines.some((l) => l.includes("low sample (N=7"))).toBe(true);
    expect(lines.some((l) => l.includes("not meaningful"))).toBe(true);
    expect(lines.some((l) => l.includes("fail-threshold"))).toBe(false);
    expect(lines.some((l) => l.includes("stale 5"))).toBe(true);
  });

  test("pollution at/above minSample still WARNs with the ratio framing", async () => {
    // Companion to the floor test: once there are enough hits (>= minSample) the
    // existing ratio verdict applies unchanged — a genuinely polluted node still
    // surfaces a WARN.
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const conceptHash = TEST_HASHES.concept;
    // 10 hits (== default floor), 8 stale → 80% polluted → WARN.
    const code = await doctor({
      configPath,
      freshness: true,
      freshnessTrials: 1,
      nonceFn: () => "atFloor",
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () =>
        mockNodeClient({
          onFreshnessSearch: (slug) => selfHit(slug, conceptHash, 0.9),
          onPollutionSearch: () => [
            fbrainHit("alive-1", conceptHash, 0.7),
            fbrainHit("alive-2", conceptHash, 0.6),
            fbrainHit("gone-1", conceptHash, 0.55),
            fbrainHit("gone-2", conceptHash, 0.5),
            fbrainHit("gone-3", conceptHash, 0.45),
            fbrainHit("gone-4", conceptHash, 0.4),
            fbrainHit("gone-5", conceptHash, 0.35),
            fbrainHit("gone-6", conceptHash, 0.3),
            fbrainHit("gone-7", conceptHash, 0.25),
            fbrainHit("gone-8", conceptHash, 0.2),
          ],
          store: {
            [conceptHash]: [conceptRow("alive-1"), conceptRow("alive-2")],
          },
        }),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("[WARN] pollution-probe"))).toBe(true);
    expect(lines.some((l) => l.includes("pollution 80%"))).toBe(true);
    expect(lines.some((l) => l.includes("low sample"))).toBe(false);
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
      nodeClientFactory: () => mockNodeClient({ missingFromNode: ["concept"] }),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[SKIP] freshness-probe") && l.includes("skipped"))).toBe(true);
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
    const result =
      consent.status === 202
        ? "no_pending"
        : consent.status === 404
          ? "not_registered"
          : undefined;
    return {
      ...base,
      async rawCall() {
        return {
          status: consent.status === 202 || consent.status === 404 ? 200 : consent.status,
          headers: new Headers(),
          body: "",
          json: result ? { result } : (consent.body ?? {}),
        };
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

  test("plain doctor checks app registration without POSTing request-consent", async () => {
    const cfg = makeCfg();
    const configPath = writeCfg(cfg);
    const store = await withCachedCapability(cfg.nodeUrl);
    let requestConsentCalls = 0;
    let rawCalls = 0;
    const base = mockNodeClient({});
    const node: NodeClient = {
      ...base,
      async requestConsent() {
        requestConsentCalls++;
        throw new Error("requestConsent must not run during plain doctor");
      },
      async rawCall(method, path) {
        rawCalls++;
        expect(method).toBe("GET");
        expect(path).toBe("/api/apps/consent-request/fbrain");
        return {
          status: 200,
          headers: new Headers(),
          body: "",
          json: { result: "no_pending" },
        };
      },
    };
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      capabilityStore: store,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => node,
    });

    expect(code).toBe(0);
    expect(rawCalls).toBe(1);
    expect(requestConsentCalls).toBe(0);
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
    // Must name the non-interactive verb `fbrain init --grant-consent`, NOT bare
    // `fbrain init` — bare init silently skips the consent prompt without a TTY,
    // so following the hint on the scripted/agent install path loops forever.
    expect(fix).toContain("fbrain init --grant-consent");
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
      async rawCall() {
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

  function nodeWithRegisteredApp(): NodeClient {
    const base = mockNodeClient({});
    return {
      ...base,
      async rawCall() {
        return {
          status: 200,
          headers: new Headers(),
          body: "",
          json: { result: "no_pending" },
        };
      },
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
      // Write-ready probe also runs in this codepath; give it a registered
      // app lookup so its no-capability failure is deterministic.
      nodeClientFactory: () => nodeWithRegisteredApp(),
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
      nodeClientFactory: () => mockNodeClient({ missingFromNode: ["concept"] }),
    });
    expect(code).toBe(1);
    expect(
      lines.some((l) => l.includes("[SKIP] write-roundtrip") && l.includes("skipped")),
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

// fbrain-entrypoint probe — catches a broken global CLI install before
// scripts/routines that shell out to bare `fbrain` hit command-not-found.
describe("runCliEntrypointProbe", () => {
  test("resolved → PASS, detail names the resolved path", () => {
    const check = runCliEntrypointProbe(
      { whichBin: () => "/Users/x/.bun/bin/fbrain" },
      undefined,
    );
    expect(check.name).toBe("fbrain-entrypoint");
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined();
    expect(check.detail).toContain("fbrain -> /Users/x/.bun/bin/fbrain");
  });

  test("unresolved → WARN (ok:true) with the relink hint, never FAIL", () => {
    const check = runCliEntrypointProbe(
      {
        whichBin: () => null,
        homeDir: mkdtempSync(join(tmpdir(), "fbrain-no-bin-")),
      },
      undefined,
    );
    expect(check.name).toBe("fbrain-entrypoint");
    expect(check.ok).toBe(true);
    expect(check.tag).toBe("WARN");
    expect(check.detail).toContain("command not found");
    expect(check.fix).toContain("bun add -g github:EdgeVector/fbrain");
    expect(check.fix).toContain("fbrain --version");
  });

  test("unresolved with dangling ~/.bun/bin/fbrain → WARN names the broken symlink", () => {
    const home = mkdtempSync(join(tmpdir(), "fbrain-dangling-bin-"));
    const bunBin = join(home, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    symlinkSync("../install/global/node_modules/fbrain/bin/fbrain", join(bunBin, "fbrain"));

    const check = runCliEntrypointProbe(
      { whichBin: () => null, homeDir: home },
      undefined,
    );
    expect(check.name).toBe("fbrain-entrypoint");
    expect(check.ok).toBe(true);
    expect(check.tag).toBe("WARN");
    expect(check.detail).toContain("dangling ~/.bun/bin/fbrain");
    expect(check.detail).toContain("../install/global/node_modules/fbrain/bin/fbrain");
    expect(check.fix).toContain("remove it before relinking");
  });

  test("probes the fbrain bin name", () => {
    const asked: string[] = [];
    runCliEntrypointProbe(
      {
        whichBin: (n) => {
          asked.push(n);
          return null;
        },
        homeDir: mkdtempSync(join(tmpdir(), "fbrain-probe-name-")),
      },
      undefined,
    );
    expect(asked).toEqual(["fbrain"]);
  });
});

// mcp-entrypoint probe — the headline agent-integration path. PASS when the
// `fbrain-mcp` bin resolves on PATH (message carries the resolved path); WARN
// (never FAIL — must not flip the verdict) with a re-link hint when it
// doesn't. Resolution is injected via `whichBin` so the test never depends on
// the host's real PATH.
describe("runMcpEntrypointProbe", () => {
  test("resolved → PASS, detail names the resolved path", () => {
    const check = runMcpEntrypointProbe(
      { whichBin: () => "/Users/x/.bun/bin/fbrain-mcp" },
      undefined,
    );
    expect(check.name).toBe("mcp-entrypoint");
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined(); // plain PASS
    expect(check.detail).toContain("fbrain-mcp -> /Users/x/.bun/bin/fbrain-mcp");
  });

  test("unresolved → WARN (ok:true) with the re-link hint, never FAIL", () => {
    const check = runMcpEntrypointProbe({ whichBin: () => null }, undefined);
    expect(check.name).toBe("mcp-entrypoint");
    expect(check.ok).toBe(true); // WARN must not flip the verdict
    expect(check.tag).toBe("WARN");
    expect(check.fix).toContain("bun link");
    expect(check.fix).toContain("claude mcp add fbrain fbrain-mcp");
    expect(check.fix).toContain('realpath src/mcp/main.ts');
  });

  test("probes the fbrain-mcp bin name", () => {
    const asked: string[] = [];
    runMcpEntrypointProbe(
      {
        whichBin: (n) => {
          asked.push(n);
          return null;
        },
      },
      undefined,
    );
    expect(asked).toEqual(["fbrain-mcp"]);
  });
});

// runtime probe — compares the running Bun against fbrain's documented minimum
// (README Prerequisites / package.json engines.bun). PASS when new enough;
// FAIL (not WARN — too old a runtime is a real blocker) with a `brew upgrade
// bun` hint when older. The running version is injected via `bunVersion` so
// both branches are deterministic regardless of the host's installed Bun.
describe("runRuntimeProbe", () => {
  test("supported Bun → PASS, detail names found + minimum", () => {
    const check = runRuntimeProbe({ bunVersion: "1.3.10" }, undefined);
    expect(check.name).toBe("runtime");
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined(); // plain PASS
    expect(check.detail).toContain("1.3.10");
    expect(check.fix).toBeUndefined();
  });

  test("newer Bun → PASS", () => {
    const check = runRuntimeProbe({ bunVersion: "1.4.0" }, undefined);
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined();
  });

  test("a Bun prerelease of the minimum still PASSes (build noise ignored)", () => {
    const check = runRuntimeProbe({ bunVersion: "1.3.10-canary.1+abc" }, undefined);
    expect(check.ok).toBe(true);
  });

  test("older Bun → FAIL with an actionable upgrade hint", () => {
    const check = runRuntimeProbe({ bunVersion: "1.2.0" }, undefined);
    expect(check.name).toBe("runtime");
    expect(check.ok).toBe(false); // FAIL flips the verdict — real blocker
    expect(check.detail).toContain("1.2.0");
    expect(check.detail).toContain("1.3.10"); // names the required minimum
    expect(check.fix).toContain("1.2.0"); // the found version
    expect(check.fix).toContain("1.3.10"); // the required minimum
    expect(check.fix).toContain("brew upgrade bun");
  });
});

describe("doctor runtime integration", () => {
  test("supported Bun → [PASS] runtime, exit 0", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      bunVersion: "1.3.10",
    });
    expect(code).toBe(0);
    const line = lines.find((l) => /\] runtime\b/.test(l));
    expect(line).toBeDefined();
    expect(line!.startsWith("[PASS]")).toBe(true);
    expect(line!).toContain("1.3.10");
  });

  test("older Bun → [FAIL] runtime + upgrade hint, overall exit 1", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      bunVersion: "1.0.0",
    });
    // A too-old runtime FAILs the verdict.
    expect(code).toBe(1);
    const failLine = lines.find((l) => /\] runtime\b/.test(l));
    expect(failLine).toBeDefined();
    expect(failLine!.startsWith("[FAIL]")).toBe(true);
    const fixLine = lines[lines.indexOf(failLine!) + 1] ?? "";
    expect(fixLine).toContain("brew upgrade bun");
    expect(fixLine).toContain("1.0.0"); // names the found version
  });

  test("--json output includes the runtime check entry", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      json: true,
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      bunVersion: "1.3.10",
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as {
      checks: { name: string; tag: string; ok: boolean }[];
    };
    const runtime = parsed.checks.find((c) => c.name === "runtime");
    expect(runtime).toBeDefined();
    expect(runtime!.tag).toBe("PASS");
    expect(runtime!.ok).toBe(true);
  });
});

describe("doctor mcp-entrypoint integration", () => {
  test("resolvable fbrain-mcp → [PASS] mcp-entrypoint with path, exit 0", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => "/Users/x/.bun/bin/fbrain-mcp",
    });
    expect(code).toBe(0);
    const line = lines.find((l) => l.includes("mcp-entrypoint"));
    expect(line).toBeDefined();
    expect(line!.startsWith("[PASS]")).toBe(true);
    expect(line!).toContain("/Users/x/.bun/bin/fbrain-mcp");
  });

  test("unresolvable fbrain-mcp → [WARN] mcp-entrypoint + hint, overall exit STILL 0", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => null,
    });
    // WARN must NOT flip doctor's overall exit code.
    expect(code).toBe(0);
    const warnLine = lines.find((l) => l.includes("mcp-entrypoint"));
    expect(warnLine).toBeDefined();
    expect(warnLine!.startsWith("[WARN]")).toBe(true);
    // The actionable re-link hint follows on the next `fix:` line.
    const fixLine = lines[lines.indexOf(warnLine!) + 1] ?? "";
    expect(fixLine).toContain("bun link");
    expect(fixLine).toContain("claude mcp add fbrain fbrain-mcp");
  });

  test("--json output includes the mcp-entrypoint check entry", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      json: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => "/Users/x/.bun/bin/fbrain-mcp",
    });
    expect(code).toBe(0);
    // --json emits exactly one JSON object — the human lines are suppressed.
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      ok: boolean;
      failures: number;
      checks: Array<{ name: string; tag: string; ok: boolean; detail?: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.failures).toBe(0);
    const mcp = parsed.checks.find((c) => c.name === "mcp-entrypoint");
    expect(mcp).toBeDefined();
    expect(mcp!.tag).toBe("PASS");
    expect(mcp!.ok).toBe(true);
    expect(mcp!.detail).toContain("fbrain-mcp -> /Users/x/.bun/bin/fbrain-mcp");
  });

  test("--json with unresolvable fbrain-mcp → WARN entry, overall ok:true (exit 0)", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      json: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => null,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as {
      ok: boolean;
      checks: Array<{ name: string; tag: string; ok: boolean; fix?: string }>;
    };
    expect(parsed.ok).toBe(true); // WARN doesn't flip the verdict
    const mcp = parsed.checks.find((c) => c.name === "mcp-entrypoint");
    expect(mcp).toBeDefined();
    expect(mcp!.tag).toBe("WARN");
    expect(mcp!.ok).toBe(true);
    expect(mcp!.fix).toContain("bun link");
  });
});

// --mcp boot probe — the opt-in deep probe that BOOTS fbrain-mcp and asserts
// the complete agent surface (vs. mcp-entrypoint, which is PATH-resolution
// only). The child-process handshake is injected via `mcpBootRunner` so the
// tests never spawn a real server: a runner that returns a valid handshake +
// the full tool set → PASS; one that drops a tool → FAIL; one that simulates a
// hung server (timeout) → FAIL. Mirrors the owner-session-attest deadline
// test shape.
const FULL_TOOLS = [...FBRAIN_MCP_TOOL_NAMES];

function bootRunnerReturning(result: McpBootResult) {
  return async (_input: McpBootInput): Promise<McpBootResult> => result;
}

describe("runMcpBootProbe", () => {
  test("valid handshake + all tools, version MATCHES CLI → PASS with count + serverInfo", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        // Pin the CLI version to the agent's so the build-skew check passes
        // and we exercise the plain-PASS path deterministically.
        cliVersion: "0.8.0 (abc1234)",
        mcpBootRunner: bootRunnerReturning({
          ok: true,
          tools: FULL_TOOLS,
          serverInfo: { name: "fbrain", version: "0.8.0 (abc1234)" },
        }),
      },
      undefined,
    );
    expect(check.name).toBe("mcp-boot");
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined(); // plain PASS
    expect(check.detail).toContain(`tools=${FULL_TOOLS.length}`);
    expect(check.detail).toContain("fbrain 0.8.0 (abc1234)");
  });

  test("valid handshake but agent build DIFFERS from CLI → WARN naming both versions + re-link fix", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        // CLI is one build; the booted (stale `bun link`ed) agent is another.
        cliVersion: "0.8.0 (1aef3ea)",
        mcpBootRunner: bootRunnerReturning({
          ok: true,
          tools: FULL_TOOLS,
          serverInfo: { name: "fbrain", version: "0.8.0 (eac2d81)" },
        }),
      },
      undefined,
    );
    expect(check.name).toBe("mcp-boot");
    // WARN is ok:true + tag WARN — surfaces visibly but doesn't trip the verdict.
    expect(check.ok).toBe(true);
    expect(check.tag).toBe("WARN");
    expect(check.detail).toContain("DIFFERENT fbrain build");
    expect(check.detail).toContain("CLI 0.8.0 (1aef3ea)");
    expect(check.detail).toContain("agent 0.8.0 (eac2d81)");
    expect(check.fix).toContain("bun link");
    expect(check.fix).toContain("claude mcp add fbrain fbrain-mcp");
  });

  test("serverInfo absent → stays PASS (no version to compare)", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        cliVersion: "0.8.0 (1aef3ea)",
        mcpBootRunner: bootRunnerReturning({
          ok: true,
          tools: FULL_TOOLS,
        }),
      },
      undefined,
    );
    expect(check.ok).toBe(true);
    expect(check.tag).toBeUndefined(); // plain PASS
    expect(check.detail).toContain("serverInfo (none)");
  });

  test("handshake reports one missing tool → FAIL naming the missing tool", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        mcpBootRunner: bootRunnerReturning({
          ok: true,
          tools: FULL_TOOLS.filter((t) => t !== "fbrain_link"),
          serverInfo: { name: "fbrain", version: "0.8.0" },
        }),
      },
      undefined,
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("mismatch");
    expect(check.detail).toContain("missing: fbrain_link");
    expect(check.detail).toContain(`expected exactly ${FULL_TOOLS.length}`);
    expect(check.fix).toContain("bun link");
    expect(check.fix).toContain("claude mcp add fbrain fbrain-mcp");
  });

  test("handshake reports an unexpected/renamed tool → FAIL", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        mcpBootRunner: bootRunnerReturning({
          ok: true,
          tools: [...FULL_TOOLS, "fbrain_renamed"],
        }),
      },
      undefined,
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("unexpected: fbrain_renamed");
  });

  test("server hangs past the deadline → clean FAIL (probe never hangs)", async () => {
    // Mirror owner-session-attest's deadline test: the runner reports the
    // timeout outcome the real child-kill path would produce, and the probe
    // resolves to a FAIL rather than hanging.
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        mcpBootRunner: bootRunnerReturning({
          ok: false,
          reason: "boot/handshake exceeded the 30000ms deadline (server hung)",
        }),
      },
      undefined,
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("boot/handshake failed");
    expect(check.detail).toContain("deadline");
    expect(check.fix).toContain("bun link");
  });

  test("boot crash → FAIL carrying the crash reason", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        mcpBootRunner: bootRunnerReturning({
          ok: false,
          reason: "initialize returned an error: SyntaxError on startup",
        }),
      },
      undefined,
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("SyntaxError on startup");
  });

  test("runner that THROWS becomes a clean FAIL, not an uncaught rejection", async () => {
    const check = await runMcpBootProbe(
      "/Users/x/.bun/bin/fbrain-mcp",
      {
        mcpBootRunner: async () => {
          throw new Error("spawn ENOENT");
        },
      },
      undefined,
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("spawn ENOENT");
  });

  // Real-spawn regression for the deadline: the DEFAULT runner (no injected
  // mcpBootRunner) spawns an actual child that never speaks MCP and ignores
  // SIGTERM. The probe must surface a bounded timeout FAIL and reap the child
  // — proving the deadline is enforced by racing the read, not by relying on
  // proc.kill() to unblock a pending read. A short FBRAIN_HTTP_TIMEOUT_MS
  // keeps the test fast.
  test("DEFAULT runner: a hung SIGTERM-deaf child → bounded timeout FAIL (no hang)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbrain-mcp-hang-"));
    const fake = join(dir, "fbrain-mcp");
    // Bash: ignore TERM, block forever reading stdin. Only SIGKILL stops it.
    writeFileSync(fake, "#!/bin/bash\ntrap '' TERM\nwhile true; do read -r _l || sleep 1; done\n");
    chmodSync(fake, 0o755);

    const prev = process.env.FBRAIN_HTTP_TIMEOUT_MS;
    process.env.FBRAIN_HTTP_TIMEOUT_MS = "1500";
    const started = Date.now();
    try {
      const check = await runMcpBootProbe(fake, {}, undefined);
      const elapsed = Date.now() - started;
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("deadline");
      // Must complete near the deadline, not hang — generous upper bound to
      // absorb CI scheduling jitter while still proving it didn't wedge.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (prev === undefined) delete process.env.FBRAIN_HTTP_TIMEOUT_MS;
      else process.env.FBRAIN_HTTP_TIMEOUT_MS = prev;
    }
  });
});

describe("doctor --mcp integration", () => {
  test("default doctor (no --mcp) never invokes the boot runner / spawns", async () => {
    const configPath = writeCfg(makeCfg());
    let invoked = false;
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => "/Users/x/.bun/bin/fbrain-mcp",
      mcpBootRunner: async () => {
        invoked = true;
        return { ok: true, tools: FULL_TOOLS };
      },
    });
    expect(code).toBe(0);
    expect(invoked).toBe(false); // cheap path: no spawn without --mcp
    expect(lines.find((l) => l.includes("mcp-boot"))).toBeUndefined();
  });

  test("--mcp with a healthy server → [PASS] mcp-boot tools count, exit 0", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      mcp: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => "/Users/x/.bun/bin/fbrain-mcp",
      // Agent build matches the CLI → plain PASS (not the version-skew WARN).
      cliVersion: "0.8.0",
      mcpBootRunner: bootRunnerReturning({
        ok: true,
        tools: FULL_TOOLS,
        serverInfo: { name: "fbrain", version: "0.8.0" },
      }),
    });
    expect(code).toBe(0);
    const line = lines.find((l) => l.includes("mcp-boot"));
    expect(line).toBeDefined();
    expect(line!.startsWith("[PASS]")).toBe(true);
    expect(line!).toContain(`tools=${FULL_TOOLS.length}`);
  });

  test("--mcp with a broken tool surface → [FAIL] mcp-boot, exit 1", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      mcp: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => "/Users/x/.bun/bin/fbrain-mcp",
      mcpBootRunner: bootRunnerReturning({
        ok: true,
        tools: FULL_TOOLS.slice(0, 6),
      }),
    });
    expect(code).toBe(1); // FAIL flips the verdict (unlike mcp-entrypoint WARN)
    const line = lines.find((l) => l.includes("mcp-boot"));
    expect(line).toBeDefined();
    expect(line!.startsWith("[FAIL]")).toBe(true);
  });

  test("--mcp but fbrain-mcp unresolved → [WARN] mcp-boot skipped, exit STILL 0", async () => {
    const configPath = writeCfg(makeCfg());
    let invoked = false;
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      mcp: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => null,
      mcpBootRunner: async () => {
        invoked = true;
        return { ok: true, tools: FULL_TOOLS };
      },
    });
    expect(code).toBe(0); // skip is a coherent WARN, not a FAIL
    expect(invoked).toBe(false); // nothing to boot — runner never called
    const line = lines.find((l) => l.includes("mcp-boot"));
    expect(line).toBeDefined();
    expect(line!.startsWith("[WARN]")).toBe(true);
    expect(line!).toContain("nothing to boot");
  });

  test("--json includes the mcp-boot check entry (FAIL → ok:false)", async () => {
    const configPath = writeCfg(makeCfg());
    const lines: string[] = [];
    const code = await doctor({
      configPath,
      mcp: true,
      json: true,
      print: (l) => lines.push(l),
      schemaClientFactory: () => mockSchemaClient({}),
      nodeClientFactory: () => mockNodeClient({}),
      whichBin: () => "/Users/x/.bun/bin/fbrain-mcp",
      mcpBootRunner: bootRunnerReturning({ ok: true, tools: FULL_TOOLS.slice(0, 6) }),
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(lines[0]!) as {
      ok: boolean;
      checks: Array<{ name: string; tag: string; ok: boolean; detail?: string; fix?: string }>;
    };
    expect(parsed.ok).toBe(false);
    const boot = parsed.checks.find((c) => c.name === "mcp-boot");
    expect(boot).toBeDefined();
    expect(boot!.tag).toBe("FAIL");
    expect(boot!.ok).toBe(false);
    expect(boot!.fix).toContain("claude mcp add fbrain fbrain-mcp");
  });
});
