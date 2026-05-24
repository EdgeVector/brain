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
// a v1 config to v2.

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
  nodeUrl: string;
  schemaServiceUrl: string;
  configPath?: string;
  bootstrapName?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Tuning hooks (mainly for tests):
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
};

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

  // Step 0/5: probe identity (with cold-build retry).
  print(`[1/${STEPS}] probing node identity`);
  const probeUserHash = existing?.userHash ?? "init-probe";
  const probeClient = newNodeClient({ baseUrl: opts.nodeUrl, userHash: probeUserHash, verbose: verbose ?? (() => {}) });
  const identity = await probeWithRetry(probeClient, opts, print);

  let userHash: string;
  let bootstrapped = false;
  if (identity.provisioned) {
    userHash = identity.userHash;
    print(`[2/${STEPS}] node already provisioned (user_hash=${userHash.slice(0, 8)}…) — skipping bootstrap`);
  } else {
    print(`[2/${STEPS}] node not provisioned (${identity.reason}); running bootstrap`);
    const result = await probeClient.bootstrap(bootstrapName);
    userHash = result.userHash;
    bootstrapped = true;
    print(`        bootstrap ok (user_hash=${userHash.slice(0, 8)}…)`);
  }

  // Step 2/5: register the unique schemas. Phase 6 types (concept,
  // preference, reference, agent, project, spike) share a single
  // FbrainKindNote schema, so we register 3 schemas total (Design,
  // Task, FbrainKindNote) and fan the note hash out to all 6 Phase 6
  // entries in schemaHashes.
  print(`[3/${STEPS}] registering ${UNIQUE_SCHEMAS.length} schemas (covering ${UNIQUE_SCHEMAS.reduce((n, s) => n + s.types.length, 0)} record types)`);
  const schemaClient = newSchemaServiceClient(opts.schemaServiceUrl, verbose);
  const schemaHashes: Record<string, string> = {};
  for (const entry of UNIQUE_SCHEMAS) {
    const reg = await schemaClient.registerSchema(entry.schema);
    for (const type of entry.types) {
      schemaHashes[type] = reg.canonicalHash;
    }
    print(`        ${entry.schema.schema.descriptive_name.padEnd(18)} → ${reg.canonicalHash}  (covers ${entry.types.join(", ")})`);
  }

  // Step 3/5: load schemas into the node
  print(`[4/${STEPS}] loading schemas into the node`);
  const nodeClient = newNodeClient({ baseUrl: opts.nodeUrl, userHash, verbose: verbose ?? (() => {}) });
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
    nodeUrl: opts.nodeUrl,
    schemaServiceUrl: opts.schemaServiceUrl,
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

async function probeWithRetry(
  probeClient: ReturnType<typeof newNodeClient>,
  opts: InitOptions,
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

function isUnreachable(err: unknown): boolean {
  return err instanceof FbrainError && err.code === "service_unreachable";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
