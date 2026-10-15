// `brain reindex --target H --source-hash T --slug S` writes one batch for
// the named slugs. It does not walk the corpus.

import {
  FbrainError,
  type BatchMutationOp,
  type QueryRow,
  type Verbose,
} from "../client.ts";
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
import { recordFromEntryRow, recordListEntryHash } from "../record-list-index.ts";
import {
  BACKFILL_PAGE,
  BACKLINK_PAGE,
  CHILD_PAGE,
  LIST_PAGE,
  SYMPTOM_PAGE,
  WRITE_BATCH_MAX,
  planNamedSlugBackfill,
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

function emptyResult(): ReindexResult {
  return { wrote: 0 };
}

function dedupe(slugs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function pageTarget(
  hash: string,
  extra: Partial<Omit<NamedPageTarget, "kind" | "hash">> = {},
): NamedPageTarget {
  return {
    kind: "page",
    hash,
    symptomFromField: extra.symptomFromField === true,
    bound: extra.bound ?? LIST_PAGE,
    symptom: extra.symptom === true,
    tag: extra.tag ?? null,
    childOf: extra.childOf ?? null,
    linkDest: extra.linkDest ?? null,
    status: extra.status ?? null,
  };
}

function parseTarget(raw: string): NamedBackfillTarget {
  if (raw === "keyword" || raw === "kw") return { kind: "keyword", token: null };
  if (raw.startsWith("kw#") && raw.length > 3) {
    return { kind: "keyword", token: raw.slice(3) };
  }
  if (raw === "all") return pageTarget("all");
  if (isRecordType(raw)) return pageTarget(raw);
  if (raw.startsWith("tag#") && raw.length > 4) {
    return pageTarget(raw, { tag: raw.slice(4) });
  }
  if (raw.startsWith("link#") && raw.length > 5) {
    return pageTarget(raw, { linkDest: raw.slice(5), bound: BACKLINK_PAGE });
  }
  if (raw.startsWith("child#") && raw.length > 6) {
    return pageTarget(raw, { childOf: raw.slice(6), bound: CHILD_PAGE });
  }
  if (raw === "symptom") {
    return pageTarget("", { symptom: true, symptomFromField: true, bound: SYMPTOM_PAGE });
  }
  if (raw.startsWith("symptom#") && raw.length > 8) {
    return pageTarget(raw, { symptom: true, bound: SYMPTOM_PAGE });
  }
  const cut = raw.indexOf("#");
  if (cut > 0) {
    const typeName = raw.slice(0, cut);
    const status = raw.slice(cut + 1);
    if (isRecordType(typeName) && status.length > 0) {
      return pageTarget(raw, { status });
    }
  }
  refuse(`reindex does not know target ${raw}.`);
}

function countHashFor(target: string, source: RecordType): string | null {
  if (target === "all" || target === source || isRecordType(target)) return target;
  return null;
}

function recordFromEntry(row: QueryRow): { slug: string; record: FbrainRecord } | null {
  const snap = recordFromEntryRow(row);
  const fields = row.fields ?? {};
  const range = row.key?.range ?? "";
  const slug =
    range.length > 0 ? range : typeof fields.rle_r === "string" ? fields.rle_r : "";
  if (!snap || slug.length === 0) return null;
  if (!snap.cut) return { slug, record: snap.record };
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
  return { slug, record };
}

function cursorState(raw: string | null): { slug: string; added: number } | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw) as { slug?: unknown; added?: unknown };
    if (typeof value.slug !== "string") return null;
    return { slug: value.slug, added: typeof value.added === "number" ? value.added : 0 };
  } catch {
    return null;
  }
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
    return emptyResult();
  }

  if (opts.papercutStatusIndex) {
    print(
      "papercut-status-index: this command does not write PapercutStatusIndex. papercut list reads the list page.",
    );
    return emptyResult();
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
  const slugs = dedupe(rawSlugs);
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
    `HashRangeKeys RecordListEntry hash=${source} keys_visited=${slugs.length} fields=rle_h,rle_r,rle_payload`,
  );
  const entry = await node.queryAll({
    schemaHash: entrySchema,
    fields: ["rle_h", "rle_r", "rle_payload"],
    filter: { HashRangeKeys: slugs.map((slug) => [source, slug]) },
  });
  const bySlug = new Map<string, FbrainRecord>();
  for (const row of entry.results) {
    const parsed = recordFromEntry(row);
    if (parsed) bySlug.set(parsed.slug, parsed.record);
  }

  const productSchema = schemaHashFor(source, opts.cfg);
  const queryByKey = node.queryByKey;
  if (!queryByKey) refuse("reindex requires a key read.");
  for (const slug of slugs) {
    const have = bySlug.get(slug);
    const needBody = target.kind === "keyword" && (have === undefined || have.body.length === 0);
    if (have && !needBody) continue;
    traces.push(`HashKey ${source} keys_visited=1`);
    const row = await queryByKey({
      schemaHash: productSchema,
      fields: fieldsFor(source),
      keyHash: slug,
    });
    if (!row) {
      if (needBody) bySlug.delete(slug);
      continue;
    }
    bySlug.set(slug, rowToRecord(row, source));
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
  const previous = cursorState(previousRaw);
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
  const ops: BatchMutationOp[] = plan.ops.map((op) => ({
    mutationType: op.mutationType,
    schemaHash: op.schemaHash,
    keyHash: op.keyHash,
    keyRange: op.keyRange,
    fields: op.fields,
  }));
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

  const countHash = countHashFor(targetRaw, source);
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
    traces.push("HashKey BrainListCount keys_visited=1");
    const countRow = await queryByKey({
      schemaHash: countSchema,
      fields: ["bln_h", "bln_n"],
      keyHash: countHash,
    });
    const raw = countRow?.fields?.bln_n;
    const text = typeof raw === "string" ? raw : null;
    const numeric = text !== null && /^-?\d+$/.test(text);
    const current = numeric ? Number(text) : 0;
    const next = String(current + plan.added);
    if (!node.mutateIfExpected) refuse("reindex requires a compare-and-set count.");
    traces.push(`mutateIfExpected BrainListCount hash=${countHash}`);
    const applied = await node.mutateIfExpected({
      mutationType: numeric ? "update" : "create",
      schemaHash: countSchema,
      fields: { bln_h: countHash, bln_n: next },
      keyHash: countHash,
      expected: numeric
        ? { type: "value", field: "bln_n", value: text ?? "" }
        : { type: "absent", field: "bln_n" },
    });
    if (applied !== "applied") print("the count did not confirm");
  }

  print("reindex");
  print(`calls ${traces.length}`);
  for (const line of traces) print(line);
  for (const note of plan.notes) print(note);
  print(`wrote ${wrote}`);
  print(`${cursorHash} ${CURSOR_RANGE}`);
  return { wrote };
}
