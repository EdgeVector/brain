// `brain reindex --target H --source-hash T --slug S` writes one batch for
// the named slugs. It does not walk the corpus.

import { FbrainError, type BatchMutationOp, type Verbose } from "../client.ts";
import { pageBackfill } from "../backlink-index.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSinks } from "../format.ts";
import {
  fieldsFor,
  rowToRecord,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { readTypeListEntriesBySlugs, recordListEntryHash } from "../record-list-index.ts";
import {
  BACKFILL_PAGE,
  BACKLINK_PAGE,
  CHILD_PAGE,
  COUNT_UNCONFIRMED,
  LIST_PAGE,
  SYMPTOM_PAGE,
  WRITE_BATCH_MAX,
  planNamedSlugBackfill,
  readCount,
  writeCount,
  type NamedBackfillTarget,
  type NamedPageTarget,
} from "../list-page.ts";
import {
  BRAIN_BACKFILL_CURSOR_SCHEMA_KEY,
  BRAIN_LIST_COUNT_SCHEMA_KEY,
  RECORD_LIST_ENTRY_FIELDS,
  isRecordType,
  type RecordType,
} from "../schemas.ts";

const CURSOR_RANGE = "__cursor__";

export type ReindexOptions = {
  cfg: Config;
  type?: RecordType;
  dryRun?: boolean;
  tags?: boolean;
  backlinks?: boolean;
  bm25?: boolean;
  listIndex?: boolean;
  childTaskIndex?: boolean;
  papercutStatusIndex?: boolean;
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
  throw new FbrainError({
    code: "reindex_refused",
    message,
  });
}

function parseTarget(raw: string): NamedBackfillTarget {
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

  if (opts.papercutStatusIndex) {
    print(
      "papercut-status-index: this command does not write PapercutStatusIndex. papercut list reads the list page.",
    );
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
  const target = parseTarget(targetRaw);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const entrySchema = recordListEntryHash(opts.cfg);
  if (!entrySchema) refuse("reindex requires RecordListEntry. Run brain init.");
  const cursorSchema = opts.cfg.schemaHashes[BRAIN_BACKFILL_CURSOR_SCHEMA_KEY] ?? "";
  if (cursorSchema.length === 0) {
    refuse("reindex requires BrainBackfillCursor. Run brain init.");
  }

  const traces: string[] = [];
  traces.push(
    `HashRangeKeys RecordListEntry hash=${source} keys_visited=${slugs.length} fields=${RECORD_LIST_ENTRY_FIELDS.join(",")}`,
  );
  const entries = await readTypeListEntriesBySlugs(node, opts.cfg, source, slugs);
  const bySlug = new Map<string, FbrainRecord>();
  for (const slug of slugs) {
    const snap = entries.get(slug) ?? null;
    if (!snap) continue;
    if (!snap.cut) {
      bySlug.set(slug, snap.record);
      continue;
    }
    const summary = snap.summary;
    const record: FbrainRecord = {
      slug: summary.slug,
      title: summary.title,
      body: "",
      status: summary.status,
      tags: [...summary.tags],
      created_at: summary.created_at,
      updated_at: summary.updated_at,
    };
    if (typeof summary.design_slug === "string" && summary.design_slug.length > 0) {
      record.design_slug = summary.design_slug;
    }
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === "string") record[key] = value;
    }
    bySlug.set(slug, record);
  }

  const need: string[] = [];
  for (const slug of slugs) {
    const have = bySlug.get(slug);
    const needBody = target.kind === "keyword" && (have === undefined || have.body.length === 0);
    if (have && !needBody) continue;
    need.push(slug);
  }
  if (need.length > 0) {
    const queryByKeys = node.queryByKeys;
    if (!queryByKeys) refuse("reindex requires a key read.");
    traces.push(`HashRangeKeys ${source} keys_visited=${need.length}`);
    const rows = await queryByKeys({
      schemaHash: schemaHashFor(source, opts.cfg),
      fields: fieldsFor(source),
      keys: need.map((slug) => ({ hash: slug })),
    });
    const got = new Set<string>();
    for (const row of rows) {
      const record = rowToRecord(row, source);
      if (record.slug.length === 0) continue;
      got.add(record.slug);
      bySlug.set(record.slug, record);
    }
    if (target.kind === "keyword") {
      for (const slug of need) {
        if (!got.has(slug)) bySlug.delete(slug);
      }
    }
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
  let previous: { slug: string; added: number } | null = null;
  if (previousRaw !== null && previousRaw.length > 0) {
    try {
      const value = JSON.parse(previousRaw) as { slug?: unknown; added?: unknown };
      if (typeof value.slug === "string") {
        previous = {
          slug: value.slug,
          added: typeof value.added === "number" ? value.added : 0,
        };
      }
    } catch {
      previous = null;
    }
  }
  const cursorExisted = cursorRow !== undefined;

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
  const ops: BatchMutationOp[] = plan.ops;
  if (!cursorExisted || previousRaw !== state) {
    ops.push({
      mutationType: cursorExisted ? "update" : "create",
      schemaHash: cursorSchema,
      keyHash: cursorHash,
      keyRange: CURSOR_RANGE,
      fields: { bfc_h: cursorHash, bfc_r: CURSOR_RANGE, bfc_state: state },
    });
  }
  if (ops.length > WRITE_BATCH_MAX) {
    refuse("reindex one batch cannot hold this backfill.");
  }
  if (!node.mutateBatch) refuse("reindex requires a batch write.");
  if (ops.length > 0) {
    traces.push(`mutateBatch count=${ops.length}`);
    await node.mutateBatch(ops);
  }

  const countHash =
    targetRaw === "all" || targetRaw === source || isRecordType(targetRaw) ? targetRaw : null;
  const cursorChanged = (previous?.slug ?? "") !== plan.lastSlug;
  // A put may already hold the locator. The first cursor advance still
  // reports those slugs. The counter moves only for a new card.
  let wrote = plan.added;
  if (wrote === 0 && cursorChanged && plan.covered === slugs.length && slugs.length > 0) {
    wrote = plan.covered;
  }
  if (countHash && cursorChanged && plan.added > 0) {
    const countSchema = opts.cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY] ?? "";
    if (countSchema.length === 0) refuse("reindex requires BrainListCount. Run brain init.");
    if (!node.mutateIfExpected) refuse("reindex requires a compare-and-set count.");
    traces.push("HashRangeKey BrainListCount keys_visited=1");
    const raw = await readCount(node, countSchema, countHash);
    const numeric = raw !== null && /^-?\d+$/.test(raw);
    const next = String((numeric ? Number(raw) : 0) + plan.added);
    traces.push(`mutateIfExpected BrainListCount hash=${countHash}`);
    let applied = await writeCount(node, countSchema, countHash, numeric ? raw : null, next);
    if (!applied) {
      traces.push("HashRangeKey BrainListCount keys_visited=1");
      const again = await readCount(node, countSchema, countHash);
      const againNumeric = again !== null && /^-?\d+$/.test(again);
      const retry = String((againNumeric ? Number(again) : 0) + plan.added);
      traces.push(`mutateIfExpected BrainListCount hash=${countHash}`);
      applied = await writeCount(
        node,
        countSchema,
        countHash,
        againNumeric ? again : null,
        retry,
      );
    }
    if (!applied) print(COUNT_UNCONFIRMED);
  }

  print("reindex");
  print(`calls ${traces.length}`);
  for (const line of traces) print(line);
  for (const note of plan.notes) print(note);
  print(`wrote ${wrote}`);
  print(`${cursorHash} ${CURSOR_RANGE}`);
  return { wrote };
}
