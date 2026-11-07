import type { BatchMutationOp, NodeClient } from "./client.ts";
import type { SchemaDefinition } from "./schemas.ts";

type Fields = Record<string, unknown>;
export type RecordCoordinate = { hash: string; range: string | null };
export type RecordPreimage = {
  key: RecordCoordinate;
  fields: Fields;
  alternates: Record<string, RecordCoordinate | null>;
  revision: string;
  metadata: Fields | null;
};

export function coordinateId(schema: string, hash: string, range?: string | null): string {
  return JSON.stringify([schema, hash, range ?? null]);
}

export async function readCompleteRecord(node: NodeClient, schema: string, hash: string): Promise<RecordPreimage | null> {
  const result = await node.rawCall("POST", "/api/query", {
    schema_name: schema, filter: { HashKey: hash }, limit: 2,
  });
  const reply = result.json as { results?: RecordPreimage[]; has_more?: boolean };
  if (result.status !== 200 || reply?.has_more !== false || !Array.isArray(reply.results) || reply.results.length > 1) {
    throw new Error("LastDB did not confirm the complete record read.");
  }
  const row = reply.results[0];
  if (!row) return null;
  if (row.key.hash !== hash || row.key.range !== null || !row.fields || !row.alternates || !/^[a-f0-9]{64}$/.test(row.revision)) {
    throw new Error("LastDB returned an invalid complete record.");
  }
  return row;
}

export function fileOperation(schema: string, hash: string, fields: Fields, current?: RecordPreimage | null) {
  return {
    type: "mutation", schema, key_value: { hash, range: null }, record: fields, alternates: {},
    mutation_type: current ? "replace" : "create",
    expected: current ? { type: "revision", revision: current.revision } : { type: "absent" },
    durability: "durable",
  };
}

export function expectationMatches(op: BatchMutationOp, current: RecordPreimage | undefined): boolean {
  if (op.mutationType === "create" && current && !op.replaceIfPresent) return false;
  if (op.mutationType === "update" && !current) return false;
  if (op.expected?.type === "absent") return current?.fields[op.expected.field] == null;
  if (op.expected?.type === "value") return current?.fields[op.expected.field] === op.expected.value;
  return true;
}

function alternateAddresses(schema: SchemaDefinition, fields: Fields): RecordPreimage["alternates"] {
  return Object.fromEntries(Object.entries(schema.alternate_keys ?? {}).map(([name, spec]) => {
    const hash = spec.hash_literal ?? fields[spec.hash_field ?? ""];
    const parts = (spec.range_parts ?? []).map((part) => fields[part.field]);
    if (typeof hash !== "string" || !hash || parts.some((value) => value == null)) {
      if (spec.missing === "omit") return [name, null];
      throw new Error(`The ${name} alternate key is missing a required value.`);
    }
    const separator = spec.range_separator ?? "";
    const range = (spec.range_parts ?? []).map((part, index) => {
      const value = parts[index];
      if (typeof value !== "string" || (separator && value.includes(separator))) {
        throw new Error(`The ${name} alternate key has an invalid range value.`);
      }
      if (part.format === "reverse_time_millis") {
        const millis = Date.parse(value);
        if (!Number.isFinite(millis)) throw new Error(`The ${name} alternate key has an invalid timestamp.`);
        return ((1n << 63n) - 1n - BigInt(millis)).toString().padStart(20, "0");
      }
      if (typeof part.format === "object") return value.padStart(part.format.padded_text.width, "0");
      return value;
    }).join(separator);
    if (!range) throw new Error(`The ${name} alternate key is missing its range.`);
    return [name, { hash, range }];
  }));
}

export function recordOperation(
  op: BatchMutationOp, schema: SchemaDefinition, current: RecordPreimage | undefined,
  durable: boolean,
) {
  const deleting = op.mutationType === "delete";
  const fields = deleting ? {} : { ...current?.fields, ...op.fields };
  const metadata = deleting ? null : current?.metadata;
  return {
    type: "mutation",
    schema: op.schemaHash,
    key_value: { hash: op.keyHash, range: op.keyRange ?? null },
    record: fields,
    alternates: deleting ? current?.alternates : alternateAddresses(schema, fields),
    mutation_type: deleting ? "delete" : current ? "replace" : "create",
    expected: current ? { type: "revision", revision: current.revision } : { type: "absent" },
    source_file_name: metadata?.source_file_name ?? null,
    metadata: metadata?.metadata ?? null,
    file: metadata?.file ?? null,
    ...(durable ? { durability: "durable" } : {}),
  };
}
