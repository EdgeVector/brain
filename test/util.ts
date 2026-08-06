// Test helpers shared across unit and integration suites.

import {
  RECORD_LIST_ENTRY_LAYOUT,
  RECORD_LIST_ENTRY_MARKER,
  RECORD_LIST_ENTRY_MIGRATED_RANGE,
  RECORD_LIST_ENTRY_SCHEMA_KEY,
  RECORD_TYPES,
  TAG_INDEX_SCHEMA_KEY,
  type RecordType,
} from "../src/schemas.ts";
import { CONFIG_VERSION, type Config } from "../src/config.ts";
import { DEFAULT_NODE_URL } from "../src/commands/init.ts";
import { entryFieldsFor } from "../src/record-list-index.ts";
import { rowToRecord, type FbrainRecord } from "../src/record.ts";

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
  papercut: "4".repeat(64),
};

export const TEST_TAG_INDEX_HASH = "7".repeat(64);
export const TEST_RECORD_LIST_ENTRY_HASH = "8".repeat(64);

// Reverse map of TEST_HASHES so fetch/query stubs can turn a product schema
// hash back into a RecordType when synthesizing the type-list index.
const TEST_HASH_TO_TYPE: ReadonlyMap<string, RecordType> = new Map(
  (Object.entries(TEST_HASHES) as Array<[RecordType, string]>).map(([t, h]) => [
    h,
    t,
  ]),
);

export function testTypeForHash(hash: string): RecordType | null {
  return TEST_HASH_TO_TYPE.get(hash) ?? null;
}

export function testHashForType(type: string): string | null {
  return (TEST_HASHES as Record<string, string>)[type] ?? null;
}

/** Build a minimal FbrainRecord from product-schema field rows used in fixtures. */
export function fieldsToTestRecord(
  type: RecordType,
  fields: Record<string, unknown>,
): FbrainRecord {
  return rowToRecord(
    {
      fields,
      key: { hash: String(fields.slug ?? ""), range: null },
    },
    type,
  );
}

export type TypeListIndexRow = {
  fields: Record<string, string>;
  key: { hash: string; range: string };
};

/**
 * Encode product rows as a COMPLETE type-list partition (entries + migrated
 * marker). Product list paths (`listRecords`) no longer cold-seed from SOT; unit
 * fixtures that put records only on the product schema must serve this shape
 * for `TEST_RECORD_LIST_ENTRY_HASH` or the read throws `list_index_incomplete`.
 *
 * Prefer this helper (or `answerTypeListIndexQuery`) over per-test edits so the
 * fixture convention stays one place — same shape a real write leaves via
 * `maintainTypeListIndex` / `writeTypeListIndex`.
 */
export function typeListIndexPartitionRows(
  type: RecordType,
  productFieldsList: Array<Record<string, unknown>>,
): TypeListIndexRow[] {
  const rows: TypeListIndexRow[] = productFieldsList.map((f) => {
    const rec = fieldsToTestRecord(type, f);
    return {
      fields: entryFieldsFor(type, rec),
      key: { hash: type, range: rec.slug },
    };
  });
  rows.push({
    fields: {
      rle_h: type,
      rle_r: RECORD_LIST_ENTRY_MIGRATED_RANGE,
      rle_payload: "",
      rle_marker: RECORD_LIST_ENTRY_MARKER,
      layout: RECORD_LIST_ENTRY_LAYOUT,
    },
    key: { hash: type, range: RECORD_LIST_ENTRY_MIGRATED_RANGE },
  });
  return rows;
}

/**
 * Answer a RecordListEntry `/api/query` (or `queryAll`) from product-schema
 * fixture rows. Returns null when `schemaHash` is not the list-entry schema so
 * callers can fall through to their product-schema handling.
 *
 * `productRowsForType` should return the current product fields for that type
 * (empty array = complete-and-empty partition, which listRecords returns as []).
 */
export function answerTypeListIndexQuery(opts: {
  schemaHash: string;
  filter?: {
    HashKey?: unknown;
    HashRangeKey?: { hash?: unknown; range?: unknown };
  } | null;
  productRowsForType: (type: RecordType) => Array<Record<string, unknown>>;
  listEntryHash?: string;
}): TypeListIndexRow[] | null {
  const listEntryHash = opts.listEntryHash ?? TEST_RECORD_LIST_ENTRY_HASH;
  if (opts.schemaHash !== listEntryHash) return null;

  const filter = opts.filter ?? undefined;
  const hrk = filter?.HashRangeKey;
  const hrHash = typeof hrk?.hash === "string" ? hrk.hash : "";
  const hrRange = typeof hrk?.range === "string" ? hrk.range : "";
  if (hrHash && hrRange) {
    // Point-read of one entry or the migrated marker.
    if (hrRange === RECORD_LIST_ENTRY_MIGRATED_RANGE) {
      const marker = typeListIndexPartitionRows(hrHash as RecordType, []).find(
        (r) => r.key.range === RECORD_LIST_ENTRY_MIGRATED_RANGE,
      )!;
      return [marker];
    }
    const type = hrHash as RecordType;
    const product = opts.productRowsForType(type);
    const match = typeListIndexPartitionRows(type, product).find(
      (r) => r.key.range === hrRange,
    );
    return match ? [match] : [];
  }

  const keyHash =
    typeof filter?.HashKey === "string" ? filter.HashKey : "";
  if (!keyHash) {
    // Unfiltered list-entry reads are not used by product paths; empty is fine.
    return [];
  }
  const type = keyHash as RecordType;
  return typeListIndexPartitionRows(type, opts.productRowsForType(type));
}

/**
 * Wrap a unit-test `fetch` so `/api/query` against the RecordListEntry schema
 * auto-synthesizes a complete type-list partition from product fixture rows.
 * Product `listRecords` no longer cold-seeds; any mock that only serves product
 * schemas must use this (or `answerTypeListIndexQuery` inline) or list throws
 * `list_index_incomplete`.
 */
export function wrapFetchWithTypeListIndex(
  inner: typeof globalThis.fetch,
  productRowsForType: (type: RecordType) => Array<Record<string, unknown>>,
  listEntryHash: string = TEST_RECORD_LIST_ENTRY_HASH,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as Request).url ?? input);
    if (url.includes("/api/query") && typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as {
          schema_name?: string;
          filter?: {
            HashKey?: unknown;
            HashRangeKey?: { hash?: unknown; range?: unknown };
          };
        };
        if (String(body.schema_name ?? "") === listEntryHash) {
          const listIndex = answerTypeListIndexQuery({
            schemaHash: listEntryHash,
            filter: body.filter,
            productRowsForType,
            listEntryHash,
          });
          if (listIndex !== null) {
            return new Response(
              JSON.stringify({
                ok: true,
                results: listIndex,
                total_count: listIndex.length,
                returned_count: listIndex.length,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }
      } catch {
        // Fall through to the inner mock.
      }
    }
    return inner(input as never, init);
  }) as typeof globalThis.fetch;
}

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
    schemaHashes: {
      ...TEST_HASHES,
      [TAG_INDEX_SCHEMA_KEY]: TEST_TAG_INDEX_HASH,
      [RECORD_LIST_ENTRY_SCHEMA_KEY]: TEST_RECORD_LIST_ENTRY_HASH,
    },
    designSchemaHash: TEST_HASHES.design,
    taskSchemaHash: TEST_HASHES.task,
  };
  const merged: Config = { ...base, ...over };
  if (
    "schemaHashes" in over &&
    over.schemaHashes !== undefined &&
    Object.keys(over.schemaHashes).length > 0 &&
    (!(TAG_INDEX_SCHEMA_KEY in over.schemaHashes) ||
      !(RECORD_LIST_ENTRY_SCHEMA_KEY in over.schemaHashes))
  ) {
    merged.schemaHashes = {
      ...over.schemaHashes,
      [TAG_INDEX_SCHEMA_KEY]: TEST_TAG_INDEX_HASH,
      [RECORD_LIST_ENTRY_SCHEMA_KEY]: TEST_RECORD_LIST_ENTRY_HASH,
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
