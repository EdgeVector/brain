// Build one Fold mutation batch for a Brain record write: primary row plus
// every exact projection. Search stays out of the default plan.

import { backlinkIndexTag, backlinkTargetSlugs } from "./backlink-index.ts";
import {
  FbrainError,
  type BatchMutationResult,
  type NodeClient,
} from "./client.ts";
import type { Config } from "./config.ts";
import {
  CHILD_TASK_INDEX_MARKER,
  CHILD_TASK_INDEX_SCHEMA_KEY,
  PAPERCUT_STATUS_INDEX_MARKER,
  type RecordType,
} from "./schemas.ts";
import {
  edgeFields,
  edgeRange,
  extractGraphEdges,
  graphEdgeHashes,
  type GraphEdge,
} from "./graph-edge.ts";
import { planLifecycleMembershipOps } from "./lifecycle-index.ts";
import { normalizeSlug, TOMBSTONE_TAG, type FbrainRecord } from "./record.ts";
import {
  entryFieldsFor,
  entryKeyFor,
  recordListEntryHash,
  typeListEntryExists,
} from "./record-list-index.ts";
import {
  papercutStatusEntryExists,
  papercutStatusIndexHash,
} from "./papercut-status-index.ts";
import {
  memberKey,
  readTagIndex,
  tagIndexAvailable,
  tagIndexSchemaHash,
  tagIndexSlug,
} from "./tag-index.ts";

export type ProjectionKind =
  | "primary"
  | "list"
  | "lifecycle"
  | "tag"
  | "backlink"
  | "graph"
  | "child-task"
  | "papercut-status";

export type PlannedMutation = {
  mutationType: "create" | "update" | "delete";
  schemaHash: string;
  keyHash: string;
  keyRange?: string;
  fields: Record<string, unknown>;
  projection: ProjectionKind;
};

export type ExactProjectionCounts = {
  created: number;
  updated: number;
  deleted: number;
  no_op: number;
};

export type ResidentWritePlan = {
  action: "created" | "updated";
  ops: PlannedMutation[];
  counts: ExactProjectionCounts;
};

function userTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.length > 0 && tag !== TOMBSTONE_TAG);
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  if (left.length !== right.length) return false;
  return left.every((value, i) => value === right[i]);
}

function sameStringRecord(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      const l = Array.isArray(left) ? left.map(String) : [];
      const r = Array.isArray(right) ? right.map(String) : [];
      if (!sameMembers(l, r)) return false;
      continue;
    }
    if (String(left ?? "") !== String(right ?? "")) return false;
  }
  return true;
}

function countOps(ops: PlannedMutation[]): ExactProjectionCounts {
  const counts: ExactProjectionCounts = {
    created: 0,
    updated: 0,
    deleted: 0,
    no_op: 0,
  };
  for (const op of ops) {
    if (op.mutationType === "create") counts.created += 1;
    else if (op.mutationType === "update") counts.updated += 1;
    else counts.deleted += 1;
  }
  return counts;
}

async function planListOp(opts: {
  node: NodeClient;
  cfg: Pick<Config, "schemaHashes">;
  type: RecordType;
  record: FbrainRecord;
}): Promise<PlannedMutation | null> {
  const schemaHash = recordListEntryHash(opts.cfg);
  if (!schemaHash) return null;
  const { hash, range } = entryKeyFor(opts.type, opts.record.slug);
  const exists = await typeListEntryExists(
    opts.node,
    schemaHash,
    opts.type,
    opts.record.slug,
  );
  return {
    mutationType: exists ? "update" : "create",
    schemaHash,
    keyHash: hash,
    keyRange: range,
    fields: entryFieldsFor(opts.type, opts.record),
    projection: "list",
  };
}

function planGraphOps(opts: {
  cfg: Pick<Config, "schemaHashes">;
  sourceSlug: string;
  previous: FbrainRecord | null;
  next: FbrainRecord;
  frontmatterEdges: readonly string[];
  now: string;
}): PlannedMutation[] {
  const hashes = graphEdgeHashes(opts.cfg);
  if (!hashes) return [];
  const src = normalizeSlug(opts.sourceSlug).toLowerCase();
  const previousEdges = opts.previous
    ? extractGraphEdges({
        sourceSlug: opts.sourceSlug,
        body: opts.previous.body,
        now: opts.now,
      })
    : [];
  const desired = extractGraphEdges({
    sourceSlug: opts.sourceSlug,
    body: opts.next.body,
    frontmatterEdges: opts.frontmatterEdges,
    now: opts.now,
  });
  const current = new Map(previousEdges.map((edge) => [edgeRange(edge), edge]));
  const wanted = new Map(desired.map((edge) => [edgeRange(edge), edge]));
  const ops: PlannedMutation[] = [];
  for (const [range] of current) {
    if (wanted.has(range)) continue;
    ops.push({
      mutationType: "delete",
      schemaHash: hashes.out,
      keyHash: src,
      keyRange: range,
      fields: {},
      projection: "graph",
    });
  }
  for (const [range, edge] of wanted) {
    const old = current.get(range);
    if (old && graphEdgeUnchanged(old, edge)) continue;
    const fields = edgeFields({
      ...edge,
      created_at: old?.created_at || edge.created_at,
    });
    ops.push({
      mutationType: old ? "update" : "create",
      schemaHash: hashes.out,
      keyHash: edge.src,
      keyRange: range,
      fields,
      projection: "graph",
    });
  }
  return ops;
}

function graphEdgeUnchanged(old: GraphEdge, next: GraphEdge): boolean {
  return (
    old.src === next.src &&
    old.dst === next.dst &&
    old.type === next.type &&
    old.provenance === next.provenance
  );
}

function planChildTaskOps(opts: {
  cfg: Pick<Config, "schemaHashes">;
  type: RecordType;
  record: FbrainRecord;
  previous: FbrainRecord | null;
  upsertType: "create" | "update";
}): PlannedMutation[] {
  if (opts.type !== "task") return [];
  const schemaHash = opts.cfg.schemaHashes[CHILD_TASK_INDEX_SCHEMA_KEY];
  if (!schemaHash) return [];
  const ops: PlannedMutation[] = [];
  const previousDesign = opts.previous?.design_slug ?? "";
  const nextDesign = opts.record.design_slug ?? "";
  if (previousDesign.length > 0 && previousDesign !== nextDesign) {
    ops.push({
      mutationType: "delete",
      schemaHash,
      keyHash: previousDesign,
      keyRange: opts.record.slug,
      fields: {},
      projection: "child-task",
    });
  }
  if (nextDesign.length > 0) {
    ops.push({
      mutationType: opts.upsertType,
      schemaHash,
      keyHash: nextDesign,
      keyRange: opts.record.slug,
      fields: {
        ctd_h: nextDesign,
        ctd_r: opts.record.slug,
        ctd_payload: JSON.stringify(opts.record),
        ctd_marker: CHILD_TASK_INDEX_MARKER,
      },
      projection: "child-task",
    });
  }
  return ops;
}

async function planPapercutStatusOps(opts: {
  node: NodeClient;
  cfg: Pick<Config, "schemaHashes">;
  type: RecordType;
  record: FbrainRecord;
  previous: FbrainRecord | null;
}): Promise<PlannedMutation[]> {
  if (opts.type !== "papercut") return [];
  const schemaHash = papercutStatusIndexHash(opts.cfg);
  if (!schemaHash) return [];
  const ops: PlannedMutation[] = [];
  const previousStatus = opts.previous?.status ?? "";
  const nextStatus = opts.record.status ?? "";
  if (previousStatus.length > 0 && previousStatus !== nextStatus) {
    ops.push({
      mutationType: "delete",
      schemaHash,
      keyHash: previousStatus,
      keyRange: opts.record.slug,
      fields: {},
      projection: "papercut-status",
    });
  }
  if (nextStatus.length > 0) {
    const exists = await papercutStatusEntryExists(
      opts.node,
      schemaHash,
      nextStatus,
      opts.record.slug,
    );
    ops.push({
      mutationType: exists ? "update" : "create",
      schemaHash,
      keyHash: nextStatus,
      keyRange: opts.record.slug,
      fields: {
        psi_h: nextStatus,
        psi_r: opts.record.slug,
        psi_payload: JSON.stringify(opts.record),
        psi_marker: PAPERCUT_STATUS_INDEX_MARKER,
      },
      projection: "papercut-status",
    });
  }
  return ops;
}

async function planTagMembershipOps(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  slug: string;
  oldTags: readonly string[];
  newTags: readonly string[];
  projection: "tag" | "backlink";
}): Promise<{ ops: PlannedMutation[]; noOp: number }> {
  if (!tagIndexAvailable(opts.cfg)) return { ops: [], noOp: 0 };
  const schemaHash = tagIndexSchemaHash(opts.cfg);
  if (!schemaHash) return { ops: [], noOp: 0 };
  const member = memberKey(opts.type, opts.slug);
  const oldSet = new Set(userTags(opts.oldTags));
  const newSet = new Set(userTags(opts.newTags));
  const added = [...newSet].filter((tag) => !oldSet.has(tag));
  const removed = [...oldSet].filter((tag) => !newSet.has(tag));
  const touched = [...new Set([...added, ...removed])];
  const ops: PlannedMutation[] = [];
  let noOp = 0;
  for (const tag of touched) {
    const existing = await readTagIndex(opts.node, opts.cfg, tag);
    const current = existing?.members ?? [];
    let next: string[];
    if (added.includes(tag)) {
      next = current.includes(member) ? current : [...current, member];
    } else {
      next = current.filter((entry) => entry !== member);
    }
    if (sameMembers(current, next)) {
      noOp += 1;
      continue;
    }
    const now = new Date().toISOString();
    const slug = tagIndexSlug(tag);
    const fields = {
      slug,
      tag,
      members: [...new Set(next)].sort(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    ops.push({
      mutationType: existing ? "update" : "create",
      schemaHash,
      keyHash: slug,
      fields,
      projection: opts.projection,
    });
  }
  return { ops, noOp };
}

export async function buildResidentWritePlan(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  schemaHash: string;
  previous: FbrainRecord | null;
  next: FbrainRecord;
  primaryFields: Record<string, unknown>;
  frontmatterEdges?: readonly string[];
  now?: string;
}): Promise<ResidentWritePlan> {
  const action: "created" | "updated" = opts.previous ? "updated" : "created";
  const upsertType: "create" | "update" = action === "created" ? "create" : "update";
  const now = opts.now ?? opts.next.updated_at;
  const ops: PlannedMutation[] = [];
  let noOp = 0;

  if (
    opts.previous &&
    sameStringRecord(opts.primaryFields, {
      slug: opts.previous.slug,
      title: opts.previous.title,
      body: opts.previous.body,
      status: opts.previous.status,
      tags: opts.previous.tags,
      created_at: opts.previous.created_at,
      updated_at: opts.previous.updated_at,
      ...(opts.previous.design_slug !== undefined
        ? { design_slug: opts.previous.design_slug }
        : {}),
    })
  ) {
    noOp += 1;
  } else {
    ops.push({
      mutationType: upsertType,
      schemaHash: opts.schemaHash,
      keyHash: opts.next.slug,
      fields: opts.primaryFields,
      projection: "primary",
    });
  }

  const listOp = await planListOp({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    record: opts.next,
  });
  if (listOp) ops.push(listOp);

  for (const op of planLifecycleMembershipOps({
    cfg: opts.cfg,
    type: opts.type,
    slug: opts.next.slug,
    record: opts.next,
    previous: opts.previous,
    upsertType,
  })) {
    ops.push({ ...op, projection: "lifecycle" });
  }

  ops.push(
    ...planGraphOps({
      cfg: opts.cfg,
      sourceSlug: opts.next.slug,
      previous: opts.previous,
      next: opts.next,
      frontmatterEdges: opts.frontmatterEdges ?? [],
      now,
    }),
  );
  ops.push(
    ...planChildTaskOps({
      cfg: opts.cfg,
      type: opts.type,
      record: opts.next,
      previous: opts.previous,
      upsertType,
    }),
  );
  ops.push(
    ...(await planPapercutStatusOps({
      node: opts.node,
      cfg: opts.cfg,
      type: opts.type,
      record: opts.next,
      previous: opts.previous,
    })),
  );

  const tags = await planTagMembershipOps({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    slug: opts.next.slug,
    oldTags: opts.previous?.tags ?? [],
    newTags: opts.next.tags,
    projection: "tag",
  });
  ops.push(...tags.ops);
  noOp += tags.noOp;

  const backlinks = await planTagMembershipOps({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    slug: opts.next.slug,
    oldTags: (opts.previous
      ? backlinkTargetSlugs(opts.previous, opts.type)
      : []
    ).map((target) => backlinkIndexTag(target)),
    newTags: backlinkTargetSlugs(opts.next, opts.type).map((target) =>
      backlinkIndexTag(target),
    ),
    projection: "backlink",
  });
  ops.push(...backlinks.ops);
  noOp += backlinks.noOp;

  const unique = dedupeOps(ops);
  const counts = countOps(unique);
  counts.no_op = noOp;
  return { action, ops: unique, counts };
}

export async function commitResidentWritePlan(opts: {
  node: NodeClient;
  plan: ResidentWritePlan;
  type: RecordType;
  slug: string;
}): Promise<BatchMutationResult> {
  if (!opts.node.mutateBatch) {
    throw new FbrainError({
      code: "resident_commit_unavailable",
      message: "this node client cannot send a Fold resident batch",
      hint: "Upgrade brain so NodeClient.mutateBatch is present.",
    });
  }
  try {
    return await opts.node.mutateBatch(opts.plan.ops);
  } catch (err) {
    // Preserve typed transport and consent errors. Callers use their codes for
    // recovery, including the MCP cold-capability self-warm path.
    if (err instanceof FbrainError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    const projections = [
      ...new Set(opts.plan.ops.map((op) => op.projection)),
    ].join(", ");
    throw new FbrainError({
      code: "resident_commit_failed",
      message:
        `resident commit failed for ${opts.type} ${opts.slug} ` +
        `(projections: ${projections || "none"}): ${detail}`,
      hint:
        "Retry the exact command. The resident batch commits the primary record and its exact projections as one operation.",
      agentHint:
        "Retry the exact command. Do not repair one projection separately from the primary record.",
      cause: err,
    });
  }
}

function dedupeOps(ops: PlannedMutation[]): PlannedMutation[] {
  const index = new Map<string, number>();
  const out: PlannedMutation[] = [];
  for (const op of ops) {
    const id = `${op.schemaHash}\0${op.keyHash}\0${op.keyRange ?? ""}`;
    const prev = index.get(id);
    if (prev !== undefined) {
      out[prev] = op;
      continue;
    }
    index.set(id, out.length);
    out.push(op);
  }
  return out;
}

export function recordFromPrimaryFields(
  fields: Record<string, unknown>,
): FbrainRecord {
  const tags = Array.isArray(fields.tags)
    ? fields.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const record: FbrainRecord = {
    slug: String(fields.slug ?? ""),
    title: String(fields.title ?? ""),
    body: String(fields.body ?? ""),
    status: String(fields.status ?? ""),
    tags,
    created_at: String(fields.created_at ?? ""),
    updated_at: String(fields.updated_at ?? ""),
  };
  if (typeof fields.design_slug === "string") {
    record.design_slug = fields.design_slug;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key in record) continue;
    if (typeof value === "string") record[key] = value;
  }
  return record;
}
