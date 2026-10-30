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
  BrainError,
  type BatchMutationResult,
  type NodeClient,
  type QueryRow,
} from "./client.ts";
import type { Config } from "./config.ts";
import { countAfterDelta, parseListCount } from "./count-state.ts";
import { BRAIN_LIST_COUNT_SCHEMA_KEY, type RecordType } from "./schemas.ts";
import {
  COUNT_UNCONFIRMED,
  DIRECTORY_RANGE,
  EDGE_CAP,
  HEAD_RANGE,
  INDEX_PARTIAL,
  mergeHeadCommits,
  planRecordListSide,
  recordGraphEdges,
  WRITE_BATCH_MAX,
  type DeferredTokenSet,
  type HeadCommit,
  type ListSidePlan,
} from "./list-page.ts";
import { schemaHashFor, type BrainRecord } from "./record.ts";

export type ProjectionKind =
  | "primary"
  | "list"
  | "lifecycle"
  | "tag"
  | "backlink"
  | "graph"
  | "child-task"
  | "list-page"
  | "list-locator"
  | "directory"
  | "edge-set"
  | "token-set"
  | "keyword"
  | "count";

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

function planChildTaskOps(opts: {
  cfg: Pick<Config, "schemaHashes">;
  type: RecordType;
  record: BrainRecord;
  previous: BrainRecord | null;
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
  previous: BrainRecord | null;
  next: BrainRecord;
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

/** Related records share one mutation call (for example a papercut twin). */
export async function commitResidentWritePlans(opts: {
  node: NodeClient;
  writes: readonly { plan: ResidentWritePlan; type: RecordType; slug: string }[];
  durable?: boolean;
  failOnIndexPartial?: boolean;
  /** A papercut close with no twin is one write. Replay its keyword heads. */
  replayKeywords?: boolean;
}): Promise<ResidentCommitResult> {
  const first = opts.writes[0];
  if (!first) return { ...emptyBatchResult(), indexNotes: [] };
  for (const write of opts.writes) assertOpsFitAtomBudget(write.type, write.slug, write.plan.ops);
  if (!opts.node.mutateBatch) {
    throw new BrainError({
      code: "resident_commit_unavailable",
      message: "this node client cannot send a Fold resident batch",
      hint: "Upgrade brain so NodeClient.mutateBatch is present.",
    });
  }
  const notes = [...new Set(opts.writes.flatMap((write) => write.plan.indexNotes))];
  const related = opts.writes.length > 1;
  const counts = await countMutations(opts.node, opts.writes.map((write) => ({
    cfg: write.plan.cfg,
    type: write.type,
    delta: write.plan.countDelta,
  })), notes);
  const ops = orderPrimaryFirst(assembleWriteOps(
    opts.writes,
    related,
    notes,
    opts.replayKeywords === true,
  ).concat(counts));
  assertOpsFitAtomBudget(first.type, first.slug, ops);
  if (ops.length > WRITE_BATCH_MAX) {
    throw new BrainError({
      code: "resident_batch_too_large",
      message: `resident batch has ${ops.length} mutations; the cap is ${WRITE_BATCH_MAX}.`,
      hint: "The command does not report success. The record was not written.",
    });
  }
  if (opts.failOnIndexPartial && notes.includes(INDEX_PARTIAL)) {
    throw indexPartialMiss(first.type, first.slug, notes);
  }
  const durable = opts.durable ? { durability: "durable" as const } : undefined;
  let primary = emptyBatchResult();
  try {
    if (ops.length > 0) {
      primary = await opts.node.mutateBatch(ops, durable);
      if (opts.durable && primary.durability !== "durable") {
        throw durableMiss(first.type, first.slug, primary.durability);
      }
    }
  } catch (err) {
    throw wrapCommitError(err, first.type, first.slug, ops);
  }
  return { ...primary, indexNotes: notes };
}

/**
 * Product tombstone and page changes in one mutation call.
 * The update stamps the tombstone fields. The delete hides the product key.
 * Those two ops share a key, so this list must not pass through dedupe:
 * dedupe would keep only the delete and drop the tombstone fields.
 * The node applies the update first and the delete after it.
 * A missing batch client or a failed call throws before any success line.
 */
export async function commitResidentRemoval(opts: {
  node: NodeClient;
  cfg: Config;
  type: RecordType;
  slug: string;
  tombstoneFields: Record<string, unknown>;
  side: ListSidePlan;
}): Promise<ResidentCommitResult> {
  if (!opts.node.mutateBatch) {
    throw new BrainError({
      code: "resident_commit_unavailable",
      message: "this node client cannot send a Fold resident batch",
      hint: "Upgrade brain so NodeClient.mutateBatch is present.",
    });
  }
  const notes = [...opts.side.details];
  const counts = await countMutations(opts.node, [{
    cfg: opts.cfg,
    type: opts.type,
    delta: -1,
  }], notes);
  const schemaHash = schemaHashFor(opts.type, opts.cfg);
  const pages = dedupeOps(assembleSide({
    ops: opts.side.ops,
    heads: opts.side.heads,
    keywordHeads: opts.side.keywordHeads,
    tokenSet: opts.side.tokenSet,
  }, false, notes).concat(counts));
  const ops = [
    {
      mutationType: "update" as const,
      schemaHash,
      keyHash: opts.slug,
      fields: opts.tombstoneFields,
      projection: "primary" as const,
    },
    {
      mutationType: "delete" as const,
      schemaHash,
      keyHash: opts.slug,
      fields: {},
      projection: "primary" as const,
    },
    ...pages,
  ];
  if (ops.length > WRITE_BATCH_MAX) {
    throw new BrainError({
      code: "resident_batch_too_large",
      message: `delete batch has ${ops.length} mutations; the cap is ${WRITE_BATCH_MAX}.`,
      hint: "The command does not report success. The record was not written.",
    });
  }
  try {
    const primary = await opts.node.mutateBatch(ops);
    return { ...primary, indexNotes: notes };
  } catch (err) {
    throw wrapCommitError(err, opts.type, opts.slug, ops);
  }
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
): BrainError {
  const why = notes.filter((line) => line.length > 0 && line !== INDEX_PARTIAL);
  return new BrainError({
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
): BrainError {
  return new BrainError({
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
): BrainError {
  if (err instanceof BrainError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  const projections = [...new Set(ops.map((op) => op.projection))].join(", ");
  return new BrainError({
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

function orderPrimaryFirst(ops: readonly PlannedMutation[]): PlannedMutation[] {
  return [
    ...ops.filter((op) => op.projection === "primary"),
    ...ops.filter((op) => op.projection !== "primary"),
  ];
}

type SideAssembly = {
  ops: readonly PlannedMutation[];
  heads: readonly HeadCommit[];
  keywordHeads: readonly HeadCommit[];
  tokenSet: DeferredTokenSet | null;
};

function assembleWriteOps(
  writes: readonly { plan: ResidentWritePlan }[],
  related: boolean,
  notes: string[],
  replayKeywords = false,
): PlannedMutation[] {
  const sides: SideAssembly[] = writes.map((write) => ({
    ops: write.plan.ops.filter((op) => op.projection !== "primary"),
    heads: write.plan.heads,
    keywordHeads: write.plan.keywordHeads,
    tokenSet: write.plan.tokenSet,
  }));
  const primary = writes.flatMap((write) => write.plan.ops.filter((op) => op.projection === "primary"));
  if (!related && !replayKeywords) {
    return dedupeOps(primary.concat(sides.flatMap((side) => assembleSide(side, false, notes))));
  }
  // Group page heads across the related writes before dedupe. A per-write
  // render plus last-wins dedupe drops the other write's card. A one-write
  // close still replays keyword heads: the stored page can replace another card.
  const sharedHeads = related
    ? headsToOps(sides.flatMap((side) => side.heads), true, notes)
    : sides.flatMap((side) => side.heads.map(headToOp));
  const sharedKeywords = headsToOps(
    sides.flatMap((side) => side.keywordHeads),
    true,
    notes,
  );
  const rest = sides.flatMap((side) => {
    const token = side.tokenSet ? tokenSetOp(side.tokenSet) : null;
    return token ? [...side.ops, token] : [...side.ops];
  });
  const joined = primary.concat(rest, sharedHeads, sharedKeywords);
  return dedupeOps(related ? mergeSharedDirectories(joined) : joined);
}

function assembleSide(side: SideAssembly, related: boolean, notes: string[]): PlannedMutation[] {
  const token = side.tokenSet ? tokenSetOp(side.tokenSet) : null;
  return [
    ...side.ops,
    ...headsToOps(side.heads, related, notes),
    ...headsToOps(side.keywordHeads, related, notes),
    ...(token ? [token] : []),
  ];
}

function headsToOps(heads: readonly HeadCommit[], related: boolean, notes: string[]): PlannedMutation[] {
  if (!related) return heads.map(headToOp);
  const groups = new Map<string, HeadCommit[]>();
  for (const head of heads) {
    const id = `${head.schemaHash}\0${head.keyHash}\0${head.keyRange}`;
    const group = groups.get(id) ?? [];
    group.push(head);
    groups.set(id, group);
  }
  const ops: PlannedMutation[] = [];
  for (const group of groups.values()) {
    const merged = mergeHeadCommits(group);
    if (merged.note) noteIndexPartial(notes, merged.note);
    if (merged.head) ops.push(headToOp(merged.head));
  }
  return ops;
}

function headToOp(head: HeadCommit): PlannedMutation {
  return {
    mutationType: head.mutationType,
    schemaHash: head.schemaHash,
    keyHash: head.keyHash,
    keyRange: head.keyRange,
    fields: head.fields,
    projection: head.replay.kind === "keyword" ? "keyword" : "list-page",
  };
}

function tokenSetOp(tokenSet: DeferredTokenSet): PlannedMutation | null {
  if (tokenSet.nextNames.length === 0) {
    if (!tokenSet.existed) return null;
    return {
      mutationType: "delete",
      schemaHash: tokenSet.schemaHash,
      keyHash: tokenSet.keyHash,
      keyRange: HEAD_RANGE,
      fields: {},
      projection: "token-set",
    };
  }
  const json = JSON.stringify(tokenSet.nextNames);
  if (tokenSet.existed && tokenSet.stored === json) return null;
  return {
    mutationType: tokenSet.existed ? "update" : "create",
    schemaHash: tokenSet.schemaHash,
    keyHash: tokenSet.keyHash,
    keyRange: HEAD_RANGE,
    fields: { bts_h: tokenSet.keyHash, bts_r: HEAD_RANGE, bts_tokens: json },
    projection: "token-set",
  };
}

function mergeSharedDirectories(ops: PlannedMutation[]): PlannedMutation[] {
  const groups = new Map<string, PlannedMutation[]>();
  const rest: PlannedMutation[] = [];
  for (const op of ops) {
    if (op.projection !== "directory") {
      rest.push(op);
      continue;
    }
    const id = `${op.schemaHash}\0${op.keyHash}\0${op.keyRange ?? ""}`;
    const group = groups.get(id) ?? [];
    group.push(op);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const only = group[0];
    if (!only) continue;
    if (group.length === 1) {
      rest.push(only);
      continue;
    }
    rest.push(unionDirectory(group));
  }
  return rest;
}

function unionDirectory(ops: readonly PlannedMutation[]): PlannedMutation {
  const last = ops[ops.length - 1]!;
  const names = new Set<string>();
  let write = false;
  for (const op of ops) {
    if (op.mutationType === "delete") continue;
    write = true;
    const raw = op.fields.btd_types;
    if (typeof raw !== "string") continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) continue;
      for (const name of value) {
        if (typeof name === "string" && name.length > 0) names.add(name);
      }
    } catch {
      /* A bad directory value does not add names. */
    }
  }
  if (!write) return { ...last, mutationType: "delete", fields: {} };
  const json = JSON.stringify([...names].sort());
  const existed = ops.some((op) => op.mutationType === "update");
  return {
    ...last,
    mutationType: existed ? "update" : "create",
    fields: { btd_h: last.keyHash, btd_r: last.keyRange ?? DIRECTORY_RANGE, btd_types: json },
  };
}

async function countMutations(
  node: NodeClient,
  items: readonly { cfg: Config; type: RecordType; delta: number }[],
  notes: string[],
): Promise<PlannedMutation[]> {
  const deltas = new Map<string, number>();
  let schemaHash = "";
  for (const item of items) {
    if (item.delta === 0) continue;
    const hash = item.cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY] ?? "";
    if (hash.length === 0) continue;
    schemaHash = hash;
    deltas.set("all", (deltas.get("all") ?? 0) + item.delta);
    deltas.set(item.type, (deltas.get(item.type) ?? 0) + item.delta);
  }
  if (schemaHash.length === 0 || deltas.size === 0) return [];
  const hashes = [...deltas.keys()];
  let rows: QueryRow[] = [];
  try {
    if (!node.queryByKeys) {
      if (!notes.includes(COUNT_UNCONFIRMED)) notes.push(COUNT_UNCONFIRMED);
      return [];
    }
    rows = await node.queryByKeys({
      schemaHash,
      fields: ["bln_h", "bln_n"],
      keys: hashes.map((hash) => ({ hash })),
    });
  } catch {
    if (!notes.includes(COUNT_UNCONFIRMED)) notes.push(COUNT_UNCONFIRMED);
    return [];
  }
  const ops: PlannedMutation[] = [];
  for (const hash of hashes) {
    const delta = deltas.get(hash) ?? 0;
    const row = rows.find((item) => {
      const named = item.key.hash && item.key.hash.length > 0
        ? item.key.hash
        : fieldString(item.fields, "bln_h");
      return named === hash;
    });
    const rawValue = row?.fields?.bln_n;
    if (row && typeof rawValue !== "string") {
      if (!notes.includes(COUNT_UNCONFIRMED)) notes.push(COUNT_UNCONFIRMED);
      continue;
    }
    const raw = typeof rawValue === "string" ? rawValue : null;
    if (raw !== null && parseListCount(raw) === null) {
      if (!notes.includes(COUNT_UNCONFIRMED)) notes.push(COUNT_UNCONFIRMED);
      continue;
    }
    if (raw === null && delta < 0) continue;
    const next = countAfterDelta(raw, delta);
    if (next === null) {
      if (!notes.includes(COUNT_UNCONFIRMED)) notes.push(COUNT_UNCONFIRMED);
      continue;
    }
    ops.push({
      mutationType: raw === null ? "create" : "update",
      schemaHash,
      keyHash: hash,
      fields: { bln_h: hash, bln_n: next },
      projection: "count",
    });
  }
  return ops;
}

function fieldString(fields: Record<string, unknown> | undefined, name: string): string {
  const value = fields?.[name];
  return typeof value === "string" ? value : "";
}

function noteIndexPartial(details: string[], why: string): void {
  if (!details.includes(INDEX_PARTIAL)) details.push(INDEX_PARTIAL);
  if (why.length > 0 && why !== INDEX_PARTIAL && !details.includes(why)) {
    details.push(why);
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
): BrainRecord {
  const tags = Array.isArray(fields.tags)
    ? fields.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const record: BrainRecord = {
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
