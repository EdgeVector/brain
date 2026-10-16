// `brain get <slug> [--type T]` — print one record.
// Untyped get reads the type directory, then at most one product key.
// Typed get reads that product key and does not read the directory.
// A design get reads child# as one HashRangeKey.
// linked_from reads link# as one HashRangeKey.
// A print that omits the body does not fetch the blob.

import {
  displayCap,
  pageBackfill,
  pageRangeOrThrow,
  readStoredPage,
  type StoredCard,
  type StoredPage,
} from "../backlink-index.ts";
import { hydrateRecord, parseSpillMarker, spillFieldsFor } from "../body-spill.ts";
import { FbrainError, newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { printFieldProjection } from "../field-projection.ts";
import { resolvePrintSink } from "../format.ts";
import { BACKLINK_PAGE, CHILD_PAGE, HEAD_RANGE } from "../list-page.ts";
import {
  findBySlug,
  NOT_FOUND_TYPED,
  normalizeSlug,
  resolveBySlug,
  schemaHashFor,
  type BacklinkRef,
  type FbrainRecord,
  type SlugTwin,
} from "../record.ts";
import { BRAIN_LIST_PAGE_SCHEMA_KEY, isRecordType, RECORDS, type RecordType } from "../schemas.ts";

export type GetOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  // Machine-readable mode. Emits a single JSON object via `print` (one
  // call) covering the same fields the human surface shows plus the
  // body.
  json?: boolean;
  fields?: readonly string[];
  verbose?: Verbose;
  print?: (line: string) => void;
  // Structured-result sink. When set, receives the SAME single
  // `RecordJson` object that `--json` mode serializes to stdout — one
  // source of truth for both the JSON CLI surface and the MCP
  // `structuredContent`. Fires once on a successful resolve (a not-found
  // slug throws before this, surfacing as a tool error) regardless of
  // the `json` flag, so the MCP handler can run the command in human
  // mode for `content` text AND capture the typed record.
  onResult?: (payload: RecordJson) => void;
  // Optional CLI body cap. Undefined preserves the historical full-body
  // surface; when set, both human output and --json use the same truncated
  // body string.
  bodyLimit?: number;
  // Child page id. Valid only with --type design. linked_from stays on __head__.
  page?: string;
  limit?: number;
};

export async function getRecord(opts: GetOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  let childRange = HEAD_RANGE;
  if (opts.page !== undefined && opts.page.length > 0) {
    if (opts.type !== "design") {
      throw new FbrainError({
        code: "page_needs_design",
        message: "--page is valid only when --type is design",
        hint: "Pass --type design with --page.",
      });
    }
    childRange = pageRangeOrThrow(opts.page);
  }
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

  // Stored text first. A shown spill loads its blob only when the print
  // passes the inline head.
  const found = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    notFoundMessage: NOT_FOUND_TYPED,
    recoveryVerb: "get",
    hydrate: false,
    ...(opts.type === undefined
      ? { directory: true }
      : { normalizedSlugFallback: true }),
  });

  // Flag a dangling design reference. A task's design_slug is validated on
  // write (task new / link), so a now-missing parent means the design was
  // deleted out from under it — surface that instead of printing a live-
  // looking pointer. Uses the fast-miss helper so a deleted parent surfaces
  // in ~one query (populated design schema, parent absent ⇒ authoritative
  // miss) instead of burning the full 5×250 ms read-retry budget on EVERY
  // `fbrain get` of an orphaned task; empty design page still rides out the
  // saturated-daemon flake, so a live parent isn't mislabeled as deleted.
  let designMissing = false;
  const designSlug = found.record.design_slug;
  if (RECORDS[found.type].hasDesignSlug && designSlug && designSlug.length > 0) {
    const designHash = schemaHashFor("design", opts.cfg);
    const parent = await findBySlug(node, "design", designHash, designSlug, opts.cfg, {
      hydrate: false,
    });
    designMissing = parent === null;
  }

  const pageSchema = opts.cfg.schemaHashes[BRAIN_LIST_PAGE_SCHEMA_KEY] ?? "";
  let designChildren: Array<{ slug: string; status: string }> | undefined;
  let tasksLines: string[] | undefined;
  if (found.type === "design") {
    const childHash = `child#${found.record.slug}`;
    const childPage = await readStoredPage(node, pageSchema, childHash, childRange);
    const childView = memberLines(`tasks:`.padEnd(12), childPage, {
      limit: opts.limit,
      named: CHILD_PAGE,
      absentLines: [
        `${"tasks:".padEnd(12)}child page absent`,
        "sample",
        pageBackfill(childHash, "task"),
      ],
      render: (cards) => cards.map((card) => `${card.slug} (${card.status})`).join(", "),
    });
    tasksLines = childView.lines;
    if (childPage.kind === "page" && childView.provenEmpty) {
      designChildren = [];
    } else if (childView.shown.length > 0) {
      designChildren = childView.shown.map((card) => ({ slug: card.slug, status: card.status }));
    }
  }

  const linkHash = `link#${found.record.slug}`;
  const linkPage = await readStoredPage(node, pageSchema, linkHash, HEAD_RANGE);
  const linkView = memberLines("linked_from: ", linkPage, {
    named: BACKLINK_PAGE,
    absentLines: [
      "linked_from: sample",
      "index record absent",
      pageBackfill(linkHash, "<type>"),
    ],
    render: (cards) =>
      cards
        .filter((card) => card.type.length > 0)
        .map((card) => `${card.type} ${card.slug}`)
        .join(", "),
  });
  const linkedFrom: BacklinkRef[] = [];
  for (const card of linkView.shown) {
    if (!isRecordType(card.type)) continue;
    linkedFrom.push({ type: card.type, slug: card.slug });
  }

  // Built unconditionally (not just under --json) so the `onResult`
  // structured sink and the `--json` stdout document are the SAME value
  // — the MCP `structuredContent` can't drift from the CLI JSON shape.
  const recordForOutput = await textForPrint(node, opts, found);
  const json = recordToJson(
    recordForOutput,
    found.type,
    designMissing,
    designChildren,
    linkPage.kind === "page" ? linkedFrom : undefined,
    undefined,
    found.also_types,
    { tasks: tasksLines, linkedFrom: linkView.lines },
  );
  opts.onResult?.(json);

  if (opts.fields !== undefined && opts.fields.length > 0) {
    printFieldProjection([json], opts.fields, print);
    return;
  }

  if (opts.json) {
    print(JSON.stringify(json));
    return;
  }

  print(
    formatRecord(
      recordForOutput,
      found.type,
      designMissing,
      designChildren,
      linkedFrom,
      undefined,
      found.also_types,
      tasksLines,
      linkView.lines,
    ),
  );
}

function truncateBody(body: string, limit: number): string {
  return body.length > limit ? body.slice(0, limit) : body;
}

function printShowsField(
  fields: readonly string[] | undefined,
  name: string,
  extraFields: readonly string[],
): boolean {
  if (fields === undefined || fields.length === 0) return true;
  for (const path of fields) {
    const top = path.split(".")[0] ?? path;
    const head = top.split("[")[0] ?? top;
    if (head === name) return true;
    if (head !== "extra_fields" || !extraFields.includes(name)) continue;
    if (path === "extra_fields") return true;
    const bracket = /^extra_fields\[([^\]]+)\]/.exec(path);
    if (bracket?.[1] === name) return true;
    const rest = path.startsWith("extra_fields.") ? path.slice("extra_fields.".length) : path;
    const extraTop = rest.split(".")[0] ?? rest;
    const extraHead = extraTop.split("[")[0] ?? extraTop;
    if (extraHead === name) return true;
  }
  return false;
}

// A shown spilled field prints text, never the marker. A limit that stays
// inside the inline head prints that head. A wider print loads the blob.
async function textForPrint(
  node: ReturnType<typeof newReadClientFromCfg>,
  opts: GetOptions,
  found: { type: RecordType; record: FbrainRecord },
): Promise<FbrainRecord> {
  const output: FbrainRecord = { ...found.record };
  const toHydrate: string[] = [];
  for (const field of spillFieldsFor(found.type)) {
    if (!printShowsField(opts.fields, field, RECORDS[found.type].extraStringFields ?? [])) continue;
    const value = found.record[field];
    if (typeof value !== "string") continue;
    const marker = parseSpillMarker(value);
    const limit = field === "body" ? opts.bodyLimit : undefined;
    if (marker === null) {
      if (limit !== undefined) output[field] = truncateBody(value, limit);
      continue;
    }
    if (limit !== undefined && marker.head.length >= limit) {
      output[field] = marker.head.slice(0, limit);
      continue;
    }
    toHydrate.push(field);
  }
  if (toHydrate.length === 0) return output;

  let full: FbrainRecord;
  try {
    full = await hydrateRecord(node, opts.cfg, found.type, found.record, { fields: toHydrate });
  } catch (err) {
    if (!(err instanceof FbrainError) || err.code !== "body_spill_sidecar_mismatch") throw err;
    const hash = schemaHashFor(found.type, opts.cfg);
    const again = await findBySlug(node, found.type, hash, found.record.slug, opts.cfg, {
      hydrate: false,
    });
    if (again === null) throw err;
    full = await hydrateRecord(node, opts.cfg, found.type, again, {
      fields: toHydrate,
    });
  }
  for (const field of toHydrate) {
    const text = full[field];
    if (typeof text !== "string") continue;
    output[field] =
      field === "body" && opts.bodyLimit !== undefined ? truncateBody(text, opts.bodyLimit) : text;
  }
  return output;
}

// Render a `field:` label padded to the same fixed column the built-in
// metadata lines (`title:      `, `status:     `) use, so extra-field lines
// like a decision's `program:`/`decided_on:` align with them.
const EXTRA_LABEL_WIDTH = 12;
function padLabel(field: string): string {
  return `${field}:`.padEnd(EXTRA_LABEL_WIDTH);
}

export type RecordJson = {
  type: RecordType;
  slug: string;
  title: string;
  status: string;
  tags: string[];
  design_slug?: string;
  // Only set when the type carries a design link and the referenced
  // design has been deleted since the link was written. Same signal
  // the human output flags as "(deleted)".
  design_missing?: boolean;
  // Type-specific extra String columns beyond the shared envelope, for a
  // dedicated-shape type like `decision` (program/gate_slug/decided_by/
  // decided_on). Present only when the type declares `extraStringFields`;
  // each key maps to its stored value (empty string when unset). Without
  // this the write path stores these columns but the read surface drops
  // them, so `fbrain get --json`/human output showed nothing for them.
  extra_fields?: Record<string, string>;
  // Only present for type=design — child task summaries for the
  // reverse-direction parent ↔ child link the human surface renders
  // on the `tasks:` line.
  children?: Array<{ slug: string; status: string }>;
  // Set (instead of `children`) when the child-task projection could not be
  // read — the design's own body is still returned. Distinct from
  // `children: []`, which asserts the design genuinely has no children.
  children_unavailable?: string;
  tasks_lines?: string[];
  linked_from_lines?: string[];
  // Cards on the one link# page for this slug. get maps that page
  // (type and slug). backlinks reads one page, then one status and tags batch.
  linked_from?: Array<{
    type: RecordType;
    slug: string;
    status?: string;
    via?: Array<"explicit" | "body">;
  }>;
  // Other schemas that ALSO hold this slug. A sweep sets this when a
  // precedence list picks one type among several. Untyped get reads the type
  // directory. Two directory types raise `ambiguous_slug` and leave this unset.
  also_types?: Array<{ type: RecordType; status: string }>;
  created_at: string;
  updated_at: string;
  body: string;
  // Each `extra_fields` entry is also copied onto the top level (see
  // `recordToJson`), so `brain papercut list --json` and `brain get --json`
  // agree on where a custom column lives — a naive `.fixed_by` read works on
  // both instead of silently returning undefined on `get`
  // (papercut-brain-papercut-list-json-envelope-not-documented-20261010).
  [extraField: string]: unknown;
};

export function recordToJson(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
  children?: ReadonlyArray<{ slug: string; status: string }>,
  linkedFrom?: ReadonlyArray<BacklinkRef>,
  childrenUnavailable?: string,
  alsoTypes?: readonly SlugTwin[],
  pageLines?: { tasks?: readonly string[]; linkedFrom?: readonly string[] },
): RecordJson {
  const out: RecordJson = {
    type,
    slug: r.slug,
    title: r.title,
    status: r.status,
    tags: r.tags,
    created_at: r.created_at,
    updated_at: r.updated_at,
    body: r.body,
  };
  if (alsoTypes !== undefined && alsoTypes.length > 0) {
    out.also_types = alsoTypes.map((t) => ({ type: t.type, status: t.status }));
  }
  if (RECORDS[type].hasDesignSlug) {
    out.design_slug = r.design_slug ?? "";
    if (designMissing) out.design_missing = true;
  }
  const extraFields = RECORDS[type].extraStringFields;
  if (extraFields !== undefined && extraFields.length > 0) {
    const extra: Record<string, string> = {};
    for (const ef of extraFields) {
      const value = r[ef];
      extra[ef] = typeof value === "string" ? value : "";
    }
    out.extra_fields = extra;
    Object.assign(out, extra);
  }
  if (pageLines?.tasks !== undefined) out.tasks_lines = [...pageLines.tasks];
  if (pageLines?.linkedFrom !== undefined) out.linked_from_lines = [...pageLines.linkedFrom];
  if (type === "design" && childrenUnavailable !== undefined) {
    out.children_unavailable = childrenUnavailable;
  } else if (type === "design" && children !== undefined) {
    out.children = children.map((t) => ({ slug: t.slug, status: t.status }));
  }
  if (linkedFrom !== undefined) {
    out.linked_from = linkedFrom.map((link) => ({
      type: link.type,
      slug: link.slug,
      ...(link.status !== undefined ? { status: link.status } : {}),
      ...(link.via !== undefined ? { via: link.via } : {}),
    }));
  }
  return out;
}

export function formatRecord(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
  children?: ReadonlyArray<{ slug: string; status: string }>,
  linkedFrom?: ReadonlyArray<BacklinkRef>,
  childrenUnavailable?: string,
  alsoTypes?: readonly SlugTwin[],
  tasksLines?: readonly string[],
  linkLines?: readonly string[],
): string {
  const lines = [
    `[${type}] ${r.slug}`,
    `title:      ${r.title}`,
    `status:     ${r.status}`,
  ];
  // Directly under `status:`, because the twin's status is the field that
  // disagrees and the reader is about to act on the one printed above.
  if (alsoTypes !== undefined && alsoTypes.length > 0) {
    lines.push(`also:       ${formatAlsoTypes(r.slug, alsoTypes)}`);
  }
  lines.push(
    `tags:       ${r.tags.length === 0 ? "(none)" : r.tags.join(", ")}`,
  );
  if (RECORDS[type].hasDesignSlug) {
    const hasDesign = r.design_slug !== undefined && r.design_slug.length > 0;
    const designValue = hasDesign
      ? `${r.design_slug}${designMissing ? " (deleted)" : ""}`
      : "(none)";
    lines.push(`design:     ${designValue}`);
  }
  for (const ef of RECORDS[type].extraStringFields ?? []) {
    const value = r[ef];
    const rendered = typeof value === "string" && value.length > 0 ? value : "(none)";
    lines.push(`${padLabel(ef)}${rendered}`);
  }
  if (tasksLines !== undefined) {
    for (const line of tasksLines) lines.push(line);
  } else if (type === "design" && childrenUnavailable !== undefined) {
    lines.push(`tasks:      (unavailable — ${childrenUnavailable})`);
  } else if (type === "design" && children !== undefined) {
    if (children.length === 0) {
      lines.push("tasks:      (none)");
    } else {
      const rendered = children.map((t) => `${t.slug} (${t.status})`).join(", ");
      lines.push(`tasks:      ${rendered}`);
    }
  }
  if (linkLines !== undefined) {
    for (const line of linkLines) lines.push(line);
  } else if (linkedFrom !== undefined) {
    lines.push(`linked_from: ${formatLinkedFrom(linkedFrom)}`);
  }
  lines.push(`created_at: ${r.created_at}`);
  lines.push(`updated_at: ${r.updated_at}`);
  if (r.body.length > 0) {
    lines.push("---");
    lines.push(r.body);
  }
  return lines.join("\n");
}

// Re-render a record's human text from a `RecordJson` (the structured shape),
// substituting `body` with a possibly-windowed slice and appending a visible
// truncation note when the window doesn't cover the whole body. Used by the
// MCP `fbrain_get` handler, which caps the body it returns so a large record
// can't overflow the agent harness token budget. The header/metadata lines are
// rendered identically to `formatRecord` (so the two surfaces stay in sync),
// but driven off `RecordJson` because that is the only shape the MCP handler
// holds after `getRecord`'s structured sink fires. The CLI `fbrain get` does
// NOT use this — a terminal has no token cap — so its output is unaffected.
export function formatRecordJsonWindow(
  json: RecordJson,
  window: { body: string; offset: number; total: number; truncated: boolean },
): string {
  const lines = [
    `[${json.type}] ${json.slug}`,
    `title:      ${json.title}`,
    `status:     ${json.status}`,
  ];
  if (json.also_types !== undefined && json.also_types.length > 0) {
    lines.push(`also:       ${formatAlsoTypes(json.slug, json.also_types)}`);
  }
  lines.push(
    `tags:       ${json.tags.length === 0 ? "(none)" : json.tags.join(", ")}`,
  );
  if (json.design_slug !== undefined) {
    const hasDesign = json.design_slug.length > 0;
    const designValue = hasDesign
      ? `${json.design_slug}${json.design_missing ? " (deleted)" : ""}`
      : "(none)";
    lines.push(`design:     ${designValue}`);
  }
  if (json.extra_fields !== undefined) {
    for (const [ef, value] of Object.entries(json.extra_fields)) {
      const rendered = value.length > 0 ? value : "(none)";
      lines.push(`${padLabel(ef)}${rendered}`);
    }
  }
  if (json.tasks_lines !== undefined) {
    for (const line of json.tasks_lines) lines.push(line);
  } else if (json.type === "design" && json.children_unavailable !== undefined) {
    lines.push(`tasks:      (unavailable — ${json.children_unavailable})`);
  } else if (json.type === "design" && json.children !== undefined) {
    if (json.children.length === 0) {
      lines.push("tasks:      (none)");
    } else {
      const rendered = json.children.map((t) => `${t.slug} (${t.status})`).join(", ");
      lines.push(`tasks:      ${rendered}`);
    }
  }
  if (json.linked_from_lines !== undefined) {
    for (const line of json.linked_from_lines) lines.push(line);
  } else if (json.linked_from !== undefined) {
    lines.push(`linked_from: ${formatLinkedFrom(json.linked_from)}`);
  }
  lines.push(`created_at: ${json.created_at}`);
  lines.push(`updated_at: ${json.updated_at}`);
  if (window.total > 0) {
    lines.push("---");
    lines.push(window.body);
    if (window.truncated || window.offset > 0) {
      const shownEnd = window.offset + window.body.length;
      lines.push(
        `… [body truncated: showing chars ${window.offset}–${shownEnd} of ${window.total}` +
          (window.truncated
            ? `; re-call fbrain_get with body_offset=${shownEnd} for more]`
            : ` (end of body)]`),
      );
    }
  }
  return lines.join("\n");
}

// One line naming every OTHER schema holding this slug, each with its own
// status and a runnable command to read it. The status is included because a
// bare type list ("also exists as a papercut") still leaves the reader
// believing the status they just read applies to the defect — which is the
// exact misread this line exists to stop.
function formatAlsoTypes(
  slug: string,
  twins: readonly { type: RecordType; status: string }[],
): string {
  const rendered = twins
    .map((t) => `${t.type} (status ${t.status})`)
    .join(", ");
  const example = twins[0]!.type;
  return `${rendered} — read with \`fbrain get ${slug} --type ${example}\``;
}

function memberLines(
  label: string,
  page: StoredPage,
  opts: {
    limit?: number;
    named: number;
    absentLines: string[];
    render: (cards: StoredCard[]) => string;
  },
): { lines: string[]; shown: StoredCard[]; provenEmpty: boolean } {
  if (page.kind === "absent") return { lines: opts.absentLines, shown: [], provenEmpty: false };
  if (page.kind === "bad") {
    return { lines: [`${label}sample`, "index partial"], shown: [], provenEmpty: false };
  }
  const { cap, partial } = displayCap(opts.limit, opts.named, page.bytes);
  const shown = page.cards.slice(0, cap);
  const clipped = page.cards.length > shown.length;
  const lines: string[] = [];
  const provenEmpty = shown.length === 0 && page.older.length === 0;
  if (provenEmpty) lines.push(`${label}(none)`);
  else if (shown.length === 0) lines.push(`${label}sample ${page.older}`);
  else {
    lines.push(`${label}${opts.render(shown)}`);
    if (clipped) lines.push("the cap cut this page");
    if (page.older.length > 0) lines.push(`sample ${page.older}`);
  }
  if (partial) lines.push("index partial");
  return { lines, shown, provenEmpty };
}

// `type slug` per entry; the `(via)` suffix only when a hydrated view supplied
// it. Consumers that crawl this line split on `, ` and take the second token
// (last-stack-design-pack), so both shapes parse the same.
function formatLinkedFrom(
  linkedFrom: ReadonlyArray<BacklinkRef>,
): string {
  if (linkedFrom.length === 0) return "(none)";
  return linkedFrom
    .map((link) =>
      link.via !== undefined
        ? `${link.type} ${link.slug} (${link.via.join(", ")})`
        : `${link.type} ${link.slug}`,
    )
    .join(", ");
}
