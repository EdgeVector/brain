// HashRange membership for the keep set, topic clusters, parked rows, and
// ephemeral day partitions. Presence in live:{type} is the only live surface.
// No record body stores a list of slugs.

import type { NodeClient, QueryRow } from "./client.ts";
import {
  CLUSTER_INDEX_FIELDS,
  CLUSTER_INDEX_MARKER,
  CLUSTER_INDEX_SCHEMA_KEY,
  EPH_INDEX_FIELDS,
  EPH_INDEX_MARKER,
  EPH_INDEX_SCHEMA_KEY,
  LIVE_INDEX_FIELDS,
  LIVE_INDEX_MARKER,
  LIVE_INDEX_SCHEMA_KEY,
  PARKED_INDEX_FIELDS,
  PARKED_INDEX_MARKER,
  PARKED_INDEX_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";
import type { FbrainRecord } from "./record.ts";
import {
  ephDayFromTags,
  ephHash,
  isEphRecord,
  isLiveStatus,
  seriesFromTags,
  topicFromTags,
} from "./lifecycle.ts";

type SchemaCfg = { schemaHashes: Record<string, string> };

type IndexKind = "live" | "cluster" | "parked" | "eph";

const INDEX: Record<
  IndexKind,
  {
    schemaKey: string;
    marker: string;
    fields: readonly string[];
    h: string;
    r: string;
    payload: string;
    markerField: string;
  }
> = {
  live: {
    schemaKey: LIVE_INDEX_SCHEMA_KEY,
    marker: LIVE_INDEX_MARKER,
    fields: LIVE_INDEX_FIELDS,
    h: "liv_h",
    r: "liv_r",
    payload: "liv_payload",
    markerField: "liv_marker",
  },
  cluster: {
    schemaKey: CLUSTER_INDEX_SCHEMA_KEY,
    marker: CLUSTER_INDEX_MARKER,
    fields: CLUSTER_INDEX_FIELDS,
    h: "clu_h",
    r: "clu_r",
    payload: "clu_payload",
    markerField: "clu_marker",
  },
  parked: {
    schemaKey: PARKED_INDEX_SCHEMA_KEY,
    marker: PARKED_INDEX_MARKER,
    fields: PARKED_INDEX_FIELDS,
    h: "prk_h",
    r: "prk_r",
    payload: "prk_payload",
    markerField: "prk_marker",
  },
  eph: {
    schemaKey: EPH_INDEX_SCHEMA_KEY,
    marker: EPH_INDEX_MARKER,
    fields: EPH_INDEX_FIELDS,
    h: "eph_h",
    r: "eph_r",
    payload: "eph_payload",
    markerField: "eph_marker",
  },
};

function schemaHash(cfg: SchemaCfg, kind: IndexKind): string | null {
  const h = cfg.schemaHashes[INDEX[kind].schemaKey];
  return h && h.length > 0 ? h : null;
}

function entryFields(
  kind: IndexKind,
  hash: string,
  range: string,
  record: FbrainRecord | null,
): Record<string, string> {
  const spec = INDEX[kind];
  return {
    [spec.h]: hash,
    [spec.r]: range,
    [spec.payload]: record ? JSON.stringify(record) : "",
    [spec.markerField]: spec.marker,
  };
}

async function rowExists(
  node: NodeClient,
  kind: IndexKind,
  entryHash: string,
  hash: string,
  range: string,
): Promise<boolean> {
  const spec = INDEX[kind];
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: [spec.h, spec.r],
    filter: { HashRangeKey: { hash, range } },
  });
  return res.results.length > 0;
}

export async function upsertMembership(
  node: NodeClient,
  cfg: SchemaCfg,
  kind: IndexKind,
  hash: string,
  range: string,
  record: FbrainRecord,
): Promise<boolean> {
  const entryHash = schemaHash(cfg, kind);
  if (!entryHash) return false;
  const fields = entryFields(kind, hash, range, record);
  const exists = await rowExists(node, kind, entryHash, hash, range);
  if (exists) {
    await node.updateRecord({
      schemaHash: entryHash,
      fields,
      keyHash: hash,
      keyRange: range,
    });
  } else {
    await node.createRecord({
      schemaHash: entryHash,
      fields,
      keyHash: hash,
      keyRange: range,
    });
  }
  return true;
}

export async function deleteMembership(
  node: NodeClient,
  cfg: SchemaCfg,
  kind: IndexKind,
  hash: string,
  range: string,
): Promise<boolean> {
  const entryHash = schemaHash(cfg, kind);
  if (!entryHash) return false;
  if (!(await rowExists(node, kind, entryHash, hash, range))) return true;
  await node.deleteRecord({
    schemaHash: entryHash,
    keyHash: hash,
    keyRange: range,
  });
  return true;
}

export async function membershipExists(
  node: NodeClient,
  cfg: SchemaCfg,
  kind: IndexKind,
  hash: string,
  range: string,
): Promise<boolean> {
  const entryHash = schemaHash(cfg, kind);
  if (!entryHash) return false;
  return rowExists(node, kind, entryHash, hash, range);
}

export async function listMembership(
  node: NodeClient,
  cfg: SchemaCfg,
  kind: IndexKind,
  hash: string,
): Promise<Array<{ range: string; record: FbrainRecord | null }>> {
  const entryHash = schemaHash(cfg, kind);
  if (!entryHash) return [];
  const spec = INDEX[kind];
  const res = await node.queryAll({
    schemaHash: entryHash,
    fields: [...spec.fields],
    filter: { HashKey: hash },
  });
  const out: Array<{ range: string; record: FbrainRecord | null }> = [];
  for (const row of res.results) {
    const range = rangeOf(row, spec.r);
    if (!range) continue;
    out.push({ range, record: recordFromRow(row, spec.payload) });
  }
  return out;
}

function rangeOf(row: QueryRow, field: string): string | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const range = row.key?.range ?? fields[field];
  return typeof range === "string" && range.length > 0 ? range : null;
}

function recordFromRow(row: QueryRow, payloadField: string): FbrainRecord | null {
  const fields = (row.fields as Record<string, unknown> | undefined) ?? {};
  const raw = fields[payloadField];
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as FbrainRecord;
    if (typeof parsed.slug !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function liveIndexRegistered(cfg: SchemaCfg): boolean {
  return schemaHash(cfg, "live") !== null;
}

/**
 * Dual-write live / parked / cluster / eph membership after a product write
 * or delete. Non-fatal: the primary record already landed.
 */
export async function maintainLifecycleIndex(opts: {
  node: NodeClient;
  cfg: SchemaCfg;
  type: RecordType;
  record: FbrainRecord | null;
  slug: string;
  previous?: FbrainRecord | null;
}): Promise<void> {
  const { node, cfg, type, slug } = opts;
  const prev = opts.previous ?? null;
  const rec = opts.record;

  const prevTopic = prev ? topicFromTags(prev.tags) : null;
  const prevSeries = prev ? seriesFromTags(prev.tags) : null;
  const prevDay = prev ? ephDayFromTags(prev.tags) : null;

  if (!rec) {
    await deleteMembership(node, cfg, "live", type, slug);
    await deleteMembership(node, cfg, "parked", type, slug);
    if (prevTopic) await deleteMembership(node, cfg, "cluster", prevTopic, slug);
    if (prevSeries && prevDay) {
      await deleteMembership(node, cfg, "eph", ephHash(prevSeries, prevDay), slug);
    }
    return;
  }

  const topic = topicFromTags(rec.tags);
  const series = seriesFromTags(rec.tags);
  const day = ephDayFromTags(rec.tags);
  const eph = isEphRecord(rec);
  const live = !eph && isLiveStatus(type, rec.status);
  const parked = rec.status === "parked";

  const snap = { ...rec, type } as FbrainRecord;
  if (live) {
    await upsertMembership(node, cfg, "live", type, slug, snap);
    await deleteMembership(node, cfg, "parked", type, slug);
  } else if (parked) {
    await upsertMembership(node, cfg, "parked", type, slug, snap);
    await deleteMembership(node, cfg, "live", type, slug);
  } else {
    await deleteMembership(node, cfg, "live", type, slug);
    await deleteMembership(node, cfg, "parked", type, slug);
  }

  if (topic) {
    await upsertMembership(node, cfg, "cluster", topic, slug, snap);
  }
  if (prevTopic && prevTopic !== topic) {
    await deleteMembership(node, cfg, "cluster", prevTopic, slug);
  }

  if (series && day) {
    await upsertMembership(node, cfg, "eph", ephHash(series, day), slug, rec);
    await deleteMembership(node, cfg, "live", type, slug);
  }
  if (
    prevSeries &&
    prevDay &&
    (prevSeries !== series || prevDay !== day)
  ) {
    await deleteMembership(node, cfg, "eph", ephHash(prevSeries, prevDay), slug);
  }
}
