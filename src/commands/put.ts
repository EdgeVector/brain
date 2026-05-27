// `fbrain put <slug>` — read body from stdin, parse YAML-subset
// frontmatter, upsert any of fbrain's record types.
//
// Designed to match the gbrain `put` contract closely enough for the
// `brain` wrapper at ~/.claude/scripts/brain to route writes to fbrain
// transparently when primary=fbrain.
//
// Frontmatter is the gbrain YAML SUBSET, not full YAML:
//   - `key: value` on a single line (inline scalar; quoted optional)
//   - `tags: [a, b]` inline list, or `tags:` followed by `  - a` block list
//   - `type:` and `title:` only have meaning here; other keys are
//     silently ignored (forward-compatible with future fields).
//
// As of Phase 6, every type in RECORDS routes to a real write:
// design / task / concept / preference / reference / agent / project / spike.
// An unrecognised `type:` errors as `unsupported_type`.

import { newNodeClient, FbrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import {
  findBySlug,
  nowIso,
  schemaHashFor,
  validateSlug,
  withReadRetry,
  type FbrainRecord,
} from "../record.ts";
import {
  RECORDS,
  isRecordType,
  type RecordType,
} from "../schemas.ts";

export type PutOptions = {
  cfg: Config;
  slug: string;
  input: string;
  // Override / supply the record type from the command line. Useful when
  // piping schema-less notes: `cat note.md | fbrain put slug --type concept`.
  // If frontmatter also carries `type:` and the two disagree, putCmd errors
  // with `type_conflict` rather than silently picking one.
  typeOverride?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type PutResult = {
  type: RecordType;
  slug: string;
  action: "created" | "updated";
};

export async function putCmd(opts: PutOptions): Promise<PutResult> {
  validateSlug(opts.slug);
  const { frontmatter, body } = splitFrontmatter(opts.input);
  // Refuse a silent-default record when stdin carried nothing: with no
  // frontmatter AND no body the upsert would otherwise mint a blank
  // design row with the slug as title. A scripted `cat $note | fbrain
  // put $slug` where $note is accidentally empty hits this trap.
  // Frontmatter-with-empty-body is still valid (explicit intent).
  if ((frontmatter === null || frontmatter.trim().length === 0) && body.trim().length === 0) {
    throw new FbrainError({
      code: "empty_stdin",
      message: "put: stdin was empty — nothing to write.",
      hint: "Pipe a body (with optional YAML frontmatter) into `fbrain put <slug>`.",
    });
  }
  const parsed = parseFrontmatter(frontmatter);
  const type = resolveRecordType(parsed.type, opts.typeOverride);
  const title = resolveTitle(parsed.title, body, opts.slug);

  const node = newNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    verbose: opts.verbose,
  });
  const hash = schemaHashFor(type, opts.cfg);
  // The fold_db_node `/api/query` endpoint returns a non-deterministic
  // top-100 slice of records per schema, so a single findBySlug call on a
  // schema with >100 rows can miss a slug that genuinely exists (~40%
  // miss rate empirically on a 168-row concept schema). That miss made
  // put fall through to `createRecord`, which re-stamped `created_at` and
  // printed "created" for what was actually an update. withReadRetry is
  // the same hedge `resolveBySlug` already applies to get/status/delete.
  const existing = await withReadRetry(
    () => findBySlug(node, type, hash, opts.slug),
    (r) => r !== null,
  );
  const now = nowIso();

  const fields = buildFields(type, opts.slug, title, body, parsed.tags, existing, now);

  if (existing) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: opts.slug });
    return { type, slug: opts.slug, action: "updated" };
  }
  await node.createRecord({ schemaHash: hash, fields, keyHash: opts.slug });
  return { type, slug: opts.slug, action: "created" };
}

function buildFields(
  type: RecordType,
  slug: string,
  title: string,
  body: string,
  tags: string[],
  existing: FbrainRecord | null,
  now: string,
): Record<string, unknown> {
  const entry = RECORDS[type];
  const base: Record<string, unknown> = {
    slug,
    title,
    body,
    status: existing?.status ?? entry.defaultStatus,
    tags,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  if (entry.hasDesignSlug) {
    base.design_slug = existing?.design_slug ?? "";
  }
  return base;
}

function resolveRecordType(
  fromFrontmatter: string | undefined,
  override: string | undefined,
): RecordType {
  // Why no silent default: the historic fallback was `design`, which is the
  // heaviest opinionated record type (status enum, design_slug machinery).
  // Piping a schema-less note silently created a Design row — a frequent
  // mis-type trap. We now require an explicit signal: either frontmatter
  // `type:` or a `--type` flag.
  const fmType = normaliseType(fromFrontmatter);
  const ovType = normaliseType(override);

  if (fmType && ovType && fmType !== ovType) {
    throw new FbrainError({
      code: "type_conflict",
      message:
        `--type ${ovType} conflicts with frontmatter \`type: ${fmType}\`.`,
      hint: "Drop one — they must agree. Frontmatter and --type can't both be set to different types.",
    });
  }
  const chosen = fmType ?? ovType;
  if (chosen === undefined) {
    throw new FbrainError({
      code: "missing_type",
      message:
        "fbrain put requires a `type:` field in frontmatter (or pass --type <T>).",
      hint: "One of: design | task | concept | preference | reference | agent | project | spike.",
    });
  }
  return chosen;
}

function normaliseType(raw: string | undefined): RecordType | undefined {
  if (raw === undefined || raw === "") return undefined;
  const normalised = raw.toLowerCase();
  if (isRecordType(normalised)) return normalised;
  throw new FbrainError({
    code: "unsupported_type",
    message: `type "${raw}" is not a recognised fbrain record type.`,
    hint:
      "Supported: design | task | concept | preference | reference | agent | project | spike. " +
      "Check spelling or pick the closest type.",
  });
}

function resolveTitle(
  raw: string | undefined,
  body: string,
  slug: string,
): string {
  if (raw && raw.length > 0) return raw;
  const h1 = firstH1(body);
  if (h1) return h1;
  return slug;
}

function firstH1(body: string): string | null {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = line.match(/^#\s+(.+)$/);
    return m ? m[1]!.trim() : null;
  }
  return null;
}

export type ParsedFrontmatter = {
  type: string | undefined;
  title: string | undefined;
  tags: string[];
  raw: Record<string, string | string[]>;
};

export function splitFrontmatter(input: string): {
  frontmatter: string | null;
  body: string;
} {
  // Allow a trailing newline (or none) after the closing `---`.
  // Don't anchor to the entire string — body may follow.
  const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: null, body: input.replace(/(?:\r?\n)+$/, "") };
  const frontmatter = match[1] ?? "";
  const body = input.slice(match[0].length).replace(/(?:\r?\n)+$/, "");
  return { frontmatter, body };
}

export function parseFrontmatter(raw: string | null): ParsedFrontmatter {
  const out: ParsedFrontmatter = {
    type: undefined,
    title: undefined,
    tags: [],
    raw: {},
  };
  if (raw === null || raw.trim().length === 0) return out;

  const lines = raw.split(/\r?\n/);
  let currentListKey: string | null = null;
  let currentList: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      currentListKey = null;
      currentList = null;
      continue;
    }

    // Block-list continuation: `  - item` for the most recent key whose
    // value was empty / placeholder.
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(listMatch[1]!.trim()));
      continue;
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) {
      throw new FbrainError({
        code: "frontmatter_malformed",
        message: `Frontmatter line ${i + 1} is not "key: value": ${JSON.stringify(line)}.`,
        hint: "fbrain accepts a YAML SUBSET: `key: value` per line, optional inline `[a, b]`, optional block `\\n  - a`.",
      });
    }

    const key = kv[1]!;
    const value = kv[2]!.trim();

    // Inline list `[a, b, c]`?
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      const items =
        inner.length === 0
          ? []
          : inner.split(",").map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
      out.raw[key] = items;
      if (key === "tags") out.tags = items;
      currentListKey = null;
      currentList = null;
      continue;
    }

    if (value.length === 0) {
      // Block-list opener — subsequent indented `- item` lines belong here.
      const list: string[] = [];
      out.raw[key] = list;
      if (key === "tags") out.tags = list;
      currentListKey = key;
      currentList = list;
      continue;
    }

    const stripped = stripQuotes(value);
    out.raw[key] = stripped;
    if (key === "type") out.type = stripped;
    else if (key === "title") out.title = stripped;
    currentListKey = null;
    currentList = null;
  }

  // Suppress unused-var warning while preserving meaning.
  void currentListKey;
  return out;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
