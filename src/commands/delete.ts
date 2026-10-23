// `fbrain delete <slug> [--type T]` — delete a record.
//
// One mutation call carries the product tombstone and the page changes.
// The call updates the product fields to the tombstone tag, then deletes
// the product key. The node applies that update first and the delete after
// it, so a later get misses the row. The batch ack is success. A missing
// batch client, a batch over the cap, or a failed batch fails the command
// before any success line.
//
// Historical Phase 5 (2026-05-23) treated Delete as a sync-log marker
// only. That is no longer true. See docs/phase-5-delete-spike.md for the
// old probe, not for live product truth.

import { FbrainError, type NodeClient, type Verbose } from "../client.ts";
import { pageBackfill, readStoredPage } from "../backlink-index.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import { HEAD_RANGE, planRecordListSide } from "../list-page.ts";
import {
  buildRecordFields,
  normalizeSlug,
  nowIso,
  NOT_FOUND_TYPED,
  resolveBySlug,
  TOMBSTONE_TAG,
} from "../record.ts";
import { BRAIN_LIST_PAGE_SCHEMA_KEY, isRecordType, type RecordType } from "../schemas.ts";
import { matchesListFilters, resolveListEntries } from "./list.ts";
import { commitResidentRemoval } from "../resident-write-plan.ts";
import { formatIndexNotes } from "../write-confirmation.ts";

export type DeleteOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  // Override the referential-integrity guard that blocks deleting a design
  // still referenced by live tasks. With --force the design is deleted and
  // those tasks' design_slug references are left dangling (a warning lists
  // them). Mirrors the --force escape hatch on `task new` / `put`.
  force?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  // Structured-output sink, mirroring the read commands' `onResult`: fires
  // once on the success path with the SAME resolved `type`/`slug` the printed
  // `deleted <type> <slug>` line uses, so the MCP `structuredContent` can't
  // drift from the human text. `soft` stays `true` because the CLI still
  // stamps a tombstone tag; native LastDB Delete also runs and get misses.
  onResult?: (payload: DeleteResult) => void;
};

// The structured payload the MCP `fbrain_delete` tool returns in
// `structuredContent` (mirrors the printed `deleted <type> <slug>` line).
// `soft` is invariant `true` on the payload, not in the printed text.
export type DeleteResult = {
  action: "deleted";
  type: RecordType;
  slug: string;
  soft: true;
};

// A child page is one HashRangeKey. Do not list every task.
async function findLinkedTaskSlugs(
  node: NodeClient,
  cfg: Config,
  designSlug: string,
): Promise<string[]> {
  const hash = `child#${designSlug}`;
  const schemaHash = cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
  const seen = new Set<string>();
  let range = HEAD_RANGE;
  for (;;) {
    if (seen.has(range)) {
      throw new FbrainError({
        code: "child_page_unproven",
        message: `Cannot delete design "${designSlug}" — child page repeats.`,
        hint: pageBackfill(hash, "task"),
      });
    }
    seen.add(range);
    const page = await readStoredPage(node, schemaHash, hash, range);
    if (page.kind === "absent") {
      throw new FbrainError({
        code: "child_page_unproven",
        message: `Cannot delete design "${designSlug}" — child page absent.`,
        hint: pageBackfill(hash, "task"),
      });
    }
    if (page.kind === "bad") {
      throw new FbrainError({
        code: "child_page_unproven",
        message: `Cannot delete design "${designSlug}" — child page is partial.`,
        hint: pageBackfill(hash, "task"),
      });
    }
    if (page.cards.length > 0) return page.cards.map((card) => card.slug);
    if (page.older.length === 0) return [];
    range = page.older;
  }
}

async function linkedTasksForDelete(
  node: NodeClient,
  cfg: Config,
  designSlug: string,
  force: boolean | undefined,
  print: (line: string) => void,
): Promise<string[]> {
  try {
    return await findLinkedTaskSlugs(node, cfg, designSlug);
  } catch (err) {
    if (!(force && err instanceof FbrainError && err.code === "child_page_unproven")) throw err;
    // Force explicitly permits dangling references. Do not claim the absent
    // or damaged child page proves that the design has no linked tasks.
    print(`warning: child references for design "${designSlug}" are unknown; --force permits dangling references.`);
    return [];
  }
}

// Tombstone status per type — pick a value from each type's status enum
// that semantically fits "this is gone". Validated on write by the
// record's schema (statuses are free-form strings in fold_db itself, but
// fbrain ensures the value is in the enum via ensureStatus elsewhere).
export const TOMBSTONE_STATUS: Record<RecordType, string> = {
  design: "archived",
  task: "cancelled",
  concept: "archived",
  preference: "superseded",
  reference: "archived",
  agent: "archived",
  project: "archived",
  spike: "concluded",
  sop: "archived",
  decision: "superseded",
};

export function buildTombstoneFields(
  type: RecordType,
  slug: string,
  createdAt: string,
  now: string,
): Record<string, unknown> {
  return buildRecordFields(type, {
    slug,
    title: "(deleted)",
    body: "",
    status: TOMBSTONE_STATUS[type],
    tags: [TOMBSTONE_TAG],
    created_at: createdAt,
    updated_at: now,
  });
}

export async function deleteRecord(opts: DeleteOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);

  // raw mode bypasses tombstone filtering at the lookup layer; resolveBySlug
  // drops tombstones inside the helper afterward.
  const resolved = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    raw: true,
    notFoundMessage: NOT_FOUND_TYPED,
    recoveryVerb: "delete",
  });
  const { type, record } = resolved;

  // Referential-integrity guard, symmetric with the create-time rejection in
  // `task new --design` / `link`: those refuse to point a task at a missing
  // design, so deleting a design out from under live tasks must not silently
  // orphan them. Only Task carries design_slug (RECORDS[*].hasDesignSlug), so
  // this is a design-only concern. Runs before any mutation: a blocked delete
  // leaves the design untouched.
  if (type === "design") {
    const linked = await linkedTasksForDelete(node, opts.cfg, slug, opts.force, print);
    if (linked.length > 0) {
      const n = linked.length;
      const noun = n === 1 ? "task" : "tasks";
      const verb = n === 1 ? "links" : "link";
      if (!opts.force) {
        throw new FbrainError({
          code: "design_has_linked_tasks",
          message: `Cannot delete design "${slug}" — ${n} ${noun} still ${verb} to it: ${linked.join(", ")}.`,
          hint: "Re-link those tasks to another design (`fbrain link <task> <design>`) or delete them first (`fbrain delete <task> --type task`), or pass --force to delete anyway (their design references will dangle).",
        });
      }
      print(
        `warning: ${n} ${noun} still ${verb} to design "${slug}" (${linked.join(", ")}); after this delete their design references will dangle.`,
      );
    }
  }

  const listSide = await planRecordListSide({
    node, cfg: opts.cfg, type, previous: record, next: null, nextEdges: [],
  });
  const removed = await commitResidentRemoval({
    node,
    cfg: opts.cfg,
    type,
    slug,
    tombstoneFields: buildTombstoneFields(type, slug, record.created_at, nowIso()),
    side: listSide,
  });
  const indexNote = formatIndexNotes(removed.indexNotes);

  print(`deleted ${type} ${slug}${indexNote}`);
  // Emit the structured payload from the SAME resolved `type`/`slug` the
  // printed line uses (one source of truth — see the read commands).
  opts.onResult?.({ action: "deleted", type, slug, soft: true });
}

// ── Filter-mode (bulk) delete ────────────────────────────────────────────

// One record matched by a filter-mode delete (`type · slug · title`), the
// unit both the dry-run preview and the actual delete operate on.
type FilterMatch = {
  type: RecordType;
  slug: string;
  title: string;
  created_at: string;
};

// The structured payload `fbrain delete --tag …` emits under `--json`. `deleted`
// is the list that WAS (or, under `dryRun`, WOULD BE) tombstoned. In dry-run
// mode nothing is mutated, so the same list is the preview.
export type DeleteBatchFailure = {
  type: RecordType;
  slug: string;
  error: string;
};

export type DeleteBatchResult = {
  ok: boolean;
  deleted: Array<{ type: RecordType; slug: string }>;
  failed: DeleteBatchFailure[];
  dryRun: boolean;
};

export type DeleteByFilterOptions = {
  cfg: Config;
  // The list-style selectors. At least one of `tag`/`status`/`type` must be
  // set — an unbounded selector (none of them) is rejected by the CLI before
  // it reaches here, and re-rejected here defensively.
  type?: RecordType;
  status?: string;
  tag?: string;
  // Safety gate. When false (the default), filter mode is a dry-run preview:
  // it lists what WOULD be deleted and exits without mutating. `--yes` flips
  // it to actually delete.
  yes?: boolean;
  // Override the design-with-live-tasks referential-integrity guard per
  // record, mirroring single-slug `--force`. Without it a linked design is
  // skipped+warned (the batch continues); with it the design is deleted and
  // its tasks' design references are left dangling.
  force?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  onResult?: (payload: DeleteBatchResult) => void;
};

function sortFilterMatches(matches: FilterMatch[]): void {
  matches.sort((a, b) =>
    a.type !== b.type
      ? a.type < b.type
        ? -1
        : 1
      : a.slug < b.slug
        ? -1
        : a.slug > b.slug
          ? 1
          : 0,
  );
}

// `--tag` walks tag# pages. One HashRangeKey per page. `--type` and `--status`
// without a tag still use the list resolver.
async function resolveFilterMatches(
  node: NodeClient,
  opts: DeleteByFilterOptions,
): Promise<{ matches: FilterMatch[]; partial: boolean }> {
  if (opts.tag) {
    const hash = `tag#${opts.tag}`;
    const schemaHash = opts.cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
    const seen = new Set<string>();
    const matches: FilterMatch[] = [];
    let range = HEAD_RANGE;
    let partial = false;
    for (;;) {
      if (seen.has(range)) {
        partial = true;
        break;
      }
      seen.add(range);
      const page = await readStoredPage(node, schemaHash, hash, range);
      if (page.kind !== "page") {
        partial = true;
        break;
      }
      for (const card of page.cards) {
        if (!isRecordType(card.type)) continue;
        if (opts.type && card.type !== opts.type) continue;
        if (opts.status && card.status !== opts.status) continue;
        matches.push({
          type: card.type,
          slug: card.slug,
          title: card.title,
          created_at: "",
        });
      }
      if (page.older.length === 0) break;
      range = page.older;
    }
    sortFilterMatches(matches);
    return { matches, partial };
  }
  const entries = await resolveListEntries(node, opts);
  const matches: FilterMatch[] = entries
    .filter(({ record }) => matchesListFilters(record, opts))
    .map(({ type, record }) => ({
      type,
      slug: record.slug,
      title: record.title,
      created_at: record.created_at,
    }));
  sortFilterMatches(matches);
  return { matches, partial: false };
}

// A short, human-readable description of the active selector, for the preview
// header and the empty-match line ("no live records match --tag junk").
function describeSelector(opts: DeleteByFilterOptions): string {
  const parts: string[] = [];
  if (opts.type) parts.push(`--type ${opts.type}`);
  if (opts.status) parts.push(`--status ${opts.status}`);
  if (opts.tag) parts.push(`--tag ${opts.tag}`);
  return parts.join(" ");
}

function isNotFound(err: unknown): boolean {
  return err instanceof FbrainError && err.code === "not_found";
}

function formatBatchError(err: unknown): string {
  if (err instanceof FbrainError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function deleteByFilter(
  opts: DeleteByFilterOptions,
): Promise<void> {
  const print = resolvePrintSink(opts);

  // Defense in depth: the CLI refuses an unbounded selector before calling us,
  // but a bare filter delete that matched EVERYTHING would be catastrophic, so
  // re-assert the bound here. (`onResult`/MCP callers go through the same gate.)
  if (!opts.tag && !opts.status && !opts.type) {
    throw new FbrainError({
      code: "unbounded_delete_selector",
      message:
        "Bulk delete requires a filter — refusing to select every record.",
      hint: "Narrow with --tag T, --type T, and/or --status S (or delete one record with `fbrain delete <slug>`).",
    });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const selector = describeSelector(opts);

  const { matches, partial } = await resolveFilterMatches(node, opts);
  if (partial) print("the delete is partial");
  if (matches.length === 0) {
    if (!partial) print(`no live records match ${selector}`);
    opts.onResult?.({ ok: !partial, deleted: [], failed: [], dryRun: !opts.yes });
    return;
  }

  // Dry-run by default: list the records that WOULD be deleted, with a count,
  // and exit WITHOUT mutating. `--yes` is the explicit confirmation to proceed.
  if (!opts.yes) {
    const noun = matches.length === 1 ? "record" : "records";
    print(`Would delete ${matches.length} ${noun} matching ${selector}:`);
    for (const m of matches) print(`  ${m.type}  ${m.slug}  ${m.title}`);
    print(
      `Re-run with --yes to delete ${matches.length === 1 ? "it" : "them"}.`,
    );
    opts.onResult?.({
      ok: !partial,
      deleted: matches.map((m) => ({ type: m.type, slug: m.slug })),
      failed: [],
      dryRun: true,
    });
    return;
  }

  // --yes: actually delete. Resolve each record's created_at fresh (the list
  // sweep above hydrated it, but re-resolving via resolveBySlug also re-runs
  // the per-record not-found/ambiguity handling and gives the design guard a
  // single source of truth). Honor the design-with-live-tasks guard per record
  // — skip+warn by default, delete-and-warn under --force — so one linked
  // design never aborts the whole batch.
  const deleted: Array<{ type: RecordType; slug: string }> = [];
  const failed: DeleteBatchFailure[] = [];
  for (const m of matches) {
    const slug = normalizeSlug(m.slug);

    try {
      if (m.type === "design") {
        const linked = await linkedTasksForDelete(node, opts.cfg, slug, opts.force, print);
        if (linked.length > 0) {
          const n = linked.length;
          const lnoun = n === 1 ? "task" : "tasks";
          const verb = n === 1 ? "links" : "link";
          if (!opts.force) {
            print(
              `skipped design ${slug} — ${n} ${lnoun} still ${verb} to it (${linked.join(", ")}); pass --force to delete anyway.`,
            );
            continue;
          }
          print(
            `warning: ${n} ${lnoun} still ${verb} to design "${slug}" (${linked.join(", ")}); after this delete their design references will dangle.`,
          );
        }
      }

      // Re-read the live row so we tombstone with its real created_at (and skip
      // anything that vanished between the sweep and now). raw:true bypasses the
      // tombstone filter at the lookup layer; resolveBySlug drops tombstones.
      let resolved: Awaited<ReturnType<typeof resolveBySlug>>;
      try {
        resolved = await resolveBySlug({
          node,
          cfg: opts.cfg,
          slug,
          type: m.type,
          raw: true,
          notFoundMessage: NOT_FOUND_TYPED,
          recoveryVerb: "delete",
        });
      } catch (err) {
        if (isNotFound(err)) continue; // already gone — nothing to do
        throw err;
      }

      const listSide = await planRecordListSide({
        node, cfg: opts.cfg, type: m.type, previous: resolved.record, next: null, nextEdges: [],
      });
      const removed = await commitResidentRemoval({
        node,
        cfg: opts.cfg,
        type: m.type,
        slug,
        tombstoneFields: buildTombstoneFields(
          m.type,
          slug,
          resolved.record.created_at,
          nowIso(),
        ),
        side: listSide,
      });
      const indexNote = formatIndexNotes(removed.indexNotes);
      print(`deleted ${m.type} ${slug}${indexNote}`);
      deleted.push({ type: m.type, slug });
    } catch (err) {
      const error = formatBatchError(err);
      failed.push({ type: m.type, slug, error });
      print(`failed ${m.type} ${slug} — ${error}`);
    }
  }

  const noun = deleted.length === 1 ? "record" : "records";
  if (failed.length === 0) {
    print(`deleted ${deleted.length} ${noun} matching ${selector}.`);
    opts.onResult?.({ ok: !partial, deleted, failed: [], dryRun: false });
    return;
  }

  const fnoun = failed.length === 1 ? "record" : "records";
  print(
    `deleted ${deleted.length} ${noun} matching ${selector}; ${failed.length} ${fnoun} failed.`,
  );
  opts.onResult?.({ ok: false, deleted, failed, dryRun: false });
  throw new FbrainError({
    code: "batch_delete_failed",
    message: `Bulk delete matching ${selector} failed for ${failed.length} ${fnoun}.`,
    hint: "Review the failed slug(s) above and retry once the node error is resolved.",
  });
}
