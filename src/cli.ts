#!/usr/bin/env bun
// fbrain CLI entrypoint.
//
// `--verbose` (global) echoes each HTTP request and response, including the
// canonical schema hash being targeted — per the Phase 0 spike's
// debugging guidance.

import { parseArgs } from "node:util";

import pkg from "../package.json" with { type: "json" };
import { FbrainError } from "./client.ts";
import { readConfig, ConfigMissingError } from "./config.ts";
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
  ask            hybrid retrieval (BM25 + vector + RRF + LLM expansion)
  doctor         health-check the local setup (--freshness adds G3 retrieval probes)
  raw            authenticated passthrough to node or schema service
  share          (placeholder) — see docs/phase-3-sharing-memo.md
  delete         soft-delete a record (fold_db is append-only)
  reindex        re-put every live record to refresh embeddings
  migrate        evolve a schema by adding a field (see docs/g15-schema-evolution-playbook.md)
  mcp            start an MCP server over stdio (6 tools: search/get/list/put/delete/link)
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
  return `fbrain ${type} new <slug> [--title T] [--tag T]... [--body STR] [--force]

  --title     one-line name (defaults to slug)
  --tag       repeatable; tag value to attach
  --body      markdown body; if omitted and stdin is non-TTY, body is read from stdin
  --force     overwrite an existing slug`;
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
  task: `fbrain task new <slug> [--title T] [--design D] [--tag T]... [--body STR] [--force]

  --title     one-line name (defaults to slug)
  --design    parent design slug (rejected if it does not exist)
  --tag       repeatable; tag value to attach
  --body      markdown body; if omitted and stdin is non-TTY, body is read from stdin
  --force     overwrite an existing slug`,
  concept: simpleNewHelp("concept"),
  preference: simpleNewHelp("preference"),
  reference: simpleNewHelp("reference"),
  agent: simpleNewHelp("agent"),
  project: simpleNewHelp("project"),
  spike: simpleNewHelp("spike"),
  put: `fbrain put [<slug>] [--type T]

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
  get: `fbrain get <slug> [--type T]

Without --type, queries every registered schema. Errors if the slug
exists in multiple types (prints all matches first).

  --type    design | task | concept | preference | reference | agent | project | spike`,
  list: `fbrain list [--type T] [--status S] [--tag T] [-n N | --limit N]

  --type        design | task | concept | preference | reference | agent | project | spike
                (omit to list across all types)
  --status      filter by status enum
  --tag         filter by tag membership
  -n, --limit   max results, newest-first (\`-n\` and \`--limit\` are aliases; last wins)`,
  status: `fbrain status <slug> [<new-status>] [--type T]

Bare form prints current status. With a new-status, validates against the
type's status enum, updates updated_at, and writes back.

  --type    design | task | concept | preference | reference | agent | project | spike`,
  link: `fbrain link <task-slug> <design-slug>

Rejects a non-existent design slug.`,
  search: `fbrain search <query> [-n N | --limit N] [--exact] [--min-score F] [--type T]...

Semantic search across indexed records. Dedupes fragment hits per record
and skips stale hits (records deleted since indexing). Prints
\`slug · score · type · title\` per match.

  -n, --limit   max results (\`-n\` and \`--limit\` are aliases; last wins)
  --exact       exact-match mode (passes ?exact=true to the index)
  --min-score   server-side score floor (passes ?min_score=F)
  --type        restrict results to a record type; repeat to allow several
                (e.g. \`--type design --type task\`).
                One of: design | task | concept | preference | reference |
                agent | project | spike. Omit to search across all 8 types.`,
  ask: `fbrain ask <query> [-n N | --limit N] [--no-llm] [--explain] [--type T]...

Hybrid retrieval: BM25 (client-side) + vector (native-index, schema-scoped)
fused via Reciprocal Rank Fusion. By default an LLM generates 3 alternative
phrasings of the query; BM25 + vector run against original + 3 expansions
and RRF fuses across all 8 lists. The 4-query × 2-ranker design lets
paraphrase recall ride alongside rare-token / acronym recall.

  -n, --limit N max results (default 5; \`-n\` and \`--limit\` are aliases,
                last wins)
  --no-llm      skip LLM expansion (BM25 + vector + RRF on the original
                query only — useful offline or to save tokens).
                Incompatible with --explain (there is nothing to explain
                without expansions); the combination exits 2.
  --explain     print the LLM-generated expansions before results.
                Requires expansion — incompatible with --no-llm.
  --type        restrict results to a record type; repeat to allow several
                (e.g. \`--type design --type task\`). Narrows both the BM25
                corpus and the vector schemas filter.
                One of: design | task | concept | preference | reference |
                agent | project | spike. Omit to search across all 8 types.

Cost: 1 LLM call per invocation. Run with the global --verbose to see
token + USD estimates and per-ranker debug. Missing ANTHROPIC_API_KEY
falls back to --no-llm automatically with a one-line notice; with
--explain set, the explain section also prints a no-key notice instead
of silently dropping.

The LLM key is read from \$ANTHROPIC_API_KEY (preferred) or an
optional \`anthropicApiKey\` field in ~/.fbrain/config.json.`,
  doctor: `fbrain doctor [--freshness] [--write] [--usage [--usage-window N] [--usage-path PATH]]

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

With --freshness, additionally runs the G3 retrieval-quality probes
(see docs/phase-7-search-latency-spike.md):
  - freshness-probe: 5 trials of put → search assert score ≥ 0.5
  - pollution-probe: one broad query, classify hits as live / stale /
    orphan-schema. PASS at <25% polluted, WARN at 25-50%, FAIL above.

With --write, additionally runs an idempotent put → get → soft-delete
round-trip under a reserved \`doctor-write-roundtrip-<nonce>\` slug to
prove writes actually land. OFF by default so plain \`fbrain doctor\`
never mutates.

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

Placeholder. Phase 3 spike concluded that cross-node data flow requires
fold_db's S3 + Auth-Lambda transport, which is unreachable from a
localhost-only spike. The sharing METADATA primitives (ShareRule,
ShareInvite, ShareSubscription) work end-to-end on loopback but no
records actually move between nodes. See docs/phase-3-sharing-memo.md
for the full evidence and the conditions under which this command can
become a real share.

Prints a pointer and exits 1.`,
  delete: `fbrain delete <slug> [--type T] [--force] [--yes]

Soft-deletes the record. fold_db's mutation pipeline is append-only — see
docs/phase-5-delete-spike.md — so the workaround overwrites every user
field with sentinels and stamps a tombstone tag. All fbrain read paths
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

After delete, the slug is reusable: \`fbrain design new <same-slug>\` (no
--force) will recreate it.`,
  reindex: `fbrain reindex [--type T] [--dry-run] [--repair-titles]

Refreshes the embedding entry for every live (non-tombstoned) fbrain
record by re-issuing an update mutation. Workaround for the H2a
finding in docs/phase-7-search-latency-spike.md — fold_db's
EmbeddingIndex is not currently purged on tombstone, so this
guarantees the live records stay current in the native-index top-50.
Does NOT purge phantom embeddings (that's G3e, upstream fold_db).

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

Start a Model Context Protocol server over stdio. Exposes six tools so
MCP clients (Claude Code, Codex, etc.) can read and write fbrain
in-process:
  read:  fbrain_search, fbrain_get, fbrain_list
  write: fbrain_put,    fbrain_delete, fbrain_link

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
} as const;
const TASK_OPTIONS = {
  title: { type: "string" },
  design: { type: "string" },
  tag: { type: "string", multiple: true },
  body: { type: "string" },
  force: { type: "boolean", default: false },
} as const;
const PUT_OPTIONS = { type: { type: "string" } } as const;
const GET_OPTIONS = { type: { type: "string" } } as const;
const LIST_OPTIONS = {
  type: { type: "string" },
  status: { type: "string" },
  tag: { type: "string" },
  // `--limit` with `-n` short alias — mirrors SEARCH_OPTIONS / ASK_OPTIONS so a
  // user who learned `search --limit N` doesn't hit "Unknown option" on list.
  limit: { type: "string", short: "n" },
} as const;
const STATUS_OPTIONS = { type: { type: "string" } } as const;
const SEARCH_OPTIONS = {
  limit: { type: "string", short: "n" },
  exact: { type: "boolean", default: false },
  "min-score": { type: "string" },
  type: { type: "string", multiple: true },
} as const;
const ASK_OPTIONS = {
  limit: { type: "string", short: "n" },
  "no-llm": { type: "boolean", default: false },
  explain: { type: "boolean", default: false },
  type: { type: "string", multiple: true },
} as const;
const DOCTOR_OPTIONS = {
  freshness: { type: "boolean", default: false },
  usage: { type: "boolean", default: false },
  "usage-window": { type: "string" },
  "usage-path": { type: "string" },
  write: { type: "boolean", default: false },
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
  link: EMPTY_OPTIONS,
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

export async function main(argv: Argv): Promise<number> {
  const stripped = argv.slice();
  const verbose = consumeFlag(stripped, "--verbose");
  if (consumeFlag(stripped, "--version") || consumeFlag(stripped, "-V")) {
    console.log(`fbrain ${pkg.version}`);
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
    return 1;
  }
  const rest = stripped.slice(1);

  try {
    return await dispatch(cmd, rest, { verbose });
  } catch (err) {
    if (err instanceof FbrainError) {
      console.error(`error: ${err.message}`);
      if (err.hint) console.error(`hint:  ${err.hint}`);
      return 1;
    }
    if (err instanceof ConfigMissingError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    if (err instanceof Error) {
      console.error(`error: ${err.message}`);
      return 1;
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

function printHelpFor(name: string): number {
  if (!isCommand(name)) {
    console.error(`Unknown command: ${name}`);
    console.log(TOP_HELP);
    return 1;
  }
  const h = COMMAND_HELP[name];
  if (!h) {
    console.error(`Unknown command: ${name}`);
    console.log(TOP_HELP);
    return 1;
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
// only one with a per-type extra (--design), so we branch the option set on
// type rather than wiring six near-identical functions. The pre-Phase-6
// runDesign/runTask functions did the same work copy-pasted; collapsing
// them keeps the slug-validation / stdin-fallback / "created <type> <slug>"
// envelope in one place.
async function runRecordNew(type: RecordType, args: Argv, verbose: Verbose): Promise<number> {
  const sub = args[0];
  if (sub !== "new") {
    const suggestion = sub ? suggestCommand({ compound: `${type} ${sub}` }) : null;
    if (suggestion) {
      console.error(`Unknown ${type} subcommand: ${sub}. Did you mean: ${suggestion}?`);
    } else {
      console.error(`Unknown ${type} subcommand: ${sub ?? "(none)"}\n${COMMAND_HELP[type]}`);
    }
    return 1;
  }
  const rest = args.slice(1);
  if (type === "task") {
    const { values, positionals } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: TASK_OPTIONS,
    });
    const slug = positionals[0];
    if (!slug) {
      console.error(COMMAND_HELP.task);
      return 1;
    }
    const cfg = readConfig();
    const body = values.body ?? (await maybeReadStdin());
    const tnOpts: Parameters<typeof recordNew>[0] = {
      cfg,
      type: "task",
      slug,
      title: values.title ?? slug,
      body,
      tags: values.tag ?? [],
      force: values.force,
      verbose,
    };
    if (values.design) tnOpts.designSlug = values.design;
    await recordNew(tnOpts);
    console.log(`created task ${slug}`);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: DESIGN_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP[type]);
    return 1;
  }
  const cfg = readConfig();
  const body = values.body ?? (await maybeReadStdin());
  await recordNew({
    cfg,
    type,
    slug,
    title: values.title ?? slug,
    body,
    tags: values.tag ?? [],
    force: values.force,
    verbose,
  });
  console.log(`created ${type} ${slug}`);
  return 0;
}

async function runPut(args: Argv, verbose: Verbose): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: PUT_OPTIONS,
    });
  } catch (err) {
    // `put` is intentionally frontmatter-driven — title comes from the
    // `title:` key or the first `# H1`. But every `<type> new` subcommand
    // takes `--title`, so a fresh user reflexively types
    // `fbrain put <slug> --title X` and dead-ends on parseArgs's bare
    // "Unknown option '--title'" with no nudge toward the right form.
    // Re-throw with a hint that points at `<type> new` instead.
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" &&
      args.includes("--title")
    ) {
      // Best-effort recovery of the slug positional. We can't trust parseArgs
      // (it just threw), so scan everything before `--title` and pick the
      // first non-flag arg — that's the user's positional. If they typed
      // `fbrain put --title X` with no slug, there's nothing before --title
      // and we fall back to `<slug>` rather than mis-quoting `X`.
      const titleIdx = args.indexOf("--title");
      const slug =
        args.slice(0, titleIdx).find((a) => !a.startsWith("-")) ?? "<slug>";
      throw new FbrainError({
        code: "unknown_option",
        message:
          "`put` does not accept --title. The title comes from frontmatter (`title:` between leading `---` lines) or the first `# H1` of the body.",
        hint: `To set the title via a flag, use \`fbrain <type> new ${slug} --title "..."\` instead.`,
      });
    }
    throw err;
  }
  const { values, positionals } = parsed;
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
  const result = await putCmd(pOpts);
  console.log(`${result.action} ${result.type} ${result.slug}`);
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
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: GET_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.get);
    return 1;
  }
  const type = parseRecordType(values.type);
  const cfg = readConfig();
  const getOpts: Parameters<typeof getRecord>[0] = { cfg, slug, verbose };
  if (type) getOpts.type = type;
  await withTypeAsPositionalHint(slug, () => getRecord(getOpts));
  return 0;
}

async function runList(args: Argv, verbose: Verbose): Promise<number> {
  validatePositiveIntFlag(args, "-n", "invalid_limit");
  validatePositiveIntFlag(args, "--limit", "invalid_limit");
  let parsed;
  try {
    parsed = parseArgs({
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
  await listCmd(lOpts);
  return 0;
}

async function runStatus(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: STATUS_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.status);
    return 1;
  }
  const cfg = readConfig();
  const type = parseRecordType(values.type);
  const sOpts: Parameters<typeof statusCmd>[0] = { cfg, slug, verbose };
  if (positionals[1]) sOpts.newStatus = positionals[1];
  if (type) sOpts.type = type;
  await withTypeAsPositionalHint(slug, () => statusCmd(sOpts));
  return 0;
}

async function runLink(args: Argv, verbose: Verbose): Promise<number> {
  const { positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: EMPTY_OPTIONS,
  });
  const taskSlug = positionals[0];
  const designSlug = positionals[1];
  if (!taskSlug || !designSlug) {
    console.error(COMMAND_HELP.link);
    return 1;
  }
  const cfg = readConfig();
  await linkCmd({ cfg, taskSlug, designSlug, verbose });
  return 0;
}

async function runSearch(args: Argv, verbose: Verbose): Promise<number> {
  // `-n` and `--limit` are interchangeable aliases (see ASK_OPTIONS/SEARCH_OPTIONS).
  // Validate whichever spelling the user typed.
  validatePositiveIntFlag(args, "-n", "invalid_limit");
  validatePositiveIntFlag(args, "--limit", "invalid_limit");
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: SEARCH_OPTIONS,
  });
  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    console.error(COMMAND_HELP.search);
    return 1;
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
  await searchCmd(sOpts);
  return 0;
}

async function runAsk(args: Argv, verbose: Verbose): Promise<number> {
  // `-n` and `--limit` are interchangeable aliases. Validate whichever
  // spelling the user typed.
  validatePositiveIntFlag(args, "-n", "invalid_limit");
  validatePositiveIntFlag(args, "--limit", "invalid_limit");
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: ASK_OPTIONS,
  });
  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    console.error(COMMAND_HELP.ask);
    return 1;
  }
  if (values.explain && values["no-llm"]) {
    console.error(
      "error: --explain requires LLM expansion; remove --no-llm or drop --explain.",
    );
    return 2;
  }
  // Validate --type before readConfig so an unknown type surfaces even on
  // an un-init'd machine.
  const askTypes = parseRecordTypeList(values.type);
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const cfg = readConfig();
  const aOpts: Parameters<typeof askCmd>[0] = { cfg, query, verbose };
  if (typeof limit === "number") aOpts.limit = limit;
  if (values["no-llm"]) aOpts.noLlm = true;
  if (values.explain) aOpts.explain = true;
  if (askTypes) aOpts.types = askTypes;
  await askCmd(aOpts);
  return 0;
}

async function runDoctor(args: Argv, verbose: Verbose): Promise<number> {
  validatePositiveIntFlag(args, "--usage-window", "invalid_usage_window");
  const { values } = parseArgs({
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
  parseArgs({ args, strict: true, allowPositionals: true, options: EMPTY_OPTIONS });
  return shareCmd();
}

async function runDelete(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: DELETE_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.delete);
    return 1;
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
  await withTypeAsPositionalHint(slug, () => deleteRecord(dOpts));
  return 0;
}

async function runMcpCmd(args: Argv): Promise<number> {
  parseArgs({ args, strict: true, allowPositionals: false, options: EMPTY_OPTIONS });
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
  const { values } = parseArgs({
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
  const { values, positionals } = parseArgs({
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
      return 1;
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
    return 1;
  }

  await migrateCmd(mOpts);
  return 0;
}

async function runRaw(args: Argv, verbose: Verbose): Promise<number> {
  const { positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: EMPTY_OPTIONS,
  });
  const method = positionals[0];
  const path = positionals[1];
  if (!method || !path) {
    console.error(COMMAND_HELP.raw);
    return 1;
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
    const normalised = v.trim().toLowerCase();
    if (!isRecordType(normalised)) {
      throw new FbrainError({
        code: "invalid_type",
        message: `--type must be one of ${RECORD_TYPES.join(" | ")} (got "${v}").`,
        hint: suggestRecordTypeHint(normalised),
      });
    }
    seen.add(normalised);
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

async function maybeReadStdin(): Promise<string> {
  // Only read stdin when piped — avoid blocking interactive invocation.
  // Bun's process.stdin.isTTY is the same as Node's. In test contexts the
  // stdin stream may already be closed; tolerate that with a try/catch.
  if ((process.stdin as unknown as { isTTY?: boolean }).isTTY) return "";
  if (process.env.FBRAIN_NO_STDIN === "1") return "";
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
