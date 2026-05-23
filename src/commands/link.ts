// `fbrain link <task-slug> <design-slug>` — set a task's parent design.
// Rejects a non-existent design (no dangling refs).

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { findBySlug, nowIso, schemaHashFor } from "../record.ts";

export type LinkOptions = {
  cfg: Config;
  taskSlug: string;
  designSlug: string;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function linkCmd(opts: LinkOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });

  const taskHash = schemaHashFor("task", opts.cfg);
  const designHash = schemaHashFor("design", opts.cfg);

  const task = await findBySlug(node, "task", taskHash, opts.taskSlug);
  if (!task) {
    throw new FbrainError({
      code: "not_found",
      message: `No task: ${opts.taskSlug}`,
    });
  }

  const design = await findBySlug(node, "design", designHash, opts.designSlug);
  if (!design) {
    throw new FbrainError({
      code: "dangling_design_slug",
      message: `No design: ${opts.designSlug}`,
      hint: "Create the design first (`fbrain design new ...`).",
    });
  }

  const now = nowIso();
  const fields = {
    slug: task.slug,
    title: task.title,
    body: task.body,
    status: task.status,
    design_slug: opts.designSlug,
    tags: task.tags,
    created_at: task.created_at,
    updated_at: now,
  };

  await node.updateRecord({
    schemaHash: taskHash,
    keyHash: opts.taskSlug,
    fields,
  });

  print(`linked task ${opts.taskSlug} → design ${opts.designSlug}`);
}
