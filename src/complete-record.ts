import type { WriteItem } from "@lastdb/app-sdk";

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
  if (!node.queryByKey) throw new Error("LastDB did not confirm the complete record read.");
  const row = await node.queryByKey({ schemaHash: schema, fields: [], keyHash: hash, file: true });
  if (!row) return null;
  if (row.key.hash !== hash || row.key.range !== null || !row.revision) {
    throw new Error("LastDB returned an invalid complete record.");
  }
  return {
    key: { hash: row.key.hash, range: row.key.range },
    fields: row.fields,
    alternates: {},
    revision: row.revision,
    metadata: null,
  };
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

export function alternateAddresses(schema: SchemaDefinition, fields: Fields): RecordPreimage["alternates"] {
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

export function toAppMutation(
  op: BatchMutationOp,
  schemaName: string,
  schema: SchemaDefinition,
  current: RecordPreimage | undefined,
): WriteItem | null {
  const deleting = op.mutationType === "delete";
  if (deleting && !current) return null;
  const key = { hash: op.keyHash, range: op.keyRange ? op.keyRange : null };
  if (deleting) {
    if (!current?.revision) throw new Error("LastDB delete needs the record revision.");
    return { op: "delete", schema: schemaName, key, revision: current.revision };
  }
  const fields = { ...current?.fields, ...op.fields } as WriteItem extends { record: infer R } ? R : never;
  const alternates = alternateAddresses(schema, fields);
  const link = op.file
    ? {
        path: op.file.path,
        ...(op.file.name !== undefined ? { name: op.file.name } : {}),
        ...(op.file.media_type !== undefined ? { media_type: op.file.media_type } : {}),
      }
    : undefined;
  const record = fields;
  if (current) {
    if (!current.revision) throw new Error("LastDB replace needs the record revision.");
    return {
      op: "replace",
      schema: schemaName,
      key,
      revision: current.revision,
      record,
      alternates,
      ...(link ? { file: link } : {}),
    };
  }
  return {
    op: "create",
    schema: schemaName,
    key,
    record,
    alternates,
    ...(link ? { file: link } : {}),
  };
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
