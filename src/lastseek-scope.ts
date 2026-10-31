// LastSeek scope terms for the Brain types a query walks.
//
// Brain names its schemas `brain/<Type>`. The Schema Service does not list
// those owner-local names, so LastSeek resolves one only after it holds a row
// under it (its store-local tier), and it refuses the WHOLE query with
// `unknown schema` for any term it cannot resolve. A type that has no record
// never sends a row, so one empty type broke every unscoped `brain search` and
// `brain ask`: on the 2026-10-31 primary, `task` and `agent` were empty and
// every query failed on `brain/Task`.
//
// So leave out exactly the types that hold no record. They have nothing to
// find, and the scope loses nothing. Every other type stays in, so a type that
// holds records LastSeek never received still fails loudly (see
// lastseek-plane.ts: an unknown schema is never swallowed).
//
// One batched count read decides most types. A count above zero keeps the type
// (the count over-reports: soft-deleted records keep their entry, and those
// still reach LastSeek). A type whose count is zero or absent gets a one-key
// membership read, because an absent count is also what an install that never
// backfilled its counts looks like. Any read failure keeps the type.

import type { NodeClient, QueryRow, Verbose } from "./client.ts";
import type { Config } from "./config.ts";
import { parseListCount } from "./count-state.ts";
import { uniqueSchemaHashes } from "./record.ts";
import { BRAIN_LIST_COUNT_SCHEMA_KEY, type RecordType } from "./schemas.ts";

function countField(row: QueryRow, name: string): string | null {
  const value = (row.fields as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : null;
}

async function readTypeCounts(
  node: NodeClient,
  cfg: Config,
  types: readonly RecordType[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const schemaHash = cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY] ?? "";
  if (schemaHash.length === 0 || !node.queryByKeys) return counts;
  const rows = await node.queryByKeys({
    schemaHash,
    fields: ["bln_h", "bln_n"],
    keys: types.map((type) => ({ hash: type })),
  });
  for (const row of rows) {
    const hash = row.key?.hash ?? countField(row, "bln_h");
    const count = parseListCount(countField(row, "bln_n"))?.count;
    if (hash && count !== undefined) counts.set(hash, count);
  }
  return counts;
}

async function holdsRecord(node: NodeClient, schemaHash: string): Promise<boolean> {
  if (!node.listRecordKeys) return true;
  const page = await node.listRecordKeys(schemaHash, { limit: 1 });
  return page.keys.length > 0;
}

/**
 * The LastSeek scope for `types`: their schema names, less the types that hold
 * no record. Empty only when every type is empty; callers then have nothing to
 * search and must not send an unscoped LastSeek query.
 */
export async function lastSeekScope(
  node: NodeClient,
  cfg: Config,
  types: readonly RecordType[],
  verbose?: Verbose,
): Promise<string[]> {
  const all = uniqueSchemaHashes(cfg, types);
  if (types.length === 0) return all;
  try {
    const counts = await readTypeCounts(node, cfg, types);
    const unsure = types.filter((type) => !((counts.get(type) ?? 0) > 0));
    const held = await Promise.all(
      unsure.map((type) => holdsRecord(node, cfg.schemaHashes[type] ?? "")),
    );
    const empty = new Set(unsure.filter((_, index) => !held[index]));
    if (empty.size === 0) return all;
    verbose?.(`lastseek scope: no record in ${[...empty].join(", ")}; left out of the scope`);
    return uniqueSchemaHashes(cfg, types.filter((type) => !empty.has(type)));
  } catch (error) {
    verbose?.(
      `lastseek scope: membership read failed (${error instanceof Error ? error.message : error}); keeping every type`,
    );
    return all;
  }
}
