// `fbrain doctor` — live health check for the local fbrain setup.
//
// Checks (each prints PASS/FAIL with a fix-suggestion when FAIL):
//   1. config valid (~/.fbrain/config.json exists + schema-shape + hex64 hashes)
//   2. schema service reachable (GET /v1/schemas → 200)
//   3. node reachable (GET /api/system/auto-identity → 200 or 503)
//   4. node provisioned (auto-identity → 200, body has user_hash)
//   5. schemas loaded into the node (POST /api/schemas/load → failed_schemas empty)
//   6. schema drift — for Design + Task: GET /v1/schema/<canonicalHash>,
//      compare descriptive_name + fields + field_types against schemas.ts.
//
// Exit code 0 on all-green, 1 if any check fails.

import {
  FbrainError,
  newNodeClient,
  newSchemaServiceClient,
  type NodeClient,
  type RegisteredSchema,
  type SchemaServiceClient,
  type Verbose,
} from "../client.ts";
import { tryReadConfig, type Config } from "../config.ts";
import {
  designSchema,
  taskSchema,
  type AddSchemaRequest,
} from "../schemas.ts";

export type DoctorOptions = {
  configPath?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // For testing: inject prebuilt clients to bypass the real fetches.
  schemaClientFactory?: (url: string, v?: Verbose) => SchemaServiceClient;
  nodeClientFactory?: (opts: { baseUrl: string; userHash: string; verbose?: Verbose }) => NodeClient;
};

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
};

export async function doctor(opts: DoctorOptions = {}): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const verbose = opts.verbose;

  const checks: CheckResult[] = [];

  // 1. config
  const cfg = tryReadConfig(opts.configPath);
  if (!cfg) {
    checks.push({
      name: "config",
      ok: false,
      detail: "no ~/.fbrain/config.json",
      fix: "run `fbrain init`",
    });
    return finalize(checks, print);
  }
  const cfgIssues = validateConfigShape(cfg);
  if (cfgIssues.length > 0) {
    checks.push({
      name: "config",
      ok: false,
      detail: cfgIssues.join("; "),
      fix: "re-run `fbrain init` to refresh canonical hashes",
    });
  } else {
    checks.push({
      name: "config",
      ok: true,
      detail: `nodeUrl=${cfg.nodeUrl} schemaServiceUrl=${cfg.schemaServiceUrl}`,
    });
  }
  verbose?.(`config: ${cfgIssues.length === 0 ? "ok" : `bad — ${cfgIssues.join("; ")}`}`);

  const schemaClient = (opts.schemaClientFactory ?? newSchemaServiceClient)(
    cfg.schemaServiceUrl,
    verbose,
  );
  const nodeClient = (opts.nodeClientFactory ?? newNodeClient)({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    verbose,
  });

  // 2. schema service reachable
  try {
    await schemaClient.listSchemas();
    checks.push({ name: "schema-service-reachable", ok: true });
    verbose?.(`schema-service-reachable: ok`);
  } catch (err) {
    checks.push({
      name: "schema-service-reachable",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: "start fold's schema service (e.g. `./run.sh --local --local-schema`)",
    });
    verbose?.(`schema-service-reachable: FAIL`);
  }

  // 3 + 4. node reachable + provisioned
  let provisioned = false;
  try {
    const identity = await nodeClient.autoIdentity();
    checks.push({ name: "node-reachable", ok: true });
    verbose?.(`node-reachable: ok`);
    if (identity.provisioned) {
      provisioned = true;
      checks.push({
        name: "node-provisioned",
        ok: true,
        detail: `user_hash=${identity.userHash.slice(0, 8)}…`,
      });
      verbose?.(`node-provisioned: ok`);
    } else {
      checks.push({
        name: "node-provisioned",
        ok: false,
        detail: identity.reason,
        fix: "run `fbrain init` to bootstrap",
      });
      verbose?.(`node-provisioned: FAIL — ${identity.reason}`);
    }
  } catch (err) {
    checks.push({
      name: "node-reachable",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: "start a fold node (e.g. `cd fold/fold_db_node && ./run.sh --local --local-schema`)",
    });
    verbose?.(`node-reachable: FAIL`);
  }

  // 5. schemas loaded
  if (provisioned) {
    try {
      const loaded = await nodeClient.loadSchemas();
      if (loaded.failed_schemas.length === 0) {
        checks.push({
          name: "schemas-loaded",
          ok: true,
          detail: `${loaded.schemas_loaded_to_db}/${loaded.available_schemas_loaded} loaded`,
        });
        verbose?.(`schemas-loaded: ok (${loaded.schemas_loaded_to_db}/${loaded.available_schemas_loaded})`);
      } else {
        checks.push({
          name: "schemas-loaded",
          ok: false,
          detail: `failed_schemas: ${loaded.failed_schemas.join(", ")}`,
          fix: "re-run `fbrain init`; if it persists, check the schema service logs",
        });
        verbose?.(`schemas-loaded: FAIL — ${loaded.failed_schemas.join(", ")}`);
      }
    } catch (err) {
      checks.push({
        name: "schemas-loaded",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        fix: "re-run `fbrain init`",
      });
      verbose?.(`schemas-loaded: FAIL`);
    }
  }

  // 6. schema drift — only meaningful if config is OK and schema service is reachable
  if (cfgIssues.length === 0) {
    for (const [type, request, hash] of [
      ["Design", designSchema, cfg.designSchemaHash] as const,
      ["Task", taskSchema, cfg.taskSchemaHash] as const,
    ]) {
      const driftCheck = await checkSchemaDrift(schemaClient, type, request, hash);
      checks.push(driftCheck);
      verbose?.(
        `schema-drift[${type}]: ${driftCheck.ok ? "ok" : `FAIL — ${driftCheck.detail ?? ""}`}`,
      );
    }
  }

  return finalize(checks, print);
}

async function checkSchemaDrift(
  schemaClient: SchemaServiceClient,
  type: string,
  request: AddSchemaRequest,
  hash: string,
): Promise<CheckResult> {
  const name = `schema-drift[${type}]`;
  let registered: RegisteredSchema | null;
  try {
    registered = await schemaClient.getSchemaByHash(hash);
  } catch (err) {
    if (err instanceof FbrainError) {
      return {
        name,
        ok: false,
        detail: err.message,
        fix: "re-run `fbrain init`",
      };
    }
    throw err;
  }
  if (!registered) {
    return {
      name,
      ok: false,
      detail: `canonical hash ${hash} not found in schema service (deleted there?)`,
      fix: "re-run `fbrain init`",
    };
  }
  const issues = diffSchemas(request, registered);
  if (issues.length === 0) {
    return { name, ok: true, detail: `${registered.descriptive_name} @ ${hash.slice(0, 12)}…` };
  }
  return {
    name,
    ok: false,
    detail: issues.join("; "),
    fix: "re-run `fbrain init` so the config picks up the current canonical hash; otherwise reconcile schemas.ts with the registered schema",
  };
}

export function diffSchemas(
  expected: AddSchemaRequest,
  actual: RegisteredSchema,
): string[] {
  const issues: string[] = [];

  if (actual.descriptive_name !== expected.schema.descriptive_name) {
    issues.push(
      `descriptive_name mismatch: registered "${actual.descriptive_name}" vs schemas.ts "${expected.schema.descriptive_name}"`,
    );
  }

  const expectedFields = new Set(expected.schema.fields);
  const actualFields = new Set(actual.fields);
  const missingFromActual: string[] = [];
  for (const f of expectedFields) {
    if (!actualFields.has(f)) missingFromActual.push(f);
  }
  const extraInActual: string[] = [];
  for (const f of actualFields) {
    if (!expectedFields.has(f)) extraInActual.push(f);
  }
  if (missingFromActual.length > 0) {
    issues.push(`fields missing from registered schema: ${missingFromActual.join(", ")}`);
  }
  if (extraInActual.length > 0) {
    issues.push(`fields present only in registered schema: ${extraInActual.join(", ")}`);
  }

  for (const field of expected.schema.fields) {
    if (!actualFields.has(field)) continue;
    const exp = expected.schema.field_types[field];
    const act = actual.field_types[field];
    if (!sameFieldType(exp, act)) {
      issues.push(
        `field_types[${field}] mismatch: registered ${JSON.stringify(act)} vs schemas.ts ${JSON.stringify(exp)}`,
      );
    }
  }

  return issues;
}

function sameFieldType(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
    }
    return true;
  }
  return false;
}

export function validateConfigShape(cfg: Config): string[] {
  const issues: string[] = [];
  if (!/^[0-9a-f]{64}$/i.test(cfg.designSchemaHash)) {
    issues.push(`designSchemaHash "${cfg.designSchemaHash}" is not a 64-char hex string`);
  }
  if (!/^[0-9a-f]{64}$/i.test(cfg.taskSchemaHash)) {
    issues.push(`taskSchemaHash "${cfg.taskSchemaHash}" is not a 64-char hex string`);
  }
  return issues;
}

function finalize(checks: CheckResult[], print: (line: string) => void): number {
  const failures = checks.filter((c) => !c.ok);
  for (const check of checks) {
    const tag = check.ok ? "PASS" : "FAIL";
    const detail = check.detail ? `  — ${check.detail}` : "";
    print(`[${tag}] ${check.name}${detail}`);
    if (!check.ok && check.fix) {
      print(`       fix:   ${check.fix}`);
    }
  }
  print("");
  if (failures.length === 0) {
    print("OK");
    return 0;
  }
  print(`FAIL: ${failures.length} issue${failures.length === 1 ? "" : "s"}`);
  return 1;
}
