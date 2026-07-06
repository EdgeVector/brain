import { FbrainError, newSchemaServiceClient, stripDoctorTip, type RegisteredSchema, type SchemaServiceClient, type Verbose } from "../../client.ts";
import type { Config } from "../../config.ts";
import { DEFAULT_SCHEMA_SERVICE_URL } from "../init.ts";
import { listManifests, type MigrationManifest } from "../../migration.ts";
import { RECORD_TYPES, UNIQUE_SCHEMAS, type AddSchemaRequest, type RecordType } from "../../schemas.ts";
import type { CheckResult, DoctorOptions } from "../doctor.ts";

export async function checkSchemaDrift(
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
  const classification = classifySchemaDrift(request, registered);
  switch (classification.kind) {
    case "none":
      return { name, ok: true, detail: `${registered.descriptive_name} @ ${hash.slice(0, 12)}…` };
    case "extras_only":
      // The schema service expanded fbrain's canonical schema against an
      // existing one (often a Schema.org starter_seed sharing the same
      // descriptive_name) and kept the extra fields. `fbrain init` cannot
      // shrink this — the service expands schemas, never deletes fields —
      // so the old fix-hint ("re-run init") was a dead end. The extras are
      // harmless: fbrain only writes the fields in schemas.ts. Demote to
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
          "extras are harmless (fbrain doesn't write them). `fbrain init` can't remove them — " +
          "the service grows fields via expansion only. To force a clean schema, bump " +
          `descriptive_name on the ${type} schema in src/schemas.ts and re-run \`fbrain init\`.`,
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
          "re-run `fbrain init` so the config picks up the current canonical hash. " +
          "If drift persists, the schema service can't shrink registered schemas — " +
          "bump descriptive_name in src/schemas.ts to force a fresh registration.",
      };
  }
}

// Classify a drift comparison so doctor can tell "fbrain's canonical is a
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

// If a completed `migrate` manifest covers this schema and its to_hash
// matches the live config hash, the drift is documented and expected
// (schemas.ts hasn't been hand-edited yet to reflect the migration).
// Surface it as WARN with a fix pointer rather than failing the
// doctor verdict.
export function softenDriftIfMigrated(
  drift: CheckResult,
  schemaKey: string,
  liveHash: string,
  manifests: MigrationManifest[],
): CheckResult {
  if (drift.ok) return drift;
  const matching = manifests.find(
    (m) =>
      m.scope.schema_key === schemaKey &&
      m.status === "complete" &&
      m.to_hash === liveHash,
  );
  if (!matching) return drift;
  return {
    ...drift,
    ok: true,
    tag: "WARN",
    detail: `${drift.detail ?? "drift detected"} — explained by migration ${matching.id}`,
    fix: `update src/schemas.ts to add "${matching.field_added}" to the ${schemaKey} schema so the next \`fbrain init\` keeps the new hash`,
  };
}

// Canonical deployed schema service Lambdas. Mirrored against the prod
// default in src/commands/init.ts and the dev URL in test/util.ts; kept
// inline here so the fix-hint stays self-contained (no cross-command
// import for one constant).
const SCHEMA_SERVICE_URL_DEV =
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";
const SCHEMA_SERVICE_URL_PROD = DEFAULT_SCHEMA_SERVICE_URL;

// Branch the schema-service-reachable fix hint on the configured URL.
// Most fbrain users run against a deployed Lambda, so the original
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
    `set \`schemaServiceUrl\` in ~/.fbrain/config.json to dev ` +
    `(\`${SCHEMA_SERVICE_URL_DEV}\`) or prod (\`${SCHEMA_SERVICE_URL_PROD}\`)`
  );
}

export function safeListManifests(): MigrationManifest[] {
  try {
    return listManifests();
  } catch {
    return [];
  }
}

export function validateConfigShape(cfg: Config): string[] {
  const issues: string[] = [];
  for (const type of RECORD_TYPES as readonly RecordType[]) {
    const h = cfg.schemaHashes[type];
    if (!h || h.length === 0) {
      issues.push(`schemaHashes["${type}"] is missing`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/i.test(h)) {
      issues.push(`schemaHashes["${type}"] "${h}" is not a 64-char hex string`);
    }
  }
  return issues;
}

// One-token search probe: forces the node's lazy ONNX load so the
// `embedding_model_unavailable` failure surfaces as a structured FAIL in
// the doctor verdict rather than being hidden behind an `fbrain search`
// call. We don't care about the hit list — only whether the call
// completes. The probe is read-only and cheap, so it runs on every
// `fbrain doctor` invocation (no --freshness gate).

export async function runSchemaPublishGateProbe(
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult | null> {
  const url = DEFAULT_SCHEMA_SERVICE_URL;
  const factory = opts.schemaClientFactory ?? newSchemaServiceClient;
  const client = factory(url, verbose);
  // Pick a fbrain-namespaced schema with a stable hash; any fbrain schema
  // would trip the same cert_required gate, since the schema service checks
  // for a DevCert before deciding the operation is idempotent.
  const probe = UNIQUE_SCHEMAS.find((s) => s.key === "design") ?? UNIQUE_SCHEMAS[0];
  if (!probe) return null;
  try {
    await client.registerSchema(probe.schema);
    // EXPECTED on prod: fbrain's schemas are ALREADY published there (that's
    // how `init` resolves their canonical hashes without a DevCert), so this
    // re-register is idempotent and succeeds. Success means the publish gate
    // isn't blocking onboarding — a calm PASS, not an alarm. Don't imply
    // doctor "published" anything; the no-config `[FAIL] config`
    // (→ "run `fbrain init`") line already drives doctor's red verdict.
    verbose?.(`schema-publish-gate: fbrain/* already published (idempotent re-register) PASS`);
    return {
      name: "schema-publish-gate",
      ok: true,
      detail:
        `schema service at ${url} already has fbrain/* published ` +
        `(idempotent re-register succeeded) — the publish gate isn't blocking; ` +
        `run \`fbrain init\` to finish onboarding`,
    };
  } catch (err) {
    if (err instanceof FbrainError && err.code === "schema_cert_required") {
      // `cert_required` is the EXPECTED state for a fresh consumer, NOT a
      // blocker. The schema service gates POST /v1/schemas behind a DevCert
      // for the namespaced `fbrain/*` schemas — but `fbrain init` never needs
      // to publish: it loads the cert-free catalog and resolves the
      // already-published canonical hashes from the node (proven by the
      // init.ts "cert_required POST → resolves all hashes, no throw" path).
      // Reporting this as a FAIL with "init cannot complete" is a false
      // dead-end that scares fresh adopters away before they've even run
      // init. Surface it as a calm PASS; the no-config `[FAIL] config` line
      // (→ "run `fbrain init`") already drives doctor's red verdict.
      verbose?.(`schema-publish-gate: cert_required (expected consumer state) PASS`);
      return {
        name: "schema-publish-gate",
        ok: true,
        detail:
          `schema service at ${url} gates fbrain/* publishing behind a DevCert ` +
          `(cert_required) — expected for a consumer; \`fbrain init\` resolves the ` +
          `already-published canonical hashes from the node, no DevCert needed`,
      };
    }
    // Anything else (schema service unreachable, 5xx, unknown 401 body) —
    // emit a WARN so the user sees we tried, without claiming we know what's
    // wrong. The probe is a diagnostic, not a verdict.
    verbose?.(
      `schema-publish-gate: probe inconclusive — ${errMsg(err)}`,
    );
    return {
      name: "schema-publish-gate",
      ok: true,
      tag: "WARN",
      detail: `could not probe schema service at ${url}: ${stripDoctorTip(errMsg(err))}`,
    };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
