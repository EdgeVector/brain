// `fbrain init` — bootstrap a node (if needed), register every fbrain
// schema, load them, persist canonical hashes to ~/.fbrain/config.json.
//
// 5 steps (per Phase 0 spike, step 0 added):
//   0. probe /api/system/auto-identity
//   1. POST /api/setup/bootstrap if 503
//   2. register all 8 schemas via schema service → capture canonical hashes
//   3. POST /api/schemas/load
//   4. verify failed_schemas empty + persist config
//
// Idempotent. Step 0 makes a re-run skip bootstrap; step 2's POST is
// idempotent on the schema service side (identical re-POST returns 200
// with the same canonical hash). Re-running init is the prescribed
// remedy for `409 ambiguous_schema_name`, and also the way to upgrade
// older configs (v1 → current; v2 → current, with URL auto-heal if the
// existing URLs still point at the dead `:9101 / :9102` local-schema).

import { newNodeClient, newSchemaServiceClient, FbrainError, type Verbose } from "../client.ts";
import { UNIQUE_SCHEMAS } from "../schemas.ts";
import {
  CONFIG_VERSION,
  defaultConfigPath,
  tryReadConfig,
  writeConfig,
  type Config,
} from "../config.ts";

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
};

const STEPS = 5;

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const verbose = opts.verbose;
  const bootstrapName = opts.bootstrapName ?? "fbrain";
  const configPath = opts.configPath ?? defaultConfigPath();

  const existing = tryReadConfig(configPath);
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

  // Step 0/5: probe identity (with cold-build retry).
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

  // Step 2/5: register the unique schemas. As of Phase E each Phase 6
  // kind has its own dedicated schema, so init registers Design + Task +
  // six per-kind schemas + the legacy FbrainKindNote (kept registered
  // so pre-Phase-E records remain readable via the legacy fallback).
  print(`[3/${STEPS}] registering ${UNIQUE_SCHEMAS.length} schemas (covering ${UNIQUE_SCHEMAS.reduce((n, s) => n + s.types.length, 0)} record types)`);
  const schemaClient = newSchemaServiceClient(schemaServiceUrl, verbose);
  const schemaHashes: Record<string, string> = {};
  for (const entry of UNIQUE_SCHEMAS) {
    const reg = await schemaClient.registerSchema(entry.schema);
    // Persist under the entry's key (for the legacy fallback's lookup)
    // and under each RecordType the entry covers (for schemaHashFor).
    // Most entries have key === types[0], so this writes the same hash
    // twice under the same key — harmless.
    schemaHashes[entry.key] = reg.canonicalHash;
    for (const type of entry.types) {
      schemaHashes[type] = reg.canonicalHash;
    }
    const coverage = entry.types.length > 0
      ? `covers ${entry.types.join(", ")}`
      : "legacy read-only";
    print(`        ${entry.schema.schema.descriptive_name.padEnd(18)} → ${reg.canonicalHash}  (${coverage})`);
  }

  // Step 3/5: load schemas into the node
  print(`[4/${STEPS}] loading schemas into the node`);
  const nodeClient = newNodeClient({ baseUrl: nodeUrl, userHash, verbose: verbose ?? (() => {}) });
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

  // Step 4/5: persist config
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
  print(`[init] ok`);
  return { config, bootstrapped };
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
      `        node not reachable at ${opts.nodeUrl}. If this is a first run, fold_db is compiling Rust — give it a few minutes.`,
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
