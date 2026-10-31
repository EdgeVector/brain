// `brain reindex --target H --source-hash T --slug S` repairs the named keys.
// Page heads commit conditionally. The command does not walk the corpus.

import { BrainError, type BatchMutationOp, type NodeClient, type Verbose } from "../client.ts";
import { pageBackfill } from "../backlink-index.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { parseListCount, serializeListCount } from "../count-state.ts";
import { resolvePrintSinks } from "../format.ts";
import {
  fieldsFor,
  isTombstoned,
  rowToRecord,
  schemaHashFor,
  type BrainRecord,
} from "../record.ts";
import {
  BACKFILL_PAGE,
  BACKLINK_PAGE,
  CHILD_PAGE,
  INDEX_PARTIAL,
  LIST_PAGE,
  SYMPTOM_PAGE,
  WRITE_BATCH_MAX,
  commitHeadPages,
  planNamedSlugBackfill,
  readCount,
  writeCount,
  type NamedBackfillTarget,
  type NamedPageTarget,
} from "../list-page.ts";
import {
  BRAIN_BACKFILL_CURSOR_SCHEMA_KEY,
  BRAIN_LIST_COUNT_SCHEMA_KEY,
  isRecordType,
  type RecordType,
} from "../schemas.ts";

const CURSOR_RANGE = "__cursor__";

type CountedSubject = {
  slug: string;
  createdAt: string | null;
  state: "absent" | "live" | "tombstone";
};

type CountedCursor = {
  version: 1;
  phase: "pending" | "complete";
  sequence: number;
  slugs: string[];
  subjects: CountedSubject[];
  delta: number;
  slug: string;
  added: number;
};

function sameSlugs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slug) => right.includes(slug));
}

function validSubject(raw: unknown): raw is CountedSubject {
  if (raw === null || typeof raw !== "object") return false;
  const value = raw as Partial<CountedSubject>;
  return typeof value.slug === "string" && value.slug.length > 0 &&
    (value.state === "absent" ? value.createdAt === null :
      (value.state === "live" || value.state === "tombstone") &&
      typeof value.createdAt === "string" && value.createdAt.length > 0);
}

function subjectSnapshot(slugs: readonly string[], records: ReadonlyMap<string, BrainRecord>): CountedSubject[] {
  return slugs.map((slug) => {
    const record = records.get(slug);
    if (record && record.created_at.length === 0) {
      refuse(`reindex cannot identify ${slug}: its created_at field is empty.`);
    }
    return {
      slug, createdAt: record?.created_at ?? null,
      state: record ? isTombstoned(record) ? "tombstone" : "live" : "absent",
    };
  });
}

function sameSubjects(left: readonly CountedSubject[], right: readonly CountedSubject[]): boolean {
  return left.length === right.length && left.every((item) => right.some((other) =>
    item.slug === other.slug && item.createdAt === other.createdAt && item.state === other.state));
}

function countedCursor(raw: string | null): CountedCursor | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<CountedCursor>;
    // Accept the cursor format from installations before recoverable counts.
    if (value.version === undefined && typeof value.slug === "string" &&
      typeof value.added === "number" &&
      Object.keys(value).every((key) => key === "slug" || key === "added")) return null;
    if (value.version !== 1 || (value.phase !== "pending" && value.phase !== "complete") ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
      !Number.isSafeInteger(value.delta) || Number(value.delta) < 0 || Number(value.delta) > BACKFILL_PAGE ||
      !Array.isArray(value.slugs) || value.slugs.length === 0 || value.slugs.length > BACKFILL_PAGE ||
      !value.slugs.every((slug) => typeof slug === "string" && slug.length > 0) ||
      new Set(value.slugs).size !== value.slugs.length ||
      Number(value.delta) > value.slugs.length ||
      !Array.isArray(value.subjects) || !value.subjects.every(validSubject) ||
      !sameSlugs(value.slugs, value.subjects.map((subject) => subject.slug)) ||
      value.slug !== value.slugs[value.slugs.length - 1] ||
      (value.added !== 0 && value.added !== 1) || Number(value.delta) < value.added) throw new Error();
    return value as CountedCursor;
  } catch {
    refuse("reindex cursor state is invalid. Repair the named cursor before a retry.");
  }
}

async function readCursor(node: NodeClient, schemaHash: string, hash: string): Promise<string | null> {
  const rows = await node.queryAll({
    schemaHash, fields: ["bfc_state"],
    filter: { HashRangeKey: { hash, range: CURSOR_RANGE } },
  });
  const raw = rows.results[0]?.fields?.bfc_state;
  if (rows.results[0] && typeof raw !== "string") refuse("reindex cursor state is invalid.");
  return typeof raw === "string" ? raw : null;
}

async function casCursor(
  node: NodeClient, schemaHash: string, hash: string, previous: string | null, next: CountedCursor,
): Promise<boolean> {
  if (!node.mutateIfExpected) refuse("reindex requires a compare-and-set cursor.");
  try {
    return await node.mutateIfExpected({
      mutationType: previous === null ? "create" : "update",
      schemaHash, keyHash: hash, keyRange: CURSOR_RANGE,
      fields: { bfc_h: hash, bfc_r: CURSOR_RANGE, bfc_state: JSON.stringify(next) },
      expected: previous === null
        ? { type: "absent", field: "bfc_state" }
        : { type: "value", field: "bfc_state", value: previous },
    }) === "applied";
  } catch {
    // The next read decides whether an interrupted acknowledgement committed.
    return false;
  }
}

async function beginCountedBackfill(opts: {
  node: NodeClient; cursorSchema: string; cursorHash: string; previousRaw: string | null;
  countSchema: string; countHash: string; source: RecordType;
  slugs: string[]; subjects: CountedSubject[]; delta: number; lastSlug: string; lastAdded: number; traces: string[];
}): Promise<CountedCursor> {
  const previous = countedCursor(opts.previousRaw);
  opts.traces.push("HashRangeKey BrainListCount keys_visited=1");
  const rawCount = await readCount(opts.node, opts.countSchema, opts.countHash);
  const count = parseListCount(rawCount);
  if (rawCount !== null && count === null) refuse("reindex count state is invalid.");
  if (previous?.phase === "pending") {
    if (!sameSlugs(previous.slugs, opts.slugs)) {
      refuse(`reindex must finish pending sequence ${previous.sequence} for these slugs first: ${previous.slugs.join(", ")}.`);
    }
    if ((count?.receipts[opts.source] ?? 0) >= previous.sequence) {
      // Only cursor completion remains. Do not replay an old page plan after
      // another record create/delete changes the count or its membership.
      return { ...previous, phase: "complete" };
    }
    if (!sameSubjects(previous.subjects, opts.subjects)) {
      refuse("reindex pending records changed identity or deletion state. Repair the named pending operation before another count addition.");
    }
    return previous;
  }
  const sequence = Math.max(previous?.sequence ?? 0, count?.receipts[opts.source] ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) refuse("reindex count sequence is exhausted.");
  const pending: CountedCursor = {
    version: 1, phase: "pending", sequence, slugs: opts.slugs, subjects: opts.subjects,
    delta: opts.delta, slug: opts.lastSlug, added: opts.lastAdded,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    opts.traces.push("mutateIfExpected BrainBackfillCursor pending");
    if (await casCursor(opts.node, opts.cursorSchema, opts.cursorHash, opts.previousRaw, pending)) return pending;
    opts.traces.push("HashRangeKey BrainBackfillCursor keys_visited=1");
    const raw = await readCursor(opts.node, opts.cursorSchema, opts.cursorHash);
    const concurrent = countedCursor(raw);
    if (concurrent && concurrent.sequence >= sequence && sameSlugs(concurrent.slugs, opts.slugs)) {
      if (concurrent.phase === "complete") return concurrent;
      if (!sameSubjects(concurrent.subjects, opts.subjects)) {
        refuse("reindex concurrent pending records changed identity or deletion state.");
      }
      return concurrent;
    }
    if (raw !== opts.previousRaw) refuse("reindex cursor changed. Retry the named slugs after its pending operation completes.");
  }
  refuse("reindex pending cursor did not confirm. Retry the same named slugs.");
}

async function finishCountedBackfill(opts: {
  node: NodeClient; cursorSchema: string; cursorHash: string; countSchema: string;
  countHash: string; source: RecordType; sourceSchema: string; operation: CountedCursor; traces: string[];
}): Promise<void> {
  const { operation } = opts;
  let counted = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    opts.traces.push("HashRangeKey BrainListCount keys_visited=1");
    const raw = await readCount(opts.node, opts.countSchema, opts.countHash);
    const state = parseListCount(raw);
    if (raw !== null && state === null) refuse("reindex count state is invalid. Retry after the named count is repaired.");
    if (raw === null && operation.delta === 0) {
      // A zero addition cannot establish a missing count. Complete only the
      // cursor; a replay remains harmless without a counter receipt.
      counted = true;
      break;
    }
    if ((state?.receipts[opts.source] ?? 0) >= operation.sequence) {
      counted = true;
      break;
    }
    if (!opts.node.queryByKeys) refuse("reindex requires a key read.");
    opts.traces.push(`HashRangeKeys ${opts.source} identity keys_visited=${operation.slugs.length}`);
    const rows = await opts.node.queryByKeys({
      schemaHash: opts.sourceSchema, fields: ["slug", "created_at", "tags"],
      keys: operation.slugs.map((slug) => ({ hash: slug })),
    });
    const records = new Map(rows.map((row) => {
      const record = rowToRecord(row, opts.source);
      return [record.slug, record] as const;
    }));
    if (!sameSubjects(operation.subjects, subjectSnapshot(operation.slugs, records))) {
      refuse("reindex pending records changed identity or deletion state. Its count did not change; repair the named pending operation.");
    }
    const current = state ?? { count: 0, receipts: {} };
    const next = current.count + operation.delta;
    if (!Number.isSafeInteger(next)) refuse("reindex count exceeds the integer limit.");
    opts.traces.push(`mutateIfExpected BrainListCount hash=${opts.countHash}`);
    if (await writeCount(opts.node, opts.countSchema, opts.countHash, raw, serializeListCount({
      count: next,
      receipts: { ...current.receipts, [opts.source]: operation.sequence },
    }))) {
      counted = true;
      break;
    }
  }
  if (!counted) refuse("reindex count did not confirm. Its pending cursor remains. Retry the same named slugs.");
  for (let attempt = 0; attempt < 4; attempt++) {
    opts.traces.push("HashRangeKey BrainBackfillCursor keys_visited=1");
    const raw = await readCursor(opts.node, opts.cursorSchema, opts.cursorHash);
    const current = countedCursor(raw);
    if (current && current.sequence > operation.sequence) return;
    if (!current || current.sequence !== operation.sequence || !sameSlugs(current.slugs, operation.slugs)) {
      refuse("reindex cursor changed before completion. The count receipt remains.");
    }
    if (current.phase === "complete") return;
    opts.traces.push("mutateIfExpected BrainBackfillCursor complete");
    if (await casCursor(opts.node, opts.cursorSchema, opts.cursorHash, raw, { ...operation, phase: "complete" })) return;
  }
  refuse("reindex cursor completion did not confirm. Retry the same named slugs; its count receipt prevents a second addition.");
}

export type ReindexOptions = {
  cfg: Config;
  type?: RecordType;
  dryRun?: boolean;
  tags?: boolean;
  backlinks?: boolean;
  bm25?: boolean;
  listIndex?: boolean;
  childTaskIndex?: boolean;
  graphEdges?: boolean;
  graphMaxRecords?: number;
  target?: string;
  sourceHash?: string;
  slugs?: string[];
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
};

export type ReindexResult = {
  wrote: number;
};

function refuse(message: string): never {
  throw new BrainError({
    code: "reindex_refused",
    message,
  });
}

function parseTarget(raw: string): NamedBackfillTarget {
  if (raw === "directory") return { kind: "directory" };
  if (raw === "keyword" || raw === "kw") return { kind: "keyword", token: null };
  if (raw.startsWith("kw#") && raw.length > 3) {
    return { kind: "keyword", token: raw.slice(3) };
  }
  let hash = raw;
  let symptomFromField = false;
  let bound = LIST_PAGE;
  let symptom = false;
  let tag: string | null = null;
  let childOf: string | null = null;
  let linkDest: string | null = null;
  let status: string | null = null;
  let known = raw === "all" || isRecordType(raw);
  if (raw.startsWith("tag#") && raw.length > 4) {
    tag = raw.slice(4);
    known = true;
  } else if (raw.startsWith("link#") && raw.length > 5) {
    linkDest = raw.slice(5);
    bound = BACKLINK_PAGE;
    known = true;
  } else if (raw.startsWith("child#") && raw.length > 6) {
    childOf = raw.slice(6);
    bound = CHILD_PAGE;
    known = true;
  } else if (raw === "symptom") {
    hash = "";
    symptom = true;
    symptomFromField = true;
    bound = SYMPTOM_PAGE;
    known = true;
  } else if (raw.startsWith("symptom#") && raw.length > 8) {
    symptom = true;
    bound = SYMPTOM_PAGE;
    known = true;
  } else if (!known) {
    const cut = raw.indexOf("#");
    if (cut > 0) {
      const typeName = raw.slice(0, cut);
      const typeStatus = raw.slice(cut + 1);
      if (isRecordType(typeName) && typeStatus.length > 0) {
        status = typeStatus;
        known = true;
      }
    }
  }
  if (!known) refuse(`reindex does not know target ${raw}.`);
  const page: NamedPageTarget = {
    kind: "page",
    hash,
    symptomFromField,
    bound,
    symptom,
    tag,
    childOf,
    linkDest,
    status,
  };
  return page;
}

export async function reindexCmd(opts: ReindexOptions): Promise<ReindexResult> {
  const { print } = resolvePrintSinks(opts);

  if (opts.tags || opts.backlinks || opts.childTaskIndex) {
    const backfill = opts.tags
      ? pageBackfill("tag#<tag>", "<type>")
      : opts.backlinks
        ? pageBackfill("link#<slug>", "<type>")
        : pageBackfill("child#<designSlug>", "task");
    print(`The old payload write stopped. ${backfill}`);
    return { wrote: 0 };
  }

  if (opts.bm25) refuse("reindex refuses --bm25.");
  if (opts.listIndex || opts.graphEdges || opts.dryRun) {
    refuse("reindex refuses the walk that writes every record again.");
  }

  const rawSlugs = opts.slugs ?? [];
  if (!opts.target || !opts.sourceHash || rawSlugs.length === 0) {
    if (!opts.target && !opts.sourceHash && rawSlugs.length === 0) {
      refuse("reindex refuses the walk that writes every record again.");
    }
    refuse("reindex requires --target, --source-hash, and --slug.");
  }
  if (opts.sourceHash === "all") refuse("reindex refuses a source hash of all.");
  if (!isRecordType(opts.sourceHash)) {
    refuse("reindex source hash must be one record type.");
  }
  if (rawSlugs.length > BACKFILL_PAGE) refuse("reindex refuses more than 25 slugs.");

  const source = opts.sourceHash;
  const targetRaw = opts.target;
  const slugs: string[] = [];
  const seenSlug = new Set<string>();
  for (const slug of rawSlugs) {
    if (slug.length === 0 || seenSlug.has(slug)) continue;
    seenSlug.add(slug);
    slugs.push(slug);
  }
  if (slugs.length === 0) refuse("reindex requires at least one nonempty slug.");
  const target = parseTarget(targetRaw);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const cursorSchema = opts.cfg.schemaHashes[BRAIN_BACKFILL_CURSOR_SCHEMA_KEY] ?? "";
  if (cursorSchema.length === 0) {
    refuse("reindex requires BrainBackfillCursor. Run brain init.");
  }

  const traces: string[] = [];
  const queryByKeys = node.queryByKeys;
  if (!queryByKeys) refuse("reindex requires a key read.");
  // Retired list payloads are snapshots. Only the named product keys can
  // supply the current status, tags, title, and sealed body for this repair.
  traces.push(`HashRangeKeys ${source} keys_visited=${slugs.length}`);
  const rows = await queryByKeys({
    schemaHash: schemaHashFor(source, opts.cfg),
    fields: fieldsFor(source),
    keys: slugs.map((slug) => ({ hash: slug })),
  });
  const bySlug = new Map<string, BrainRecord>();
  for (const row of rows) {
    const record = rowToRecord(row, source);
    if (record.slug.length > 0) bySlug.set(record.slug, record);
  }

  const cursorHash = `bf#${targetRaw}#${source}`;
  traces.push("HashRangeKey BrainBackfillCursor keys_visited=1");
  const cursorRows = await node.queryAll({
    schemaHash: cursorSchema,
    fields: ["bfc_h", "bfc_r", "bfc_state"],
    filter: { HashRangeKey: { hash: cursorHash, range: CURSOR_RANGE } },
  });
  const cursorRow = cursorRows.results[0];
  const previousRaw =
    cursorRow && typeof cursorRow.fields?.bfc_state === "string"
      ? cursorRow.fields.bfc_state
      : null;
  const cursorExisted = cursorRow !== undefined;
  const countHash = targetRaw === "all" || isRecordType(targetRaw) ? targetRaw : null;
  const countSchema = opts.cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY] ?? "";
  if (countHash) {
    if (cursorExisted && typeof cursorRow.fields?.bfc_state !== "string") {
      refuse("reindex cursor state is invalid.");
    }
    // Validate pending state before any membership mutation or cursor change.
    const pending = countedCursor(previousRaw);
    if (pending?.phase === "pending" && !sameSlugs(pending.slugs, slugs)) {
      refuse(`reindex must finish pending sequence ${pending.sequence} for these slugs first: ${pending.slugs.join(", ")}.`);
    }
    if (countSchema.length === 0) refuse("reindex requires BrainListCount. Run brain init.");
    if (!node.mutateIfExpected) refuse("reindex requires compare-and-set counts and cursors.");
  }

  const plan = await planNamedSlugBackfill({
    node,
    cfg: opts.cfg,
    sourceType: source,
    target,
    slugOrder: slugs,
    records: [...bySlug.values()],
  });
  if (plan.blocked) refuse(`reindex ${plan.blocked}.`);
  for (const line of plan.traces) traces.push(line);

  const state = JSON.stringify({ slug: plan.lastSlug, added: plan.lastAdded });
  const cursorOp: BatchMutationOp | null = !cursorExisted || previousRaw !== state
    ? {
      mutationType: cursorExisted ? "update" : "create",
      schemaHash: cursorSchema,
      keyHash: cursorHash,
      keyRange: CURSOR_RANGE,
      fields: { bfc_h: cursorHash, bfc_r: CURSOR_RANGE, bfc_state: state },
    }
    : null;
  const ops = [...plan.ops];
  if (!countHash && plan.heads.length === 0 && cursorOp) ops.push(cursorOp);
  if (ops.length > WRITE_BATCH_MAX) {
    refuse("reindex one batch cannot hold this backfill.");
  }
  if (!node.mutateBatch) refuse("reindex requires a batch write.");
  const counted = countHash ? await beginCountedBackfill({
    node, cursorSchema, cursorHash, previousRaw, countSchema, countHash, source,
    slugs, subjects: subjectSnapshot(slugs, bySlug), delta: plan.added,
    lastSlug: plan.lastSlug, lastAdded: plan.lastAdded, traces,
  }) : null;
  if (ops.length > 0 && counted?.phase !== "complete") {
    traces.push(`mutateBatch count=${ops.length}`);
    await node.mutateBatch(ops);
  }
  if (plan.heads.length > 0 && counted?.phase !== "complete") {
    traces.push(`mutateIfExpected BrainListPage count=${plan.heads.length}`);
    const headNotes = await commitHeadPages(node, plan.heads);
    for (const note of headNotes) if (!plan.notes.includes(note)) plan.notes.push(note);
    if (headNotes.includes(INDEX_PARTIAL)) {
      throw new BrainError({
        code: "index_partial",
        message: `reindex index partial (${headNotes.filter((note) => note !== INDEX_PARTIAL).join(", ")}).`,
        hint: counted
          ? "The count did not change. The pending cursor remains. Retry the same named slugs."
          : "The cursor did not change. Retry the same named slugs.",
      });
    }
    if (!countHash && cursorOp) {
      traces.push("mutateBatch count=1");
      await node.mutateBatch([cursorOp]);
    }
  }

  const wrote = counted?.delta ?? plan.added;
  if (countHash && counted) {
    await finishCountedBackfill({
      node, cursorSchema, cursorHash, countSchema, countHash, source, operation: counted, traces,
      sourceSchema: schemaHashFor(source, opts.cfg),
    });
  }

  print("reindex");
  print(`calls ${traces.length}`);
  for (const line of traces) print(line);
  for (const note of plan.notes) print(note);
  print(`wrote ${wrote}`);
  print(`${cursorHash} ${CURSOR_RANGE}`);
  return { wrote };
}
