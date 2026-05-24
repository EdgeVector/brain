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
  NodeClient,
  RegisteredSchema,
  SchemaServiceClient,
} from "../../src/client.ts";
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

function mockNodeClient(opts: {
  provisioned?: boolean;
  loadOk?: boolean;
  failedSchemas?: string[];
  identityThrows?: Error;
}): NodeClient {
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
    async createRecord() {},
    async updateRecord() {},
    async deleteRecord() {},
    async queryAll() {
      return { ok: true, results: [] };
    },
    async search() {
      return [];
    },
    async rawCall() {
      return { status: 200, headers: new Headers(), body: "", json: null };
    },
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
