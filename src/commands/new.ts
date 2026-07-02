// `fbrain <type> new <slug>` — table-driven record creator.
//
// One creator for all 8 record types. Pre-Phase-6 only `design new` and
// `task new` existed as ergonomic verbs; the other 6 (concept, preference,
// reference, agent, project, spike) were reachable only via `fbrain put
// --type <t>` even though their schemas were fully registered. This shared
// implementation closes that gap without duplicating the slug-exists guard,
// the /api/query top-100 read-flake hedge, or the parent-design dangling-ref
// check across six near-identical copies.
//
// Only `task` has a per-type extra (`--design <slug>`); the others share the
// common option set. The flag is rejected loudly on non-task types rather
// than silently ignored.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { capitalize } from "../format.ts";
import {
  confirmVectorIndexed,
  crossTypeSlugNote,
  findBySlugFast,
  findCrossTypeSlugCollisions,
  findExistingForWrite,
  nowIso,
  type ReadRetryOptions,
  schemaHashFor,
  validateSlug,
  type FbrainRecord,
} from "../record.ts";
import { RECORDS, type RecordType } from "../schemas.ts";
import { updateTagIndexForRecord } from "../tag-index.ts";

export type RecordNewOptions = {
  cfg: Config;
  type: RecordType;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  // Only valid for `task` (the one type with a `design_slug` field). Set
  // on any other type and recordNew rejects with `design_flag_unsupported`
  // before any I/O.
  designSlug?: string;
  force?: boolean;
  verbose?: Verbose;
  // Tunables for the post-write VECTOR-index confirmation (read-after-write
  // `fbrain search` parity — see `confirmVectorIndexed`). Production callers
  // leave this unset and inherit the short bounded budget; tests pin attempts +
  // inject a no-op sleep so a timed-out probe is observable without backoff.
  vectorVerifyOptions?: ReadRetryOptions;
};

export type RecordNewResult = {
  // True when the record persisted but the bounded vector-index confirmation
  // timed out — an immediate `fbrain search` may miss it. Mirrors
  // `PutResult.indexPending`; the CLI prints an honest "index still catching
  // up" note and surfaces it under `--json`.
  indexPending: boolean;
};

export async function recordNew(opts: RecordNewOptions): Promise<RecordNewResult> {
  validateSlug(opts.slug);
  const entry = RECORDS[opts.type];

  if (opts.designSlug && opts.designSlug.length > 0 && !entry.hasDesignSlug) {
    throw new FbrainError({
      code: "design_flag_unsupported",
      message: `--design is only valid for task records (got ${opts.type}).`,
      hint: "Drop --design, or use `fbrain task new` to link a task to a parent design.",
    });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const hash = schemaHashFor(opts.type, opts.cfg);

  if (!opts.force) {
    // Duplicate guard. `findExistingForWrite` rides out the daemon's
    // empty-result `/api/query` flake (which would otherwise let the guard
    // fail open and the createRecord below silently overwrite the row) but
    // short-circuits on a populated page that lacks the slug — so creating a
    // genuinely-new record doesn't burn the full retry budget (~1.1s) on
    // every `<type> new`. Same helper put.ts uses; see its comment in
    // record.ts (supersedes the per-call withReadRetry hedge from PR #53).
    const existing = await findExistingForWrite(node, opts.type, hash, opts.slug);
    if (existing) {
      throw new FbrainError({
        code: "slug_already_exists",
        message: `${capitalize(opts.type)} with slug "${opts.slug}" already exists.`,
        hint:
          opts.type === "task"
            ? "Use --force to overwrite, or pick a different slug."
            : "Use --force to overwrite (re-creates with the values you passed), or pick a different slug.",
      });
    }
  }

  // Validate the design exists, if provided — same dangling-ref rule as link.
  // Uses the fast-miss helper so a real `dangling_design_slug` errors in ~one
  // query (populated design schema, slug absent ⇒ authoritative miss) instead
  // of burning the full 5×250 ms read-retry budget; an empty design page still
  // rides out the saturated-daemon flake, so a valid parent on a >100-row
  // schema is still found. Same helper put.ts uses for its existence check.
  if (entry.hasDesignSlug && opts.designSlug && opts.designSlug.length > 0) {
    const designHash = schemaHashFor("design", opts.cfg);
    const parent = await findBySlugFast(node, "design", designHash, opts.designSlug);
    if (!parent) {
      throw new FbrainError({
        code: "dangling_design_slug",
        message: `Cannot link task "${opts.slug}" to design "${opts.designSlug}" — that design does not exist.`,
        hint: "Create the design first (`fbrain design new ...`), or omit --design.",
      });
    }
  }

  // Cross-type slug-collision NOTE (best-effort, non-fatal). Slugs are unique
  // per-type but allowed to collide across types; every bare-slug read/update
  // verb is keyed by slug, so a cross-type collision quietly arms an
  // `ambiguous_slug` trap for later `get`/`status`/`delete`. Warn the dev at
  // creation, naming `--type` concretely. The probe is swallowed on any error
  // (see findCrossTypeSlugCollisions) so it can never block or fail the create.
  // Gated on `!opts.force` to honor the documented "--force skips the lookups"
  // contract (force is a deliberate re-create from scratch; it does no reads).
  if (!opts.force) {
    const collisions = await findCrossTypeSlugCollisions(node, opts.cfg, opts.type, opts.slug);
    const note = crossTypeSlugNote(opts.type, opts.slug, collisions);
    if (note) console.error(note);
  }

  // --force intentionally skips the lookup and stamps a fresh created_at.
  // It's a deliberate "re-create from scratch" — callers wanting upsert
  // semantics (preserve created_at) should use `fbrain put` instead.
  const now = nowIso();
  const fields: Record<string, unknown> = {
    slug: opts.slug,
    title: opts.title,
    body: opts.body,
    status: entry.defaultStatus,
    tags: opts.tags,
    created_at: now,
    updated_at: now,
  };
  if (entry.hasDesignSlug) {
    fields.design_slug = opts.designSlug ?? "";
  }
  await node.createRecord({ schemaHash: hash, fields, keyHash: opts.slug });
  const indexedRecord: FbrainRecord = {
    slug: opts.slug,
    title: opts.title,
    body: opts.body,
    status: entry.defaultStatus,
    tags: opts.tags,
    created_at: now,
    updated_at: now,
  };
  if (entry.hasDesignSlug) indexedRecord.design_slug = opts.designSlug ?? "";
  await updateTagIndexForRecord(node, opts.cfg, opts.type, indexedRecord);

  // Read-after-write SEARCH parity (#295, CLI half). The native (vector) index
  // `fbrain search` reads is populated asynchronously after the mutation
  // returns, so a human's first `fbrain search` right after `fbrain <type> new`
  // would otherwise get a jarring "no matches" for the record they just made.
  // Confirm the slug is in the vector index on a short bounded budget; on
  // timeout report `indexPending: true` so the CLI prints an honest "index
  // still catching up" note. Gated to local nodes and never throws — see
  // `confirmVectorIndexed`. (No record-list verify-read here: unlike `put`,
  // `<type> new` doesn't promise read-your-writes on /api/query; the vector
  // confirmation is the user-visible search-parity concern.)
  return confirmVectorIndexed(
    opts.cfg,
    opts.type,
    opts.slug,
    opts.title,
    opts.vectorVerifyOptions,
  );
}
