// Test helpers shared across unit and integration suites.

import { RECORD_TYPES, type RecordType } from "../src/schemas.ts";
import { CONFIG_VERSION, type Config } from "../src/config.ts";

// Synthetic 64-hex hashes for unit tests — distinct first byte per type so
// recordTypeForHash() and schemaHashFor() lookups behave like real configs
// without standing up a node.
export const TEST_HASHES: Record<RecordType, string> = {
  design: "84d9f350b4ff55d9bc96178cd83bd858e8db692485dc820474c5c30355a3062b",
  task: "c0352ec0c4534bfbc7b692ce4437a0843bdc993aeedfa7df9679437a3cf2bd1e",
  concept: "c".repeat(64),
  preference: "f".repeat(64),
  reference: "e".repeat(64),
  agent: "a".repeat(64),
  project: "9".repeat(64),
  spike: "5".repeat(64),
};

// Test URL defaults: homebrew `fold_db_node` daemon + the dev cloud Lambda.
// Dev (us-west-2) — not prod — so iteration-test runs don't pollute the
// production schema registry. CI / per-env overrides via env vars.
export const TEST_NODE_URL =
  process.env.FBRAIN_TEST_NODE_URL ?? "http://127.0.0.1:9001";
export const TEST_SCHEMA_SERVICE_URL =
  process.env.FBRAIN_TEST_SCHEMA_URL ??
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";

export function buildTestCfg(over: Partial<Config> = {}): Config {
  const base: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl: TEST_NODE_URL,
    schemaServiceUrl: TEST_SCHEMA_SERVICE_URL,
    userHash: "uh-test",
    schemaHashes: { ...TEST_HASHES },
    designSchemaHash: TEST_HASHES.design,
    taskSchemaHash: TEST_HASHES.task,
  };
  const merged: Config = { ...base, ...over };
  // Keep mirrors in sync unless caller explicitly overrode them.
  if (!("designSchemaHash" in over)) {
    merged.designSchemaHash = merged.schemaHashes.design ?? "";
  }
  if (!("taskSchemaHash" in over)) {
    merged.taskSchemaHash = merged.schemaHashes.task ?? "";
  }
  return merged;
}

export { RECORD_TYPES };
