// `fbrain get <slug> [--type T]` — print a record.
// If --type is omitted, queries every registered schema. If found in
// multiple schemas, prints all matches and tells the user to specify --type.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlug,
  schemaHashFor,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import { RECORDS, RECORD_TYPES, type RecordType } from "../schemas.ts";

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

  const types: readonly RecordType[] = opts.type ? [opts.type] : RECORD_TYPES;
  // Retry the full per-type sweep on an empty result to ride out the
  // polluted-daemon read flake — see withReadRetry in ../record.ts.
  const found = await withReadRetry(
    async () => {
      const matches: Array<{ type: RecordType; record: FbrainRecord }> = [];
      for (const t of types) {
        const r = await findBySlug(node, t, schemaHashFor(t, opts.cfg), opts.slug);
        if (r) matches.push({ type: t, record: r });
      }
      return matches;
    },
    (matches) => matches.length > 0,
  );

  if (found.length === 0) {
    if (opts.type) {
      throw new FbrainError({
        code: "not_found",
        message: `No ${opts.type}: ${opts.slug}`,
      });
    }
    throw new FbrainError({
      code: "not_found",
      message: `No record with slug "${opts.slug}".`,
    });
  }

  if (found.length > 1) {
    for (const { type, record } of found) print(formatRecord(record, type));
    const matchedTypes = found.map((f) => f.type).join(", ");
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists in multiple schemas (${matchedTypes}). Specify --type.`,
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
