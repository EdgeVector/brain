// `fbrain init` — bootstrap a node (if needed), register Design + Task,
// load them, persist canonical hashes to ~/.fbrain/config.json.
//
// 5 steps (per Phase 0 spike, step 0 added):
//   0. probe /api/system/auto-identity
//   1. POST /api/setup/bootstrap if 503
//   2. register Design + Task via schema service → capture canonical hashes
//   3. POST /api/schemas/load
//   4. verify failed_schemas empty + persist config
//
// Idempotent. Step 0 makes a re-run skip bootstrap; step 2's POST is
// idempotent on the schema service side (identical re-POST returns 200
// with the same canonical hash). Re-running init is the prescribed
// remedy for `409 ambiguous_schema_name`.

import { newNodeClient, newSchemaServiceClient, type Verbose } from "../client.ts";
import { designSchema, taskSchema } from "../schemas.ts";
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
};

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

  // Step 0/5: probe identity
  print(`[1/${STEPS}] probing node identity`);
  const probeUserHash = existing?.userHash ?? "init-probe";
  const probeClient = newNodeClient({ baseUrl: opts.nodeUrl, userHash: probeUserHash, verbose: verbose ?? (() => {}) });
  const identity = await probeClient.autoIdentity();

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

  // Step 2/5: register schemas
  print(`[3/${STEPS}] registering Design + Task schemas`);
  const schemaClient = newSchemaServiceClient(opts.schemaServiceUrl, verbose);
  const designReg = await schemaClient.registerSchema(designSchema);
  const taskReg = await schemaClient.registerSchema(taskSchema);
  print(`        Design hash:  ${designReg.canonicalHash}`);
  print(`        Task hash:    ${taskReg.canonicalHash}`);

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
    designSchemaHash: designReg.canonicalHash,
    taskSchemaHash: taskReg.canonicalHash,
  };
  writeConfig(config, configPath);
  print(`        wrote config v${CONFIG_VERSION}`);
  print(`[init] ok`);
  return { config, bootstrapped };
}
