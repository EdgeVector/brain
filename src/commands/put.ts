// `fbrain put [<slug>]` — read body from stdin, parse YAML-subset
// frontmatter, upsert any of fbrain's record types. The slug may be
// passed as a positional arg or set via frontmatter `slug:` — at least
// one is required, and disagreement between the two errors with
// `slug_conflict` (mirrors the `type_conflict` contract).
//
// Designed to match the gbrain `put` contract closely enough for the
// `brain` wrapper at ~/.claude/scripts/brain to route writes to fbrain
// transparently when primary=fbrain.
//
// Frontmatter is the gbrain YAML SUBSET, not full YAML:
//   - `key: value` on a single line (inline scalar; quoted optional)
//   - `tags: [a, b]` inline list, or `tags:` followed by `  - a` block list
//   - `slug:`, `type:`, `title:`, `status:`, and `tags:` have meaning here;
//     other keys are silently ignored (forward-compatible with future fields).
//
// As of Phase 6, every type in RECORDS routes to a real write:
// design / task / concept / preference / reference / agent / project / spike.
// An unrecognised `type:` errors as `unsupported_type`.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteNodeClient } from "../write-context.ts";
import type { Config } from "../config.ts";
import {
  ensureStatus,
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
  // Slug from the CLI positional arg. Optional because the slug may instead
  // be supplied via frontmatter `slug:`. If both are set and disagree,
  // putCmd errors with `slug_conflict`; if neither is set, `missing_slug`.
  slug?: string;
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
  const slug = resolveSlug(opts.slug, parsed.slug);
  validateSlug(slug);
  const type = resolveRecordType(parsed.type, opts.typeOverride);
  const title = resolveTitle(parsed.title, body, slug);
  // Validate status against the resolved type's enum BEFORE any HTTP
  // traffic so a bad status — typo or wrong enum for the type — never
  // racks up a network round-trip. Mirrors validateSlug's pre-flight.
  if (parsed.status !== undefined) ensureStatus(type, parsed.status);

  const { node } = newWriteNodeClient({
    baseUrl: opts.cfg.nodeUrl,
    userHash: opts.cfg.userHash,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
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
    () => findBySlug(node, type, hash, slug),
    (r) => r !== null,
  );
  const now = nowIso();

  const fields = buildFields(type, slug, title, body, parsed.tags, parsed.status, existing, now);

  if (existing) {
    await node.updateRecord({ schemaHash: hash, fields, keyHash: slug });
    return { type, slug, action: "updated" };
  }
  await node.createRecord({ schemaHash: hash, fields, keyHash: slug });
  return { type, slug, action: "created" };
}

function buildFields(
  type: RecordType,
  slug: string,
  title: string,
  body: string,
  tags: string[],
  // Optional explicit status from frontmatter `status:`. When set, it
  // wins over the existing record's status (so a `put` that carries
  // `status: in_progress` actually lands that status) and over the
  // type's default. Validated by the caller via `ensureStatus` before
  // we get here — invalid values can't reach this point.
  status: string | undefined,
  existing: FbrainRecord | null,
  now: string,
): Record<string, unknown> {
  const entry = RECORDS[type];
  const base: Record<string, unknown> = {
    slug,
    title,
    body,
    status: status ?? existing?.status ?? entry.defaultStatus,
    tags,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  if (entry.hasDesignSlug) {
    base.design_slug = existing?.design_slug ?? "";
  }
  return base;
}

function resolveSlug(
  positional: string | undefined,
  fromFrontmatter: string | undefined,
): string {
  // Mirror the resolveRecordType contract: positional and frontmatter are
  // peers — either one supplies the value, both must agree if both are set,
  // and missing-from-both is a specific error (not a usage dump).
  const posTrim = positional?.trim() ?? "";
  const fmTrim = fromFrontmatter?.trim() ?? "";
  const pos = posTrim.length > 0 ? posTrim : undefined;
  const fm = fmTrim.length > 0 ? fmTrim : undefined;

  if (pos && fm && pos !== fm) {
    throw new FbrainError({
      code: "slug_conflict",
      message:
        `positional slug "${pos}" conflicts with frontmatter \`slug: ${fm}\`.`,
      hint: "Drop one — they must agree. Frontmatter and the positional arg can't be set to different slugs.",
    });
  }
  const chosen = pos ?? fm;
  if (chosen === undefined) {
    throw new FbrainError({
      code: "missing_slug",
      message: "fbrain put requires a slug — pass it as a positional arg or set `slug:` in frontmatter.",
      hint: "Example: `fbrain put my-note` OR include `slug: my-note` in the YAML frontmatter.",
    });
  }
  return chosen;
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
  slug: string | undefined;
  type: string | undefined;
  title: string | undefined;
  // Optional explicit status from frontmatter `status:`. Untyped (a free
  // string) at parse time — the caller validates it against the record
  // type's enum via `ensureStatus` once the type is resolved.
  status: string | undefined;
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
    slug: undefined,
    type: undefined,
    title: undefined,
    status: undefined,
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
          : splitInlineListItems(inner)
              .map((s) => stripQuotes(s.trim()))
              .filter((s) => s.length > 0);
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
    if (key === "slug") out.slug = stripped;
    else if (key === "type") out.type = stripped;
    else if (key === "title") out.title = stripped;
    else if (key === "status") out.status = stripped;
    currentListKey = null;
    currentList = null;
  }

  // Suppress unused-var warning while preserving meaning.
  void currentListKey;
  return out;
}

// Split an inline-list inner body (the text between `[` and `]`) on commas,
// but treat commas that fall inside a double- or single-quoted scalar as part
// of the scalar. The naive `inner.split(",")` mangles `tags: ["a,b", "c"]`
// into `["\"a", "b\"", "c"]` — a silent corruption on every write whose tag
// (or future inline-list field) happens to carry a literal comma. The MCP
// `buildPutInput` always quotes tags with commas, so this fires through the
// MCP put path verbatim and through any CLI user typing the documented YAML
// subset; mirrors YAML's inline-flow rule that a quoted scalar's interior
// commas belong to the scalar.
//
// Inside a double-quoted scalar, `\"` and `\\` are escape sequences (matching
// what the MCP serializer in `yamlScalar` emits): a backslash defers the next
// char so an escaped quote doesn't terminate the scalar and a `,` after it
// isn't treated as a separator. Single quotes carry no escapes in YAML, so
// they're passed through verbatim.
function splitInlineListItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < inner.length) {
    const ch = inner.charAt(i);
    if (quote === '"' && ch === "\\" && i + 1 < inner.length) {
      // Defer the escape pair as-is; `stripQuotes` un-escapes after split.
      current += ch + inner.charAt(i + 1);
      i += 2;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      items.push(current);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  items.push(current);
  return items;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if (first === '"' && last === '"') {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (first === "'" && last === "'") {
    return value.slice(1, -1);
  }
  return value;
}

// Reverse the `yamlScalar` MCP serializer: `\\` → `\`, `\"` → `"`. Pass any
// other `\X` through unchanged (the serializer never emits them, and YAML's
// fuller escape table — `\n`, `\t`, `\uXXXX`, … — is out of scope for this
// subset). Without this, a tag like `a\b` round-trips as `a\\b` and `a"b`
// round-trips as `a\"b`.
function unescapeDoubleQuoted(inner: string): string {
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner.charAt(i);
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner.charAt(i + 1);
      if (next === "\\" || next === '"') {
        out += next;
        i += 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
