// Test helpers shared across unit and integration suites.

import {
  RECORD_TYPES,
  TAG_INDEX_SCHEMA_KEY,
  type RecordType,
} from "../src/schemas.ts";
import { CONFIG_VERSION, type Config } from "../src/config.ts";
import { DEFAULT_NODE_URL } from "../src/commands/init.ts";

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
  sop: "6".repeat(64),
  decision: "d".repeat(64),
};

export const TEST_TAG_INDEX_HASH = "7".repeat(64);

// Test URL defaults: current local Mini default + the dev cloud Lambda.
// Dev (us-west-2) — not prod — so iteration-test runs don't pollute the
// production schema registry. CI / per-env overrides via env vars.
export const TEST_NODE_URL =
  process.env.FBRAIN_TEST_NODE_URL ?? DEFAULT_NODE_URL;
export const TEST_SCHEMA_SERVICE_URL =
  process.env.FBRAIN_TEST_SCHEMA_URL ??
  "https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com";

export function buildTestCfg(over: Partial<Config> = {}): Config {
  const base: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl: TEST_NODE_URL,
    schemaServiceUrl: TEST_SCHEMA_SERVICE_URL,
    userHash: "uh-test",
    schemaHashes: { ...TEST_HASHES, [TAG_INDEX_SCHEMA_KEY]: TEST_TAG_INDEX_HASH },
    designSchemaHash: TEST_HASHES.design,
    taskSchemaHash: TEST_HASHES.task,
  };
  const merged: Config = { ...base, ...over };
  if (
    "schemaHashes" in over &&
    over.schemaHashes !== undefined &&
    Object.keys(over.schemaHashes).length > 0 &&
    !(TAG_INDEX_SCHEMA_KEY in over.schemaHashes)
  ) {
    merged.schemaHashes = {
      ...over.schemaHashes,
      [TAG_INDEX_SCHEMA_KEY]: TEST_TAG_INDEX_HASH,
    };
  }
  // Keep mirrors in sync unless caller explicitly overrode them.
  if (!("designSchemaHash" in over)) {
    merged.designSchemaHash = merged.schemaHashes.design ?? "";
  }
  if (!("taskSchemaHash" in over)) {
    merged.taskSchemaHash = merged.schemaHashes.task ?? "";
  }
  return merged;
}

type LegacySearchHit = {
  schema_name?: string;
  schema_display_name?: string | null;
  key_value?: { hash?: string | null; range?: string | null };
  value?: string;
  metadata?: { score?: number; match_type?: string };
};

export function appSearchAsLegacyNativeIndex(
  url: string,
  init?: RequestInit,
): { url: string; target?: string } | null {
  if (!url.includes("/api/app/search")) return null;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
  const params = new URLSearchParams();
  if (typeof body.query === "string") params.set("q", body.query);
  const target = typeof body.target === "string" ? body.target : undefined;
  if (target) params.set("schemas", target);
  return { url: `http://localhost/api/native-index/search?${params.toString()}`, target };
}

export function appSearchBodyFromLegacy(body: unknown, target?: string): unknown {
  if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).results)) {
    return body;
  }
  const b = body as Record<string, unknown>;
  const results = (b.results as unknown[]).filter((raw) => {
    if (!target || !raw || typeof raw !== "object") return true;
    return (raw as LegacySearchHit).schema_name === target;
  });
  return {
    ...b,
    results: results.map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const hit = raw as LegacySearchHit;
      const hash = hit.key_value?.hash ?? "";
      const value = hit.value ?? "";
      return {
        schema_name: hit.schema_name ?? "",
        schema_display_name: hit.schema_display_name ?? null,
        score: hit.metadata?.score,
        key: { hash, range: hit.key_value?.range ?? null },
        fields: { slug: hash, title: value, body: value },
        metadata: hit.metadata ?? null,
        author_pub_key: null,
      };
    }),
  };
}

export function legacySearchResponseBody(body: unknown, appSearch: { target?: string } | null): unknown {
  return appSearch ? appSearchBodyFromLegacy(body, appSearch.target) : body;
}

export { RECORD_TYPES };
