// Build one Fold mutation batch for a Brain record write: primary row plus
// every exact projection. Search stays out of the default plan.

import { backlinkIndexTag, backlinkTargetSlugs } from "./backlink-index.ts";
import {
  assertOpsFitAtomBudget,
  sealRecordFields,
  storedFieldsOf,
  type SpilledField,
} from "./body-spill.ts";
import { indexPayload } from "./index-payload.ts";
import {
  FbrainError,
  type BatchMutationResult,
  type NodeClient,
} from "./client.ts";
import type { Config } from "./config.ts";
import {
  CHILD_TASK_INDEX_MARKER,
  CHILD_TASK_INDEX_SCHEMA_KEY,
  type RecordType,
} from "./schemas.ts";
import {
  edgeFields,
  edgeRange,
  extractGraphEdges,
  graphEdgeHashes,
  normalizeGraphEdgeType,
  type GraphEdge,
} from "./graph-edge.ts";
import { planLifecycleMembershipOps } from "./lifecycle-index.ts";
import {
  adjustListCounts,
  commitHeadPages,
  COUNT_UNCONFIRMED,
  EDGE_CAP,
  INDEX_PARTIAL,
  planRecordListSide,
  WRITE_BATCH_MAX,
  type HeadCommit,
} from "./list-page.ts";
import { normalizeSlug, TOMBSTONE_TAG, type FbrainRecord } from "./record.ts";
import {
  memberKey,
  planTagMemberOps,
  tagIndexAvailable,
  type TagMemberChange,
} from "./tag-index.ts";

export type ProjectionKind =
  | "primary"
  | "list"
  | "lifecycle"
  | "tag"
  | "backlink"
  | "graph"
  | "child-task"
  | "papercut-status"
  | "list-page"
  | "list-locator"
  | "directory"
  | "edge-set"
  | "token-set";

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
  /** Long text fields that went to a body file for this write. */
  spilled: SpilledField[];
  heads: HeadCommit[];
  indexNotes: string[];
  /** 1 on create. An update does not change the count. */
  countDelta: 0 | 1;
  cfg: Config;
};

export type ResidentCommitResult = BatchMutationResult & {
  indexNotes: string[];
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

function planGraphOps(opts: {
  cfg: Pick<Config, "schemaHashes">;
  sourceSlug: string;
  previousEdges: readonly GraphEdge[];
  desiredEdges: readonly GraphEdge[];
}): { ops: PlannedMutation[]; partial: boolean } {
  const hashes = graphEdgeHashes(opts.cfg);
  if (!hashes) return { ops: [], partial: false };
  const src = normalizeSlug(opts.sourceSlug).toLowerCase();
  const current = new Map(opts.previousEdges.map((edge) => [edgeRange(edge), edge]));
  const wanted = new Map(opts.desiredEdges.map((edge) => [edgeRange(edge), edge]));
  const deletes: PlannedMutation[] = [];
  const writes: PlannedMutation[] = [];
  for (const [range] of current) {
    if (wanted.has(range)) continue;
    deletes.push({
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
    writes.push({
      mutationType: old ? "update" : "create",
      schemaHash: hashes.out,
      keyHash: edge.src,
      keyRange: range,
      fields,
      projection: "graph",
    });
  }
  const partial = deletes.length > EDGE_CAP;
  return { ops: [...deletes.slice(0, EDGE_CAP), ...writes], partial };
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
        ctd_payload: indexPayload(opts.record),
        ctd_marker: CHILD_TASK_INDEX_MARKER,
      },
      projection: "child-task",
    });
  }
  return ops;
}

// Tag and backlink membership. One small create per added member and one
// delete per removed member of an indexed tag, in the same batch as the record.
// Never a read-modify-write of a member list (see tag-index.ts).
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
  const member = memberKey(opts.type, opts.slug);
  const oldSet = new Set(userTags(opts.oldTags));
  const newSet = new Set(userTags(opts.newTags));
  const changes: TagMemberChange[] = [
    ...[...newSet]
      .filter((tag) => !oldSet.has(tag))
      .map((tag): TagMemberChange => ({ tag, member, op: "add" })),
    ...[...oldSet]
      .filter((tag) => !newSet.has(tag))
      .map((tag): TagMemberChange => ({ tag, member, op: "remove" })),
  ];
  const planned = await planTagMemberOps(opts.node, opts.cfg, changes);
  return {
    ops: planned.ops.map((op) => ({ ...op, projection: opts.projection })),
    noOp: planned.noOp,
  };
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
  verbose?: (msg: string) => void;
  /** Keep edge-set ids that are absent from the body. Append uses this. */
  preserveStoredEdges?: boolean;
}): Promise<ResidentWritePlan> {
  const action: "created" | "updated" = opts.previous ? "updated" : "created";
  const upsertType: "create" | "update" = action === "created" ? "create" : "update";
  const now = opts.now ?? opts.next.updated_at;
  const ops: PlannedMutation[] = [];
  let noOp = 0;

  // Blob and sidecar land before the record. `next` stays the full text so
  // graph edges and backlinks see the whole body. Index copies use the head.
  const sealed = await sealRecordFields({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    slug: opts.next.slug,
    fields: opts.primaryFields,
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });
  const stored = recordFromPrimaryFields(sealed.fields);
  const previousStored = opts.previous ? storedFieldsOf(opts.previous) : null;

  if (
    previousStored &&
    sameStringRecord(sealed.fields, {
      slug: previousStored.slug,
      title: previousStored.title,
      body: previousStored.body,
      status: previousStored.status,
      tags: previousStored.tags,
      created_at: previousStored.created_at,
      updated_at: previousStored.updated_at,
      ...(previousStored.design_slug !== undefined
        ? { design_slug: previousStored.design_slug }
        : {}),
    })
  ) {
    noOp += 1;
  } else {
    ops.push({
      mutationType: upsertType,
      schemaHash: opts.schemaHash,
      keyHash: opts.next.slug,
      fields: sealed.fields,
      projection: "primary",
    });
  }

  const indexNotes: string[] = [];
  const bodyDesired = extractGraphEdges({
    sourceSlug: opts.next.slug,
    body: opts.next.body,
    frontmatterEdges: opts.frontmatterEdges ?? [],
    now,
  });
  const desiredForPages =
    opts.preserveStoredEdges || bodyDesired.length <= EDGE_CAP
      ? bodyDesired
      : bodyDesired.slice(0, EDGE_CAP);
  if (!opts.preserveStoredEdges && bodyDesired.length > EDGE_CAP) {
    noteIndexPartial(indexNotes, "edge cap");
  }
  const side = await planRecordListSide({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    previous: opts.previous,
    next: opts.next,
    nextEdges: desiredForPages,
    preserveStoredEdges: opts.preserveStoredEdges === true,
  });
  for (const line of side.details) {
    if (!indexNotes.includes(line)) indexNotes.push(line);
  }
  for (const op of side.ops) ops.push(op);

  let graphDesired = desiredForPages;
  let graphPrevious = opts.previous
    ? extractGraphEdges({
        sourceSlug: opts.next.slug,
        body: opts.previous.body,
        now,
      })
    : [];
  if (opts.preserveStoredEdges) {
    const kept = new Set(side.writtenEdgeIds);
    const prevIds = new Set(graphPrevious.map((edge) => edgeRange(edge)));
    graphDesired = [
      ...bodyDesired.filter((edge) => kept.has(edgeRange(edge))),
      ...edgesFromIds(opts.next.slug, side.preservedEdgeIds, now),
    ];
    graphPrevious = [
      ...graphPrevious,
      ...edgesFromIds(
        opts.next.slug,
        side.preservedEdgeIds.filter((id) => !prevIds.has(id)),
        now,
      ),
    ];
  }
  const graph = planGraphOps({
    cfg: opts.cfg,
    sourceSlug: opts.next.slug,
    previousEdges: graphPrevious,
    desiredEdges: graphDesired,
  });
  if (graph.partial) noteIndexPartial(indexNotes, "edge cap");
  ops.push(...graph.ops);

  for (const op of planLifecycleMembershipOps({
    cfg: opts.cfg,
    type: opts.type,
    slug: opts.next.slug,
    record: stored,
    previous: opts.previous,
    upsertType,
  })) {
    ops.push({ ...op, projection: "lifecycle" });
  }
  ops.push(
    ...planChildTaskOps({
      cfg: opts.cfg,
      type: opts.type,
      record: stored,
      previous: opts.previous,
      upsertType,
    }),
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
  return {
    action,
    ops: unique,
    counts,
    spilled: sealed.spilled,
    heads: side.heads,
    indexNotes,
    countDelta: action === "created" ? 1 : 0,
    cfg: opts.cfg,
  };
}

export async function commitResidentWritePlan(opts: {
  node: NodeClient;
  plan: ResidentWritePlan;
  type: RecordType;
  slug: string;
  durable?: boolean;
  /** Papercut file and close refuse a short or partial index. Do not send. */
  failOnIndexPartial?: boolean;
}): Promise<ResidentCommitResult> {
  // Name the field here. A later 413 from the node does not.
  assertOpsFitAtomBudget(opts.type, opts.slug, opts.plan.ops);
  if (!opts.node.mutateBatch) {
    throw new FbrainError({
      code: "resident_commit_unavailable",
      message: "this node client cannot send a Fold resident batch",
      hint: "Upgrade brain so NodeClient.mutateBatch is present.",
    });
  }
  const notes = [...opts.plan.indexNotes];
  const split = splitResidentBatches(opts.plan.ops, opts.plan.heads.length);
  if (split.trimmed) noteIndexPartial(notes, "batch cap");
  if (opts.failOnIndexPartial && notes.includes(INDEX_PARTIAL)) {
    throw indexPartialMiss(opts.type, opts.slug, notes);
  }
  const durable = opts.durable ? { durability: "durable" as const } : undefined;
  let primary = emptyBatchResult();
  try {
    if (split.batch1.length > 0) {
      primary = await opts.node.mutateBatch(split.batch1, durable);
      if (opts.durable && primary.durability !== "durable") {
        throw durableMiss(opts.type, opts.slug, primary.durability);
      }
    }
  } catch (err) {
    throw wrapCommitError(err, opts.type, opts.slug, opts.plan.ops);
  }
  if (split.batch2.length > 0) {
    try {
      const second = await opts.node.mutateBatch(split.batch2, durable);
      if (opts.durable && second.durability !== "durable") {
        throw durableMiss(opts.type, opts.slug, second.durability);
      }
      if (split.batch1.length === 0) primary = second;
    } catch (err) {
      if (
        opts.durable ||
        (err instanceof FbrainError && err.code === "durability_not_confirmed")
      ) {
        throw wrapCommitError(err, opts.type, opts.slug, opts.plan.ops);
      }
      noteIndexPartial(notes, "batch2 failed");
    }
  }
  const headNotes = await commitHeadPages(opts.node, opts.plan.heads);
  for (const line of headNotes) {
    if (!notes.includes(line)) notes.push(line);
  }
  if (opts.plan.countDelta !== 0) {
    const count = await adjustListCounts(
      opts.node,
      opts.plan.cfg,
      opts.type,
      opts.plan.countDelta,
    );
    if (count === "unconfirmed" && !notes.includes(COUNT_UNCONFIRMED)) {
      notes.push(COUNT_UNCONFIRMED);
    }
  }
  if (opts.failOnIndexPartial && notes.includes(INDEX_PARTIAL)) {
    throw indexPartialMiss(opts.type, opts.slug, notes);
  }
  return {
    ...primary,
    indexNotes: notes,
  };
}

export async function removeResidentListSide(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  record: FbrainRecord;
}): Promise<ResidentCommitResult> {
  const side = await planRecordListSide({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    previous: opts.record,
    next: null,
    nextEdges: [],
  });
  const notes = [...side.details];
  let ops = side.ops;
  if (ops.length > WRITE_BATCH_MAX) {
    ops = ops.slice(0, WRITE_BATCH_MAX);
    noteIndexPartial(notes, "batch cap");
  }
  let primary = emptyBatchResult();
  if (ops.length > 0) {
    if (!opts.node.mutateBatch) {
      noteIndexPartial(notes, "batch unavailable");
    } else {
      try {
        primary = await opts.node.mutateBatch(ops);
      } catch {
        noteIndexPartial(notes, "batch1 failed");
      }
    }
  }
  const headNotes = await commitHeadPages(opts.node, side.heads);
  for (const line of headNotes) {
    if (!notes.includes(line)) notes.push(line);
  }
  const count = await adjustListCounts(opts.node, opts.cfg, opts.type, -1);
  if (count === "unconfirmed" && !notes.includes(COUNT_UNCONFIRMED)) {
    notes.push(COUNT_UNCONFIRMED);
  }
  return {
    ...primary,
    indexNotes: notes,
  };
}

function emptyBatchResult(): BatchMutationResult {
  return {
    mutationIds: [],
    count: 0,
    backgroundTasksDrained: true,
    convergencePending: false,
  };
}

function indexPartialMiss(
  type: RecordType,
  slug: string,
  notes: readonly string[],
): FbrainError {
  const why = notes.filter((line) => line.length > 0 && line !== INDEX_PARTIAL);
  return new FbrainError({
    code: "index_partial",
    message:
      `index partial for ${type} ${slug}` +
      (why.length > 0 ? ` (${why.join(", ")})` : ""),
    hint: "The command does not report success. Read the record before a manual retry.",
    agentHint:
      "Do not retry automatically. Read the record before a manual retry.",
  });
}

function durableMiss(
  type: RecordType,
  slug: string,
  reported: string | undefined,
): FbrainError {
  return new FbrainError({
    code: "durability_not_confirmed",
    message:
      `the node did not confirm durable storage for ${type} ${slug} ` +
      `(receipt: ${reported ?? "missing"})`,
    hint: "The resident batch can already exist. Read the record before a manual retry.",
    agentHint:
      "Do not retry automatically. Read the record and inspect node health before a manual retry.",
  });
}

function wrapCommitError(
  err: unknown,
  type: RecordType,
  slug: string,
  ops: readonly PlannedMutation[],
): FbrainError {
  if (err instanceof FbrainError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  const projections = [...new Set(ops.map((op) => op.projection))].join(", ");
  return new FbrainError({
    code: "resident_commit_failed",
    message:
      `resident commit failed for ${type} ${slug} ` +
      `(projections: ${projections || "none"}): ${detail}`,
    hint:
      "Retry the exact command. The resident batch commits the primary record and its exact projections as one operation.",
    agentHint:
      "Retry the exact command. Do not repair one projection separately from the primary record.",
    cause: err,
  });
}

function isBatch2(op: PlannedMutation): boolean {
  return op.projection === "lifecycle" || op.projection === "graph";
}

function splitResidentBatches(
  ops: readonly PlannedMutation[],
  headCount: number,
): { batch1: PlannedMutation[]; batch2: PlannedMutation[]; trimmed: boolean } {
  let batch1 = ops.filter((op) => !isBatch2(op));
  let batch2 = ops.filter((op) => isBatch2(op));
  let trimmed = false;
  const budget = Math.max(0, WRITE_BATCH_MAX - headCount);
  if (batch1.length > budget) {
    batch1 = batch1.slice(0, budget);
    trimmed = true;
  }
  if (batch2.length > WRITE_BATCH_MAX) {
    batch2 = batch2.slice(0, WRITE_BATCH_MAX);
    trimmed = true;
  }
  return { batch1, batch2, trimmed };
}

function noteIndexPartial(details: string[], why: string): void {
  if (!details.includes(INDEX_PARTIAL)) details.push(INDEX_PARTIAL);
  if (why.length > 0 && why !== INDEX_PARTIAL && !details.includes(why)) {
    details.push(why);
  }
}

function edgesFromIds(sourceSlug: string, ids: readonly string[], now: string): GraphEdge[] {
  const src = normalizeSlug(sourceSlug).toLowerCase();
  const edges: GraphEdge[] = [];
  for (const id of ids) {
    const cut = id.indexOf("#");
    if (cut <= 0) continue;
    const dst = id.slice(cut + 1);
    if (dst.length === 0) continue;
    edges.push({
      src,
      dst,
      type: normalizeGraphEdgeType(id.slice(0, cut)),
      provenance: "frontmatter",
      created_at: now,
    });
  }
  return edges;
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
