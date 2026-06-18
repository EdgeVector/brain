#!/usr/bin/env bun
// fbrain CLI entrypoint.
//
// `--verbose` (global) echoes each HTTP request and response, including the
// canonical schema hash being targeted — per the Phase 0 spike's
// debugging guidance.

import { parseArgs, type ParseArgsConfig } from "node:util";

import { getFbrainVersion } from "./version.ts";
import { FbrainError } from "./client.ts";
import { readConfig } from "./config.ts";
import { runInit } from "./commands/init.ts";
import { recordNew } from "./commands/new.ts";
import { getRecord } from "./commands/get.ts";
import { listCmd } from "./commands/list.ts";
import { statusCmd } from "./commands/status.ts";
import { linkCmd } from "./commands/link.ts";
import { searchCmd } from "./commands/search.ts";
import { askCmd } from "./commands/ask.ts";
import { doctor } from "./commands/doctor.ts";
import { rawCmd } from "./commands/raw.ts";
import { shareCmd } from "./commands/share.ts";
import { putCmd } from "./commands/put.ts";
import { deleteRecord } from "./commands/delete.ts";
import { reindexCmd } from "./commands/reindex.ts";
import { migrateCmd, type MigrateMode } from "./commands/migrate.ts";
import { isRecordType, RECORD_TYPES, type RecordType } from "./schemas.ts";

// Exit code for usage/argument errors — "you invoked fbrain wrong" (unknown
// command, typo'd command, missing required arg, unknown/misapplied flag,
// missing flag value). Distinct from exit 1, which means an operational
// failure — "the work couldn't be done" (record not found on a reachable
// node, node unreachable, write/consent failure, non-2xx from `raw`). Help
// and bare invocation stay 0. Mirrors the sibling fkanban CLI's contract so a
// script or agent wrapping fbrain can tell "fix my invocation" apart from
// "the node is down / record missing / retry".
export const USAGE_ERROR = 2;

// FbrainError `code`s that represent a usage/argument error (bad invocation),
// not an operational failure. main()'s catch maps these to USAGE_ERROR (2);
// every other FbrainError code is operational and stays exit 1. Keep in sync
// with the `throw new FbrainError({ code: ... })` sites in this file that
// reject malformed invocations (flag parsing, positional arity, flag
// combinations, numeric/type validation) — see `parseCommandArgs`,
// `validatePositiveIntFlag`, `parseRecordType`, and the per-command guards.
export const USAGE_ERROR_CODES: ReadonlySet<string> = new Set([
  "unknown_option",
  "node_url_is_init_only",
  "extra_positional_args",
  "unexpected_positional",
  "invalid_type",
  "invalid_min_score",
  "invalid_limit",
  "invalid_usage_window",
  "doctor_mode_conflict",
  "doctor_flag_requires_usage",
  "migrate_mode_conflict",
  "migrate_flag_requires_add_field",
  // Bad invocation surfaced inside the command modules (put / new / raw):
  // missing or contradictory slug/type, a misapplied --design, an
  // unrecognised --type, empty stdin with nothing to write, malformed
  // frontmatter (unclosed/malformed/unfenced) or an invalid slug on the
  // put/create path, and a malformed `raw` method/path. All are "you invoked
  // it wrong," not operational.
  "missing_slug",
  "missing_type",
  "slug_conflict",
  "type_conflict",
  "unsupported_type",
  "unknown_record_type",
  "design_flag_unsupported",
  "empty_stdin",
  "frontmatter_unclosed",
  "frontmatter_malformed",
  "frontmatter_unfenced",
  "invalid_slug",
  // An invalid status enum value (e.g. `status <slug> bogus`, or a bad
  // `status:` in put frontmatter) is a caller-supplied malformed value, same
  // class as invalid_slug — usage error, exit 2.
  "invalid_status",
  "invalid_raw_method",
  "invalid_raw_path",
]);

export const COMMANDS = [
  "init",
  "design",
  "task",
  "concept",
  "preference",
  "reference",
  "agent",
  "project",
  "spike",
  "put",
  "get",
  "list",
  "status",
  "link",
  "search",
  "ask",
  "doctor",
  "raw",
  "share",
  "delete",
  "reindex",
  "migrate",
  "mcp",
  "help",
] as const;
export type Command = (typeof COMMANDS)[number];

export const TOP_HELP = `fbrain — CLI brain over fold_db

Usage:
  fbrain <command> [options]

Commands:
  init           bootstrap a node + register schemas + write config
  design new     create a new Design
  task new       create a new Task (--design <slug> links to a parent design)
  concept new    create a new Concept
  preference new create a new Preference
  reference new  create a new Reference
  agent new      create a new Agent
  project new    create a new Project
  spike new      create a new Spike
  put            upsert any record type from stdin (frontmatter-aware; type: picks schema)
  get            print a record by slug
  list           list records, newest-first
  status         show or update a record's status
  link           link a task to a parent design
  search         semantic search over indexed records
  ask            hybrid retrieval (BM25 + vector + RRF; --expand adds LLM expansion)
  doctor         health-check the local setup (--freshness adds G3 retrieval probes)
  raw            authenticated passthrough to node or schema service
  share          (placeholder) — team sync is not wired up yet
  delete         soft-delete a record (fold_db is append-only)
  reindex        re-put every live record so its current embedding is present (does not reduce pollution)
  migrate        evolve a schema by adding a field (see docs/g15-schema-evolution-playbook.md)
  mcp            start an MCP server over stdio (7 tools: search/ask/get/list/put/delete/link)
  help <cmd>     per-command usage

Global flags:
  --verbose      echo HTTP requests + responses
  --help, -h     print this help
  --version, -V  print the fbrain version and exit

Run \`fbrain help <command>\` for per-command usage.`;

// Shared help shape for the 7 record types that take the common
// (--title/--tag/--body/--force) flag set. Task is the one type with an extra
// --design parent-link arg, so it keeps its own bespoke help block.
function simpleNewHelp(type: RecordType): string {
  return `fbrain ${type} new <slug> [--title T] [--tag T]... [--body STR] [--force] [--json]

  --title     one-line name (defaults to slug)
  --tag       repeatable; tag value to attach
  --body      markdown body; if omitted and stdin is non-TTY, body is read from stdin
  --force     overwrite an existing slug
  --json      emit \`{ok, type, slug}\` on stdout; the human \`created …\` line
              moves to stderr so \`--json\` stdout is always parseable. On
              failure a \`{error, hint}\` JSON object is emitted to stdout too.`;
}

export const COMMAND_HELP: Record<Command, string> = {
  init: `fbrain init [--node-url URL] [--schema-service-url URL] [--name DISPLAY] [--grant-consent|--yes]

Probe the node, bootstrap if needed, register every schema, load them,
persist ~/.fbrain/config.json with canonical hashes, then prompt once to
grant fbrain consent against this node so the first write doesn't stall.
Idempotent — re-running skips bootstrap and the consent prompt when a
live capability is already on disk.

  --node-url             defaults to http://127.0.0.1:9001 (homebrew fold_db_node daemon)
  --schema-service-url   defaults to the prod cloud Lambda
                         (https://axo709qs11.execute-api.us-east-1.amazonaws.com)
  --name                 bootstrap display name (default: fbrain)
  --grant-consent, --yes complete the one-time consent grant non-interactively
                         (no TTY needed). Use this in scripted / CI / agent
                         installs: init shells out to folddb consent grant
                         and polls until the capability is cached. No-op when
                         a live capability already exists, or under
                         FBRAIN_APP_IDENTITY_ENFORCE=off. Requires the folddb
                         CLI on PATH (fast-fails with a clear message if not).`,
  design: simpleNewHelp("design"),
  task: `fbrain task new <slug> [--title T] [--design D] [--tag T]... [--body STR] [--force] [--json]

  --title     one-line name (defaults to slug)
  --design    parent design slug (rejected if it does not exist)
  --tag       repeatable; tag value to attach
  --body      markdown body; if omitted and stdin is non-TTY, body is read from stdin
  --force     overwrite an existing slug
  --json      emit \`{ok, type, slug}\` on stdout; the human \`created …\` line
              moves to stderr so \`--json\` stdout is always parseable. On
              failure a \`{error, hint}\` JSON object is emitted to stdout too.`,
  concept: simpleNewHelp("concept"),
  preference: simpleNewHelp("preference"),
  reference: simpleNewHelp("reference"),
  agent: simpleNewHelp("agent"),
  project: simpleNewHelp("project"),
  spike: simpleNewHelp("spike"),
  put: `fbrain put [<slug>] [--type T] [--json]

Read a markdown body (with optional YAML-subset frontmatter) from stdin
and upsert a record. Re-putting the same slug updates in place —
no --force flag, no duplicate, no 409.

Slug resolution: one of the positional arg or frontmatter \`slug:\` is
required. There is NO silent default. If both are set and disagree, the
put errors with slug_conflict (mirrors the type_conflict behavior).

Type resolution: one of frontmatter \`type:\` or \`--type T\` is required.
There is NO silent default — a stdin stream without a type errors out.
If both are set and disagree, the put errors with type_conflict.

  --type    design | task | concept | preference | reference | agent | project | spike
            (case-insensitive; overrides absent frontmatter, errors on conflict)
  --json    emit \`{ok, slug, created}\` on stdout (\`created\` is true on insert,
            false on update); the human \`created/updated …\` line moves to
            stderr so \`--json\` stdout is always parseable. On failure a
            \`{error, hint}\` JSON object is emitted to stdout too.

Frontmatter (between leading \`---\` lines) keys honored:
  slug     string         (positional arg overrides; conflict if both differ)
  type     same 8 values as --type
  title    string         (default: first H1 in body, else slug)
  tags     [a, b]         (inline) OR a block list of \`  - tag\` lines

Body after the closing \`---\` becomes the record's body (indexed for
search). Empty body is valid as long as the type is set.

Examples:
  cat note.md | fbrain put my-note --type concept
  echo "---\\ntype: concept\\nslug: concept-idempotency\\ntitle: Idempotency\\n---\\nbody" | fbrain put`,
  get: `fbrain get <slug> [--type T] [--json]

Without --type, queries every registered schema. Errors if the slug
exists in multiple types (specify --type to disambiguate).

  --type    design | task | concept | preference | reference | agent | project | spike
  --json    emit the resolved record as a single JSON object on stdout
            (parseable by \`jq\`). On failure, a \`{error, hint}\` JSON object
            is emitted to stdout too (the human \`error:\`/\`hint:\` lines still
            print to stderr) so \`--json\` stdout is always parseable.`,
  list: `fbrain list [--type T] [--status S] [--tag T] [-n N | --limit N] [--json]

  --type        design | task | concept | preference | reference | agent | project | spike
                (omit to list across all types)
  --status      filter by status enum
  --tag         filter by tag membership
  -n, --limit   max results, newest-first (\`-n\` and \`--limit\` are aliases; last wins)
  --json        emit a JSON array of record summaries on stdout
                ({type, slug, title, status, tags, design_slug?, created_at,
                updated_at}); truncation hint routes to stderr. On failure, a
                \`{error, hint}\` JSON object is emitted to stdout too, so
                \`--json\` stdout is always parseable.`,
  status: `fbrain status <slug> [<new-status>] [--type T] [--json]

Bare form prints current status. With a new-status, validates against the
type's status enum, updates updated_at, and writes back.

  --type    design | task | concept | preference | reference | agent | project | spike
  --json    (show form only) emit the status as a single JSON object on
            stdout — \`{slug, type, status}\`, parseable by \`jq\`. Ignored
            with a new-status; the update form keeps its human transition
            line. On failure, a \`{error, hint}\` JSON object is emitted to
            stdout too (human \`error:\`/\`hint:\` lines still go to stderr).`,
  link: `fbrain link <task-slug> <design-slug> [--json]

Rejects a non-existent design slug.

  --json    emit \`{ok, task, design}\` on stdout; the human \`linked …\` line
            moves to stderr so \`--json\` stdout is always parseable. On failure
            a \`{error, hint}\` JSON object is emitted to stdout too.`,
  search: `fbrain search <query> [-n N | --limit N] [--exact] [--min-score F] [--type T]... [--json]

Semantic search across indexed records. Dedupes fragment hits per record
and skips stale hits (records deleted since indexing). Prints
\`slug · score · type · title\` per match, with a short matching body snippet
indented under each row — so the answer is visible without a follow-up
\`fbrain get\`.

\`score\` is a max-normalized cosine in 0–1 (the top hit is always \`1.000\`).
This scale is NOT comparable to \`ask\`'s fused-RRF score — do not compare a
\`search\` number against an \`ask\` number for the same record.

  -n, --limit   max results (\`-n\` and \`--limit\` are aliases; last wins)
  --exact       exact-match mode (passes ?exact=true to the index)
  --min-score   server-side score floor (passes ?min_score=F)
  --type        restrict results to a record type; repeat to allow several
                (e.g. \`--type design --type task\`).
                One of: design | task | concept | preference | reference |
                agent | project | spike. Omit to search across all 8 types.
  --json        emit a JSON array of \`{slug, score, type, title, snippet}\`
                on stdout (parseable by \`jq\`); \`snippet\` is the same
                matching body extract shown under each human row. Empty
                result is \`[]\`. Weak-match advisory and empty-result hint
                route to stderr. On failure, a \`{error, hint}\` JSON object
                is emitted to stdout too, so \`--json\` stdout is always
                parseable.`,
  ask: `fbrain ask <query> [-n N | --limit N] [--expand|--llm] [--explain] [--type T]... [--json]

Hybrid retrieval: BM25 (client-side) + vector (native-index, schema-scoped)
fused via Reciprocal Rank Fusion. By DEFAULT it runs BM25 + vector on the
original query and fuses the two lists — no LLM call, no API key, fastest.
This is the eval-winning path: the 2026-05-25 labeled eval showed LLM query
expansion REDUCED relevance (P@5 0.59 vs 0.73, MRR 0.46 vs 0.60), so it is
opt-in. With --expand an LLM first generates 3 alternative phrasings; BM25 +
vector then run against original + 3 expansions and RRF fuses all 8 lists.

Prints \`slug · score · type · title\` per match, with a short matching body
snippet indented under each row — so the answer is visible without a
follow-up \`fbrain get\`.

\`score\` is a raw fused-RRF value (the top hit is a small number like
\`0.03\`). This scale is NOT comparable to \`search\`'s 0–1 cosine — do not
compare an \`ask\` number against a \`search\` number for the same record.

  -n, --limit N max results (default 5; \`-n\` and \`--limit\` are aliases,
                last wins)
  --expand      opt in to LLM query expansion (alias --llm). Generates 3
  --llm         alternative phrasings via Anthropic and fuses BM25 + vector
                across original + 3 expansions. Costs 1 LLM call + an API key.
  --no-llm      accepted for back-compat; a no-op now (expansion is already
                off by default). Conflicts with --expand/--llm.
  --explain     print the LLM-generated expansions before results.
                Requires --expand (alias --llm) — there is nothing to explain
                without expansion; \`--explain\` without it exits 2.
  --type        restrict results to a record type; repeat to allow several
                (e.g. \`--type design --type task\`). Narrows both the BM25
                corpus and the vector schemas filter.
                One of: design | task | concept | preference | reference |
                agent | project | spike. Omit to search across all 8 types.
  --json        emit a JSON array of \`{slug, score, type, title, snippet}\`
                on stdout (parseable by \`jq\`); \`snippet\` is the same
                matching body extract shown under each human row. Empty
                result is \`[]\`. Advisory notes, no-key / expansion-failure
                notices, and the \`--explain\` expansions block all route to
                stderr. On failure, a \`{error, hint}\` JSON object is emitted
                to stdout too, so \`--json\` stdout is always parseable.

Cost: 0 LLM calls by default; 1 LLM call per invocation under --expand. Run
with the global --verbose to see token + USD estimates and per-ranker debug.
Under --expand, a missing ANTHROPIC_API_KEY falls back to the no-expansion
path automatically with a one-line notice; with --explain set, the explain
section also prints a no-key notice instead of silently dropping.

The LLM key (only needed for --expand) is read from \$ANTHROPIC_API_KEY
(preferred) or an optional \`anthropicApiKey\` field in ~/.fbrain/config.json.`,
  doctor: `fbrain doctor [--freshness] [--write] [--mcp] [--json] [--usage [--usage-window N] [--usage-path PATH]]

Live health checks:
  - config valid (~/.fbrain/config.json + hex-64 hashes)
  - schema service reachable
  - node reachable + provisioned
  - schemas loaded into the node
  - schema drift between schemas.ts and the registered Design/Task schemas
  - write-ready: a valid CapabilityToken is cached for this node AND
    the node's app registry knows fbrain (a consent dry-run returns 202
    rather than 404). FAIL is reported as "write-blocked" with a
    next-step hint — distinguishes a missing grant from a cold registry.
  - mcp-entrypoint: the \`fbrain-mcp\` bin (the agent-integration path
    \`claude mcp add fbrain fbrain-mcp\`) resolves on PATH. WARN, never
    FAIL, when it's missing — MCP is optional and source checkouts use
    the path-based registration form.

With --json, emit the structured check results as a single JSON object
on stdout instead of the human PASS/WARN/FAIL lines (same verdict + exit
code). Each entry carries name, tag (PASS/WARN/FAIL), ok, detail, fix. If
the run itself errors out (e.g. missing config), a \`{error, hint}\` JSON
object is emitted to stdout instead, so \`--json\` stdout stays parseable.

With --freshness, additionally runs the G3 retrieval-quality probes:
  - freshness-probe: 5 trials of put → search assert score ≥ 0.5
  - pollution-probe: one broad query, classify hits as live / stale /
    orphan-schema. PASS at <25% polluted, WARN at 25-50%, FAIL above.

With --write, additionally runs an idempotent put → get → soft-delete
round-trip under a reserved \`doctor-write-roundtrip-<nonce>\` slug to
prove writes actually land. OFF by default so plain \`fbrain doctor\`
never mutates.

With --mcp, additionally BOOTS the \`fbrain-mcp\` entrypoint and asserts
the agent-integration surface end-to-end (the opt-in companion to the
PATH-only mcp-entrypoint check):
  - mcp-boot: spawn \`fbrain-mcp\`, drive a JSON-RPC initialize +
    tools/list handshake over stdio under a bounded deadline, and PASS
    only when the server returns a valid handshake AND reports exactly
    the 7 expected tools. FAIL (not WARN) on a boot/handshake/tool-set
    mismatch. Skipped when \`fbrain-mcp\` isn't on PATH. OFF by default
    so plain \`fbrain doctor\` never spawns the server.

With --usage, skips the health checks and prints a team-adoption
telemetry report: write count by userHash (8-char prefix only)
over the last 7 days, broken down by record type. Also appends/
updates today's per-user count in ~/.fbrain/usage.jsonl for trend
plotting.

  --usage-window N   override the rolling window (default 7 days)
  --usage-path PATH  override the daily-summary file path

Exits non-zero if any check fails or the pollution probe FAILs.`,
  raw: `fbrain raw <method> <path> [body]

Authenticated passthrough. \`/api/\` paths go to the node (with
X-User-Hash); \`/v1/\` paths go to the schema service. Body argument
is treated as the literal request body; omit or pass \`-\` to read
from stdin. Exits 0 on 2xx, 1 otherwise.

Examples:
  fbrain raw GET /api/system/auto-identity
  fbrain raw POST /api/schemas/load
  fbrain raw GET /v1/schemas`,
  share: `fbrain share

Placeholder. Cross-node data flow requires fold_db's S3 + Auth-Lambda
transport, and this daemon has not been signed in to it. The sharing
METADATA primitives (ShareRule, ShareInvite, ShareSubscription) work
end-to-end on loopback, but no records actually move between nodes until
the daemon authenticates against the cloud and an end-to-end test passes.

Prints a notice and exits 1.`,
  delete: `fbrain delete <slug> [--type T] [--force] [--yes] [--json]

Soft-deletes the record. fold_db's mutation pipeline is append-only, so
the workaround overwrites every user field with sentinels and stamps a
tombstone tag. All fbrain read paths
(get, list, status, link, search) then filter the record out.

Without --type, queries every registered schema; errors with "specify
--type" if the slug exists in more than one type. Errors with
"No <type>: <slug>" if the slug is already deleted or never existed.

Deleting a design that still has live tasks linked to it is blocked
(symmetric with \`task new --design\` / \`link\` rejecting a dangling
design). Re-link or delete those tasks first, or pass --force to delete
anyway — the tasks' design references are then left dangling.

  --type      design | task | concept | preference | reference | agent | project | spike
  --force     delete a design even if live tasks still link to it
  --yes, -y   harmless no-op; delete is non-interactive so no confirmation
              prompt is shown. Accepted so scripts can pass \`-y\` uniformly.
  --json      emit \`{ok, slug, deleted}\` on stdout; the human \`deleted …\` line
              moves to stderr so \`--json\` stdout is always parseable. On
              failure a \`{error, hint}\` JSON object is emitted to stdout too.

After delete, the slug is reusable: \`fbrain design new <same-slug>\` (no
--force) will recreate it.`,
  reindex: `fbrain reindex [--type T] [--dry-run] [--repair-titles]

Ensures every live (non-tombstoned) fbrain record's CURRENT embedding is
present by re-issuing an update mutation. fold_db's EmbeddingIndex is not
purged on tombstone or re-put.

NOTE: fold_db's index is append-only. Re-issuing the update does NOT
replace the prior embedding in place — it APPENDS a fresh one and the
previous entry persists as stale. So reindex does NOT de-duplicate the
index and does NOT reduce pollution (it adds one stale entry per record).
It is not a fix for high \`doctor --freshness\` pollution; that purge is
upstream fold_db work (G3d/G3e), not available at the fbrain layer.

  --type            narrow to one of: design | task | concept | preference |
                    reference | agent | project | spike (default: all 8)
  --dry-run         list records that would be reindexed; no writes
  --repair-titles   one-shot repair mode: skip the embedding refresh and
                    only fix records whose stored title is the literal text
                    of a YAML block-scalar indicator (\`>\`, \`>-\`, \`>+\`, \`|\`,
                    \`|-\`, \`|+\`) — leftovers from a pre-fix import path that
                    didn't fold the scalar (#7852b). Title is repaired to
                    the first H1 of the body, or the slug as last resort.
                    Idempotent; prints every change. Combine with --dry-run
                    to preview without writing.

Run with the global --verbose to print per-record outcome
(kept | reindexed | skipped-tombstone, or ok | repaired | would-repair
under --repair-titles).`,
  migrate: `fbrain migrate --add-field <type> <field> <type-spec> [--default V] [--dry-run]
fbrain migrate --status
fbrain migrate --resume <manifest-id>

Evolve a fbrain schema by adding a field. fold_db is append-only and
identity-hashes schemas by (descriptive_name, sorted fields), so
adding a field necessarily produces a new schema hash. \`migrate\`
registers the new schema, re-puts every record with the new field set
to the configured default, and atomically swaps ~/.fbrain/config.json.
See docs/g15-schema-evolution-playbook.md for the full mechanism +
recovery recipes.

Phase 6 types (concept | preference | reference | agent | project |
spike) share one underlying schema; a migrate against any of them
re-puts and re-hashes all six together.

  --add-field   register + re-put. Args: <type> <field> <type-spec>.
                <type-spec> is "String" or "Array:String".
  --default V   default value for pre-existing records under the new
                field. REQUIRED for String (no implicit empty default).
                Optional for Array:String (defaults to []; pass a JSON
                array literal to override).
  --dry-run     register the new schema + write the manifest as
                "dry_run"; no record writes, no config swap.
  --status      tabular listing of every manifest under
                ~/.fbrain/migrations/ (newest first).
  --resume ID   resume a previously-interrupted migration. The
                manifest id is in --status output.

Example:
  fbrain migrate --add-field concept urgency String --default "normal"`,
  mcp: `fbrain mcp

Start a Model Context Protocol server over stdio. Exposes seven tools so
MCP clients (Claude Code, Codex, etc.) can read and write fbrain
in-process:
  read:  fbrain_search, fbrain_ask, fbrain_get, fbrain_list
  write: fbrain_put,    fbrain_delete, fbrain_link

fbrain_ask is the recommended retrieval primitive — it fuses BM25 +
vector (RRF hybrid) for better recall than pure-vector fbrain_search.

Register with Claude Code (after \`bun link\` from the Quick start):
  claude mcp add fbrain fbrain-mcp

The \`fbrain-mcp\` bin is global once linked, so the command works from
any directory. Running from a source checkout without \`bun link\`? Use
the path-based form from the repo root:
  claude mcp add fbrain bun $(realpath src/mcp/main.ts)

The server reads ~/.fbrain/config.json (same as the CLI). Exits non-zero
if config is missing — run \`fbrain init\` first.`,
  help: `fbrain help <command>`,
};

// Per-command parseArgs option sets. Exported so `test/unit/cli-help.test.ts`
// can assert every `--flag` mentioned in COMMAND_HELP corresponds to a real
// option the runXxx dispatcher accepts. Each runXxx pulls its option literal
// from here so help, impl, and test cannot drift.
//
// Global flags (`--verbose`, `--help`, `-h`) are stripped in main() and are
// not modeled here.
//
// `as const` preserves parseArgs's generic inference for downstream
// `values.foo` accesses; `satisfies` enforces that every Command has an entry.
const INIT_OPTIONS = {
  "node-url": { type: "string" },
  "schema-service-url": { type: "string" },
  name: { type: "string" },
  "grant-consent": { type: "boolean", default: false },
  // `--yes` is a conventional alias for `--grant-consent` (apt/npm style) —
  // the first thing most users reach for to skip a y/N prompt.
  yes: { type: "boolean", default: false },
} as const;
// design / task: applied after the `new` subcommand is consumed.
const DESIGN_OPTIONS = {
  title: { type: "string" },
  tag: { type: "string", multiple: true },
  body: { type: "string" },
  force: { type: "boolean", default: false },
  // Machine-readable mode: emit a `{ok,type,slug}` success object on stdout
  // and route the human `created …` line to stderr — same convention as the
  // read verbs (get/list/status). Accepted so an agent/script that uniformly
  // appends `--json` to every fbrain call doesn't dead-end on a write verb
  // with parseArgs's bare "Unknown option".
  json: { type: "boolean", default: false },
} as const;
const TASK_OPTIONS = {
  title: { type: "string" },
  design: { type: "string" },
  tag: { type: "string", multiple: true },
  body: { type: "string" },
  force: { type: "boolean", default: false },
  // See DESIGN_OPTIONS.json.
  json: { type: "boolean", default: false },
} as const;
const PUT_OPTIONS = {
  type: { type: "string" },
  // Machine-readable mode: emit a `{ok,slug,created}` success object on
  // stdout; the human `created/updated …` line moves to stderr. See
  // DESIGN_OPTIONS.json.
  json: { type: "boolean", default: false },
} as const;
const GET_OPTIONS = {
  type: { type: "string" },
  // Machine-readable mode: emit the resolved record as a single JSON
  // object on stdout. Mirrors LIST_OPTIONS / SEARCH_OPTIONS.
  json: { type: "boolean", default: false },
} as const;
const LIST_OPTIONS = {
  type: { type: "string" },
  status: { type: "string" },
  tag: { type: "string" },
  // `--limit` with `-n` short alias — mirrors SEARCH_OPTIONS / ASK_OPTIONS so a
  // user who learned `search --limit N` doesn't hit "Unknown option" on list.
  limit: { type: "string", short: "n" },
  // Machine-readable mode: emit a JSON array of record summaries on
  // stdout. Truncation hint moves to stderr so `jq` pipelines stay clean.
  json: { type: "boolean", default: false },
} as const;
const STATUS_OPTIONS = {
  type: { type: "string" },
  // Machine-readable mode for show form (`fbrain status <slug> --json`):
  // emit a single `{slug, type, status}` JSON object on stdout, matching the
  // `get --json` field-naming convention. Closes the read-surface parity gap
  // — `status` show mode was the only read command rejecting `--json`. No
  // effect in update form (`status <slug> <new-status>`), which keeps its
  // human transition line.
  json: { type: "boolean", default: false },
} as const;
const SEARCH_OPTIONS = {
  limit: { type: "string", short: "n" },
  exact: { type: "boolean", default: false },
  "min-score": { type: "string" },
  type: { type: "string", multiple: true },
  // Machine-readable mode: emit a JSON array of `{slug, score, type, title}`
  // on stdout; weak-match note and empty-result hint move to stderr.
  json: { type: "boolean", default: false },
} as const;
const ASK_OPTIONS = {
  limit: { type: "string", short: "n" },
  // Opt-in LLM query expansion. OFF by default — the labeled eval showed
  // expansion hurts relevance (gate doc §8), so the default path is the
  // eval-winning, key-free BM25 + vector + RRF on the original query.
  expand: { type: "boolean", default: false },
  // Alias for --expand.
  llm: { type: "boolean", default: false },
  // Back-compat no-op: expansion is already off by default, so --no-llm
  // changes nothing now. Accepted so existing scripts/agents don't break.
  "no-llm": { type: "boolean", default: false },
  explain: { type: "boolean", default: false },
  type: { type: "string", multiple: true },
  // Machine-readable mode: emit a JSON array of `{slug, score, type, title}`
  // on stdout; advisory notes and --explain expansions route to stderr.
  json: { type: "boolean", default: false },
} as const;
const DOCTOR_OPTIONS = {
  freshness: { type: "boolean", default: false },
  usage: { type: "boolean", default: false },
  "usage-window": { type: "string" },
  "usage-path": { type: "string" },
  write: { type: "boolean", default: false },
  // --mcp: boot the resolved `fbrain-mcp` entrypoint and assert the 7-tool
  // agent surface end-to-end (the opt-in companion to the PATH-only
  // mcp-entrypoint check). OFF by default so plain doctor never spawns it.
  mcp: { type: "boolean", default: false },
  // Machine-readable mode: emit the structured check results as a single
  // JSON object on stdout instead of the human PASS/WARN/FAIL lines.
  json: { type: "boolean", default: false },
} as const;
const DELETE_OPTIONS = {
  type: { type: "string" },
  force: { type: "boolean", default: false },
  // `--yes` / `-y` is a documented no-op. delete is non-interactive (no
  // confirmation prompt), but apt / npm / rm muscle memory reaches for
  // `-y` to suppress one — and a script that uniformly passes `-y` to
  // destructive commands shouldn't dead-end on parseArgs's bare
  // "Unknown option '--yes'". Accept it silently so the invocation works.
  yes: { type: "boolean", short: "y", default: false },
  // Machine-readable mode: emit a `{ok,slug,deleted}` success object on
  // stdout; the human `deleted …` line moves to stderr. See
  // DESIGN_OPTIONS.json.
  json: { type: "boolean", default: false },
} as const;
// `link` takes no value flags, only `--json` for machine-readable success.
const LINK_OPTIONS = {
  // Machine-readable mode: emit a `{ok,task,design}` success object on
  // stdout; the human `linked …` line moves to stderr. See
  // DESIGN_OPTIONS.json.
  json: { type: "boolean", default: false },
} as const;
const REINDEX_OPTIONS = {
  type: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  "repair-titles": { type: "boolean", default: false },
} as const;
const MIGRATE_OPTIONS = {
  "add-field": { type: "boolean", default: false },
  status: { type: "boolean", default: false },
  resume: { type: "string" },
  default: { type: "string" },
  "dry-run": { type: "boolean", default: false },
} as const;
const EMPTY_OPTIONS = {} as const;

export const CLI_SPEC = {
  init: INIT_OPTIONS,
  design: DESIGN_OPTIONS,
  task: TASK_OPTIONS,
  // The 6 Phase-6 types share design's flag set (no --design parent link).
  concept: DESIGN_OPTIONS,
  preference: DESIGN_OPTIONS,
  reference: DESIGN_OPTIONS,
  agent: DESIGN_OPTIONS,
  project: DESIGN_OPTIONS,
  spike: DESIGN_OPTIONS,
  put: PUT_OPTIONS,
  get: GET_OPTIONS,
  list: LIST_OPTIONS,
  status: STATUS_OPTIONS,
  link: LINK_OPTIONS,
  search: SEARCH_OPTIONS,
  ask: ASK_OPTIONS,
  doctor: DOCTOR_OPTIONS,
  raw: EMPTY_OPTIONS,
  share: EMPTY_OPTIONS,
  delete: DELETE_OPTIONS,
  reindex: REINDEX_OPTIONS,
  migrate: MIGRATE_OPTIONS,
  mcp: EMPTY_OPTIONS,
  help: EMPTY_OPTIONS,
} as const satisfies Record<Command, Record<string, unknown>>;

type Argv = string[];

// Did the invocation ask for machine-readable output? `--json` is a
// per-command flag (consumed by each command's own parseArgs, not the global
// pass below), but the top-level catch block needs to know about it so a
// FAILING `--json` command can emit a parseable JSON error object on stdout
// instead of a bare `error:` line that chokes `... --json | jq`. Scan the raw
// argv rather than the per-command opts, mirroring how the global flags are
// detected here. A stray `--json` in a command that doesn't accept it would be
// rejected by that command's own parseArgs (a usage error) before reaching the
// error-body path, so a permissive scan is safe.
function wantsJson(argv: Argv): boolean {
  return argv.includes("--json");
}

export async function main(argv: Argv): Promise<number> {
  const jsonMode = wantsJson(argv);
  const stripped = argv.slice();
  const verbose = consumeFlag(stripped, "--verbose");
  if (consumeFlag(stripped, "--version") || consumeFlag(stripped, "-V")) {
    console.log(`fbrain ${getFbrainVersion()}`);
    return 0;
  }
  // Bare `fbrain version` is muscle memory from `git/docker/go version`. It
  // isn't a registered command (records are created per type, not via a global
  // `version` verb), so without this it would fall through to the unknown-command
  // path and dump the entire help wall. Alias it to the `--version`/`-V` output.
  if (stripped[0] === "version" && stripped.length === 1) {
    console.log(`fbrain ${getFbrainVersion()}`);
    return 0;
  }
  if (consumeFlag(stripped, "--help") || consumeFlag(stripped, "-h")) {
    if (stripped[0]) return printHelpFor(stripped[0]);
    console.log(TOP_HELP);
    return 0;
  }

  const cmd = stripped[0];
  if (!cmd) {
    console.log(TOP_HELP);
    return 0;
  }
  if (!isCommand(cmd)) {
    // A `-`-prefixed token in command position is an option in the wrong slot —
    // the global flags (`--verbose`, `--version`/`-V`, `--help`/`-h`) were
    // already consumed above. Tell the user about flag placement instead of
    // mislabeling the option as a "command".
    if (cmd.startsWith("-")) {
      // `-v` is muscle memory for "show the version" (node/npm/bun -v), but in
      // fbrain the version flag is `-V`/`--version`. Don't silently alias it
      // (other tools split `-v` verbose vs `-V` version) — point at the real
      // spelling instead of the generic flag-placement hint, which would
      // falsely imply `fbrain init -v <value>` is valid.
      if (cmd === "-v") {
        console.error("error: `-v` isn't a flag; did you mean `-V` / `--version`?");
        return USAGE_ERROR;
      }
      console.error(`error: \`${cmd}\` looks like an option, but it's in the command position.`);
      console.error(`hint:  Flags go after the subcommand, e.g. \`fbrain init ${cmd} <value>\`. Run \`fbrain --help\` for global flags.`);
      return USAGE_ERROR;
    }
    // A top-level create-verb (`new`/`create`/`add`) is muscle memory from
    // git/gh/cargo/npm/fkanban, but fbrain creates records *per type*
    // (`<type> new <slug>`). Pure Levenshtein lands these on an unrelated read
    // verb (`new`→`get`, `add`→`ask`) — a misleading suggestion is worse than
    // none on the highest-traffic new-dev action. Point at the real create
    // family instead, before the generic nearest-match fallback below.
    if (CREATE_SYNONYMS.includes(cmd)) {
      const types = RECORD_TYPES.join(" | ");
      console.error(`error: \`fbrain ${cmd}\` isn't a command — records are created per type.`);
      console.error(`hint:  Use \`fbrain <type> new <slug>\`, e.g. \`fbrain design new my-first-idea\`.`);
      console.error(`       Types: ${types}`);
      console.error(`       (or pipe markdown:  fbrain put <slug> --type <type>)`);
      return USAGE_ERROR;
    }
    const suggestion = suggestCommand({
      single: cmd,
      compound: stripped[1] ? `${cmd} ${stripped[1]}` : undefined,
    });
    if (suggestion) {
      console.error(`Unknown command: ${cmd}. Did you mean: ${suggestion}?`);
    } else {
      console.error(`Unknown command: ${cmd}`);
      console.error(TOP_HELP);
    }
    return USAGE_ERROR;
  }
  const rest = stripped.slice(1);

  try {
    return await dispatch(cmd, rest, { verbose });
  } catch (err) {
    // In `--json` mode every command's SUCCESS path already prints a JSON
    // payload to stdout; emit the FAILURE as a JSON object too so stdout stays
    // parseable end-to-end (`... --json | jq` no longer chokes on a bare
    // `error:` line). The human `error:`/`hint:` lines still go to stderr below,
    // unchanged, so interactive use is byte-identical. Exit-code classification
    // is unaffected. Commands reached `dispatch` and threw *before* writing
    // their own success payload, so there's no double-print on the failure path.
    if (jsonMode) {
      const hint = err instanceof FbrainError ? (err.hint ?? null) : null;
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ error: message, hint }));
    }
    if (err instanceof FbrainError) {
      console.error(`error: ${err.message}`);
      if (err.hint) console.error(`hint:  ${err.hint}`);
      // A usage/argument FbrainError (unknown/misapplied flag, missing flag
      // value, bad flag combination, malformed --type/--min-score/--limit,
      // extra/unexpected positionals) is "you invoked it wrong" → exit 2.
      // Operational FbrainErrors (record not found, node unreachable,
      // write/consent failures, non-2xx from `raw`) stay 1.
      // ConfigMissingError / ConfigInvalidError now extend FbrainError
      // (codes `config_missing` / `config_invalid`, neither in
      // USAGE_ERROR_CODES), so the branch above prints their `error:`/`hint:`
      // lines and classifies them as operational exit 1 — no dedicated case
      // needed.
      return USAGE_ERROR_CODES.has(err.code) ? USAGE_ERROR : 1;
    }
    if (err instanceof Error) {
      console.error(`error: ${err.message}`);
      // A raw parseArgs failure that no per-command handler turned into a
      // friendlier FbrainError (an unknown flag with no near-miss suggestion,
      // a missing flag value, a stray positional) is still a usage error —
      // "you invoked it wrong" → exit 2. The message above is parseArgs's own
      // (unchanged); only the exit code is classified here. Every other
      // Error is an operational/internal failure → exit 1.
      return isParseArgsUsageError(err) ? USAGE_ERROR : 1;
    }
    console.error(`error: ${String(err)}`);
    return 1;
  }
}

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

// Every record type has a `<type> new` subcommand. Derived from RECORD_TYPES
// so adding a new record type wires up "Did you mean?" and `fbrain help
// "<type> new"` automatically.
const COMPOUND_COMMANDS: readonly string[] = RECORD_TYPES.map((t) => `${t} new`);

// Top-level record-creation synonyms a new dev reaches for by analogy with
// other CLIs (git/gh/cargo/npm/fkanban). None is a real fbrain command —
// records are created via `<type> new <slug>` — so these get a targeted
// create-family hint instead of a misleading nearest-match (see the unknown-
// command handler above).
const CREATE_SYNONYMS: readonly string[] = ["new", "create", "add"];

// Suggest the closest valid command for an unknown input. `single` is matched
// against every entry in COMMANDS; `compound` (e.g. `desogn new`) is matched
// against the two-token subcommand pairs so `desogn new` suggests `design new`
// rather than the bare `design`. Returns null when no candidate scores within
// max(2, floor(input.length / 3)) edits — at which point callers fall back
// to TOP_HELP for cold-start discovery.
export function suggestCommand(opts: { single?: string; compound?: string }): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  let bestLen = 0;
  const consider = (candidate: string, input: string) => {
    const d = levenshtein(input, candidate);
    if (d < bestDist) {
      bestDist = d;
      bestLen = input.length;
      best = candidate;
    }
  };
  // Compound first so a tie favors the more-specific two-token suggestion.
  if (opts.compound) for (const c of COMPOUND_COMMANDS) consider(c, opts.compound);
  if (opts.single) for (const c of COMMANDS) consider(c, opts.single);
  if (best === null) return null;
  const threshold = Math.max(2, Math.floor(bestLen / 3));
  return bestDist <= threshold ? best : null;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost));
    }
    prev = curr;
  }
  return prev[b.length]!;
}

function consumeFlag(argv: Argv, name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

// Return the token immediately following `flag` in argv (e.g. peek the
// value of `-n` before parseArgs runs). Returns undefined if the flag
// isn't present or is the last token. Used to validate values that
// would otherwise trip parseArgs's short-option detection — `-n -1`
// reads `-1` as a new option and produces a cryptic error.
function peekNextValue(argv: Argv, flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1 || i === argv.length - 1) return undefined;
  return argv[i + 1];
}

// Validate that `flag`'s value is a positive integer BEFORE parseArgs runs.
// Three failure modes parseArgs doesn't catch cleanly:
//   - `flag -1` produces parseArgs's cryptic "Option '<flag>' argument is
//     ambiguous" (it reads `-1` as a new option, not <flag>'s value).
//   - `flag 3.5` is silently parseInt'd to 3.
//   - `flag 5abc` is silently parseInt'd to 5.
// The strict `String(n) !== raw.trim()` check rejects both junk-tail forms;
// running before parseArgs avoids the ambiguous-option error. Same shape as
// the integer-flag chain in PRs #87/#88/#89.
function validatePositiveIntFlag(
  argv: Argv,
  flag: string,
  code: string,
): void {
  const raw = peekNextValue(argv, flag);
  if (raw === undefined) return;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim() || n < 1) {
    throw new FbrainError({
      code,
      message: `${flag} must be a positive integer (got "${raw}").`,
    });
  }
}

// `-n` and `--limit` are interchangeable aliases across list/search/ask.
// Validate whichever spelling the user typed before parseArgs runs.
function validateLimitFlag(argv: Argv): void {
  validatePositiveIntFlag(argv, "-n", "invalid_limit");
  validatePositiveIntFlag(argv, "--limit", "invalid_limit");
}

// Pull the offending option name (without leading dashes) out of a caught
// ERR_PARSE_ARGS_UNKNOWN_OPTION. Node's message reads `Unknown option
// '--tags'. ...`; we prefer the quoted token but fall back to scanning the
// args for the first `--<long>` flag that isn't a known option key, so a
// future Node message-format change can't silently break the hint.
function unknownOptionName(
  err: Error,
  args: readonly string[],
  knownKeys: readonly string[],
): string | undefined {
  const m = /Unknown option '(--?[^']+)'/.exec(err.message);
  if (m?.[1]) return m[1].replace(/^--?/, "").split("=")[0];
  const known = new Set(knownKeys);
  for (const tok of args) {
    if (!tok.startsWith("--")) continue;
    const name = tok.slice(2).split("=")[0]!;
    if (name && !known.has(name)) return name;
  }
  return undefined;
}

// Mirrors the `Did you mean: <cmd>?` UX from suggestCommand — same Levenshtein
// threshold (max(2, floor(len/3))). Given the unknown option name (no dashes)
// and the command's own option keys, returns the closest known long flag, or
// undefined when nothing is near enough. `--tags` → `--tag` falls right out of
// this (edit distance 1) without a special case, but the repeatable example
// the caller appends is what makes the hint actually actionable.
function suggestOption(
  unknown: string,
  knownKeys: readonly string[],
): string | undefined {
  if (unknown.length === 0) return undefined;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const k of knownKeys) {
    const d = levenshtein(unknown, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  if (best === null) return undefined;
  const threshold = Math.max(2, Math.floor(unknown.length / 3));
  return bestDist <= threshold ? best : undefined;
}

// Single funnel for every non-init command's parseArgs. Wraps the call so a
// muscle-memory `fbrain <cmd> --node-url <URL>` / `--schema-service-url <URL>`
// (the user re-using the flag they learned at `init`) becomes an actionable
// nudge instead of parseArgs's bare "Unknown option" — or, worse on commands
// that take positionals like `get`, its actively-misleading
// `-- "--node-url"` advice. The node and schema-service are pinned in
// `~/.fbrain/config.json` at init time and not overridable per-command; the
// hint points at the right path to change them. `init` itself does NOT go
// through this helper — it accepts both flags via INIT_OPTIONS and we must
// not regress that.
// Node's `parseArgs` throws ERR_PARSE_ARGS_* for malformed invocations: an
// unknown flag, a flag missing its value, or an unexpected positional. These
// are usage errors ("you invoked it wrong"), so when one reaches main()'s
// catch unwrapped (no per-command handler upgraded it to a friendlier
// FbrainError) it should still classify as exit 2, not 1.
const PARSE_ARGS_USAGE_CODES: ReadonlySet<string> = new Set([
  "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
]);

function isParseArgsUsageError(err: unknown): boolean {
  return (
    err instanceof Error &&
    PARSE_ARGS_USAGE_CODES.has((err as NodeJS.ErrnoException).code ?? "")
  );
}

function parseCommandArgs<T extends ParseArgsConfig>(config: T) {
  try {
    return parseArgs(config);
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
    ) {
      const args = config.args ?? [];
      if (
        args.includes("--node-url") ||
        args.includes("--schema-service-url")
      ) {
        throw new FbrainError({
          code: "node_url_is_init_only",
          message:
            "--node-url / --schema-service-url are only accepted by `fbrain init`. The node and schema-service are pinned in ~/.fbrain/config.json at init time.",
          hint: "To point fbrain at a different node, re-run `fbrain init --node-url <URL> [--schema-service-url <URL>]` (or edit ~/.fbrain/config.json directly).",
        });
      }
      // A near-miss spelling of one of THIS command's own flags (the classic:
      // `<type> new --tags foo,bar` — `--tags` plural is the natural guess
      // since npm/cargo/git accept comma lists somewhere) dead-ends on
      // parseArgs's bare "Unknown option" with no nudge toward the right
      // flag. Mirror runPut's friendly recovery: suggest the closest known
      // option via the same Levenshtein suggester used elsewhere. The
      // legitimate `-- "--tags"` positional escape hatch never reaches here —
      // parseArgs treats post-`--` tokens as positionals, so it doesn't throw.
      const knownKeys = Object.keys(config.options ?? {});
      const unknown = unknownOptionName(err, args, knownKeys);
      if (unknown !== undefined) {
        const suggestion = suggestOption(unknown, knownKeys);
        if (suggestion !== undefined) {
          // `tag` is `multiple: true` (repeatable), so the actionable form is
          // one flag per value — the single highest-value hint for the
          // `--tags foo,bar` papercut this guards against.
          const opt = (config.options as Record<string, { multiple?: boolean }>)[
            suggestion
          ];
          const example = opt?.multiple
            ? `Repeat the flag per value: \`--${suggestion} foo --${suggestion} bar\`.`
            : `Did you mean \`--${suggestion}\`?`;
          throw new FbrainError({
            code: "unknown_option",
            message: `Unknown option \`--${unknown}\`. Did you mean \`--${suggestion}\`?`,
            hint: example,
          });
        }
      }
    }
    throw err;
  }
}

function printHelpFor(name: string): number {
  if (!isCommand(name)) {
    console.error(`Unknown command: ${name}`);
    console.log(TOP_HELP);
    return USAGE_ERROR;
  }
  const h = COMMAND_HELP[name];
  if (!h) {
    console.error(`Unknown command: ${name}`);
    console.log(TOP_HELP);
    return USAGE_ERROR;
  }
  console.log(h);
  return 0;
}

type Globals = { verbose: boolean };

async function dispatch(cmd: Command, args: Argv, g: Globals): Promise<number> {
  const verboseFn = g.verbose ? (msg: string) => console.error(`[verbose] ${msg}`) : undefined;
  switch (cmd) {
    case "init":
      return runInitCmd(args, verboseFn);
    case "design":
    case "task":
    case "concept":
    case "preference":
    case "reference":
    case "agent":
    case "project":
    case "spike":
      return runRecordNew(cmd, args, verboseFn);
    case "put":
      return runPut(args, verboseFn);
    case "get":
      return runGet(args, verboseFn);
    case "list":
      return runList(args, verboseFn);
    case "status":
      return runStatus(args, verboseFn);
    case "link":
      return runLink(args, verboseFn);
    case "search":
      return runSearch(args, verboseFn);
    case "ask":
      return runAsk(args, verboseFn);
    case "doctor":
      return runDoctor(args, verboseFn);
    case "raw":
      return runRaw(args, verboseFn);
    case "share":
      return runShare(args);
    case "delete":
      return runDelete(args, verboseFn);
    case "reindex":
      return runReindex(args, verboseFn);
    case "migrate":
      return runMigrate(args, verboseFn);
    case "mcp":
      return runMcpCmd(args);
    case "help": {
      const target = args[0];
      if (!target) {
        console.log(TOP_HELP);
        return 0;
      }
      // Accept the two-word names from TOP_HELP ("design new" / "task new")
      // whether the user quoted them as a single arg or typed them as two
      // tokens — both forms appear verbatim in the index.
      const joined = args.slice(0, 2).join(" ");
      if ((COMPOUND_COMMANDS as readonly string[]).includes(joined)) {
        return printHelpFor(joined.split(" ")[0]!);
      }
      return printHelpFor(target);
    }
  }
}

type Verbose = ((msg: string) => void) | undefined;

async function runInitCmd(args: Argv, verbose: Verbose): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: INIT_OPTIONS,
  });
  // Defaults are resolved inside runInit so it can auto-heal a stale config
  // (e.g. previously-baked `:9101 / :9102` URLs) without clobbering a user
  // override the next time `fbrain init` runs without flags.
  const initOpts: Parameters<typeof runInit>[0] = { bootstrapName: values.name, verbose };
  if (values["node-url"]) initOpts.nodeUrl = values["node-url"];
  if (values["schema-service-url"]) initOpts.schemaServiceUrl = values["schema-service-url"];
  if (values["grant-consent"] || values.yes) initOpts.grantConsent = true;
  await runInit(initOpts);
  return 0;
}

// Shared `<type> new` dispatcher. Handles all 8 record types — task is the
// only one with a per-type extra (--design), so we pick the option set on
// type but funnel everything through one parse + envelope. The pre-Phase-6
// runDesign/runTask functions did the same work copy-pasted; keeping the
// slug-validation / stdin-fallback / "created <type> <slug>" envelope in
// one place lets future per-type flags slot in by extending the options
// alone.
async function runRecordNew(type: RecordType, args: Argv, verbose: Verbose): Promise<number> {
  const sub = args[0];
  if (sub !== "new") {
    const suggestion = sub ? suggestCommand({ compound: `${type} ${sub}` }) : null;
    if (suggestion) {
      console.error(`Unknown ${type} subcommand: ${sub}. Did you mean: ${suggestion}?`);
      return USAGE_ERROR;
    }
    // "I want to change this record's status" recovery. By analogy with most
    // CLIs (`git branch <name> --move`, `kubectl set ...`), a dev who knows
    // `fbrain <type> new <slug>` and `fbrain status <slug>` naturally reaches
    // for `fbrain <type> <slug> --status <value>` to move a record. That guess
    // dead-ends here: `<slug>` is an unknown subcommand and `--status` is
    // silently swallowed. Rather than dump the misleading `<type> new` usage,
    // point at the real verb — `fbrain status <slug> <new-status>` — and echo
    // back what they typed so the swallowed `--status` is acknowledged. We do
    // NOT auto-perform the update; the explicit verb is intentional. Mirrors
    // the accepted `--tags → --tag` recovery-hint pattern in parseCommandArgs.
    //
    // Gate: a slug-shaped subcommand (the record they meant to act on) and/or
    // an explicit `--status <value>` flag. Both conditions point unambiguously
    // at the status-update intent; genuinely unrecognizable input (a bad flag,
    // a typo'd verb that missed the Levenshtein threshold) still falls through
    // to the bare help dump below.
    const statusValue = peekNextValue(args, "--status");
    const subIsSlugShaped =
      sub !== undefined && !sub.startsWith("-") && /^[a-z0-9][a-z0-9-_]*$/.test(sub);
    if (subIsSlugShaped || statusValue !== undefined) {
      const slugPart = subIsSlugShaped ? sub : "<slug>";
      const statusPart = statusValue ?? "<new-status>";
      const echo =
        subIsSlugShaped && statusValue !== undefined
          ? ` (you asked to set "${slugPart}" → "${statusPart}")`
          : "";
      console.error(
        `Did you mean to change status? Use: fbrain status ${slugPart} ${statusPart}${echo}`,
      );
      return USAGE_ERROR;
    }
    console.error(`Unknown ${type} subcommand: ${sub ?? "(none)"}\n${COMMAND_HELP[type]}`);
    return USAGE_ERROR;
  }
  const rest = args.slice(1);
  // TASK_OPTIONS is DESIGN_OPTIONS + --design; for non-task types parseArgs
  // will reject --design via its strict-unknown-option check.
  const { values, positionals } = parseCommandArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: type === "task" ? TASK_OPTIONS : DESIGN_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP[type]);
    return USAGE_ERROR;
  }
  // `fbrain <type> new <slug>` accepts exactly one positional. Without this
  // guard, `fbrain task new my-slug --tag a b` silently dropped `b` (parseArgs
  // consumed `a` as the --tag value, then `b` became positional[1] which the
  // dispatcher ignored — the record was created with tags=["a"] while the
  // user thought both landed). Same for unquoted titles: `--title two words`
  // dropped `words`. Worst kind of silent drop because writes succeeded with
  // a partial-truth payload. Same papercut shape as PRs #177 / #181 / #112
  // (put / link / delete extra-positional guards).
  if (positionals.length > 1) {
    throw new FbrainError({
      code: "extra_positional_args",
      message: `${type} new takes exactly one slug (got ${positionals.length}: ${positionals.join(", ")}).`,
      hint: `Title, body, and tags are flags, not positionals. Wrap multi-word titles in quotes: \`--title "..."\`. Repeat \`--tag\` per tag: \`--tag a --tag b\`.`,
    });
  }
  const cfg = readConfig();
  // No --body → fall back to stdin. `maybeReadStdin({ announce: true })` prints
  // a one-line breadcrumb BEFORE the (potentially indefinite) blocking read so
  // the new-dev path doesn't silently hang on an empty inherited pipe. The
  // notice only fires when a read will actually happen (non-TTY and not
  // FBRAIN_NO_STDIN=1) — those cases short-circuit inside maybeReadStdin.
  const body = values.body ?? (await maybeReadStdin({ announce: true }));
  const opts: Parameters<typeof recordNew>[0] = {
    cfg,
    type,
    slug,
    title: values.title ?? slug,
    body,
    tags: values.tag ?? [],
    force: values.force,
    verbose,
  };
  // --design is only reachable on TASK_OPTIONS; cast scopes the field access
  // without widening the parseArgs return type.
  const designSlug = (values as { design?: string }).design;
  if (designSlug) opts.designSlug = designSlug;
  const { indexPending } = await recordNew(opts);
  // Under --json the structured success object is the stdout document; the
  // human line moves to stderr so `--json` stdout stays parseable (mirrors
  // the read verbs). The `indexPending` flag mirrors the MCP put's
  // `structuredContent` so a scripted CLI write has the same read-after-write
  // search-parity signal the agent path gets.
  if (values.json) {
    console.error(`created ${type} ${slug}${indexPendingNote(indexPending)}`);
    console.log(JSON.stringify({ ok: true, type, slug, indexPending }));
  } else {
    console.log(`created ${type} ${slug}${indexPendingNote(indexPending)}`);
  }
  return 0;
}

// Honest one-line suffix appended to a CLI write's success output when the
// record persisted but the bounded vector-index confirmation timed out. Keeps
// the success line truthful — the write landed — while warning that an
// IMMEDIATE `fbrain search` may miss it (the native index is still catching
// up). Empty when the record is confirmed in the index (or the confirmation
// was skipped on a remote node), so the common case prints the bare line.
function indexPendingNote(indexPending: boolean): string {
  return indexPending
    ? " (semantic index still catching up — an immediate `fbrain search` may miss it; retry in a moment)"
    : "";
}

// The value-taking options on `put`, derived from PUT_OPTIONS so the slug
// recovery below stays correct if another value option is ever added.
// (`type: "boolean"` options take no value; everything else does.)
const PUT_VALUE_FLAGS = new Set(
  Object.entries(PUT_OPTIONS)
    .filter(([, spec]) => (spec as { type: string }).type !== "boolean")
    .map(([name]) => `--${name}`),
);

// Best-effort recovery of `put`'s slug positional when parseArgs already
// threw — we can't trust its output, so scan args BEFORE the offending flag
// and pick the first non-flag token. We must skip an option's VALUE: in
// `fbrain put --type design my-note --title X`, `design` is the value of
// `--type`, not the positional slug, so a naive "first non-flag token" scan
// grabs `design`. Skip any token whose preceding token is a value-taking
// option (e.g. `--type`). The inline `--type=design` form carries its value
// in the same token, so it's already harmless. If the user typed e.g.
// `fbrain put --body X` with no slug, there's nothing before the flag and we
// fall back to `<slug>` rather than mis-quoting the flag's (or --type's) VALUE.
function recoverPutSlug(args: Argv, flag: string): string {
  const idx = args.indexOf(flag);
  const before = args.slice(0, idx);
  return (
    before.find(
      (a, i) =>
        !a.startsWith("-") &&
        !(i > 0 && PUT_VALUE_FLAGS.has(before[i - 1] as string)),
    ) ?? "<slug>"
  );
}

// Best-effort recovery of `put`'s `--type <T>` value when parseArgs already
// threw — used by the `--title` recovery hint so the suggested
// `fbrain <T> new <slug> --title "..."` is copy-pasteable. If the user already
// typed `--type concept`, thread it through; otherwise fall back to a concrete
// example (`concept`), mirroring the sibling `--body` hint. Never emit the
// literal `<type>` placeholder — a fresh user would copy it verbatim.
function recoverPutType(args: Argv): RecordType {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--type" && i + 1 < args.length) {
      const v = args[i + 1];
      if (v && isRecordType(v)) return v;
    } else if (a?.startsWith("--type=")) {
      const v = a.slice("--type=".length);
      if (isRecordType(v)) return v;
    }
  }
  return "concept";
}

async function runPut(args: Argv, verbose: Verbose): Promise<number> {
  let parsed;
  try {
    parsed = parseCommandArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: PUT_OPTIONS,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
    ) {
      // `put` is intentionally frontmatter-driven — title comes from the
      // `title:` key or the first `# H1`. But every `<type> new` subcommand
      // takes `--title`, so a fresh user reflexively types
      // `fbrain put <slug> --title X` and dead-ends on parseArgs's bare
      // "Unknown option '--title'" with no nudge toward the right form.
      // Re-throw with a hint that points at `<type> new` instead.
      if (args.includes("--title")) {
        const slug = recoverPutSlug(args, "--title");
        const type = recoverPutType(args);
        throw new FbrainError({
          code: "unknown_option",
          message:
            "`put` does not accept --title. The title comes from frontmatter (`title:` between leading `---` lines) or the first `# H1` of the body.",
          hint: `To set the title via a flag, use \`fbrain ${type} new ${slug} --title "..."\` instead.`,
        });
      }
      // Same papercut for `--body` / `--content` / `--text`: a fresh user
      // reflexively types `fbrain put my-note --type concept --body "..."`
      // and dead-ends on parseArgs's bare "Unknown option". The body comes
      // from stdin (with optional YAML frontmatter) — point them there.
      const bodyFlag = ["--body", "--content", "--text"].find((f) =>
        args.includes(f),
      );
      if (bodyFlag) {
        const slug = recoverPutSlug(args, bodyFlag);
        // Thread through the user's `--type <T>` (falling back to `concept`)
        // so the hint stays copy-pasteable — mirrors the `--title` branch
        // above. Without this, `put x --type design --body "..."` wrongly
        // suggested `--type concept`, contradicting what the user typed.
        const type = recoverPutType(args);
        throw new FbrainError({
          code: "unknown_option",
          message: `\`put\` does not accept ${bodyFlag}. The record body comes from stdin (with optional YAML frontmatter).`,
          hint: `Pipe the body in:  echo "..." | fbrain put ${slug} --type ${type}   (or:  fbrain put ${slug} --type ${type} < note.md)`,
        });
      }
    }
    throw err;
  }
  const { values, positionals } = parsed;
  // `fbrain put <slug>` accepts exactly one positional (type is `--type
  // <T>`). Without this guard, `fbrain put design storage-decision --type
  // concept` silently dropped `storage-decision` and created a concept
  // slugged `design` — wrong-slug data, no warning. Mirror delete's
  // extra-positional guard. When the first surplus token is a known
  // record type, the user almost certainly tried `put <type> <slug>`
  // (the git/kubectl shape), so route them at the right form.
  if (positionals.length > 1) {
    const first = positionals[0]!;
    const hint = isRecordType(first)
      ? `"${first}" is a record type — did you mean \`fbrain put ${positionals[1]} --type ${first}\`, or \`fbrain ${first} new ${positionals[1]}\`? Slug is the only positional on \`put\` — type is \`--type <T>\`.`
      : "Run `fbrain put <slug> --type <T>` (slug is the only positional).";
    throw new FbrainError({
      code: "extra_positional_args",
      message: `put takes one slug (got ${positionals.length}: ${positionals.join(", ")}).`,
      hint,
    });
  }
  const cfg = readConfig();
  const input = await maybeReadStdin();
  // Slug is optional at the CLI boundary — putCmd resolves it from the
  // positional arg and/or frontmatter `slug:` and raises `missing_slug`
  // if neither is set. The old code dumped usage on missing positional,
  // which silently hid a frontmatter slug.
  const pOpts: Parameters<typeof putCmd>[0] = { cfg, input };
  if (positionals[0]) pOpts.slug = positionals[0];
  if (values.type !== undefined) pOpts.typeOverride = values.type;
  if (verbose) pOpts.verbose = verbose;
  let result;
  try {
    result = await putCmd(pOpts);
  } catch (err) {
    // `fbrain put design` (single type-name positional, no --type, no
    // frontmatter `type:`) lands here. Without this re-throw, the user
    // gets the generic "list of valid types" hint and never notices that
    // their first arg already IS a valid type — the same gap fixed for
    // get/status/delete via withTypeAsPositionalHint. The catch is gated
    // on `missing_type` only, so a real record slugged "design" (whose
    // frontmatter resolves a type) is unaffected.
    if (
      err instanceof FbrainError &&
      err.code === "missing_type" &&
      positionals[0] &&
      isRecordType(positionals[0])
    ) {
      throw new FbrainError({
        code: err.code,
        message: err.message,
        hint: `"${positionals[0]}" is a record type — did you mean \`fbrain put <slug> --type ${positionals[0]}\`, or \`fbrain ${positionals[0]} new <slug>\`?`,
      });
    }
    throw err;
  }
  // Under --json the structured success object is the stdout document; the
  // human line moves to stderr (mirrors the read verbs). `created` reuses
  // put's existing created/updated signal.
  if (values.json) {
    console.error(
      `${result.action} ${result.type} ${result.slug}${indexPendingNote(result.indexPending)}`,
    );
    console.log(
      JSON.stringify({
        ok: true,
        slug: result.slug,
        created: result.action === "created",
        indexPending: result.indexPending,
      }),
    );
  } else {
    console.log(
      `${result.action} ${result.type} ${result.slug}${indexPendingNote(result.indexPending)}`,
    );
  }
  return 0;
}

// Re-throw a `not_found` from a slug-lookup command (get / status / delete)
// with a `--type` hint when the user typed a known record type as the slug
// (e.g. `fbrain get task` instead of `fbrain list --type task`). Other
// errors pass through untouched. Only nudges when no record actually exists
// with that slug — if a real concept slugged "task" lives in the brain, the
// lookup succeeds and we never get here.
export async function withTypeAsPositionalHint<T>(
  slug: string,
  inner: () => Promise<T>,
): Promise<T> {
  try {
    return await inner();
  } catch (err) {
    if (
      err instanceof FbrainError &&
      err.code === "not_found" &&
      isRecordType(slug)
    ) {
      throw new FbrainError({
        code: err.code,
        message: err.message,
        hint: `"${slug}" is a record type — did you mean \`fbrain list --type ${slug}\`?`,
      });
    }
    throw err;
  }
}

async function runGet(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: GET_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.get);
    return USAGE_ERROR;
  }
  const type = parseRecordType(values.type);
  const cfg = readConfig();
  const getOpts: Parameters<typeof getRecord>[0] = { cfg, slug, verbose };
  if (type) getOpts.type = type;
  if (values.json) getOpts.json = true;
  await withTypeAsPositionalHint(slug, () => getRecord(getOpts));
  return 0;
}

async function runList(args: Argv, verbose: Verbose): Promise<number> {
  validateLimitFlag(args);
  let parsed;
  try {
    parsed = parseCommandArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: LIST_OPTIONS,
    });
  } catch (err) {
    // A fresh user's instinct is `fbrain list task`, not `fbrain list --type
    // task`. parseArgs rejects the positional with ERR_PARSE_ARGS_UNEXPECTED_
    // POSITIONAL; when the rejected positional is a known record type, add a
    // hint pointing at the `--type` form rather than dead-ending on parseArgs's
    // bare message.
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
    ) {
      const positional = args.find((a) => !a.startsWith("-"));
      if (positional && isRecordType(positional)) {
        throw new FbrainError({
          code: "unexpected_positional",
          message: err.message,
          hint: `did you mean \`fbrain list --type ${positional}\`?`,
        });
      }
    }
    throw err;
  }
  const { values } = parsed;
  const cfg = readConfig();
  const type = parseRecordType(values.type);
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const lOpts: Parameters<typeof listCmd>[0] = { cfg, verbose };
  if (type) lOpts.type = type;
  if (values.status) lOpts.status = values.status;
  if (values.tag) lOpts.tag = values.tag;
  if (typeof limit === "number" && Number.isFinite(limit)) lOpts.limit = limit;
  if (values.json) lOpts.json = true;
  await listCmd(lOpts);
  return 0;
}

async function runStatus(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: STATUS_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.status);
    return USAGE_ERROR;
  }
  const cfg = readConfig();
  const type = parseRecordType(values.type);
  const sOpts: Parameters<typeof statusCmd>[0] = { cfg, slug, verbose };
  if (positionals[1]) sOpts.newStatus = positionals[1];
  if (type) sOpts.type = type;
  if (values.json) sOpts.json = true;
  await withTypeAsPositionalHint(slug, () => statusCmd(sOpts));
  return 0;
}

async function runLink(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: LINK_OPTIONS,
  });
  const taskSlug = positionals[0];
  const designSlug = positionals[1];
  if (!taskSlug || !designSlug) {
    console.error(COMMAND_HELP.link);
    return USAGE_ERROR;
  }
  // `fbrain link <task-slug> <design-slug>` accepts exactly two positionals.
  // Without this check, `fbrain link t1 d1 t2 d2` silently linked only
  // t1→d1 and dropped the trailing pair, while the user thought both pairs
  // landed — same silent partial-action shape delete (PR #112) and put
  // (PR #177) already fixed. Reject loudly before any I/O.
  if (positionals.length > 2) {
    throw new FbrainError({
      code: "extra_positional_args",
      message: `link takes exactly two positionals: <task-slug> <design-slug> (got ${positionals.length}: ${positionals.join(", ")}).`,
      hint: "Run `fbrain link <task-slug> <design-slug>` once per pair; bulk linking is not supported.",
    });
  }
  const cfg = readConfig();
  const lOpts: Parameters<typeof linkCmd>[0] = { cfg, taskSlug, designSlug, verbose };
  // Under --json the structured success object is the stdout document; route
  // linkCmd's human `linked …` line to stderr and emit the payload from the
  // `onResult` sink (the same value the MCP tool returns).
  if (values.json) {
    lOpts.print = (line: string) => console.error(line);
    lOpts.onResult = (payload) =>
      console.log(
        JSON.stringify({ ok: true, task: payload.from_slug, design: payload.to_slug }),
      );
  }
  await linkCmd(lOpts);
  return 0;
}

async function runSearch(args: Argv, verbose: Verbose): Promise<number> {
  validateLimitFlag(args);
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: SEARCH_OPTIONS,
  });
  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    console.error(COMMAND_HELP.search);
    return USAGE_ERROR;
  }
  // Validate --type / --min-score before readConfig so a malformed invocation
  // surfaces the parse error even on an un-init'd machine.
  const searchTypes = parseRecordTypeList(values.type);
  // Check the raw string before calling Number(): `Number("")` and
  // `Number("  ")` both return 0 (well-known JS quirk), so without the
  // trim-length guard `--min-score ""` and `--min-score "   "` silently
  // pass validation and apply a zero floor (i.e. no filter at all) —
  // masking a malformed invocation. Symmetric with the integer-flag chain
  // in PRs #87/#88/#89: reject the bad input loudly instead of silently
  // dropping it to a fake default.
  const minScoreRaw = values["min-score"];
  let minScore: number | undefined;
  if (minScoreRaw !== undefined) {
    const n = Number(minScoreRaw);
    if (minScoreRaw.trim().length === 0 || !Number.isFinite(n)) {
      throw new FbrainError({
        code: "invalid_min_score",
        message: `--min-score must be a number (got "${minScoreRaw}").`,
      });
    }
    minScore = n;
  }
  const cfg = readConfig();
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const sOpts: Parameters<typeof searchCmd>[0] = { cfg, query, verbose };
  if (typeof limit === "number" && Number.isFinite(limit)) sOpts.limit = limit;
  if (values.exact) sOpts.exact = true;
  if (minScore !== undefined) sOpts.minScore = minScore;
  if (searchTypes) sOpts.types = searchTypes;
  if (values.json) sOpts.json = true;
  await searchCmd(sOpts);
  return 0;
}

async function runAsk(args: Argv, verbose: Verbose): Promise<number> {
  validateLimitFlag(args);
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: ASK_OPTIONS,
  });
  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    console.error(COMMAND_HELP.ask);
    return USAGE_ERROR;
  }
  // --expand and its alias --llm both turn LLM query expansion back on.
  const expand = values.expand || values.llm;
  // --no-llm is now a no-op (expansion is off by default); it only conflicts
  // when paired with an explicit --expand/--llm — that's a contradiction we
  // reject so the caller's intent is unambiguous.
  if (expand && values["no-llm"]) {
    console.error(
      "error: --no-llm contradicts --expand/--llm; pick one (expansion is off by default).",
    );
    return USAGE_ERROR;
  }
  // --explain prints the LLM-generated expansions, so it requires expansion.
  // With expansion now off by default, --explain without --expand has nothing
  // to explain — exit 2 with a clear next step (keeps the old --explain
  // --no-llm rejection, now generalized to "explain needs expansion").
  if (values.explain && !expand) {
    console.error(
      "error: --explain requires LLM expansion; add --expand (alias --llm).",
    );
    return USAGE_ERROR;
  }
  // Validate --type before readConfig so an unknown type surfaces even on
  // an un-init'd machine.
  const askTypes = parseRecordTypeList(values.type);
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const cfg = readConfig();
  const aOpts: Parameters<typeof askCmd>[0] = { cfg, query, verbose };
  if (typeof limit === "number") aOpts.limit = limit;
  if (expand) aOpts.expand = true;
  if (values.explain) aOpts.explain = true;
  if (askTypes) aOpts.types = askTypes;
  if (values.json) aOpts.json = true;
  await askCmd(aOpts);
  return 0;
}

async function runDoctor(args: Argv, verbose: Verbose): Promise<number> {
  validatePositiveIntFlag(args, "--usage-window", "invalid_usage_window");
  const { values } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: DOCTOR_OPTIONS,
  });

  // `--usage` and `--freshness` pick mutually exclusive top-level paths:
  // doctor()'s `if (opts.usage)` short-circuit returns before the freshness
  // probes ever run, so `fbrain doctor --usage --freshness` ran the usage
  // report and silently dropped --freshness. Reject the combo before
  // doctor() so the user can fix the invocation instead of debugging a
  // no-op. Same flavor as PR #93 (migrate mode conflict).
  if (values.usage && values.freshness) {
    throw new FbrainError({
      code: "doctor_mode_conflict",
      message: "--usage and --freshness are mutually exclusive — pick one.",
    });
  }

  // `--usage-window` and `--usage-path` only mean anything under `--usage`
  // (COMMAND_HELP.doctor documents them nested under it). Without `--usage`,
  // the dispatcher below never reads them — so `fbrain doctor --usage-window
  // 14` ran a normal health check and silently dropped the override. Reject
  // the combo before doctor() so the user can fix the invocation instead of
  // debugging a no-op. Same flavor as PRs #93/#94 (migrate orphan flags).
  if (!values.usage) {
    const orphans: string[] = [];
    if (values["usage-window"] !== undefined) orphans.push("--usage-window");
    if (values["usage-path"] !== undefined) orphans.push("--usage-path");
    if (orphans.length > 0) {
      throw new FbrainError({
        code: "doctor_flag_requires_usage",
        message: `${orphans.join(", ")} only ${orphans.length === 1 ? "applies" : "apply"} to --usage.`,
      });
    }
  }

  const dOpts: Parameters<typeof doctor>[0] = {};
  if (verbose) dOpts.verbose = verbose;
  if (values.freshness) dOpts.freshness = true;
  if (values.write) dOpts.write = true;
  if (values.mcp) dOpts.mcp = true;
  if (values.json) dOpts.json = true;
  if (values.usage) {
    dOpts.usage = true;
    const windowArg = values["usage-window"];
    const usageOpts: NonNullable<typeof dOpts.usageOptions> = {};
    if (windowArg !== undefined) usageOpts.windowDays = parseInt(windowArg, 10);
    if (values["usage-path"]) usageOpts.usagePath = values["usage-path"];
    dOpts.usageOptions = usageOpts;
  }
  return doctor(dOpts);
}

async function runShare(args: Argv): Promise<number> {
  parseCommandArgs({ args, strict: true, allowPositionals: true, options: EMPTY_OPTIONS });
  return shareCmd();
}

async function runDelete(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: DELETE_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.delete);
    return USAGE_ERROR;
  }
  // `fbrain delete <slug>` accepts exactly one positional. Without this
  // check, extra positionals were silently dropped: `fbrain delete slug1
  // slug2` soft-deleted slug1 and threw slug2 away with no warning. Worst
  // class of silent drop — a destructive command claiming success while
  // half the user's intent vanished. Same shape as the silently-dropped
  // flag fixes in PRs #93/#94/#96/#108: reject loudly before any I/O.
  if (positionals.length > 1) {
    throw new FbrainError({
      code: "extra_positional_args",
      message: `delete takes exactly one slug (got ${positionals.length}: ${positionals.join(", ")}).`,
      hint: "Run `fbrain delete <slug>` once per record; bulk delete is not supported.",
    });
  }
  const type = parseRecordType(values.type);
  const cfg = readConfig();
  const dOpts: Parameters<typeof deleteRecord>[0] = { cfg, slug, verbose };
  if (type) dOpts.type = type;
  if (values.force) dOpts.force = true;
  // Under --json the structured success object is the stdout document; route
  // deleteRecord's human `deleted …` line to stderr and emit the payload from
  // the `onResult` sink (the same value the MCP tool returns).
  if (values.json) {
    dOpts.print = (line: string) => console.error(line);
    dOpts.onResult = (payload) =>
      console.log(JSON.stringify({ ok: true, slug: payload.slug, deleted: true }));
  }
  await withTypeAsPositionalHint(slug, () => deleteRecord(dOpts));
  return 0;
}

async function runMcpCmd(args: Argv): Promise<number> {
  parseCommandArgs({ args, strict: true, allowPositionals: false, options: EMPTY_OPTIONS });
  // Lazy-import so the SDK only loads when the user runs `fbrain mcp`.
  // Keeps CLI startup fast for non-MCP commands.
  const { runMcp } = await import("./mcp/main.ts");
  const code = await runMcp();
  if (code !== 0) return code;
  // server.connect() returns once stdio is wired; the SDK's stdin reader
  // would normally keep the event loop alive on its own, but the CLI
  // entrypoint calls `process.exit(code)` as soon as `main()` resolves.
  // Block here so the server stays up serving RPCs.
  await new Promise<void>(() => {});
  return 0; // unreachable
}

async function runReindex(args: Argv, verbose: Verbose): Promise<number> {
  const { values } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: REINDEX_OPTIONS,
  });
  const type = parseRecordType(values.type);
  const cfg = readConfig();
  const rOpts: Parameters<typeof reindexCmd>[0] = { cfg, verbose };
  if (type) rOpts.type = type;
  if (values["dry-run"]) rOpts.dryRun = true;
  if (values["repair-titles"]) rOpts.repairTitles = true;
  await reindexCmd(rOpts);
  return 0;
}

async function runMigrate(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: MIGRATE_OPTIONS,
  });

  // --status / --resume / --add-field pick three mutually exclusive modes,
  // but the dispatch below is if/else if/else — when more than one is set
  // the first branch silently wins and the others' args are dropped:
  //   fbrain migrate --status --add-field concept urgency String
  //     → ran --status, silently ignored the add-field args.
  //   fbrain migrate --resume m-1234 --add-field concept urgency String
  //     → ran --resume, silently ignored --add-field.
  // Reject the conflict before readConfig so the user can fix the
  // invocation instead of debugging a no-op migration. Same spirit as
  // `ask --explain --no-llm` (PR #56).
  const modes: string[] = [];
  if (values.status) modes.push("--status");
  if (values.resume) modes.push("--resume");
  if (values["add-field"]) modes.push("--add-field");
  if (modes.length > 1) {
    throw new FbrainError({
      code: "migrate_mode_conflict",
      message: `${modes.join(", ")} are mutually exclusive — pick one.`,
    });
  }

  // `--default` and `--dry-run` only mean anything under `--add-field` (see
  // COMMAND_HELP.migrate). With `--status` or `--resume` they were silently
  // dropped — e.g. `fbrain migrate --status --dry-run` ran a normal status
  // listing and discarded `--dry-run`. Reject the combo before readConfig
  // so the user can fix the invocation. Same flavor as PR #93 and PR #56.
  if (!values["add-field"]) {
    const orphans: string[] = [];
    if (values.default !== undefined) orphans.push("--default");
    if (values["dry-run"]) orphans.push("--dry-run");
    if (orphans.length > 0) {
      throw new FbrainError({
        code: "migrate_flag_requires_add_field",
        message: `${orphans.join(", ")} only ${orphans.length === 1 ? "applies" : "apply"} to --add-field.`,
      });
    }
  }

  const cfg = readConfig();
  const mOpts: Parameters<typeof migrateCmd>[0] = { cfg, mode: { kind: "status" }, verbose };

  if (values.status) {
    mOpts.mode = { kind: "status" };
  } else if (values.resume) {
    mOpts.mode = { kind: "resume", manifestId: values.resume };
  } else if (values["add-field"]) {
    const type = parseRecordType(positionals[0]);
    const fieldName = positionals[1];
    const fieldSpec = positionals[2];
    if (!type || !fieldName || !fieldSpec) {
      console.error(COMMAND_HELP.migrate);
      return USAGE_ERROR;
    }
    const mode: MigrateMode = {
      kind: "add-field",
      type,
      fieldName,
      fieldSpec,
      ...(values.default !== undefined ? { defaultRaw: values.default } : {}),
      ...(values["dry-run"] ? { dryRun: true } : {}),
    };
    mOpts.mode = mode;
  } else {
    console.error(COMMAND_HELP.migrate);
    return USAGE_ERROR;
  }

  await migrateCmd(mOpts);
  return 0;
}

async function runRaw(args: Argv, verbose: Verbose): Promise<number> {
  const { positionals } = parseCommandArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: EMPTY_OPTIONS,
  });
  const method = positionals[0];
  const path = positionals[1];
  if (!method || !path) {
    console.error(COMMAND_HELP.raw);
    return USAGE_ERROR;
  }
  const cfg = readConfig();
  const rOpts: Parameters<typeof rawCmd>[0] = {
    cfg,
    method,
    path,
    readStdin: maybeReadStdin,
    verbose,
  };
  if (positionals[2] !== undefined) rOpts.body = positionals[2];
  return rawCmd(rOpts);
}

// Case-insensitive on the way in: every display surface (doctor, --help,
// list/ask/get output) Capitalizes the type name, so users naturally reach
// for `--type Design`. Mirrors `put.ts normaliseType` — keep the canonical
// RECORD_TYPES lowercase and normalize input here.
function parseRecordType(raw: string | undefined): RecordType | undefined {
  if (raw === undefined) return undefined;
  const normalised = raw.trim().toLowerCase();
  if (isRecordType(normalised)) return normalised;
  throw new FbrainError({
    code: "invalid_type",
    message: `--type must be one of ${RECORD_TYPES.join(" | ")} (got "${raw}").`,
    hint: suggestRecordTypeHint(normalised),
  });
}

// Repeatable `--type` (search / ask). Validates every value against the 8
// record types and dedupes. Returns undefined when the flag is absent so
// callers can leave the filter unset. Case-insensitive — see parseRecordType.
function parseRecordTypeList(raw: string[] | undefined): RecordType[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const seen = new Set<RecordType>();
  for (const v of raw) {
    // parseRecordType throws on invalid input and never returns undefined
    // for a defined string, so the `!` is safe here.
    seen.add(parseRecordType(v)!);
  }
  return Array.from(seen);
}

// Mirrors the `Did you mean: <cmd>?` UX from suggestCommand — same Levenshtein
// threshold (max(2, floor(len/3))). Returns undefined when no candidate is
// close enough, so the caller keeps the bare "must be one of" error.
function suggestRecordTypeHint(normalised: string): string | undefined {
  if (normalised.length === 0) return undefined;
  let best: RecordType | null = null;
  let bestDist = Infinity;
  for (const t of RECORD_TYPES) {
    const d = levenshtein(normalised, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (best === null) return undefined;
  const threshold = Math.max(2, Math.floor(normalised.length / 3));
  return bestDist <= threshold ? `did you mean \`--type ${best}\`?` : undefined;
}

async function maybeReadStdin(opts?: { announce?: boolean }): Promise<string> {
  // Only read stdin when piped — avoid blocking interactive invocation.
  // Bun's process.stdin.isTTY is the same as Node's. In test contexts the
  // stdin stream may already be closed; tolerate that with a try/catch.
  if ((process.stdin as unknown as { isTTY?: boolean }).isTTY) return "";
  if (process.env.FBRAIN_NO_STDIN === "1") return "";
  // We're past the early returns, so a blocking read is about to happen. For
  // callers where stdin is a FALLBACK (the `<type> new` path with no --body),
  // the wait is invisible: an inherited-but-empty pipe never EOFs, so the
  // process hangs with zero output and a fresh dev (or their agent) has no
  // idea why. Emit one stderr breadcrumb BEFORE the read so the wait is
  // self-explaining. Only the fallback callers opt in via `announce` —
  // `put`/`raw` take stdin as their documented PRIMARY input and stay silent.
  // (Same warn-before-the-trap shape as #275/#276/#278/#279/#280.)
  if (opts?.announce) {
    console.error(
      "note: no --body given; reading the record body from stdin until EOF " +
        "(press Ctrl-D to finish, or pass --body / set FBRAIN_NO_STDIN=1 to skip).",
    );
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
