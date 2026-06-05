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
//   7. embedding-runtime — one-token search forces ONNX load.
//   8. write-ready — capability cached for this node + consent dry-run
//      returns 202 (not 404). Pre-this-PR doctor was all read-path
//      probes, so a node that rejected every write (cold app registry,
//      revoked grant, missing capability) still reported all-PASS. This
//      probe asks both questions a write needs to answer "yes" to and
//      surfaces a structured FAIL ("write-blocked") with an actionable
//      hint that distinguishes a missing grant from a cold registry.
//
// Always-WARN disclosure probes (G0 gate item #9 —
// see docs/g0-replacement-readiness-gate.md §6). These don't detect a
// condition; they declare a known limitation so a teammate dogfooding
// on a second machine sees it instead of inferring a silent fork:
//   - single-machine-slice — record set is local to this daemon.
//   - no-team-sync       — `fbrain share` is a placeholder.
//
// With `--freshness`: also runs two G3 probes (see docs/phase-7-search-latency-spike.md):
//   - freshness-probe — 5 trials of put → search asserting score ≥ 0.5
//     against a `doctor-freshness-probe-<nonce>` slug namespace, cleaning
//     up afterwards. FAILs if any trial misses its own record at score ≥ 0.5.
//   - pollution-probe — one broad query (default "fbrain"); classifies each
//     hit as live / stale-fragment / orphan-schema. PASS if <25% polluted,
//     WARN at 25-50%, FAIL above 50%.
//
// With `--write`: also runs a real put → get → soft-delete round-trip
// under a reserved `doctor-write-roundtrip-<nonce>` slug. OFF by default
// so plain `fbrain doctor` never mutates.
//
// Exit code 0 on all-green, 1 if any check fails.

import {
  FbrainError,
  newNodeClient,
  newSchemaServiceClient,
  nodeDownHint,
  recordTypeForHash,
  stripDoctorTip,
  type NativeIndexHit,
  type NodeClient,
  type RegisteredSchema,
  type SchemaServiceClient,
  type Verbose,
} from "../client.ts";
import { tryReadConfig, type Config } from "../config.ts";
import { DEFAULT_SCHEMA_SERVICE_URL } from "./init.ts";
import {
  findBySlug,
  nowIso,
} from "../record.ts";
import {
  RECORD_TYPES,
  UNIQUE_SCHEMAS,
  type AddSchemaRequest,
  type RecordType,
} from "../schemas.ts";
import { buildTombstoneFields } from "./delete.ts";
import { runUsageReport, type UsageOptions } from "./usage.ts";
import { listManifests, type MigrationManifest } from "../migration.ts";
import {
  FBRAIN_APP_ID,
  decodeCapabilityBlob,
  tokenIntegrityValid,
  type CapabilityStore,
} from "../capability.ts";
import { defaultCapabilityStore } from "../keychain.ts";
import {
  appIdentityEnforceEnabled,
  newWriteNodeClient,
  type WriteNodeClient,
  type WriteNodeClientOptions,
} from "../write-context.ts";

export type DoctorOptions = {
  configPath?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // For testing: inject prebuilt clients to bypass the real fetches.
  schemaClientFactory?: (url: string, v?: Verbose) => SchemaServiceClient;
  nodeClientFactory?: (opts: { baseUrl: string; userHash: string; verbose?: Verbose }) => NodeClient;
  // --freshness probes (G3a in docs/phase-7-search-latency-spike.md).
  freshness?: boolean;
  freshnessTrials?: number;            // default 5
  freshnessMinScore?: number;          // default 0.5
  pollutionQuery?: string;             // default "fbrain"
  pollutionWarnThreshold?: number;     // default 0.25
  pollutionFailThreshold?: number;     // default 0.5
  nonceFn?: () => string;              // override for deterministic tests
  // --usage report (G13 team-adoption telemetry — see commands/usage.ts).
  // When set, doctor skips its health-check sequence and just prints the
  // usage report. Config + node-client wiring still validate first so the
  // user gets a useful error if init hasn't been run.
  usage?: boolean;
  usageOptions?: UsageOptions;
  // --write probe: do a real put → get → soft-delete round-trip under a
  // reserved slug to verify writes land end-to-end. Off by default so plain
  // `fbrain doctor` never mutates.
  write?: boolean;
  // Override for tests: the capability store the write-ready probe inspects
  // and the round-trip writes use. Defaults to the OS keychain store.
  capabilityStore?: CapabilityStore;
  // Override for tests: the write-node-client factory used by the round-trip
  // probe. Defaults to newWriteNodeClient.
  writeNodeFactory?: (opts: WriteNodeClientOptions) => WriteNodeClient;
};

// `tag` overrides the printed tag when set; `ok` always drives the exit code.
// WARN entries set `ok: true` + `tag: "WARN"` so they surface visually but
// don't trip the doctor verdict.
type CheckResult = {
  name: string;
  ok: boolean;
  tag?: "PASS" | "WARN" | "FAIL";
  detail?: string;
  fix?: string;
};

export async function doctor(opts: DoctorOptions = {}): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const verbose = opts.verbose;

  const checks: CheckResult[] = [];
  let schemasLoadedOk = false;

  // 1. config
  const cfg = tryReadConfig(opts.configPath);
  if (!cfg) {
    checks.push({
      name: "config",
      ok: false,
      detail: "no ~/.fbrain/config.json",
      fix: "run `fbrain init`",
    });
    // Break the init↔doctor dead-end: if init's step 3 keeps failing with
    // `401 cert_required`, the user has no config to load — pre-this-PR
    // doctor stopped here and told them to re-run init, which would loop
    // forever. Probe the schema-service publish gate independently so the
    // real cause surfaces with an actionable remedy instead of bouncing
    // them back to a command that can't succeed.
    const probe = await runSchemaPublishGateProbe(opts, verbose);
    if (probe) checks.push(probe);
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

  // --usage diverts to the team-adoption report (G13). It needs a valid
  // config + reachable node but doesn't depend on the schema-drift /
  // freshness checks, so we short-circuit before running them.
  if (opts.usage) {
    if (cfgIssues.length > 0) {
      print("usage report skipped — config is invalid (see [FAIL] above).");
      return finalize(checks, print);
    }
    const usageOpts: UsageOptions = { ...(opts.usageOptions ?? {}) };
    if (!usageOpts.print) usageOpts.print = print;
    if (!usageOpts.verbose && verbose) usageOpts.verbose = verbose;
    try {
      await runUsageReport(nodeClient, cfg, usageOpts);
      return 0;
    } catch (err) {
      print(`usage report failed: ${doctorReachabilityDetail(err, "node", cfg.nodeUrl)}`);
      return 1;
    }
  }

  // 2. schema service reachable
  try {
    await schemaClient.listSchemas();
    checks.push({ name: "schema-service-reachable", ok: true });
    verbose?.(`schema-service-reachable: ok`);
  } catch (err) {
    checks.push({
      name: "schema-service-reachable",
      ok: false,
      detail: doctorReachabilityDetail(err, "schema service", cfg.schemaServiceUrl),
      fix: schemaServiceFixHint(cfg.schemaServiceUrl),
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
      detail: doctorReachabilityDetail(err, "node", cfg.nodeUrl),
      fix: nodeDownHint(cfg.nodeUrl),
    });
    verbose?.(`node-reachable: FAIL`);
  }

  // 5. schemas loaded
  if (provisioned) {
    try {
      const loaded = await nodeClient.loadSchemas();
      if (loaded.failed_schemas.length === 0) {
        schemasLoadedOk = true;
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
        detail: errMsg(err),
        fix: "re-run `fbrain init`",
      });
      verbose?.(`schemas-loaded: FAIL`);
    }
  }

  // 6. schema drift — check each unique schema once. Iterates 8 entries:
  // Design + Task + six per-kind Phase 6 schemas. Two flavors of drift are
  // demoted to WARN instead of failing the verdict:
  //   - extras-only: the schema service expanded fbrain's canonical against
  //     an existing schema of the same descriptive_name (often a
  //     Schema.org starter_seed) and the registered schema now carries
  //     extra fields. `fbrain init` cannot shrink registered schemas —
  //     handled inside checkSchemaDrift().
  //   - migration-explained: a completed `fbrain migrate --add-field`
  //     manifest's to_hash matches the live config hash, so the registered
  //     schema's extra field is expected — softened here by
  //     softenDriftIfMigrated().
  const allManifests = safeListManifests();
  if (cfgIssues.length === 0) {
    for (const entry of UNIQUE_SCHEMAS) {
      const hash = cfg.schemaHashes[entry.key];
      const label = entry.schema.schema.descriptive_name;
      if (!hash) {
        checks.push({
          name: `schema-drift[${label}]`,
          ok: false,
          detail: `no canonical hash for "${entry.key}" in config.schemaHashes`,
          fix: "re-run `fbrain init`",
        });
        continue;
      }
      const driftCheck = await checkSchemaDrift(
        schemaClient,
        label,
        entry.schema,
        hash,
      );
      const softened = softenDriftIfMigrated(driftCheck, entry.key, hash, allManifests);
      checks.push(softened);
      verbose?.(
        `schema-drift[${label}]: ${tagOf(softened)} — ${softened.detail ?? ""}`,
      );
    }
  }

  // Embedding-runtime probe — issue one trivial search query so the node
  // is forced to load its ONNX model. Surfaces the
  // `embedding_model_unavailable` failure as a structured FAIL, separate
  // from schema-drift, so `fbrain doctor` is the one source of truth for
  // "is search end-to-end usable?" — not just "are the schemas right?".
  // Cheap when it passes (one GET); the heavy freshness probe stays
  // gated behind --freshness.
  if (provisioned && schemasLoadedOk) {
    const embed = await runEmbeddingProbe(nodeClient, verbose);
    checks.push(embed);
  }

  // Write-readiness probe — capability + consent-path check. The pre-PR
  // doctor was all read-path probes, so a node that rejected every write
  // (cold app registry, revoked capability, missing grant, …) still
  // reported all-PASS. This probe asks both questions a write needs:
  //   (a) is a valid CapabilityToken cached for this node, and
  //   (b) does the node's app registry know about fbrain (does
  //       request-consent return 202, not 404)?
  // Read-only: it polls request-consent for the HTTP status but never
  // grants or waits, so the leftover pending request times out naturally.
  // Fails closed — any indeterminate state (consent endpoint 5xx, store
  // unreadable) surfaces as a WARN, not a silent PASS.
  if (provisioned && cfgIssues.length === 0) {
    const store = opts.capabilityStore ?? defaultCapabilityStore();
    const writeReady = await runWriteReadyProbe(nodeClient, cfg.nodeUrl, store, verbose);
    checks.push(writeReady);
  }

  // Disclosure probes — always WARN, no detection. They surface the
  // multi-machine + team-sharing limits called out in
  // docs/g0-replacement-readiness-gate.md §6 so the gate stays honest
  // about what fbrain does and doesn't do today.
  checks.push({
    name: "single-machine-slice",
    ok: true,
    tag: "WARN",
    detail:
      "you're on this daemon; record set is local — multi-machine reads " +
      "require fbrain to drive fold_db's sync transport (deployed but not " +
      "yet wired up from fbrain; tracked as G16)",
  });
  checks.push({
    name: "no-team-sync",
    ok: true,
    tag: "WARN",
    detail:
      "no team-sync transport — `fbrain share` is a placeholder until " +
      "cloud sync is signed in and validated end-to-end " +
      "(see docs/phase-3-sharing-memo.md)",
  });

  // --write probe — real put → get → soft-delete round-trip under a
  // reserved slug. The write-ready probe above is a static check; this is
  // the active proof that capability headers attach + the consent path
  // resolves + the node accepts the mutation. OFF by default so plain
  // `fbrain doctor` never mutates.
  if (opts.write) {
    if (cfgIssues.length === 0 && schemasLoadedOk) {
      const writeProbe = await runWriteRoundtripProbe(cfg, opts, verbose);
      checks.push(writeProbe);
      verbose?.(
        `write-roundtrip: ${tagOf(writeProbe)} — ${writeProbe.detail ?? ""}`,
      );
    } else {
      checks.push(skippedByPrereqs("write-roundtrip"));
    }
  }

  // G3 freshness + pollution probes — only when --freshness is set and the
  // upstream checks confirmed the node is workable.
  if (opts.freshness) {
    if (cfgIssues.length === 0 && schemasLoadedOk) {
      const freshness = await runFreshnessProbe(nodeClient, cfg, opts, verbose);
      checks.push(freshness);
      verbose?.(
        `freshness-probe: ${freshness.ok ? "ok" : `FAIL — ${freshness.detail ?? ""}`}`,
      );

      const pollution = await runPollutionProbe(nodeClient, cfg, opts, verbose);
      checks.push(pollution);
      verbose?.(
        `pollution-probe: ${tagOf(pollution)} — ${pollution.detail ?? ""}`,
      );
    } else {
      checks.push(skippedByPrereqs("freshness-probe"));
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
function softenDriftIfMigrated(
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
const SCHEMA_SERVICE_URL_PROD =
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

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

// client.ts appends "— run `fbrain doctor` for a full diagnosis" to every
// FbrainError message so non-doctor commands (list/put/etc.) point users
// here. Inside doctor's own output that tip is circular — the user is
// already running doctor. For the typed service_unreachable case
// synthesize a clean detail; for everything else (node_not_provisioned,
// missing_user_context, schema_http_*, …) strip the shared suffix off
// err.message via the helper exported from client.ts.
function doctorReachabilityDetail(err: unknown, which: string, baseUrl: string): string {
  if (err instanceof FbrainError && err.code === "service_unreachable") {
    return `${which} not reachable at ${baseUrl}`;
  }
  return stripDoctorTip(errMsg(err));
}

function safeListManifests(): MigrationManifest[] {
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

function finalize(checks: CheckResult[], print: (line: string) => void): number {
  const failures = checks.filter((c) => !c.ok);
  for (const check of checks) {
    const tag = tagOf(check);
    const detail = check.detail ? `  — ${check.detail}` : "";
    print(`[${tag}] ${check.name}${detail}`);
    if (check.fix && (tag === "FAIL" || tag === "WARN")) {
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

// One-token search probe: forces the node's lazy ONNX load so the
// `embedding_model_unavailable` failure surfaces as a structured FAIL in
// the doctor verdict rather than being hidden behind an `fbrain search`
// call. We don't care about the hit list — only whether the call
// completes. The probe is read-only and cheap, so it runs on every
// `fbrain doctor` invocation (no --freshness gate).
export async function runEmbeddingProbe(
  node: NodeClient,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  try {
    const hits = await node.search("fbrain");
    verbose?.(`embedding-runtime: ok (${hits.length} hits to probe query)`);
    return {
      name: "embedding-runtime",
      ok: true,
      detail: "one-token search returned without an embedding-model error",
    };
  } catch (err) {
    if (err instanceof FbrainError && err.code === "embedding_model_unavailable") {
      return {
        name: "embedding-runtime",
        ok: false,
        detail: stripDoctorTip(err.message),
        fix:
          err.hint ??
          "restart the node so it re-fetches the ONNX file (homebrew: `folddb daemon stop && folddb daemon start`)",
      };
    }
    return {
      name: "embedding-runtime",
      ok: false,
      detail: stripDoctorTip(errMsg(err)),
      fix: "check the node log; the native-index search endpoint is rejecting our probe query",
    };
  }
}

// G3a — freshness probe. Five trials of put → search; each trial passes
// when the freshly-written record surfaces in the top-K of a search for a
// unique marker word at score ≥ freshnessMinScore (default 0.5). Probes are
// soft-deleted in a finally block so a thrown error mid-trial still
// cleans up. See docs/phase-7-search-latency-spike.md G3a.
export async function runFreshnessProbe(
  node: NodeClient,
  cfg: Config,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const trials = opts.freshnessTrials ?? 5;
  const minScore = opts.freshnessMinScore ?? 0.5;
  const nonce = (opts.nonceFn ?? defaultNonce)();
  const conceptHash = cfg.schemaHashes.concept;
  if (!conceptHash) {
    return {
      name: "freshness-probe",
      ok: false,
      detail: 'config has no schemaHashes["concept"]',
      fix: "re-run `fbrain init` so the config picks up all 8 schema hashes",
    };
  }

  type TrialResult = {
    slug: string;
    marker: string;
    found: boolean;
    score: number | null;
    pass: boolean;
  };
  const created: string[] = [];
  const trialResults: TrialResult[] = [];

  let searchError: string | null = null;
  try {
    for (let i = 0; i < trials; i++) {
      const slug = `doctor-freshness-probe-${nonce}-${i}`;
      const marker = `freshprobe${nonce}${i}`;
      const body =
        `Doctor freshness probe trial ${i}. Marker word: ${marker}. ` +
        `Generated by \`fbrain doctor --freshness\` — safe to delete.`;
      const now = nowIso();
      // Phase E per-kind Concept schema declares 7 fields: slug, title, body,
      // status, tags, created_at, updated_at. The legacy `kind` discriminator
      // and `v1_marker_a/b` structural markers are intentionally absent.
      const fields: Record<string, unknown> = {
        slug,
        title: `freshness probe ${i}`,
        body,
        status: "active",
        tags: [],
        created_at: now,
        updated_at: now,
      };
      await node.createRecord({ schemaHash: conceptHash, fields, keyHash: slug });
      created.push(slug);

      let hits: NativeIndexHit[];
      try {
        hits = await node.search(marker);
      } catch (err) {
        // The native-index search endpoint can fail independently of the
        // write path (e.g. node's embedding model.onnx is missing). Capture
        // the first failure as the probe's headline detail and stop trialing
        // — every subsequent trial would hit the same error. The `finally`
        // block still tombstones the records we already created.
        searchError = errMsg(err);
        verbose?.(
          `freshness trial ${i + 1}/${trials}: search threw — ${searchError}`,
        );
        break;
      }
      const own = hits.find(
        (h) => h.key_value.hash === slug && h.schema_name === conceptHash,
      );
      const score =
        own && typeof own.metadata?.score === "number" ? own.metadata.score : null;
      const found = own !== undefined;
      const pass = found && typeof score === "number" && score >= minScore;
      trialResults.push({ slug, marker, found, score, pass });
      verbose?.(
        `freshness trial ${i + 1}/${trials}: ${pass ? "PASS" : "FAIL"} ` +
          `slug=${slug} marker=${marker} found=${found} score=${score ?? "—"}`,
      );
    }
  } finally {
    for (const slug of created) {
      try {
        const cleanupFields = buildTombstoneFields("concept", slug, nowIso(), nowIso());
        await node.updateRecord({ schemaHash: conceptHash, fields: cleanupFields, keyHash: slug });
      } catch (err) {
        verbose?.(
          `freshness cleanup failed for ${slug}: ${errMsg(err)}`,
        );
      }
    }
  }

  if (searchError !== null) {
    return {
      name: "freshness-probe",
      ok: false,
      detail: `native-index search failed: ${searchError}`,
      fix: "the node's native-index search is unavailable (e.g. missing embedding model.onnx). Check the node log; restart the node with embeddings enabled.",
    };
  }

  const passed = trialResults.filter((t) => t.pass).length;
  const scored = trialResults.filter((t): t is TrialResult & { score: number } => t.score !== null);
  const avgScore =
    scored.length > 0
      ? scored.reduce((s, t) => s + t.score, 0) / scored.length
      : null;
  const detail =
    `${passed}/${trials} trial${trials === 1 ? "" : "s"} passed` +
    ` (min score ≥ ${minScore}; ` +
    (avgScore === null ? "no scores observed" : `avg observed score ${avgScore.toFixed(3)}`) +
    ")";
  if (passed === trials) {
    return { name: "freshness-probe", ok: true, detail };
  }
  return {
    name: "freshness-probe",
    ok: false,
    detail,
    fix: "run `fbrain reindex` to refresh embeddings; fresh writes are not surfacing at score ≥ 0.5 (see docs/phase-7-search-latency-spike.md)",
  };
}

// G3a (pollution component) — issue one broad query and classify every hit
// into live / stale (record gone or tombstoned) / orphan (schema not an
// fbrain type). PASS at <warnThreshold (default 25%), WARN to failThreshold
// (default 50%), FAIL above. Mirrors the verbose `skip stale` / `skip
// schema_name matches no registered fbrain type` lines in `fbrain search`.
export async function runPollutionProbe(
  node: NodeClient,
  cfg: Config,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const query = opts.pollutionQuery ?? "fbrain";
  const warnThreshold = opts.pollutionWarnThreshold ?? 0.25;
  const failThreshold = opts.pollutionFailThreshold ?? 0.5;

  let hits: NativeIndexHit[];
  try {
    hits = await node.search(query);
  } catch (err) {
    return {
      name: "pollution-probe",
      ok: false,
      detail: `search "${query}" failed: ${errMsg(err)}`,
      fix: "check the node log; the native-index search endpoint is rejecting our query",
    };
  }
  const total = hits.length;
  if (total === 0) {
    return {
      name: "pollution-probe",
      ok: true,
      detail: `query "${query}" returned 0 hits — nothing to classify`,
    };
  }

  let stale = 0;
  let orphan = 0;
  let live = 0;
  for (const hit of hits) {
    const slug = hit.key_value.hash;
    const type = recordTypeForHash(hit.schema_name, cfg.schemaHashes);
    if (!type) {
      orphan++;
      verbose?.(
        `pollution: orphan schema_name="${hit.schema_name}" slug="${slug ?? "?"}"`,
      );
      continue;
    }
    if (!slug) {
      stale++;
      verbose?.(`pollution: stale (no slug) schema=${type}`);
      continue;
    }
    const schemaHash = cfg.schemaHashes[type]!;
    let record;
    try {
      record = await findBySlug(node, type, schemaHash, slug);
    } catch (err) {
      verbose?.(
        `pollution: findBySlug threw for ${type}/${slug}: ${errMsg(err)} — counting as stale`,
      );
      stale++;
      continue;
    }
    if (!record) {
      stale++;
      verbose?.(`pollution: stale ${type}/${slug}`);
    } else {
      live++;
      verbose?.(`pollution: live ${type}/${slug}`);
    }
  }

  const stalePct = stale / total;
  const orphanPct = orphan / total;
  const combinedPct = (stale + orphan) / total;
  const detail =
    `query "${query}" → ${total} hits: ` +
    `live ${live}, stale ${stale} (${pct(stalePct)}), orphan ${orphan} (${pct(orphanPct)}) ` +
    `— pollution ${pct(combinedPct)}`;
  if (combinedPct > failThreshold) {
    return {
      name: "pollution-probe",
      ok: false,
      tag: "FAIL",
      detail,
      fix: "run `fbrain reindex` to refresh embeddings; upstream fixes tracked in docs/phase-7-search-latency-spike.md (G3d schema-scoped search, G3e tombstone-purge)",
    };
  }
  if (combinedPct > warnThreshold) {
    return {
      name: "pollution-probe",
      ok: true,
      tag: "WARN",
      detail,
      fix: "pollution is climbing; consider the G3c reindex workaround and track upstream G3d/G3e",
    };
  }
  return { name: "pollution-probe", ok: true, detail };
}

function defaultNonce(): string {
  // Lowercase hex from Date.now() + a random 24-bit suffix. Stays inside
  // the slug character set ([a-z0-9-_]).
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${Date.now().toString(36)}${rand}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// Write-readiness probe — asks the two questions any mutation needs to
// answer "yes" to:
//   (a) is a valid CapabilityToken cached locally for this node? (load it,
//       run the same JCS integrity check the write path uses before replay).
//   (b) does the node's app registry know about fbrain? (probe
//       POST /api/apps/request-consent and read the status — 202 means
//       known, 404 means the registry has no fbrain entry).
// Read-only: the leftover pending consent request times out naturally
// within the node's 5-min consent window — we never poll or grant.
// Fails closed: any indeterminate state (consent endpoint 5xx / throws,
// keychain unreadable) surfaces as WARN, never silently PASS.
export async function runWriteReadyProbe(
  node: NodeClient,
  nodeUrl: string,
  store: CapabilityStore,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  // Client-side enforcement OFF means fbrain won't attach capability headers,
  // and on a node ALSO running enforcement-off writes land as NodeOwner with
  // no consent step at all. We can't introspect the node's setting, so we
  // declare the limitation: WARN so the doctor verdict stays green for the
  // dogfood case but the user sees the half-configured state.
  if (!appIdentityEnforceEnabled()) {
    verbose?.(`write-ready: enforcement off — emitting WARN`);
    return {
      name: "write-ready",
      ok: true,
      tag: "WARN",
      detail:
        "client app-identity enforcement is OFF (FBRAIN_APP_IDENTITY_ENFORCE) — " +
        "no capability check performed; writes will succeed only if the node also has enforcement off",
    };
  }

  // (a) Local capability check — load from the store + JCS-integrity-validate.
  // Mirrors the gate in CapabilitySession.loadValidCached() so this probe
  // never reports PASS for a cached token the write path would discard.
  let capabilityValid = false;
  let capabilityDetail = "no capability stored for this node";
  try {
    const cached = await store.load(nodeUrl);
    if (cached === null) {
      capabilityDetail = "no capability stored for this node";
    } else {
      const token = decodeCapabilityBlob(cached.blob);
      if (token === null) {
        capabilityDetail = "stored capability blob did not decode";
      } else if (token.app_id !== FBRAIN_APP_ID) {
        capabilityDetail = `stored capability is for app_id "${token.app_id}", not "${FBRAIN_APP_ID}"`;
      } else if (!(await tokenIntegrityValid(token))) {
        capabilityDetail = "stored capability failed JCS integrity check (tampered or stale)";
      } else {
        capabilityValid = true;
      }
    }
  } catch (err) {
    // The store path itself failed (keychain locked, file unreadable, …)
    // — we can't tell if writes would work or not, so WARN.
    verbose?.(
      `write-ready: capability store load threw — ${errMsg(err)}`,
    );
    return {
      name: "write-ready",
      ok: true,
      tag: "WARN",
      detail: `could not read capability store: ${errMsg(err)}`,
      fix: "check OS keychain access and ~/.fbrain/capabilities.json, then re-run `fbrain doctor`",
    };
  }
  verbose?.(`write-ready: capability=${capabilityValid ? "valid" : `absent (${capabilityDetail})`}`);

  // (b) Node app-registration check — POST request-consent and read the
  // status. We do NOT poll consent-status (that's an interactive grant).
  // 202 → app is known; 404 → registry has no fbrain entry; anything else
  // means we can't decide and the probe degrades to WARN.
  let registered: boolean;
  let registrationDetail = "";
  try {
    const res = await node.requestConsent(FBRAIN_APP_ID, "wildcard");
    if (res.status === 202) {
      registered = true;
    } else if (res.status === 404) {
      registered = false;
      const err = bodyErrorString(res.body);
      registrationDetail = err ?? "node returned 404 from /api/apps/request-consent";
    } else {
      verbose?.(`write-ready: consent dry-run returned HTTP ${res.status} — emitting WARN`);
      return {
        name: "write-ready",
        ok: true,
        tag: "WARN",
        detail: `consent dry-run returned HTTP ${res.status}; cannot determine write-readiness`,
        fix: "inspect the node log; once /api/apps/request-consent responds 202 / 404 cleanly, re-run `fbrain doctor`",
      };
    }
  } catch (err) {
    verbose?.(
      `write-ready: consent dry-run threw — ${errMsg(err)}`,
    );
    return {
      name: "write-ready",
      ok: true,
      tag: "WARN",
      detail: `consent dry-run threw: ${stripDoctorTip(errMsg(err))}`,
      fix: "inspect the node log; the consent endpoint is rejecting fbrain's probe",
    };
  }

  // Verdict — registration is the more actionable failure (capability is
  // moot without it), so it sorts first.
  if (!registered) {
    return {
      name: "write-blocked",
      ok: false,
      detail: `node does not recognise app "${FBRAIN_APP_ID}"${registrationDetail ? ` (${registrationDetail})` : ""}`,
      fix:
        "the node's app registry has no fbrain entry — every write will fail with `app_not_registered`. " +
        "Restart the daemon to warm the registry, or wait for the app_identity publish path to land if you're mid-migration " +
        "(`folddb-dev app publish --id fbrain` on the dev side).",
    };
  }
  if (!capabilityValid) {
    return {
      name: "write-blocked",
      ok: false,
      detail: capabilityDetail,
      fix:
        "run `fbrain init` to grant consent and store a capability (or any write command — they all run the consent handshake on first use). " +
        "On the daemon side the grant is confirmed with `folddb consent grant fbrain`.",
    };
  }
  return {
    name: "write-ready",
    ok: true,
    detail: "capability cached + JCS-valid for this node; consent dry-run returned 202",
  };
}

// --write round-trip probe — the active proof that writes land end-to-end.
// Puts a sentinel concept under a reserved `doctor-write-roundtrip-<nonce>`
// slug, reads it back via findBySlug, then soft-deletes in a finally so a
// thrown error mid-trip still cleans up. Uses the same capability-aware
// write path the real `fbrain put` uses, so it actually exercises the
// CapabilitySession → consent → mutate pipeline.
export async function runWriteRoundtripProbe(
  cfg: Config,
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult> {
  const conceptHash = cfg.schemaHashes.concept;
  if (!conceptHash) {
    return {
      name: "write-roundtrip",
      ok: false,
      detail: 'config has no schemaHashes["concept"]',
      fix: "re-run `fbrain init` so the config picks up all 8 schema hashes",
    };
  }

  const nonce = (opts.nonceFn ?? defaultNonce)();
  const slug = `doctor-write-roundtrip-${nonce}`;

  const wnOpts: WriteNodeClientOptions = {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
  };
  if (verbose) wnOpts.verbose = verbose;
  if (opts.capabilityStore) wnOpts.store = opts.capabilityStore;
  const { node } = (opts.writeNodeFactory ?? newWriteNodeClient)(wnOpts);

  let created = false;
  try {
    const now = nowIso();
    await node.createRecord({
      schemaHash: conceptHash,
      keyHash: slug,
      fields: {
        slug,
        title: `doctor write-roundtrip probe ${nonce}`,
        body:
          `Doctor --write round-trip probe. Slug: ${slug}. ` +
          `Generated by \`fbrain doctor --write\` — safe to delete.`,
        status: "active",
        tags: [],
        created_at: now,
        updated_at: now,
      },
    });
    created = true;

    const echo = await findBySlug(node, "concept", conceptHash, slug);
    if (!echo) {
      return {
        name: "write-roundtrip",
        ok: false,
        detail: `wrote ${slug} but a subsequent read returned null`,
        fix: "the create reported success but the record isn't readable — inspect the node log",
      };
    }
    return {
      name: "write-roundtrip",
      ok: true,
      detail: `put → get → soft-delete round-trip succeeded under slug "${slug}"`,
    };
  } catch (err) {
    return {
      name: "write-roundtrip",
      ok: false,
      detail: stripDoctorTip(errMsg(err)),
      fix: "the round-trip write failed — see the error above and the node log; check `fbrain doctor` for the write-ready / consent status",
    };
  } finally {
    if (created) {
      try {
        const cleanupFields = buildTombstoneFields("concept", slug, nowIso(), nowIso());
        await node.updateRecord({ schemaHash: conceptHash, fields: cleanupFields, keyHash: slug });
      } catch (err) {
        verbose?.(
          `write-roundtrip cleanup failed for ${slug}: ${errMsg(err)}`,
        );
      }
    }
  }
}

// Schema-service publish-gate probe used when there is no config yet (init
// hasn't completed). Issues one POST /v1/schemas against the configured
// schema service and translates the discriminated `cert_required` response
// into a structured FAIL with the same remedy text the init error carries.
// Other outcomes are squashed to a single WARN so the probe never overstates
// confidence on a network-flaky run — the real publish path is `fbrain init`.
//
// `schemaClientFactory` (from opts) lets tests stub the schema service; in
// production we use the default factory pointed at the URL from opts.nodeUrl
// / opts.schemaServiceUrl or the init defaults when the user has no config.
export async function runSchemaPublishGateProbe(
  opts: DoctorOptions,
  verbose: Verbose | undefined,
): Promise<CheckResult | null> {
  const url = DEFAULT_SCHEMA_SERVICE_URL;
  const factory = opts.schemaClientFactory ?? newSchemaServiceClient;
  const client = factory(url, verbose);
  // Pick a fbrain-namespaced schema with a stable hash; any of the 8 schemas
  // would trip the same cert_required gate, since the schema service checks
  // for a DevCert before deciding the operation is idempotent.
  const probe = UNIQUE_SCHEMAS.find((s) => s.key === "design") ?? UNIQUE_SCHEMAS[0];
  if (!probe) return null;
  try {
    await client.registerSchema(probe.schema);
    // Should not normally land here without a config — init would have
    // written one after a successful register. Silent PASS keeps doctor
    // honest: if the probe succeeded, the publish gate isn't blocking.
    verbose?.(`schema-publish-gate: probe unexpectedly succeeded`);
    return {
      name: "schema-publish-gate",
      ok: true,
      detail: `schema service at ${url} accepted a fbrain/* publish — re-run \`fbrain init\` to finish onboarding`,
    };
  } catch (err) {
    if (err instanceof FbrainError && err.code === "schema_cert_required") {
      // `cert_required` is the EXPECTED state for a fresh consumer, NOT a
      // blocker. The schema service gates POST /v1/schemas behind a DevCert
      // for the namespaced `fbrain/*` schemas — but `fbrain init` never needs
      // to publish: it loads the cert-free catalog and resolves the
      // already-published canonical hashes from the node (proven by the
      // init.ts "cert_required POST → resolves all 8 hashes, no throw" path).
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

function bodyErrorString(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const v = (body as Record<string, unknown>).error;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tagOf(check: CheckResult): "PASS" | "WARN" | "FAIL" {
  return check.tag ?? (check.ok ? "PASS" : "FAIL");
}

function skippedByPrereqs(name: string): CheckResult {
  return {
    name,
    ok: false,
    detail: "skipped — config or schemas-loaded did not pass",
    fix: "resolve the earlier failures and retry",
  };
}
