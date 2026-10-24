// Exact locator addresses need no ordered range and no stored key fields.
import { createHash } from "node:crypto";
import type { BatchMutationOp, NodeClient, QueryRow } from "./client.ts";
import { BRAIN_COMPACT_LOCATOR_SCHEMA_KEY, BRAIN_LIST_LOCATOR_SCHEMA_KEY } from "./schemas.ts";

type Config = { schemaHashes: Record<string, string> };
type Key = { hash: string; range: string };
export type Locator = {
  listHash: string;
  range: string;
  pageId: string;
  existed: boolean;
  deleted: boolean;
  legacy?: boolean;
  compact?: boolean;
};

export function locatorSchema(cfg: Config): string {
  return cfg.schemaHashes[BRAIN_COMPACT_LOCATOR_SCHEMA_KEY]
    || cfg.schemaHashes[BRAIN_LIST_LOCATOR_SCHEMA_KEY] || "";
}

function compactKey(key: Key): string {
  return createHash("sha256").update("brain:list-locator:v1\0")
    .update(JSON.stringify([key.hash, key.range])).digest("base64url");
}

async function read(node: NodeClient, schemaHash: string, fields: string[], keys: readonly Key[]): Promise<QueryRow[]> {
  if (!schemaHash || keys.length === 0) return [];
  if (node.queryByKeys) return node.queryByKeys({ schemaHash, fields, keys: [...keys] });
  return (await node.queryAll({ schemaHash, fields,
    filter: { HashRangeKeys: keys.map((key) => [key.hash, key.range]) },
  })).results;
}

export async function readLocators(node: NodeClient, cfg: Config, keys: readonly Key[]): Promise<QueryRow[]> {
  const compact = cfg.schemaHashes[BRAIN_COMPACT_LOCATOR_SCHEMA_KEY];
  const oldSchema = cfg.schemaHashes[BRAIN_LIST_LOCATOR_SCHEMA_KEY] || "";
  const result = new Map<string, QueryRow>();
  const selected = new Map(keys.map((key) => [compactKey(key), key]));
  const [rows, old] = await Promise.all([
    read(node, compact || "", ["bcl_page"],
      [...selected.keys()].map((hash) => ({ hash, range: "" }))),
    read(node, oldSchema, ["bll_h", "bll_r", "bll_page"], [...selected.values()]),
  ]);
  for (const row of old) {
    const key = { hash: row.key.hash ?? "", range: row.key.range ?? "" };
    result.set(compactKey(key), { ...row,
      fields: { ...row.fields, __legacy_locator: true },
    });
  }
  for (const row of rows) {
    const id = row.key?.hash ?? "";
    const key = selected.get(id);
    if (!key) continue;
    if (typeof row.fields?.bcl_page !== "string" || row.fields.bcl_page.length === 0) {
      throw new Error("A compact list locator has an invalid page value.");
    }
    result.set(id, { ...row, key: { hash: key.hash, range: key.range },
      fields: { bll_h: key.hash, bll_r: key.range, bll_page: row.fields.bcl_page,
        __compact_locator: true, __legacy_locator: result.has(id) },
    });
  }
  return [...result.values()];
}

export function locatorMutations(cfg: Config, loc: Locator): BatchMutationOp[] {
  const compact = cfg.schemaHashes[BRAIN_COMPACT_LOCATOR_SCHEMA_KEY];
  const oldSchema = cfg.schemaHashes[BRAIN_LIST_LOCATOR_SCHEMA_KEY] || "";
  const key = { hash: `loc#${loc.listHash}`, range: loc.range };
  if (!compact) {
    if (!oldSchema || (loc.deleted && !loc.existed)) return [];
    return [{ mutationType: loc.deleted ? "delete" : loc.existed ? "update" : "create",
      schemaHash: oldSchema, keyHash: key.hash, keyRange: key.range,
      fields: loc.deleted ? {} : { bll_h: key.hash, bll_r: key.range, bll_page: loc.pageId },
    }];
  }
  const ops: BatchMutationOp[] = [];
  if (!loc.deleted || loc.compact) {
    ops.push({ mutationType: loc.deleted ? "delete" : loc.compact ? "update" : "create",
      schemaHash: compact, keyHash: compactKey(key),
      fields: loc.deleted ? {} : { bcl_page: loc.pageId },
    });
  }
  if (loc.legacy && oldSchema) {
    ops.push({ mutationType: "delete", schemaHash: oldSchema,
      keyHash: key.hash, keyRange: key.range, fields: {},
    });
  }
  return ops;
}
