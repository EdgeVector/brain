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
  findExistingForWrite,
  nowIso,
  schemaHashFor,
  validateSlug,
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
  // Decide create-vs-update. A naive single `findBySlug` could miss an
  // existing slug when the daemon's `/api/query` flakes its schema to an
  // empty result, falling through to `createRecord` (which re-stamps
  // `created_at` and prints "created" for what was actually an update).
  // `findExistingForWrite` rides out that empty-result flake but — unlike a
  // blanket `withReadRetry(findBySlug, r => r !== null)` — short-circuits on
  // a populated page that simply lacks the slug, so a genuinely-new slug
  // doesn't burn the whole retry budget (~1.1s) on every create. See the
  // helper's comment in record.ts.
  const existing = await findExistingForWrite(node, type, hash, slug);
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
  // Optional explicit tags from frontmatter `tags:`. When the user wrote
  // any `tags:` line — including `tags: []` — the parsed array wins (so
  // an explicit clear is honored). When the user did NOT write `tags:`
  // at all, this is `undefined` and existing tags are preserved on
  // update, mirroring how `status` handles absence. Pre-fix, the parser
  // defaulted to `[]` and a re-put without `tags:` silently clobbered
  // the existing record's tags.
  tags: string[] | undefined,
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
    tags: tags ?? existing?.tags ?? [],
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
  // Optional tags list. `undefined` means the user did not write a `tags:`
  // line at all (so `buildFields` should preserve existing tags on update);
  // an empty `[]` means the user explicitly wrote `tags: []` (so existing
  // tags should be cleared). Mirrors how `status` distinguishes "absent"
  // from "explicit" — without this, a re-put that omits `tags:` silently
  // clobbered the existing record's tags to `[]`.
  tags: string[] | undefined;
  raw: Record<string, string | string[]>;
};

export function splitFrontmatter(input: string): {
  frontmatter: string | null;
  body: string;
} {
  // No opening fence → no frontmatter; strip a trailing newline so the body
  // round-trips cleanly when re-emitted.
  const opening = input.match(/^---\r?\n/);
  if (!opening) {
    return { frontmatter: null, body: input.replace(/(?:\r?\n)+$/, "") };
  }
  // Two-step scan (open then close) rather than one big regex so an
  // opened-but-not-closed fence is detectable. The old single regex used a
  // lazy `[\s\S]*?\r?\n---` that ALSO required at least one newline of
  // content between the fences — meaning `---\n---\n` (empty frontmatter)
  // failed to match too. Both flavors fell through to "no frontmatter,
  // body = entire input verbatim", which silently dropped the user's
  // YAML keys and pasted the `---` text into the body — a script that
  // truncates stdin then writes via `fbrain put <slug> --type X` saw a
  // record with YAML-looking gunk in its body and no parsed title/type.
  //
  // Closing fence may sit at the very start of the remainder (empty
  // frontmatter) or be preceded by a newline; trailed by a newline or EOF.
  const after = input.slice(opening[0].length);
  const close = after.match(/(?:^|\r?\n)---(?:\r?\n|$)/);
  if (!close) {
    throw new FbrainError({
      code: "frontmatter_unclosed",
      message: "Frontmatter opened with `---` but never closed.",
      hint: "Add a closing `---` on its own line before the body, or drop the leading `---` if you didn't mean to write frontmatter.",
    });
  }
  const closeStart = close.index!;
  const frontmatter = after.slice(0, closeStart);
  const body = after.slice(closeStart + close[0].length).replace(/(?:\r?\n)+$/, "");
  return { frontmatter, body };
}

export function parseFrontmatter(raw: string | null): ParsedFrontmatter {
  const out: ParsedFrontmatter = {
    slug: undefined,
    type: undefined,
    title: undefined,
    status: undefined,
    tags: undefined,
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

    // Block scalar header — `>`/`|` optionally followed by a chomping indicator
    // (`-`/`+`) and/or an explicit indent digit. Consume more-indented
    // continuation lines as the scalar body. Pre-fix, a folded title like
    //   title: >-
    //     A long title that
    //     wraps across lines
    // stored the literal `>-` as the title and threw `frontmatter_malformed`
    // on the indented continuation lines — see #7852b. Pragmatic YAML 1.2:
    // common-case folding + chomping, no anchors/tags/explicit-indent edge
    // cases beyond the indicator digit (which we honor).
    // YAML allows the chomping indicator and explicit indent digit in either
    // order: `>2-` and `>-2` both mean "fold, strip, indent 2".
    const blockHeader = value.match(/^([>|])(?:([-+])([1-9])?|([1-9])([-+])?)?$/);
    if (blockHeader) {
      const style = blockHeader[1] as ">" | "|";
      const chomp = ((blockHeader[2] ?? blockHeader[5] ?? "") as "" | "-" | "+");
      const indentDigit = blockHeader[3] ?? blockHeader[4];
      const explicitIndent = indentDigit ? parseInt(indentDigit, 10) : 0;
      const bodyLines: string[] = [];
      let blockIndent = explicitIndent;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        const ws = next.match(/^(\s*)(.*)$/)!;
        const leading = ws[1]!.length;
        const content = ws[2]!;
        if (content.length === 0) {
          // Blank line: part of the block; may be trimmed by chomping later.
          bodyLines.push("");
          j++;
          continue;
        }
        // De-indented (column 0) non-blank line ends the block — it's the
        // next frontmatter key, since keys live at column 0.
        if (leading === 0) break;
        if (blockIndent === 0) blockIndent = leading;
        if (leading < blockIndent) break;
        bodyLines.push(next.slice(blockIndent));
        j++;
      }
      // Advance the outer loop past the lines we just consumed.
      i = j - 1;

      const folded = foldBlockScalar(style, chomp, bodyLines);
      out.raw[key] = folded;
      if (key === "slug") out.slug = folded;
      else if (key === "type") out.type = folded;
      else if (key === "title") out.title = folded;
      else if (key === "status") out.status = folded;
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

// Apply YAML block-scalar folding + chomping. Pragmatic subset:
//   |  literal: preserve every line break verbatim.
//   >  folded:  consecutive non-empty lines join with a single space;
//               a blank line in the middle becomes a single `\n`.
// Chomping suffix:
//   -  strip — no trailing newline.
//   +  keep — preserve all trailing blank lines as `\n`s.
//   '' (clip) — exactly one trailing newline if the body had content.
// These feed scalar fields (title/status/slug/type/raw[k]); leading-quote
// stripping intentionally not applied (the scalar body is the text).
function foldBlockScalar(
  style: ">" | "|",
  chomp: "" | "-" | "+",
  bodyLines: string[],
): string {
  // Count trailing blank lines so chomping can decide whether to keep them,
  // then strip them off the working buffer for folding.
  let trailingBlanks = 0;
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
    trailingBlanks++;
    bodyLines.pop();
  }

  let folded: string;
  if (style === "|") {
    folded = bodyLines.join("\n");
  } else {
    // Folded: walk lines, join non-blank runs with a single space; each
    // blank line in the middle emits one `\n`.
    let buf = "";
    let prevBlank = false;
    let started = false;
    for (const ln of bodyLines) {
      if (ln === "") {
        buf += "\n";
        prevBlank = true;
        continue;
      }
      if (!started) {
        buf = ln;
        started = true;
        prevBlank = false;
        continue;
      }
      if (prevBlank) {
        buf += ln;
      } else {
        buf += " " + ln;
      }
      prevBlank = false;
    }
    folded = buf;
  }

  if (chomp === "-") return folded;
  if (chomp === "+") {
    return folded + "\n".repeat(trailingBlanks + (folded.length > 0 ? 1 : 0));
  }
  // Clip (default): one trailing newline if body had any content.
  return folded.length > 0 ? folded + "\n" : folded;
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

// Reverse the `yamlScalar` MCP serializer: `\\` → `\`, `\"` → `"`,
// `\n` → newline, `\r` → CR. Pass any other `\X` through unchanged (the
// serializer never emits them, and YAML's fuller escape table — `\t`,
// `\uXXXX`, … — is out of scope for this subset). Without `\n`/`\r`
// unescaping, a multi-line title via MCP failed twice: the serializer
// would have emitted a raw newline inside the quotes and broken the
// line-based parser before getting here — that side is fixed in
// `yamlScalar` by escaping newlines first. This side closes the round
// trip so the unescaped value matches what the agent passed in.
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
      if (next === "n") {
        out += "\n";
        i += 2;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i += 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
