// Build one Fold mutation batch for a Brain record write: primary row plus
// every exact projection. Search stays out of the default plan.

import { backlinkIndexTag, backlinkTargetSlugs } from "./backlink-index.ts";
import {
  assertOpsFitAtomBudget,
  sealRecordFields,
  storedFieldsOf,
  type SpilledField,
} from "./body-spill.ts";
import {
  FbrainError,
  type BatchMutationResult,
  type NodeClient,
} from "./client.ts";
import type { Config } from "./config.ts";
import { GRAPH_EDGE_RECONCILE_FIELDS, type RecordType } from "./schemas.ts";
import {
  edgeFields,
  edgeRange,
  graphEdgeHashes,
  normalizeGraphEdgeType,
  type GraphEdge,
} from "./graph-edge.ts";
import {
  adjustListCounts,
  commitHeadPages,
  commitKeywordHeads,
  COUNT_UNCONFIRMED,
  EDGE_CAP,
  INDEX_PARTIAL,
  planRecordListSide,
  recordGraphEdges,
  WRITE_BATCH_MAX,
  type DeferredTokenSet,
  type HeadCommit,
  type ListSidePlan,
} from "./list-page.ts";
import { normalizeSlug, type FbrainRecord } from "./record.ts";

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
  | "token-set"
  | "keyword";

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
  keywordHeads: HeadCommit[];
  tokenSet: DeferredTokenSet | null;
  indexNotes: string[];
  /** 1 on create. An update does not change the count. */
  countDelta: 0 | 1;
  cfg: Config;
  /** Replan related records sequentially after their shared primary batch. */
  listSideInput: Parameters<typeof planRecordListSide>[0];
};

export type ResidentCommitResult = BatchMutationResult & {
  indexNotes: string[];
};

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

async function readCurrentGraphEdges(opts: {
  node: NodeClient;
  cfg: Config;
  sourceSlug: string;
  ids: readonly string[];
}): Promise<{ ids: Set<string>; edges: GraphEdge[] }> {
  const hashes = graphEdgeHashes(opts.cfg);
  const ids = new Set([...new Set(opts.ids)].slice(0, EDGE_CAP * 2));
  if (!hashes || ids.size === 0) return { ids: new Set(), edges: [] };
  const src = normalizeSlug(opts.sourceSlug).toLowerCase();
  const keys = [...ids].map((range) => ({ hash: src, range }));
  const fields = [...GRAPH_EDGE_RECONCILE_FIELDS];
  const rows = opts.node.queryByKeys
    ? await opts.node.queryByKeys({ schemaHash: hashes.out, fields, keys })
    : (await opts.node.queryAll({
      schemaHash: hashes.out, fields,
      filter: { HashRangeKeys: keys.map((key) => [key.hash, key.range]) },
    })).results;
  const edges: GraphEdge[] = [];
  for (const row of rows) {
    const field = row.fields;
    // Some nodes return the inbound sibling from the shared graph fields.
    if (typeof field.bge_src === "string" && field.bge_src.length > 0 && field.bge_src !== src) continue;
    const rawType = field.bge_type;
    const provenance = field.bge_provenance;
    if (field.bge_src !== src || typeof field.bge_dst !== "string" ||
        typeof rawType !== "string" || normalizeGraphEdgeType(rawType) !== rawType ||
        (provenance !== "explicit" && provenance !== "wikilink" && provenance !== "frontmatter")) {
      throw new FbrainError({ code: "graph_edge_invalid", message: `Cannot update malformed graph edges for ${src}.` });
    }
    const edge: GraphEdge = {
      src, dst: field.bge_dst, type: normalizeGraphEdgeType(rawType), provenance,
      created_at: typeof field.bge_created_at === "string" ? field.bge_created_at : "",
    };
    if (ids.has(edgeRange(edge))) edges.push(edge);
  }
  return { ids, edges };
}

function planChildTaskOps(opts: {
  cfg: Pick<Config, "schemaHashes">;
  type: RecordType;
  record: FbrainRecord;
  previous: FbrainRecord | null;
  upsertType: "create" | "update";
}): PlannedMutation[] {
  // Page atoms replaced this payload.
  void opts;
  return [];
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
  // Page atoms replaced this payload.
  void opts;
  return { ops: [], noOp: 0 };
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
  const preserveStoredEdges = opts.preserveStoredEdges ?? (
    opts.previous !== null && opts.frontmatterEdges === undefined && opts.next.body === opts.previous.body
  );
  const bodyDesired = recordGraphEdges(opts.type, opts.next, opts.frontmatterEdges, now);
  const desiredForPages =
    preserveStoredEdges || bodyDesired.length <= EDGE_CAP
      ? bodyDesired
      : bodyDesired.slice(0, EDGE_CAP);
  if (!preserveStoredEdges && bodyDesired.length > EDGE_CAP) {
    noteIndexPartial(indexNotes, "edge cap");
  }
  const listSideInput: Parameters<typeof planRecordListSide>[0] = {
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    previous: opts.previous,
    next: opts.next,
    sealedBody: stored.body,
    nextEdges: desiredForPages,
    frontmatterEdges: opts.frontmatterEdges,
    preserveStoredEdges,
  };
  const side = await planRecordListSide(listSideInput);
  for (const line of side.details) {
    if (!indexNotes.includes(line)) indexNotes.push(line);
  }
  for (const op of side.ops) ops.push(op);

  let graphDesired = desiredForPages;
  let graphPrevious = opts.previous ? recordGraphEdges(opts.type, opts.previous, [], now) : [];
  const knownPreviousIds = new Set(graphPrevious.map(edgeRange));
  graphPrevious.push(...edgesFromIds(
    opts.next.slug, side.previousEdgeIds.filter((id) => !knownPreviousIds.has(id)), now,
  ));
  if (preserveStoredEdges || side.preservedEdgeIds.length > 0) {
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
  // A prior metadata-only update can change an edge's provenance without
  // changing its id. Compare the actual keyed graph fields before a no-op.
  const currentGraph = await readCurrentGraphEdges({
    node: opts.node, cfg: opts.cfg, sourceSlug: opts.next.slug,
    ids: [...side.previousEdgeIds, ...graphDesired.map(edgeRange)],
  });
  graphPrevious = [
    ...graphPrevious.filter((edge) => !currentGraph.ids.has(edgeRange(edge))),
    ...currentGraph.edges,
  ];
  const graph = planGraphOps({
    cfg: opts.cfg,
    sourceSlug: opts.next.slug,
    previousEdges: graphPrevious,
    desiredEdges: graphDesired,
  });
  if (graph.partial) noteIndexPartial(indexNotes, "edge cap");
  ops.push(...graph.ops);

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
    keywordHeads: side.keywordHeads,
    tokenSet: side.tokenSet,
    indexNotes,
    countDelta: action === "created" ? 1 : 0,
    cfg: opts.cfg,
    listSideInput,
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
  return commitResidentWritePlans({
    node: opts.node,
    writes: [{ plan: opts.plan, type: opts.type, slug: opts.slug }],
    durable: opts.durable,
    failOnIndexPartial: opts.failOnIndexPartial,
  });
}

/** Related records share their primary batch (for example a papercut twin). */
export async function commitResidentWritePlans(opts: {
  node: NodeClient;
  writes: readonly { plan: ResidentWritePlan; type: RecordType; slug: string }[];
  durable?: boolean;
  failOnIndexPartial?: boolean;
}): Promise<ResidentCommitResult> {
  const first = opts.writes[0];
  if (!first) return { ...emptyBatchResult(), indexNotes: [] };
  for (const write of opts.writes) assertOpsFitAtomBudget(write.type, write.slug, write.plan.ops);
  if (!opts.node.mutateBatch) {
    throw new FbrainError({
      code: "resident_commit_unavailable",
      message: "this node client cannot send a Fold resident batch",
      hint: "Upgrade brain so NodeClient.mutateBatch is present.",
    });
  }
  const notes = [...new Set(opts.writes.flatMap((write) => write.plan.indexNotes))];
  const related = opts.writes.length > 1;
  const isListSide = (op: PlannedMutation): boolean => [
    "list-page", "list-locator", "directory", "edge-set", "token-set", "keyword",
  ].includes(op.projection);
  const allOps = dedupeOps(opts.writes.flatMap((write) =>
    related ? write.plan.ops.filter((op) => !isListSide(op)) : write.plan.ops,
  ));
  // Put every primary first, so a projection cap cannot split the record pair.
  const ops = [...allOps.filter((op) => op.projection === "primary"),
    ...allOps.filter((op) => op.projection !== "primary")];
  if (ops.filter((op) => op.projection === "primary").length > WRITE_BATCH_MAX) {
    throw new FbrainError({ code: "resident_batch_too_large", message: "Related records exceed one primary batch." });
  }
  const split = splitResidentBatches(ops, 0);
  if (split.trimmed) noteIndexPartial(notes, "batch cap");
  if (opts.failOnIndexPartial && notes.includes(INDEX_PARTIAL)) {
    throw indexPartialMiss(first.type, first.slug, notes);
  }
  const durable = opts.durable ? { durability: "durable" as const } : undefined;
  let primary = emptyBatchResult();
  try {
    if (split.batch1.length > 0) {
      primary = await opts.node.mutateBatch(split.batch1, durable);
      if (opts.durable && primary.durability !== "durable") {
        throw durableMiss(first.type, first.slug, primary.durability);
      }
    }
  } catch (err) {
    throw wrapCommitError(err, first.type, first.slug, ops);
  }
  if (split.batch2.length > 0) {
    try {
      const second = await opts.node.mutateBatch(split.batch2, durable);
      if (opts.durable && second.durability !== "durable") {
        throw durableMiss(first.type, first.slug, second.durability);
      }
      if (split.batch1.length === 0) primary = second;
    } catch (err) {
      if (
        opts.durable ||
        (err instanceof FbrainError && err.code === "durability_not_confirmed")
      ) {
        throw wrapCommitError(err, first.type, first.slug, ops);
      }
      noteIndexPartial(notes, "batch2 failed");
    }
  }
  // Keyword heads ack before the token set changes, so a lost head keeps its old token.
  for (const write of opts.writes) {
    // Both primaries already exist. Refresh one record's side only after the
    // previous side ack, so related writes do not compete for the same head.
    const side = related ? await planRecordListSide(write.plan.listSideInput) : null;
    if (side) {
      for (const line of side.details) if (!notes.includes(line)) notes.push(line);
      if (side.ops.length > WRITE_BATCH_MAX) {
        noteIndexPartial(notes, "batch cap");
      } else if (side.ops.length > 0) {
        const receipt = await opts.node.mutateBatch(side.ops, durable);
        if (opts.durable && receipt.durability !== "durable") {
          throw durableMiss(write.type, write.slug, receipt.durability);
        }
      }
    }
    const keywordNotes = await commitKeywordHeads(
      opts.node, side ? side.keywordHeads : write.plan.keywordHeads,
      side ? side.tokenSet : write.plan.tokenSet,
    );
    for (const line of keywordNotes) if (!notes.includes(line)) notes.push(line);
    const headNotes = await commitHeadPages(opts.node, side?.heads ?? write.plan.heads);
    for (const line of headNotes) if (!notes.includes(line)) notes.push(line);
  }
  for (const write of opts.writes) {
    if (write.plan.countDelta === 0) continue;
    const count = await adjustListCounts(
      opts.node,
      write.plan.cfg,
      write.type,
      write.plan.countDelta,
    );
    if (count === "unconfirmed" && !notes.includes(COUNT_UNCONFIRMED)) {
      notes.push(COUNT_UNCONFIRMED);
    }
  }
  if (opts.failOnIndexPartial && notes.includes(INDEX_PARTIAL)) {
    throw indexPartialMiss(first.type, first.slug, notes);
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
  /** The delete command can prove page membership before the primary delete. */
  side?: ListSidePlan;
}): Promise<ResidentCommitResult> {
  const side = opts.side ?? await planRecordListSide({
    node: opts.node,
    cfg: opts.cfg,
    type: opts.type,
    previous: opts.record,
    next: null,
    nextEdges: [],
  });
  const notes = [...side.details];
  let rest = side.ops.filter((op) => op.projection !== "keyword");
  if (rest.length > WRITE_BATCH_MAX) {
    rest = rest.slice(0, WRITE_BATCH_MAX);
    noteIndexPartial(notes, "batch cap");
  }
  let primary = emptyBatchResult();
  if (!opts.node.mutateBatch && rest.length > 0) {
    noteIndexPartial(notes, "batch unavailable");
  } else if (opts.node.mutateBatch && rest.length > 0) {
    try {
      primary = await opts.node.mutateBatch(rest);
    } catch {
      noteIndexPartial(notes, "batch1 failed");
    }
  }
  const keywordNotes = await commitKeywordHeads(opts.node, side.keywordHeads, side.tokenSet);
  for (const line of keywordNotes) {
    if (!notes.includes(line)) notes.push(line);
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
  return op.projection === "keyword" || op.projection === "graph";
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
