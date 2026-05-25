#!/usr/bin/env bun
// fbrain CLI entrypoint.
//
// `--verbose` (global) echoes each HTTP request and response, including the
// canonical schema hash being targeted — per the Phase 0 spike's
// debugging guidance.

import { parseArgs } from "node:util";

import { FbrainError } from "./client.ts";
import { readConfig, ConfigMissingError } from "./config.ts";
import { runInit } from "./commands/init.ts";
import { designNew } from "./commands/design.ts";
import { taskNew } from "./commands/task.ts";
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

const TOP_HELP = `fbrain — CLI brain over fold_db

Usage:
  fbrain <command> [options]

Commands:
  init           bootstrap a node + register schemas + write config
  design new     create a new Design
  task new       create a new Task
  put            upsert a Design or Task from stdin (frontmatter-aware)
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

Run \`fbrain help <command>\` for per-command usage.`;

export const COMMAND_HELP: Record<Command, string> = {
  init: `fbrain init [--node-url URL] [--schema-service-url URL] [--name DISPLAY]

Probe the node, bootstrap if needed, register Design + Task, load
schemas, persist ~/.fbrain/config.json with canonical hashes.
Idempotent — re-run after \`409 ambiguous_schema_name\` to refresh hashes.

  --node-url             defaults to http://127.0.0.1:9001 (homebrew fold_db_node daemon)
  --schema-service-url   defaults to the prod cloud Lambda
                         (https://axo709qs11.execute-api.us-east-1.amazonaws.com)
  --name                 bootstrap display name (default: fbrain)`,
  design: `fbrain design new <slug> [--title T] [--tag T]... [--body STR] [--force]

  --title     one-line name (defaults to slug)
  --tag       repeatable; tag value to attach
  --body      markdown body; if omitted and stdin is non-TTY, body is read from stdin
  --force     overwrite an existing slug`,
  task: `fbrain task new <slug> [--title T] [--design D] [--tag T]... [--body STR] [--force]

  --title     one-line name (defaults to slug)
  --design    parent design slug (rejected if it does not exist)
  --tag       repeatable; tag value to attach
  --body      markdown body; if omitted and stdin is non-TTY, body is read from stdin
  --force     overwrite an existing slug`,
  put: `fbrain put <slug>

Read a markdown body (with optional YAML-subset frontmatter) from stdin
and upsert a record. Re-putting the same slug updates in place —
no --force flag, no duplicate, no 409.

Frontmatter (between leading \`---\` lines) keys honored:
  type     design | task | concept | preference | reference | agent | project | spike
           (case-insensitive; default: design)
  title    string         (default: first H1 in body, else slug)
  tags     [a, b]         (inline) OR a block list of \`  - tag\` lines

Body after the closing \`---\` becomes the record's body (indexed for
search). Empty body is valid.

Examples:
  cat note.md | fbrain put my-note
  echo "---\\ntype: concept\\ntitle: Idempotency\\n---\\nbody" | fbrain put concept-idempotency`,
  get: `fbrain get <slug> [--type T]

Without --type, queries every registered schema. Errors if the slug
exists in multiple types (prints all matches first).

  --type    design | task | concept | preference | reference | agent | project | spike`,
  list: `fbrain list [--type T] [--status S] [--tag T] [-n N]

  --type      design | task | concept | preference | reference | agent | project | spike
              (omit to list across all types)
  --status    filter by status enum
  --tag       filter by tag membership
  -n          max results (newest-first)`,
  status: `fbrain status <slug> [<new-status>] [--type T]

Bare form prints current status. With a new-status, validates against the
type's status enum, updates updated_at, and writes back.

  --type    design | task | concept | preference | reference | agent | project | spike`,
  link: `fbrain link <task-slug> <design-slug>

Rejects a non-existent design slug.`,
  search: `fbrain search <query> [-n N] [--exact] [--min-score F]

Semantic search across indexed records. Dedupes fragment hits per record
and skips stale hits (records deleted since indexing). Prints
\`slug · score · type · title\` per match.

  -n            max results
  --exact       exact-match mode (passes ?exact=true to the index)
  --min-score   server-side score floor (passes ?min_score=F)`,
  ask: `fbrain ask <query> [--limit N] [--no-llm] [--explain]

Hybrid retrieval: BM25 (client-side) + vector (native-index, schema-scoped)
fused via Reciprocal Rank Fusion. By default an LLM generates 3 alternative
phrasings of the query; BM25 + vector run against original + 3 expansions
and RRF fuses across all 8 lists. The 4-query × 2-ranker design lets
paraphrase recall ride alongside rare-token / acronym recall.

  --limit N     max results (default 5)
  --no-llm      skip LLM expansion (BM25 + vector + RRF on the original
                query only — useful offline or to save tokens)
  --explain     print the LLM-generated expansions before results

Cost: 1 LLM call per invocation. Run with the global --verbose to see
token + USD estimates and per-ranker debug. Missing ANTHROPIC_API_KEY
falls back to --no-llm automatically with a one-line notice.

The LLM key is read from \$ANTHROPIC_API_KEY (preferred) or an
optional \`anthropicApiKey\` field in ~/.fbrain/config.json.`,
  doctor: `fbrain doctor [--freshness] [--usage [--usage-window N] [--usage-path PATH]]

Live health checks:
  - config valid (~/.fbrain/config.json + hex-64 hashes)
  - schema service reachable
  - node reachable + provisioned
  - schemas loaded into the node
  - schema drift between schemas.ts and the registered Design/Task schemas

With --freshness, additionally runs the G3 retrieval-quality probes
(see docs/phase-7-search-latency-spike.md):
  - freshness-probe: 5 trials of put → search assert score ≥ 0.5
  - pollution-probe: one broad query, classify hits as live / stale /
    orphan-schema. PASS at <25% polluted, WARN at 25-50%, FAIL above.

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
  delete: `fbrain delete <slug> [--type T]

Soft-deletes the record. fold_db's mutation pipeline is append-only — see
docs/phase-5-delete-spike.md — so the workaround overwrites every user
field with sentinels and stamps a tombstone tag. All fbrain read paths
(get, list, status, link, search) then filter the record out.

Without --type, queries every registered schema; errors with "specify
--type" if the slug exists in more than one type. Errors with
"No <type>: <slug>" if the slug is already deleted or never existed.

  --type    design | task | concept | preference | reference | agent | project | spike

After delete, the slug is reusable: \`fbrain design new <same-slug>\` (no
--force) will recreate it.`,
  reindex: `fbrain reindex [--type T] [--dry-run]

Refreshes the embedding entry for every live (non-tombstoned) fbrain
record by re-issuing an update mutation. Workaround for the H2a
finding in docs/phase-7-search-latency-spike.md — fold_db's
EmbeddingIndex is not currently purged on tombstone, so this
guarantees the live records stay current in the native-index top-50.
Does NOT purge phantom embeddings (that's G3e, upstream fold_db).

  --type      narrow to one of: design | task | concept | preference |
              reference | agent | project | spike (default: all 8)
  --dry-run   list records that would be reindexed; no writes

Run with the global --verbose to print per-record outcome
(kept | reindexed | skipped-tombstone).`,
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

Register with Claude Code:
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
const GET_OPTIONS = { type: { type: "string" } } as const;
const LIST_OPTIONS = {
  type: { type: "string" },
  status: { type: "string" },
  tag: { type: "string" },
  n: { type: "string" },
} as const;
const STATUS_OPTIONS = { type: { type: "string" } } as const;
const SEARCH_OPTIONS = {
  n: { type: "string" },
  exact: { type: "boolean", default: false },
  "min-score": { type: "string" },
} as const;
const ASK_OPTIONS = {
  limit: { type: "string" },
  "no-llm": { type: "boolean", default: false },
  explain: { type: "boolean", default: false },
} as const;
const DOCTOR_OPTIONS = {
  freshness: { type: "boolean", default: false },
  usage: { type: "boolean", default: false },
  "usage-window": { type: "string" },
  "usage-path": { type: "string" },
} as const;
const DELETE_OPTIONS = { type: { type: "string" } } as const;
const REINDEX_OPTIONS = {
  type: { type: "string" },
  "dry-run": { type: "boolean", default: false },
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
  put: EMPTY_OPTIONS,
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
    console.error(`Unknown command: ${cmd}`);
    console.error(TOP_HELP);
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

function consumeFlag(argv: Argv, name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
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
      return runDesign(args, verboseFn);
    case "task":
      return runTask(args, verboseFn);
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
  await runInit(initOpts);
  return 0;
}

async function runDesign(args: Argv, verbose: Verbose): Promise<number> {
  const sub = args[0];
  if (sub !== "new") {
    console.error(`Unknown design subcommand: ${sub ?? "(none)"}\n${COMMAND_HELP.design}`);
    return 1;
  }
  const rest = args.slice(1);
  const { values, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: DESIGN_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.design);
    return 1;
  }
  const cfg = readConfig();
  const body = values.body ?? (await maybeReadStdin());
  await designNew({
    cfg,
    slug,
    title: values.title ?? slug,
    body,
    tags: values.tag ?? [],
    force: values.force,
    verbose,
  });
  console.log(`created design ${slug}`);
  return 0;
}

async function runTask(args: Argv, verbose: Verbose): Promise<number> {
  const sub = args[0];
  if (sub !== "new") {
    console.error(`Unknown task subcommand: ${sub ?? "(none)"}\n${COMMAND_HELP.task}`);
    return 1;
  }
  const rest = args.slice(1);
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
  const tnOpts: Parameters<typeof taskNew>[0] = {
    cfg,
    slug,
    title: values.title ?? slug,
    body,
    tags: values.tag ?? [],
    force: values.force,
    verbose,
  };
  if (values.design) tnOpts.designSlug = values.design;
  await taskNew(tnOpts);
  console.log(`created task ${slug}`);
  return 0;
}

async function runPut(args: Argv, verbose: Verbose): Promise<number> {
  const { positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: EMPTY_OPTIONS,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error(COMMAND_HELP.put);
    return 1;
  }
  const cfg = readConfig();
  const input = await maybeReadStdin();
  const pOpts: Parameters<typeof putCmd>[0] = { cfg, slug, input };
  if (verbose) pOpts.verbose = verbose;
  const result = await putCmd(pOpts);
  console.log(`${result.action} ${result.type} ${result.slug}`);
  return 0;
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
  await getRecord(getOpts);
  return 0;
}

async function runList(args: Argv, verbose: Verbose): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: LIST_OPTIONS,
  });
  const cfg = readConfig();
  const type = parseRecordType(values.type);
  const limit = values.n ? parseInt(values.n, 10) : undefined;
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
  await statusCmd(sOpts);
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
  const cfg = readConfig();
  const limit = values.n ? parseInt(values.n, 10) : undefined;
  const minScore = values["min-score"] !== undefined ? Number(values["min-score"]) : undefined;
  if (minScore !== undefined && !Number.isFinite(minScore)) {
    throw new FbrainError({
      code: "invalid_min_score",
      message: `--min-score must be a number (got "${values["min-score"]}").`,
    });
  }
  const sOpts: Parameters<typeof searchCmd>[0] = { cfg, query, verbose };
  if (typeof limit === "number" && Number.isFinite(limit)) sOpts.limit = limit;
  if (values.exact) sOpts.exact = true;
  if (minScore !== undefined) sOpts.minScore = minScore;
  await searchCmd(sOpts);
  return 0;
}

async function runAsk(args: Argv, verbose: Verbose): Promise<number> {
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
  const cfg = readConfig();
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new FbrainError({
      code: "invalid_limit",
      message: `--limit must be a positive integer (got "${values.limit}").`,
    });
  }
  const aOpts: Parameters<typeof askCmd>[0] = { cfg, query, verbose };
  if (typeof limit === "number") aOpts.limit = limit;
  if (values["no-llm"]) aOpts.noLlm = true;
  if (values.explain) aOpts.explain = true;
  await askCmd(aOpts);
  return 0;
}

async function runDoctor(args: Argv, verbose: Verbose): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: DOCTOR_OPTIONS,
  });
  const dOpts: Parameters<typeof doctor>[0] = {};
  if (verbose) dOpts.verbose = verbose;
  if (values.freshness) dOpts.freshness = true;
  if (values.usage) {
    dOpts.usage = true;
    const windowArg = values["usage-window"];
    const usageOpts: NonNullable<typeof dOpts.usageOptions> = {};
    if (windowArg !== undefined) {
      const n = parseInt(windowArg, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new FbrainError({
          code: "invalid_usage_window",
          message: `--usage-window must be a positive integer (got "${windowArg}").`,
        });
      }
      usageOpts.windowDays = n;
    }
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
  const type = parseRecordType(values.type);
  const cfg = readConfig();
  const dOpts: Parameters<typeof deleteRecord>[0] = { cfg, slug, verbose };
  if (type) dOpts.type = type;
  await deleteRecord(dOpts);
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

function parseRecordType(raw: string | undefined): RecordType | undefined {
  if (raw === undefined) return undefined;
  if (isRecordType(raw)) return raw;
  throw new FbrainError({
    code: "invalid_type",
    message: `--type must be one of ${RECORD_TYPES.join(" | ")} (got "${raw}").`,
  });
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
