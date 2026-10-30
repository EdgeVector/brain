// Named keys belong to one record schema. Relationship records keep their own values.
import { BrainError, type NodeClient, type QueryRow } from "./client.ts";
import { BRAIN_COMPACT_LOCATOR_SCHEMA_KEY, RECORD_TYPES, UNIQUE_SCHEMAS, schemaConfigKeys, type RecordType, type SchemaDefinition } from "./schemas.ts";

export const MULTI_KEY_MODEL = "multi-key-v1" as const;
export const multiKey = (cfg: { storageModel?: string }): boolean => cfg.storageModel === MULTI_KEY_MODEL;

export function ownedSchemas() {
  return UNIQUE_SCHEMAS.map((entry) => {
    const schema = structuredClone(entry.schema.schema);
    schema.independent_fields = true;
    const ordered = (): NonNullable<SchemaDefinition["alternate_keys"]>[string] => ({
      hash_literal: "all", range_separator: "#", range_parts: [
        { field: "updated_at", format: "reverse_time_millis" }, { field: "slug" },
      ],
    });
    if (RECORD_TYPES.includes(entry.key as RecordType)) {
      schema.alternate_keys = { recent: ordered(), by_status: { ...ordered(), hash_literal: undefined, hash_field: "status" } };
      if (entry.key === "task") schema.alternate_keys.by_design = {
        ...ordered(), hash_literal: undefined, hash_field: "design_slug", missing: "omit", omit_empty_hash: true,
      };
    }
    return { keys: schemaConfigKeys(entry), schema,
      ...(entry.key === BRAIN_COMPACT_LOCATOR_SCHEMA_KEY ? { opaqueHash: true as const } : {}) };
  });
}

export type NamedRow = QueryRow & { matched_key: { hash: string; range: string } };
export type NamedPage = { results: NamedRow[]; has_more: boolean; next_cursor?: unknown };

export async function keyPage(
  node: NodeClient, schema: string, name: string,
  filter: unknown, fields: readonly string[], limit = 1000, cursor?: unknown,
): Promise<NamedPage> {
  const response = await node.rawCall("POST", "/api/query", {
    schema_name: schema, key_name: name, filter, fields: [...fields], limit, response_format: "values",
    ...(cursor ? { cursor } : {}),
  });
  const root = response.json as { data?: unknown };
  const page = (root?.data ?? root) as NamedPage;
  if (response.status !== 200 || !Array.isArray(page?.results) || typeof page.has_more !== "boolean"
      || page.results.some((row) => !row.key?.hash || !row.matched_key?.hash || typeof row.matched_key.range !== "string")) {
    throw new BrainError({ code: "multi_key_read_failed", message: `The ${schema}/${name} read did not return a valid named-key page.` });
  }
  if (page.has_more && !page.next_cursor) throw new BrainError({ code: "multi_key_cursor_missing", message: "The named-key page has no continuation." });
  return page;
}

export async function keyRows(
  node: NodeClient, schema: string, name: string,
  filter: unknown, fields: readonly string[],
): Promise<NamedRow[]> {
  const rows: NamedRow[] = [];
  let cursor: unknown;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const page = await keyPage(node, schema, name, filter, fields, 1000, cursor);
    for (const row of page.results) {
      const id = JSON.stringify(row.key);
      if (seen.has(id)) throw new BrainError({ code: "multi_key_duplicate", message: "The named-key pages repeat a primary record." });
      seen.add(id);
      rows.push(row);
    }
    if (!page.has_more) return rows;
    if (JSON.stringify(cursor) === JSON.stringify(page.next_cursor)) throw new BrainError({ code: "multi_key_cursor_stalled", message: "The named-key cursor did not advance." });
    cursor = page.next_cursor;
  }
  throw new BrainError({ code: "multi_key_read_limit", message: "The named-key read exceeded its page limit." });
}

