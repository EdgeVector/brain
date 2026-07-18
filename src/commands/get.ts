// `fbrain get <slug> [--type T]` — print a record.
// If --type is omitted, queries every registered schema. If the slug exists in
// multiple schemas, returns the match selected by GET_RECORD_TYPE_PRECEDENCE.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import { findBacklinks } from "../backlink-index.ts";
import type { Config } from "../config.ts";
import { printFieldProjection } from "../field-projection.ts";
import { resolvePrintSink } from "../format.ts";
import {
  compareByUpdatedThenSlug,
  findBySlug,
  findChildTasksByDesign,
  GET_RECORD_TYPE_PRECEDENCE,
  NOT_FOUND_TYPED,
  normalizeSlug,
  resolveBySlug,
  schemaHashFor,
  type Backlink,
  type FbrainRecord,
} from "../record.ts";
import { RECORDS, type RecordType } from "../schemas.ts";

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
};

export async function getRecord(opts: GetOptions): Promise<void> {
  const print = resolvePrintSink(opts);
  const slug = normalizeSlug(opts.slug);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

  const found = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    notFoundMessage: NOT_FOUND_TYPED,
    recoveryVerb: "get",
    ambiguousTypePrecedence:
      opts.type === undefined ? GET_RECORD_TYPE_PRECEDENCE : undefined,
    normalizedSlugFallback: true,
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
    const parent = await findBySlug(node, "design", designHash, designSlug);
    designMissing = parent === null;
  }

  // Reverse direction of the same link: when the record IS a design, list its
  // child tasks so the parent ↔ child relationship is visible both ways. Gated
  // on `found.type === "design"` so the other 7 record types pay zero
  // additional cost; `findChildTasksByDesign` shares the empty-page cap with
  // the forward dangling-ref probe above, so a childless design on a fresh
  // node stays cheap (no full 5× retry burn).
  let designChildren: FbrainRecord[] | undefined;
  if (found.type === "design") {
    const taskHash = schemaHashFor("task", opts.cfg);
    designChildren = await findChildTasksByDesign(
      node,
      taskHash,
      found.record.slug,
      opts.cfg,
    );
  }

  const linkedFrom = await findBacklinks(node, opts.cfg, found.record.slug, {
    targetType: found.type,
    verbose: opts.verbose,
  });

  // Built unconditionally (not just under --json) so the `onResult`
  // structured sink and the `--json` stdout document are the SAME value
  // — the MCP `structuredContent` can't drift from the CLI JSON shape.
  const recordForOutput =
    opts.bodyLimit === undefined
      ? found.record
      : { ...found.record, body: truncateBody(found.record.body, opts.bodyLimit) };
  const json = recordToJson(
    recordForOutput,
    found.type,
    designMissing,
    designChildren,
    linkedFrom,
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
    ),
  );
}

function truncateBody(body: string, limit: number): string {
  return body.length > limit ? body.slice(0, limit) : body;
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
  // Records that link to this slug, either through an explicit stored edge
  // (`task.design_slug` or a generic `link:<type>:<slug>` tag) or through a
  // `[[slug]]` body reference.
  linked_from?: Array<{
    type: RecordType;
    slug: string;
    status: string;
    via: Array<"explicit" | "body">;
  }>;
  created_at: string;
  updated_at: string;
  body: string;
};

export function recordToJson(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
  children?: ReadonlyArray<FbrainRecord>,
  linkedFrom?: ReadonlyArray<Backlink>,
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
  }
  if (type === "design" && children !== undefined) {
    const sorted = sortChildrenByUpdated(children);
    out.children = sorted.map((t) => ({ slug: t.slug, status: t.status }));
  }
  if (linkedFrom !== undefined) {
    out.linked_from = linkedFrom.map((link) => ({
      type: link.type,
      slug: link.slug,
      status: link.status,
      via: link.via,
    }));
  }
  return out;
}

function sortChildrenByUpdated(
  children: ReadonlyArray<FbrainRecord>,
): FbrainRecord[] {
  return [...children].sort(compareByUpdatedThenSlug);
}

export function formatRecord(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
  children?: ReadonlyArray<FbrainRecord>,
  linkedFrom?: ReadonlyArray<Backlink>,
): string {
  const lines = [
    `[${type}] ${r.slug}`,
    `title:      ${r.title}`,
    `status:     ${r.status}`,
    `tags:       ${r.tags.length === 0 ? "(none)" : r.tags.join(", ")}`,
  ];
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
  if (type === "design" && children !== undefined) {
    if (children.length === 0) {
      lines.push("tasks:      (none)");
    } else {
      const sorted = sortChildrenByUpdated(children);
      const rendered = sorted
        .map((t) => `${t.slug} (${t.status})`)
        .join(", ");
      lines.push(`tasks:      ${rendered}`);
    }
  }
  if (linkedFrom !== undefined) {
    lines.push(
      `linked_from: ${formatLinkedFrom(
        linkedFrom.map((link) => ({
          type: link.type,
          slug: link.slug,
          status: link.status,
          via: link.via,
        })),
      )}`,
    );
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
    `tags:       ${json.tags.length === 0 ? "(none)" : json.tags.join(", ")}`,
  ];
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
  if (json.type === "design" && json.children !== undefined) {
    if (json.children.length === 0) {
      lines.push("tasks:      (none)");
    } else {
      const rendered = json.children
        .map((t) => `${t.slug} (${t.status})`)
        .join(", ");
      lines.push(`tasks:      ${rendered}`);
    }
  }
  if (json.linked_from !== undefined) {
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

function formatLinkedFrom(
  linkedFrom: NonNullable<RecordJson["linked_from"]>,
): string {
  if (linkedFrom.length === 0) return "(none)";
  return linkedFrom
    .map((link) => `${link.type} ${link.slug} (${link.via.join(", ")})`)
    .join(", ");
}
