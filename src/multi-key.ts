// Named keys belong to one record schema. Relationship records keep their own values.
import { alternateAddresses } from "./complete-record.ts";
import { BrainError, type NodeClient, type QueryRow } from "./client.ts";
import { RECORD_TYPES, UNIQUE_SCHEMAS, schemaConfigKeys, type RecordType, type SchemaDefinition } from "./schemas.ts";

export const MULTI_KEY_MODEL = "multi-key-v1" as const;

export function ownedSchemas() {
  return UNIQUE_SCHEMAS.map((entry) => {
    const schema = structuredClone(entry.schema.schema);
    if (schema.name === "BrainBodyFile" || schema.name === "BrainAttachmentFile") schema.file_required = true;
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
    const rangeField = schema.key.range_field;
    schema.record_keys = {
      primary: schema.schema_type === "HashRange"
        ? { kind: "hash_range", range_type: (rangeField && schema.field_types[rangeField]) || "String" }
        : { kind: "hash" },
      alternates: Object.fromEntries(Object.entries(schema.alternate_keys ?? {}).map(([name, key]) => [
        name, { kind: "hash_range", range_type: "String", ...(key.missing === "omit" ? { allow_absent: true } : {}) },
      ])),
    };
    return { keys: schemaConfigKeys(entry), schema };
  });
}

// The legacy definitions above are app-local recipes for computing addresses.
// The node receives only the explicit record-key shapes.
export function explicitKeyDeclaration(schema: SchemaDefinition) {
  const { key: _key, alternate_keys: _alternateKeys, ...definition } = schema;
  return definition;
}

export type NamedRow = QueryRow & { matched_key: { hash: string; range: string } };
export type NamedPage = { results: NamedRow[]; has_more: boolean; next_cursor?: unknown };

function pageRange(filter: unknown): { hash: string; prefix?: string; start?: string; end?: string } {
  if (!filter || typeof filter !== "object") {
    throw new BrainError({ code: "multi_key_read_failed", message: "The named-key filter is not an object." });
  }
  const body = filter as Record<string, unknown>;
  if (typeof body.HashKey === "string" && body.HashKey.length > 0) return { hash: body.HashKey };
  const ranged = body.HashRangeRange;
  if (ranged && typeof ranged === "object") {
    const range = ranged as Record<string, unknown>;
    if (typeof range.hash !== "string" || range.hash.length === 0) {
      throw new BrainError({ code: "multi_key_read_failed", message: "The named-key range needs a hash." });
    }
    const out: { hash: string; start?: string; end?: string } = { hash: range.hash };
    if (typeof range.start === "string" && range.start.length > 0) out.start = range.start;
    if (typeof range.end === "string" && range.end.length > 0) out.end = range.end;
    return out;
  }
  const prefixed = body.HashRangePrefix;
  if (prefixed && typeof prefixed === "object") {
    const range = prefixed as Record<string, unknown>;
    if (typeof range.hash !== "string" || range.hash.length === 0 || typeof range.prefix !== "string") {
      throw new BrainError({ code: "multi_key_read_failed", message: "The named-key prefix needs a hash and a prefix." });
    }
    return { hash: range.hash, ...(range.prefix.length > 0 ? { prefix: range.prefix } : {}) };
  }
  throw new BrainError({ code: "multi_key_read_failed", message: "The named-key filter is not a hash or a range." });
}

function ownedDefinition(schema: string): SchemaDefinition | undefined {
  const suffix = schema.startsWith("brain/") ? schema.slice("brain/".length) : schema;
  return ownedSchemas().find((entry) => entry.schema.name === suffix)?.schema;
}

function projectFields(fields: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  if (names.length === 0) return fields;
  const out: Record<string, unknown> = {};
  for (const name of names) if (Object.hasOwn(fields, name)) out[name] = fields[name];
  return out;
}

export async function keyPage(
  node: NodeClient, schema: string, name: string,
  filter: unknown, fields: readonly string[], limit = 1000, cursor?: unknown,
): Promise<NamedPage> {
  if (!node.readVia) {
    throw new BrainError({ code: "multi_key_read_failed", message: "The client cannot read an alternate key." });
  }
  const range = pageRange(filter);
  const cursorText = typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
  const page = await node.readVia({
    schemaHash: schema,
    via: name,
    range,
    limit,
    ...(cursorText ? { cursor: cursorText } : {}),
  });
  const definition = ownedDefinition(schema);
  const results: NamedRow[] = [];
  for (const row of page.rows) {
    if (!row.key?.hash) {
      throw new BrainError({
        code: "multi_key_read_failed",
        message: `The ${schema}/${name} read did not return a valid named-key page.`,
      });
    }
    let matched: { hash: string; range: string };
    try {
      const address = definition ? alternateAddresses(definition, row.fields)[name] : null;
      if (!address || typeof address.hash !== "string" || typeof address.range !== "string") {
        matched = { hash: range.hash, range: String(row.key.hash ?? "") };
      } else {
        matched = { hash: address.hash, range: address.range };
      }
    } catch {
      matched = { hash: range.hash, range: String(row.key.hash ?? "") };
    }
    results.push({ ...row, fields: projectFields(row.fields, fields), matched_key: matched });
  }
  const next = page.nextCursor;
  if (next === null) return { results, has_more: false };
  return { results, has_more: true, next_cursor: next };
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

