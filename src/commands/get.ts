// `fbrain get <slug> [--type T]` — print a record.
// If --type is omitted, queries every registered schema. If the slug exists in
// multiple schemas, throws `ambiguous_slug` (stderr-only, exit 1, no stdout) —
// byte-consistent with `status` / `delete`, so a script doing
// `r=$(fbrain get foo)` either captures one record cleanly or sees a failure.

import { newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlugFast,
  findChildTasksByDesign,
  NOT_FOUND_TYPED,
  normalizeSlug,
  resolveBySlug,
  schemaHashFor,
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
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function getRecord(opts: GetOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const slug = normalizeSlug(opts.slug);
  const node = newReadClientFromCfg(opts.cfg, opts.verbose);

  const found = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug,
    type: opts.type,
    notFoundMessage: NOT_FOUND_TYPED,
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
    const parent = await findBySlugFast(node, "design", designHash, designSlug);
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
    );
  }

  if (opts.json) {
    print(JSON.stringify(recordToJson(found.record, found.type, designMissing, designChildren)));
    return;
  }

  print(formatRecord(found.record, found.type, designMissing, designChildren));
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
  // Only present for type=design — child task summaries for the
  // reverse-direction parent ↔ child link the human surface renders
  // on the `tasks:` line.
  children?: Array<{ slug: string; status: string }>;
  created_at: string;
  updated_at: string;
  body: string;
};

export function recordToJson(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
  children?: ReadonlyArray<FbrainRecord>,
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
  if (type === "design" && children !== undefined) {
    const sorted = sortChildrenByUpdated(children);
    out.children = sorted.map((t) => ({ slug: t.slug, status: t.status }));
  }
  return out;
}

function sortChildrenByUpdated(
  children: ReadonlyArray<FbrainRecord>,
): FbrainRecord[] {
  return [...children].sort((a, b) => {
    const ts = Date.parse(b.updated_at) - Date.parse(a.updated_at);
    return ts !== 0 ? ts : a.slug.localeCompare(b.slug);
  });
}

export function formatRecord(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
  children?: ReadonlyArray<FbrainRecord>,
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
  lines.push(`created_at: ${r.created_at}`);
  lines.push(`updated_at: ${r.updated_at}`);
  if (r.body.length > 0) {
    lines.push("---");
    lines.push(r.body);
  }
  return lines.join("\n");
}
