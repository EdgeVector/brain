// `fbrain get <slug> [--type T]` — print a record.
// If --type is omitted, queries every registered schema. If found in
// multiple schemas, prints all matches and tells the user to specify --type.

import { newNodeClient, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlugFast,
  resolveBySlug,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { RECORDS, type RecordType } from "../schemas.ts";

export type GetOptions = {
  cfg: Config;
  slug: string;
  type?: RecordType;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function getRecord(opts: GetOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const found = await resolveBySlug({
    node,
    cfg: opts.cfg,
    slug: opts.slug,
    type: opts.type,
    notFoundMessage: { typed: (t, s) => `No ${t}: ${s}` },
    onAmbiguous: (matches) => {
      for (const { type, record } of matches) print(formatRecord(record, type));
    },
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

  print(formatRecord(found.record, found.type, designMissing));
}

export function formatRecord(
  r: FbrainRecord,
  type: RecordType,
  designMissing = false,
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
  lines.push(`created_at: ${r.created_at}`);
  lines.push(`updated_at: ${r.updated_at}`);
  if (r.body.length > 0) {
    lines.push("---");
    lines.push(r.body);
  }
  return lines.join("\n");
}
