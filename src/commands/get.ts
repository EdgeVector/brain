// `fbrain get <slug> [--type T]` — print a record.
// If --type is omitted, queries every registered schema. If found in
// multiple schemas, prints all matches and tells the user to specify --type.

import { newNodeClient, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { resolveBySlug, type FbrainRecord } from "../record.ts";
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

  print(formatRecord(found.record, found.type));
}

export function formatRecord(r: FbrainRecord, type: RecordType): string {
  const lines = [
    `[${type}] ${r.slug}`,
    `title:      ${r.title}`,
    `status:     ${r.status}`,
    `tags:       ${r.tags.length === 0 ? "(none)" : r.tags.join(", ")}`,
  ];
  if (RECORDS[type].hasDesignSlug) {
    lines.push(`design:     ${r.design_slug && r.design_slug.length > 0 ? r.design_slug : "(none)"}`);
  }
  lines.push(`created_at: ${r.created_at}`);
  lines.push(`updated_at: ${r.updated_at}`);
  if (r.body.length > 0) {
    lines.push("---");
    lines.push(r.body);
  }
  return lines.join("\n");
}
