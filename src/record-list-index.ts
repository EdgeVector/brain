// Per-type RecordListIndex helpers — product list/BM25 never full-scan
// fbrain record schemas (design-lastdb-scan-deprecation-path).

import type { NodeClient } from "./client.ts";
import {
  RECORD_LIST_INDEX_FIELDS,
  RECORD_LIST_INDEX_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";
import type { FbrainRecord } from "./record.ts";

export function recordListIndexHash(
  cfg: { schemaHashes: Record<string, string> },
): string | null {
  const h = cfg.schemaHashes[RECORD_LIST_INDEX_SCHEMA_KEY];
  return h && h.length > 0 ? h : null;
}

export async function readTypeListIndex(
  node: NodeClient,
  cfg: { schemaHashes: Record<string, string> },
  type: RecordType,
): Promise<FbrainRecord[] | null> {
  const hash = recordListIndexHash(cfg);
  if (!hash || !node.queryByKey) return null;
  const row = await node.queryByKey({
    schemaHash: hash,
    keyHash: type,
    fields: [...RECORD_LIST_INDEX_FIELDS],
  });
  if (!row) return null;
  const raw = (row.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is FbrainRecord => isFbrainRecordLike(e));
  } catch {
    return [];
  }
}

export async function writeTypeListIndex(
  node: NodeClient,
  cfg: { schemaHashes: Record<string, string> },
  type: RecordType,
  records: FbrainRecord[],
): Promise<void> {
  const hash = recordListIndexHash(cfg);
  if (!hash) return;
  const fields = {
    key: type,
    payload_json: JSON.stringify(records),
    updated_at: new Date().toISOString(),
  };
  const existing = node.queryByKey
    ? await node.queryByKey({
        schemaHash: hash,
        keyHash: type,
        fields: ["key"],
      })
    : null;
  if (existing) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: type });
  } else {
    await node.createRecord({ schemaHash: hash, fields, keyHash: type });
  }
}

export async function patchTypeListIndex(
  node: NodeClient,
  cfg: { schemaHashes: Record<string, string> },
  type: RecordType,
  record: FbrainRecord | null,
  slug: string,
  isTombstoned: (r: FbrainRecord) => boolean,
): Promise<void> {
  const current = (await readTypeListIndex(node, cfg, type)) ?? [];
  const without = current.filter((r) => r.slug !== slug && !isTombstoned(r));
  if (record && !isTombstoned(record)) without.push(record);
  await writeTypeListIndex(node, cfg, type, without);
}

function isFbrainRecordLike(value: unknown): value is FbrainRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.slug === "string" && typeof v.title === "string";
}
