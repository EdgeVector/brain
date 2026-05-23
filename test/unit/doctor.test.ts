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
  designSchema,
  taskSchema,
} from "../../src/schemas.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";
import type {
  NodeClient,
  RegisteredSchema,
  SchemaServiceClient,
} from "../../src/client.ts";

const DESIGN_HASH = "84d9f350b4ff55d9bc96178cd83bd858e8db692485dc820474c5c30355a3062b";
const TASK_HASH = "c0352ec0c4534bfbc7b692ce4437a0843bdc993aeedfa7df9679437a3cf2bd1e";

function asRegistered(
  schemaDef: typeof designSchema | typeof taskSchema,
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
  return {
    configVersion: CONFIG_VERSION,
    nodeUrl: "http://127.0.0.1:9101",
    schemaServiceUrl: "http://127.0.0.1:9102",
    userHash: "uh-test",
    designSchemaHash: DESIGN_HASH,
    taskSchemaHash: TASK_HASH,
    ...over,
  };
}

function writeCfg(cfg: Config): string {
  const dir = mkdtempSync(join(tmpdir(), "fbrain-doctor-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(cfg), "utf8");
  return path;
}

function mockSchemaClient(opts: {
  designReg?: RegisteredSchema | null;
  taskReg?: RegisteredSchema | null;
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
      if (hash === DESIGN_HASH) {
        return "designReg" in opts ? (opts.designReg ?? null) : asRegistered(designSchema, DESIGN_HASH);
      }
      if (hash === TASK_HASH) {
        return "taskReg" in opts ? (opts.taskReg ?? null) : asRegistered(taskSchema, TASK_HASH);
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
  test("accepts hex64 hashes", () => {
    expect(validateConfigShape(makeCfg())).toEqual([]);
  });

  test("rejects too-short designSchemaHash", () => {
    const issues = validateConfigShape(makeCfg({ designSchemaHash: "deadbeef" }));
    expect(issues[0]).toContain("designSchemaHash");
  });

  test("rejects non-hex taskSchemaHash", () => {
    const issues = validateConfigShape(
      makeCfg({ taskSchemaHash: "z".repeat(64) }),
    );
    expect(issues[0]).toContain("taskSchemaHash");
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
  test("all green → exit 0", async () => {
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
      makeCfg({ designSchemaHash: "not-hex-not-64" }),
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
        mockSchemaClient({ designReg: null }), // simulates 404 lookup
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
      schemaClientFactory: () => mockSchemaClient({ designReg: drifted }),
      nodeClientFactory: () => mockNodeClient({}),
    });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("[FAIL] schema-drift[Design]"))).toBe(true);
  });
});
