// `fbrain status <slug>` — read (getter, respects read-verb instinct).
// `fbrain status <slug> <new-status>` — update.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  ensureStatus,
  findBySlug,
  nowIso,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import type { RecordType } from "../schemas.ts";

export type StatusOptions = {
  cfg: Config;
  slug: string;
  newStatus?: string;
  type?: RecordType;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function statusCmd(opts: StatusOptions): Promise<void> {
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
    throw new FbrainError({
      code: "not_found",
      message: `No design or task with slug "${opts.slug}".`,
    });
  }
  if (found.length > 1) {
    throw new FbrainError({
      code: "ambiguous_slug",
      message: `Slug "${opts.slug}" exists as both a design and a task. Specify --type.`,
    });
  }
  const only = found[0]!;

  if (opts.newStatus === undefined) {
    print(only.record.status);
    return;
  }

  ensureStatus(only.type, opts.newStatus);

  const hash = schemaHashFor(only.type, opts.cfg);
  const now = nowIso();
  const fields: Record<string, unknown> = {
    ...only.record,
    status: opts.newStatus,
    updated_at: now,
  };
  // Re-shape the array tags + design_slug for tasks.
  if (only.type === "design") delete fields.design_slug;
  await node.updateRecord({
    schemaHash: hash,
    keyHash: opts.slug,
    fields,
  });
  print(`${only.type} ${opts.slug}: ${only.record.status} → ${opts.newStatus}`);
}
