// `fbrain init` — bootstrap a node (if needed), register every fbrain
// schema, load them, persist canonical hashes to ~/.fbrain/config.json.
//
// 6 steps:
//   0. probe /api/system/auto-identity
//   1. POST /api/setup/bootstrap if 503
//   2. obtain all 8 canonical hashes: POST each schema (maintainer w/ DevCert)
//      OR, when the cert gate returns 401 for a fresh consumer, defer and
//      resolve the already-published fbrain/* hashes from the node (step 3)
//   3. POST /api/schemas/load, then resolve any cert-gated hashes via
//      GET /api/schemas (the node's identity_hash IS the canonical hash)
//   4. verify failed_schemas empty + persist config
//   5. inline app-identity consent grant (prompt → folddb consent grant → poll)
//
// Idempotent. Step 0 makes a re-run skip bootstrap; step 2's POST is
// idempotent on the schema service side (identical re-POST returns 200
// with the same canonical hash). Re-running init is the prescribed
// remedy for `409 ambiguous_schema_name`, and also the way to upgrade
// older configs (v1 → current; v2 → current, with URL auto-heal if the
// existing URLs still point at the dead `:9101 / :9102` local-schema).

import { newNodeClient, newSchemaServiceClient, FbrainError, CERT_REQUIRED_HINT, isDefaultNodeUrl, type Verbose } from "../client.ts";
import { UNIQUE_SCHEMAS, resolveOwnedSchemaHash } from "../schemas.ts";
import {
  CONFIG_VERSION,
  ConfigInvalidError,
  defaultConfigPath,
  tryReadConfig,
  writeConfig,
  type Config,
} from "../config.ts";
import {
  establishConsentInline,
  type EstablishConsentOptions,
  type EstablishConsentResult,
} from "./init-consent.ts";
import { resolvePrintSink } from "../format.ts";
import { appIdentityEnforceEnabled } from "../write-context.ts";

export type InitOptions = {
  // Optional — when undefined, the resolver below picks either the existing
  // config's URL (if it isn't a dead local-schema default) or the new
  // default. This lets `fbrain init` (no flags) auto-heal a stale config
  // without clobbering a user-supplied override.
  nodeUrl?: string;
  schemaServiceUrl?: string;
  configPath?: string;
  bootstrapName?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Tuning hooks (mainly for tests):
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /**
   * Drive Step 6's consent grant non-interactively (no TTY required) —
   * surfaced as `fbrain init --grant-consent`. Scripted / CI / agent
   * installs use this to reach a ready-to-write state in one shot. No-op
   * under FBRAIN_APP_IDENTITY_ENFORCE=off (printed clearly) and idempotent
   * when a live capability is already cached.
   */
  grantConsent?: boolean;
  // Inline consent (Step 6/6) injection seam for tests. When omitted, init
  // runs the real `establishConsentInline` against the configured node.
  consent?: Pick<
    EstablishConsentOptions,
    "store" | "transport" | "ask" | "resolveFolddb" | "runFolddbGrant" | "isTty" | "pollIntervalMs" | "sleep" | "maxWaitMs"
  >;
};

// New default targets — `:9001` is the homebrew `fold_db_node` daemon;
// the schema service moved off `:9102` to the prod cloud Lambda. The dev
// Lambda is reserved for the test harness so iteration doesn't pollute prod.
export const DEFAULT_NODE_URL = "http://127.0.0.1:9001";
export const DEFAULT_SCHEMA_SERVICE_URL =
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

// Auto-heal triggers: any existing config carrying one of these URLs is
// treated as "still pointing at the dead pre-cloud local-schema setup".
// User overrides (any other URL, including a custom localhost port) are
// preserved verbatim.
const STALE_NODE_URLS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:9101",
  "http://localhost:9101",
]);
const STALE_SCHEMA_URLS: ReadonlySet<string> = new Set([
  "http://127.0.0.1:9102",
  "http://localhost:9102",
]);

// Default cold-build retry schedule: 5s, 10s, 20s, 30s, 60s, 60s ≈ 3m max.
// First run of `fold/run.sh` compiles Rust and can take several minutes
// before the node starts listening.
const DEFAULT_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000, 60000, 60000];

function envRetryDelays(): number[] | null {
  const raw = process.env.FBRAIN_INIT_RETRY_DELAYS_MS;
  if (raw === undefined) return null;
  if (raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

export type InitResult = {
  config: Config;
  bootstrapped: boolean;
  consent: EstablishConsentResult;
};

const STEPS = 6;

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const print = resolvePrintSink(opts);
  const verbose = opts.verbose;
  const bootstrapName = opts.bootstrapName ?? "fbrain";
  const configPath = opts.configPath ?? defaultConfigPath();

  // `tryReadConfig` returns null when the file is absent but THROWS when it
  // exists with malformed contents (truncated JSON, missing field, unknown
  // configVersion from a downgrade, …). Without this catch the throw escapes
  // before any bootstrap work runs — and ConfigInvalidError's own message
  // tells the user to "Re-run `fbrain init`", trapping them in a dead-end
  // loop where the documented remedy can't recover. Init's whole job is to
  // write a valid config, so treat a corrupt existing file as a fresh init
  // (with a visible notice — silently overwriting user data is worse than
  // the loop).
  let existing: Config | null;
  try {
    existing = tryReadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigInvalidError) {
      print(`[init] existing config at ${configPath} is invalid (${err.message}) — discarding and re-initializing`);
      existing = null;
    } else {
      throw err;
    }
  }
  if (existing) {
    print(`[init] existing config at ${configPath} — verifying`);
  }

  const resolved = resolveUrls(opts, existing);
  if (resolved.healed.length > 0) {
    print(
      `fbrain: auto-upgraded config to v${CONFIG_VERSION} with new schema-service URL` +
        ` (replaced ${resolved.healed.join(", ")})`,
    );
  }
  const nodeUrl = resolved.nodeUrl;
  const schemaServiceUrl = resolved.schemaServiceUrl;

  // Step 0/6: probe identity (with cold-build retry).
  print(`[1/${STEPS}] probing node identity`);
  const probeUserHash = existing?.userHash ?? "init-probe";
  const probeClient = newNodeClient({ baseUrl: nodeUrl, userHash: probeUserHash, verbose: verbose ?? (() => {}) });
  const identity = await probeWithRetry(probeClient, { nodeUrl, sleep: opts.sleep, retryDelaysMs: opts.retryDelaysMs }, print);

  let userHash: string;
  let bootstrapped = false;
  if (identity.provisioned) {
    userHash = identity.userHash;
    print(`[2/${STEPS}] node already provisioned (user_hash=${userHash.slice(0, 8)}…) — skipping bootstrap`);
  } else {
    print(`[2/${STEPS}] node not provisioned (${identity.reason}); running bootstrap`);
    try {
      const result = await probeClient.bootstrap(bootstrapName);
      userHash = result.userHash;
      bootstrapped = true;
      print(`        bootstrap ok (user_hash=${userHash.slice(0, 8)}…)`);
    } catch (err) {
      // Option C: the daemon is in the contradictory state where
      // auto-identity says "not provisioned" but bootstrap returns 410
      // "already provisioned". If our local config has a usable userHash
      // from a previous successful init against this node, treat the
      // config as authoritative and continue — the downstream
      // schemas-load step exercises X-User-Hash and will surface
      // `missing_user_context` if the saved userHash is genuinely wrong.
      // No usable config ⇒ rethrow the FbrainError so the user sees the
      // node's actual message (e.g. "POST /api/auth/restore …").
      if (
        err instanceof FbrainError &&
        err.code === "onboarding_already_complete" &&
        hasUsableExistingConfig(existing)
      ) {
        userHash = existing.userHash;
        print(
          `        bootstrap refused (node + auto-identity disagree); reusing existing config userHash=${userHash.slice(0, 8)}… and continuing`,
        );
      } else {
        throw err;
      }
    }
  }

  // Step 2/6: register the eight per-kind schemas — Design + Task +
  // Concept/Preference/Reference/Agent/Project/Spike. Each entry has
  // exactly one RecordType, so the hash is written once under that key.
  //
  // The fbrain/* schemas are pre-published org-wide on the canonical schema
  // service, so for a fresh consumer (no DevCert) the re-POST is rejected
  // with `401 cert_required`. That is the EXPECTED, documented state — not a
  // fatal error. Rather than dead-end, we record each cert-gated schema and
  // RESOLVE its authoritative canonical hash from the node after the
  // cert-free catalog load below (the node's `identity_hash` IS the published
  // canonical hash). A maintainer who DOES hold a DevCert still publishes
  // here (POST 200) on the same code path.
  //
  // `FBRAIN_APP_IDENTITY_ENFORCE=off` does NOT change the schema identity:
  // bare (un-namespaced) publishing would produce hashes that don't match the
  // fbrain/* schemas the node already loaded, and is rejected outright by any
  // schema service with `APP_IDENTITY_ROOT_PUBKEYS` set (i.e. the cloud
  // service, which is the only allowed one). Enforce-off only governs the
  // WRITE side — no consent step, no capability headers, writes land as
  // NodeOwner — so on this read-side step it follows the same
  // namespaced-publish-or-resolve path as enforce-on.
  const enforceOn = appIdentityEnforceEnabled();
  print(`[3/${STEPS}] registering ${UNIQUE_SCHEMAS.length} schemas`);
  if (!enforceOn) {
    print(
      `        FBRAIN_APP_IDENTITY_ENFORCE=off → namespaced fbrain/* schemas reused; consent + capability headers will be skipped (writes land as NodeOwner)`,
    );
  }
  const schemaClient = newSchemaServiceClient(schemaServiceUrl, verbose);
  const nodeClient = newNodeClient({ baseUrl: nodeUrl, userHash, verbose: verbose ?? (() => {}) });
  const schemaHashes: Record<string, string> = {};
  const certBlocked: typeof UNIQUE_SCHEMAS = [];
  for (const entry of UNIQUE_SCHEMAS) {
    try {
      const reg = await schemaClient.registerSchema(entry.schema);
      for (const type of entry.types) {
        schemaHashes[type] = reg.canonicalHash;
      }
      print(`        ${entry.schema.schema.descriptive_name.padEnd(18)} → ${reg.canonicalHash}  (covers ${entry.types.join(", ")})`);
    } catch (err) {
      // Cert-gated re-POST of an already-published fbrain/* schema — defer it
      // and resolve the canonical hash from the node catalog after load. Same
      // behavior under enforce-on and enforce-off; the schema identity is
      // identical, only the write-time auth differs.
      if (err instanceof FbrainError && err.code === "schema_cert_required") {
        certBlocked.push(entry);
        print(`        ${entry.schema.schema.descriptive_name.padEnd(18)} → published already (cert-gated re-POST skipped; resolving from node)`);
      } else {
        throw err;
      }
    }
  }

  // Step 3/6: load schemas into the node. This pulls the published catalog —
  // including every fbrain/* schema — into the node's DB with no cert needed.
  print(`[4/${STEPS}] loading schemas into the node`);
  const loadResult = await nodeClient.loadSchemas();
  if (loadResult.failed_schemas.length > 0) {
    throw new Error(
      `partial schema load — failed_schemas: ${loadResult.failed_schemas.join(", ")}`,
    );
  }
  print(
    `        loaded ${loadResult.schemas_loaded_to_db}/${loadResult.available_schemas_loaded} schemas` +
      ` (failed_schemas empty ✓)`,
  );

  // Resolve every cert-gated schema from the node's authoritative hashes.
  // This is the fresh-consumer happy path: no DevCert, no re-POST, the real
  // namespaced fbrain/* canonical hashes (NOT the bare enforce-off variants).
  if (certBlocked.length > 0) {
    const loaded = await nodeClient.listLoadedSchemas();
    const stillMissing: string[] = [];
    for (const entry of certBlocked) {
      const hash = resolveOwnedSchemaHash(entry.schema, loaded);
      if (hash) {
        for (const type of entry.types) {
          schemaHashes[type] = hash;
        }
        print(`        resolved ${entry.schema.schema.descriptive_name.padEnd(18)} → ${hash}  (published fbrain/* schema; no DevCert needed)`);
      } else {
        stillMissing.push(entry.schema.schema.descriptive_name);
      }
    }
    if (stillMissing.length > 0) {
      throw new FbrainError({
        code: "schema_cert_required",
        message:
          `Schema service rejected publish with 401 cert_required, and these schemas are not yet ` +
          `published on this schema service — so their canonical hashes could not be resolved from ` +
          `the node either: ${stillMissing.join(", ")}. A maintainer must publish them once.`,
        hint: CERT_REQUIRED_HINT,
      });
    }
  }

  // Step 4/6: persist config (config file written before consent so a Ctrl-C
  // mid-grant doesn't lose schema state — the next init re-runs the consent
  // step idempotently).
  print(`[5/${STEPS}] writing config to ${configPath}`);
  const config: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl,
    schemaServiceUrl,
    userHash,
    schemaHashes,
    designSchemaHash: schemaHashes.design ?? "",
    taskSchemaHash: schemaHashes.task ?? "",
  };
  writeConfig(config, configPath);
  print(`        wrote config v${CONFIG_VERSION}`);

  // Step 5/6: inline consent — eliminate the "two-terminal dance" on first
  // write. Idempotent (skips silently when a live capability is already on
  // disk); non-TTY safe (skips with a one-line note for CI/scripts); falls
  // back to the manual instruction when `folddb` is not on PATH.
  print(`[6/${STEPS}] establishing consent (one-time grant for fbrain's namespace)`);
  const consentBase: EstablishConsentOptions = {
    nodeUrl,
    userHash,
    print,
  };
  if (verbose !== undefined) consentBase.verbose = verbose;
  if (opts.grantConsent) consentBase.nonInteractiveGrant = true;
  const consent = await establishConsentInline({ ...consentBase, ...(opts.consent ?? {}) });

  print(`[init] ok`);
  return { config, bootstrapped, consent };
}

type ProbeResult = Awaited<ReturnType<ReturnType<typeof newNodeClient>["autoIdentity"]>>;

type ProbeOpts = {
  nodeUrl: string;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
};

async function probeWithRetry(
  probeClient: ReturnType<typeof newNodeClient>,
  opts: ProbeOpts,
  print: (line: string) => void,
): Promise<ProbeResult> {
  try {
    return await probeClient.autoIdentity();
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    const delays = opts.retryDelaysMs ?? envRetryDelays() ?? DEFAULT_RETRY_DELAYS_MS;
    if (delays.length === 0) throw err;
    const sleep = opts.sleep ?? defaultSleep;
    print(
      isDefaultNodeUrl(opts.nodeUrl)
        ? `        node not reachable at ${opts.nodeUrl}. Start it: \`brew services start folddb\` (or \`brew services restart folddb\` after a \`brew upgrade\`).`
        : `        node not reachable at ${opts.nodeUrl}. If this is a first run from source, fold_db is compiling Rust — give it a few minutes.`,
    );
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i] ?? 0;
      print(`        retrying in ${Math.round(delay / 1000)}s (attempt ${i + 1}/${delays.length})…`);
      await sleep(delay);
      try {
        return await probeClient.autoIdentity();
      } catch (e2) {
        if (i === delays.length - 1 || !isUnreachable(e2)) throw e2;
      }
    }
    throw err;
  }
}

type ResolvedUrls = {
  nodeUrl: string;
  schemaServiceUrl: string;
  // Human-readable descriptors of what we replaced, for the heal notice.
  // Empty when no heal happened (fresh init, or existing URLs are already
  // current / are user overrides).
  healed: string[];
};

export function resolveUrls(
  opts: Pick<InitOptions, "nodeUrl" | "schemaServiceUrl">,
  existing: Config | null,
): ResolvedUrls {
  const healed: string[] = [];

  let nodeUrl: string;
  if (opts.nodeUrl) {
    nodeUrl = opts.nodeUrl;
  } else if (!existing) {
    nodeUrl = DEFAULT_NODE_URL;
  } else if (STALE_NODE_URLS.has(existing.nodeUrl)) {
    nodeUrl = DEFAULT_NODE_URL;
    healed.push(`nodeUrl ${existing.nodeUrl} → ${DEFAULT_NODE_URL}`);
  } else {
    nodeUrl = existing.nodeUrl;
  }

  let schemaServiceUrl: string;
  if (opts.schemaServiceUrl) {
    schemaServiceUrl = opts.schemaServiceUrl;
  } else if (!existing) {
    schemaServiceUrl = DEFAULT_SCHEMA_SERVICE_URL;
  } else if (STALE_SCHEMA_URLS.has(existing.schemaServiceUrl)) {
    schemaServiceUrl = DEFAULT_SCHEMA_SERVICE_URL;
    healed.push(`schemaServiceUrl ${existing.schemaServiceUrl} → ${DEFAULT_SCHEMA_SERVICE_URL}`);
  } else {
    schemaServiceUrl = existing.schemaServiceUrl;
  }

  return { nodeUrl, schemaServiceUrl, healed };
}

function isUnreachable(err: unknown): boolean {
  return err instanceof FbrainError && err.code === "service_unreachable";
}

// Option C gate: only reuse a saved userHash when the config carries
// enough state (userHash + at least one schema hash) to look like a
// completed init against this node. Insufficient state ⇒ the user is
// genuinely stuck and should see the node's own recovery message.
export function hasUsableExistingConfig(cfg: Config | null): cfg is Config {
  if (!cfg) return false;
  if (typeof cfg.userHash !== "string" || cfg.userHash.length === 0) return false;
  return Object.keys(cfg.schemaHashes).length > 0;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
