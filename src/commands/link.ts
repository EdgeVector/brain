// `fbrain link <task-slug> <design-slug>` — set a task's parent design.
// Rejects a non-existent design (no dangling refs).

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteNodeClient } from "../write-context.ts";
import type { Config } from "../config.ts";
import { findBySlug, findBySlugFast, nowIso, schemaHashFor } from "../record.ts";

export type LinkOptions = {
  cfg: Config;
  taskSlug: string;
  designSlug: string;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export async function linkCmd(opts: LinkOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const { node } = newWriteNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
  });

  const taskHash = schemaHashFor("task", opts.cfg);
  const designHash = schemaHashFor("design", opts.cfg);

  // /api/query returns a non-deterministic top-100 slice per schema, so a
  // single findBySlug can miss an existing slug on a schema with >100 rows.
  // The fast-miss helper rides out the saturated-daemon empty-page flake
  // (so a real task on a >100-row schema is still found) but short-circuits
  // on a populated-but-missing page, so a typo'd <task-slug> errors in ~one
  // query instead of burning the full 5×250 ms retry budget. Same helper
  // put.ts / new.ts / resolveBySlug use.
  const task = await findBySlugFast(node, "task", taskHash, opts.taskSlug);
  if (!task) {
    // `link` is directional — <task-slug> first, <design-slug> second — and
    // reversing the two is the most common first-use mistake (the slug the
    // user named as the "task" is really a design). Detect that case and say
    // so explicitly with the corrected command, instead of a bare "No task"
    // that gives no clue the argument order is wrong. Best-effort single
    // lookup: a flaky page miss just falls through to the generic hint.
    const asDesign = await findBySlug(node, "design", designHash, opts.taskSlug);
    const hint = asDesign
      ? `'${opts.taskSlug}' is a design, not a task. \`link\` takes the task first — try \`fbrain link ${opts.designSlug} ${opts.taskSlug}\` (usage: \`fbrain link <task-slug> <design-slug>\`).`
      : `Create the task first (\`fbrain task new ${opts.taskSlug}\`) or check the slug with \`fbrain list --type task\` (usage: \`fbrain link <task-slug> <design-slug>\`).`;
    throw new FbrainError({
      code: "not_found",
      message: `No task: ${opts.taskSlug}`,
      hint,
    });
  }

  const design = await findBySlugFast(node, "design", designHash, opts.designSlug);
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
