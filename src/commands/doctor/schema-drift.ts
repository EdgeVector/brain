import { type RegisteredSchema } from "../../client.ts";
import type { Config } from "../../config.ts";
import { DEFAULT_SCHEMA_SERVICE_URL } from "../init.ts";
import { OWNER_APP_ID, RECORD_TYPES, UNIQUE_SCHEMAS, type AddSchemaRequest, type RecordType } from "../../schemas.ts";
import type { CheckResult } from "../doctor.ts";

export function checkSchemaDrift(
  type: string,
  request: AddSchemaRequest,
  hash: string,
  registered: RegisteredSchema | null,
  canonicalNames: readonly string[] = [],
): CheckResult {
  const name = `schema-drift[${type}]`;
  if (!registered) {
    return {
      name,
      ok: false,
      detail: `definition ${hash} was not found in the installed node catalog`,
      fix: "re-run `brain init`",
    };
  }
  // A canonical identity can serve several explicit local record-type names.
  // Only accept another name already bound to this exact hash in this config.
  const expected = canonicalNames.includes(registered.descriptive_name)
    ? {...request, schema:{...request.schema, descriptive_name:registered.descriptive_name}}
    : request;
  const classification = classifySchemaDrift(expected, registered);
  switch (classification.kind) {
    case "none":
      return { name, ok: true, detail: `${registered.descriptive_name} @ ${hash.slice(0, 12)}…` };
    case "extras_only":
      // The schema service expanded brain's canonical schema against an
      // existing one (often a Schema.org starter_seed sharing the same
      // descriptive_name) and kept the extra fields. `brain init` cannot
      // shrink this — the service expands schemas, never deletes fields —
      // so the old fix-hint ("re-run init") was a dead end. The extras are
      // harmless: brain only writes the fields in schemas.ts. Demote to
      // WARN and explain the real recovery (bump descriptive_name) so the
      // user knows the doctor verdict isn't blocked on a re-init they've
      // already tried.
      return {
        name,
        ok: true,
        tag: "WARN",
        detail:
          `registered schema has extra field${classification.extras.length === 1 ? "" : "s"} ` +
          `not in schemas.ts: ${classification.extras.join(", ")}`,
        fix:
          "schema service expanded against an existing schema with the same descriptive_name; " +
          "extras are harmless (brain doesn't write them). `brain init` can't remove them — " +
          "the service grows fields via expansion only. To force a clean schema, bump " +
          `descriptive_name on the ${type} schema in src/schemas.ts and re-run \`brain init\`.`,
      };
    case "real_drift":
      return {
        name,
        ok: false,
        detail: classification.issues.join("; "),
        // Drift includes missing fields, type mismatches, or descriptive_name
        // changes — re-registering the canonical schema will either pick up
        // a new hash (genuinely fresh) or expand the existing one (returning
        // a hash that now reflects the union). Either way, init is the right
        // first step; if it persists, schemas.ts and the registered schema
        // have genuinely diverged and need a descriptive_name bump.
        fix:
          "re-run `brain init` so the config picks up the current canonical hash. " +
          "If drift persists, the schema service can't shrink registered schemas — " +
          "bump descriptive_name in src/schemas.ts to force a fresh registration.",
      };
  }
}

export function boundSchemaNames(cfg: Config, hash: string): string[] {
  return UNIQUE_SCHEMAS
    .filter((entry) => (cfg.schemaIdentities?.[entry.key] ?? cfg.schemaHashes[entry.key]) === hash)
    .map((entry) => entry.schema.schema.descriptive_name);
}

// Classify a drift comparison so doctor can tell "brain's canonical is a
// subset of the registered schema" (harmless expansion — schema service
// merged with a starter seed of the same descriptive_name) apart from
// genuine drift (missing fields, type mismatches). Extras-only never fails
// doctor's verdict because re-registering the canonical schema can't shrink
// the registered one — the schema service grows fields via expansion only.
export type DriftClassification =
  | { kind: "none" }
  | { kind: "extras_only"; extras: string[] }
  | { kind: "real_drift"; issues: string[] };

export function classifySchemaDrift(
  expected: AddSchemaRequest,
  actual: RegisteredSchema,
): DriftClassification {
  const issues = diffSchemas(expected, actual);
  if (issues.length === 0) return { kind: "none" };

  const expectedFields = new Set(expected.schema.fields);
  const actualFields = new Set(actual.fields);
  const extras: string[] = [];
  for (const f of actualFields) {
    if (!expectedFields.has(f)) extras.push(f);
  }
  // Extras-only iff the registered schema has extra fields AND every other
  // dimension matches (no missing fields, no type/name drift). diffSchemas
  // emits one line per drift dimension, so we identify the extras line by
  // prefix and treat any other line as a real drift signal.
  const nonExtraIssues = issues.filter(
    (i) => !i.startsWith("fields present only in registered schema"),
  );
  if (extras.length > 0 && nonExtraIssues.length === 0) {
    return { kind: "extras_only", extras };
  }
  return { kind: "real_drift", issues };
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

// Canonical deployed schema service Lambdas. Mirrored against the prod
// default in src/commands/init.ts and the dev URL in test/util.ts; kept
// inline here so the fix-hint stays self-contained (no cross-command
// import for one constant).
const SCHEMA_SERVICE_URL_DEV =
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";
const SCHEMA_SERVICE_URL_PROD = DEFAULT_SCHEMA_SERVICE_URL;

// Branch the schema-service-reachable fix hint on the configured URL.
// Most brain users run against a deployed Lambda, so the original
// "start fold's schema service --local-schema" suggestion is only right
// for fold contributors pointing at localhost.
export function schemaServiceFixHint(url: string): string {
  if (/localhost|127\.0\.0\.1/.test(url)) {
    return "start fold's schema service (e.g. `./run.sh --local --local-schema`)";
  }
  if (url === SCHEMA_SERVICE_URL_DEV) {
    return `check your network or switch to prod (\`${SCHEMA_SERVICE_URL_PROD}\`)`;
  }
  if (url === SCHEMA_SERVICE_URL_PROD) {
    return `check your network or switch to dev (\`${SCHEMA_SERVICE_URL_DEV}\`)`;
  }
  return (
    `set \`schemaServiceUrl\` in ~/.brain/config.json to dev ` +
    `(\`${SCHEMA_SERVICE_URL_DEV}\`) or prod (\`${SCHEMA_SERVICE_URL_PROD}\`)`
  );
}

export function validateConfigShape(cfg: Config): string[] {
  const issues: string[] = [];
  for (const type of RECORD_TYPES as readonly RecordType[]) {
    const h = cfg.schemaHashes[type];
    if (!h || h.length === 0) {
      issues.push(`schemaHashes["${type}"] is missing`);
      continue;
    }
    const schema = UNIQUE_SCHEMAS.find((entry) => entry.key === type);
    const runtimeName = schema ? `${OWNER_APP_ID}/${schema.schema.schema.name}` : "";
    if (!/^[0-9a-f]{64}$/i.test(h) && h !== runtimeName) {
      issues.push(`schemaHashes["${type}"] is neither a definition hash nor its owned schema name`);
    }
  }
  return issues;
}
