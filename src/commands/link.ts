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
  // Trim surrounding whitespace on both slugs to mirror `put`'s silent
  // normalization (put.ts: `resolveSlug` calls `.trim()` on both the
  // positional arg and the frontmatter `slug:`). Without this, a task
  // created via `fbrain put " t1 "` is stored under slug "t1" but
  // `fbrain link " t1 " " d1 "` fails with `not_found` /
  // `dangling_design_slug` because the lookup compares the untrimmed input
  // against the trimmed stored slugs — the same asymmetric key-normalization
  // PR #184 just fixed for `delete`. Trim once at the top and thread the
  // normalized values through the lookups, the parent-ref write, the update
  // mutation's keyHash, and the success line.
  const taskSlug = opts.taskSlug.trim();
  const designSlug = opts.designSlug.trim();
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
  const task = await findBySlugFast(node, "task", taskHash, taskSlug);
  if (!task) {
    // `link` is directional — <task-slug> first, <design-slug> second — and
    // reversing the two is the most common first-use mistake (the slug the
    // user named as the "task" is really a design). Detect that case and say
    // so explicitly with the corrected command, instead of a bare "No task"
    // that gives no clue the argument order is wrong. Best-effort single
    // lookup: a flaky page miss just falls through to the generic hint.
    const asDesign = await findBySlug(node, "design", designHash, taskSlug);
    const hint = asDesign
      ? `'${taskSlug}' is a design, not a task. \`link\` takes the task first — try \`fbrain link ${designSlug} ${taskSlug}\` (usage: \`fbrain link <task-slug> <design-slug>\`).`
      : `Create the task first (\`fbrain task new ${taskSlug}\`) or check the slug with \`fbrain list --type task\` (usage: \`fbrain link <task-slug> <design-slug>\`).`;
    throw new FbrainError({
      code: "not_found",
      message: `No task: ${taskSlug}`,
      hint,
    });
  }

  const design = await findBySlugFast(node, "design", designHash, designSlug);
  if (!design) {
    throw new FbrainError({
      code: "dangling_design_slug",
      message: `No design: ${designSlug}`,
      hint: "Create the design first (`fbrain design new ...`).",
    });
  }

  const now = nowIso();
  const fields = {
    slug: task.slug,
    title: task.title,
    body: task.body,
    status: task.status,
    design_slug: designSlug,
    tags: task.tags,
    created_at: task.created_at,
    updated_at: now,
  };

  await node.updateRecord({
    schemaHash: taskHash,
    keyHash: taskSlug,
    fields,
  });

  print(`linked task ${taskSlug} → design ${designSlug}`);
}
