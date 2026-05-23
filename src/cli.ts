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
import { doctorStub } from "./commands/doctor.ts";
import type { RecordType } from "./schemas.ts";

const COMMANDS = [
  "init",
  "design",
  "task",
  "get",
  "list",
  "status",
  "link",
  "doctor",
  "help",
] as const;
type Command = (typeof COMMANDS)[number];

const TOP_HELP = `fbrain — CLI brain over fold_db

Usage:
  fbrain <command> [options]

Commands:
  init           bootstrap a node + register schemas + write config
  design new     create a new Design
  task new       create a new Task
  get            print a record by slug
  list           list records, newest-first
  status         show or update a record's status
  link           link a task to a parent design
  doctor         health-check the local setup (Phase 2 stub for now)
  help <cmd>     per-command usage

Global flags:
  --verbose      echo HTTP requests + responses
  --help, -h     print this help

Run \`fbrain help <command>\` for per-command usage.`;

const COMMAND_HELP: Record<string, string> = {
  init: `fbrain init [--node-url URL] [--schema-service-url URL] [--name DISPLAY]

Probe the node, bootstrap if needed, register Design + Task, load
schemas, persist ~/.fbrain/config.json with canonical hashes.
Idempotent — re-run after \`409 ambiguous_schema_name\` to refresh hashes.

  --node-url             defaults to http://127.0.0.1:9101
  --schema-service-url   defaults to http://127.0.0.1:9102
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
  get: `fbrain get <slug> [--type design|task]

Without --type, queries both schemas. Errors if the slug exists in both.`,
  list: `fbrain list [--type T] [--status S] [--tag T] [-n N]

  --type      design | task
  --status    filter by status enum
  --tag       filter by tag membership
  -n          max results (newest-first)`,
  status: `fbrain status <slug> [<new-status>] [--type design|task]

Bare form prints current status. With a new-status, validates against the
enum, updates updated_at, and writes back.`,
  link: `fbrain link <task-slug> <design-slug>

Rejects a non-existent design slug.`,
  doctor: `fbrain doctor

Phase 1 stub. Reports config presence; full health checks land in Phase 2.`,
  help: `fbrain help <command>`,
};

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
    case "get":
      return runGet(args, verboseFn);
    case "list":
      return runList(args, verboseFn);
    case "status":
      return runStatus(args, verboseFn);
    case "link":
      return runLink(args, verboseFn);
    case "doctor":
      doctorStub();
      return 0;
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
    options: {
      "node-url": { type: "string" },
      "schema-service-url": { type: "string" },
      name: { type: "string" },
    },
  });
  await runInit({
    nodeUrl: values["node-url"] ?? "http://127.0.0.1:9101",
    schemaServiceUrl: values["schema-service-url"] ?? "http://127.0.0.1:9102",
    bootstrapName: values.name,
    verbose,
  });
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
    options: {
      title: { type: "string" },
      tag: { type: "string", multiple: true },
      body: { type: "string" },
      force: { type: "boolean", default: false },
    },
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
    options: {
      title: { type: "string" },
      design: { type: "string" },
      tag: { type: "string", multiple: true },
      body: { type: "string" },
      force: { type: "boolean", default: false },
    },
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

async function runGet(args: Argv, verbose: Verbose): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      type: { type: "string" },
    },
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
    options: {
      type: { type: "string" },
      status: { type: "string" },
      tag: { type: "string" },
      n: { type: "string" },
    },
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
    options: {
      type: { type: "string" },
    },
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
    options: {},
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

function parseRecordType(raw: string | undefined): RecordType | undefined {
  if (raw === undefined) return undefined;
  if (raw === "design" || raw === "task") return raw;
  throw new FbrainError({
    code: "invalid_type",
    message: `--type must be "design" or "task" (got "${raw}").`,
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
