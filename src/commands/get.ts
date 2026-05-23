// `fbrain get <slug> [--type design|task]` — print a record.
// If --type is omitted, queries both schemas. If found in both, prints both
// and tells the user to specify --type.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlug,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";

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

  const types: RecordType[] = opts.type ? [opts.type] : ["design", "task"];
  const found: Array<{ type: RecordType; record: FbrainRecord }> = [];
  for (const t of types) {
    const r = await findBySlug(node, t, schemaHashFor(t, opts.cfg), opts.slug);
    if (r) found.push({ type: t, record: r });
  }

  if (found.length === 0) {
    if (opts.type) {
      throw new FbrainError({
        code: "not_found",
        message: `No ${opts.type}: ${opts.slug}`,
      });
    }
    throw new FbrainError({
      code: "not_found",
      message: `No design or task with slug "${opts.slug}".`,
    });
  }

  if (found.length > 1) {
    for (const { type, record } of found) print(formatRecord(record, type));
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists as both a design and a task. Specify --type.`,
    });
  }

  const only = found[0]!;
  print(formatRecord(only.record, only.type));
}

export function formatRecord(r: FbrainRecord, type: RecordType): string {
  const lines = [
    `[${type}] ${r.slug}`,
    `title:      ${r.title}`,
    `status:     ${r.status}`,
    `tags:       ${r.tags.length === 0 ? "(none)" : r.tags.join(", ")}`,
  ];
  if (type === "task") lines.push(`design:     ${r.design_slug && r.design_slug.length > 0 ? r.design_slug : "(none)"}`);
  lines.push(`created_at: ${r.created_at}`);
  lines.push(`updated_at: ${r.updated_at}`);
  if (r.body.length > 0) {
    lines.push("---");
    lines.push(r.body);
  }
  return lines.join("\n");
}
