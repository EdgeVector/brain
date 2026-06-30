// One-shot agent wiring for fbrain: `fbrain mcp install` (alias `setup`).
//
// Today a new dev who finishes `bun link` still has to run THREE manual
// commands to get an AI agent actually USING the brain (the highest-leverage
// step), surfaced from both `fbrain init`'s next-steps and the README `## MCP`
// section:
//   1. `bun link`                            (puts `fbrain-mcp` on PATH)
//   2. `claude mcp add fbrain fbrain-mcp`    (registers the MCP server)
//   3. `fbrain mcp instructions >> CLAUDE.md`(tells the agent to USE it)
//
// `fbrain mcp install` collapses 2 + 3 + 4 (and verifies 1) into one shot:
//   1. Resolve the `fbrain-mcp` entrypoint on PATH (reusing doctor's
//      `mcp-entrypoint` resolver). If absent, print the exact `bun link` fix
//      and exit non-zero — we do NOT run `bun link` for the user (it depends on
//      their cwd / repo state).
//   2. Register with Claude Code: if `claude` is on PATH, run
//      `claude mcp add fbrain fbrain-mcp`; an already-registered result is a
//      success (idempotent — detect/skip, never error). If `claude` is NOT on
//      PATH, print the exact command for the user to run (plus the path-based
//      form for a source checkout without `bun link`, matching the README).
//   3. Append the `fbrain mcp instructions` block to ./CLAUDE.md (configurable
//      via `--claude-md <path>`), idempotently — skip if the block is already
//      present (stable marker: the `## fbrain (persistent memory)` heading).
//   4. Add a Claude Code SessionStart hook to ./.claude/settings.json
//      (configurable via `--claude-settings <path>`), idempotently, so
//      strong-confidence fbrain matches are injected proactively at session
//      start.
//
// Gating mirrors `fbrain init --grant-consent` exactly: the side effects (the
// `claude mcp add` shell-out + the CLAUDE.md/settings writes) are prompted
// unless `--yes` is passed; the flag IS the explicit approval. A final pointer to
// `fbrain doctor --mcp` proves the agent surface boots.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildAgentInstructionsBlock } from "../schemas.ts";
import { resolvePrintSink } from "../format.ts";

// Stable marker for the appended instructions block — the first heading of
// buildAgentInstructionsBlock(). If it's already in the target file we skip the
// append so re-running `mcp install` never duplicates the block.
export const INSTRUCTIONS_MARKER = "## fbrain (persistent memory)";
export const SESSION_START_HOOK_COMMAND = "fbrain hook session-start";

const CLAUDE_BIN = "claude";
const MCP_ENTRYPOINT = "fbrain-mcp";
const MCP_SERVER_NAME = "fbrain";

export type McpInstallResult = {
  // 0 on success (entrypoint resolved + side effects done or already present),
  // non-zero when the entrypoint can't be resolved (the one hard prerequisite).
  code: number;
  // Whether the user cancelled at the [Y/n] prompt (no side effects ran).
  cancelled?: boolean;
};

export type McpInstallOptions = {
  // The CLAUDE.md to append the instructions block to. Defaults to ./CLAUDE.md
  // (relative to the cwd the user ran the command in).
  claudeMd?: string;
  // Claude Code settings file to update with the SessionStart hook. Defaults
  // to ./.claude/settings.json beside the CLAUDE.md project instructions.
  claudeSettings?: string;
  // Skip the [Y/n] confirmation — the flag IS the explicit approval (mirrors
  // `init --grant-consent`). Without it we prompt before any side effect.
  yes?: boolean;
  print?: (line: string) => void;

  // ---- Injection seams for tests (mirrors init-consent.ts) ----
  /** Resolve a bin name to its absolute path on PATH (or null). Default: Bun.which. */
  whichBin?: (name: string) => string | null;
  /** Prompt the user; default reads stdin/stdout via readline. */
  ask?: (question: string) => Promise<string>;
  /** Treat the current process as a TTY (default: process.stdin.isTTY). */
  isTty?: () => boolean;
  /** Invoke `claude mcp add fbrain fbrain-mcp`. Default: spawnSync. */
  runClaudeAdd?: (claudePath: string) => ClaudeAddResult;
};

export type ClaudeAddResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

/**
 * Run the one-shot agent-wiring install. Returns a structured result so the CLI
 * dispatcher (and tests) can map it to an exit code. Never throws on a "user
 * said no" branch — only a genuine error (a failed CLAUDE.md write) propagates.
 */
export async function runMcpInstall(
  opts: McpInstallOptions,
): Promise<McpInstallResult> {
  const print = resolvePrintSink(opts);
  const which = opts.whichBin ?? ((name: string) => Bun.which(name));

  // Step 1: resolve the entrypoint. This is the one hard prerequisite — without
  // `fbrain-mcp` on PATH there is nothing to register, so we fast-fail with the
  // exact fix instead of registering a server the agent can't reach. The global
  // `bun add -g` install puts `fbrain-mcp` on PATH alongside `fbrain`; if it's
  // missing the primary remedy is to (re)install. We do NOT run `bun link` for
  // the user: it only applies to a contributor checkout (cwd = the fbrain repo).
  const entrypoint = which(MCP_ENTRYPOINT);
  if (entrypoint === null) {
    print(`[mcp install] \`${MCP_ENTRYPOINT}\` is not on PATH — nothing to register.`);
    print(`  Fix: (re)install fbrain — \`bun add -g github:EdgeVector/fbrain\` puts \`${MCP_ENTRYPOINT}\` on PATH alongside \`fbrain\` — then re-run \`fbrain mcp install\`.`);
    print(`  Contributing from a source checkout? Run \`bun link\` in the fbrain repo instead, then re-run \`fbrain mcp install\`.`);
    print(`  From a source checkout you don't want to link, use the path-based form: \`claude mcp add ${MCP_SERVER_NAME} bun "$(realpath src/mcp/main.ts)"\`.`);
    return { code: 1 };
  }
  print(`[mcp install] entrypoint resolved — ${MCP_ENTRYPOINT} -> ${entrypoint}`);

  const claudeMdPath = resolve(opts.claudeMd ?? "CLAUDE.md");

  // Gate: prompt before any side effect unless --yes (mirrors init's consent
  // gate). The flag IS the explicit approval; a non-TTY shell without --yes
  // can't be prompted, so we decline rather than act silently.
  if (!opts.yes) {
    const isTty = (opts.isTty ?? defaultIsTty)();
    if (!isTty) {
      print(`[mcp install] non-interactive shell — re-run with \`--yes\` to register \`${MCP_SERVER_NAME}\` with Claude Code, append the instructions block to ${claudeMdPath}, and install the SessionStart hook.`);
      return { code: 0, cancelled: true };
    }
    const ask = opts.ask ?? defaultAsk;
    const answer = await ask(
      `Register \`${MCP_SERVER_NAME}\` with Claude Code, append the agent-instructions block to ${claudeMdPath}, and install the SessionStart hook? [Y/n] `,
    );
    if (!isAffirmative(answer)) {
      print(`[mcp install] cancelled — no changes made.`);
      return { code: 0, cancelled: true };
    }
  }

  // Step 2: register with Claude Code.
  registerWithClaude(which, print, opts);

  // Step 3: append the instructions block to CLAUDE.md (idempotent).
  appendInstructions(claudeMdPath, print);
  appendSessionStartHook(
    resolve(
      opts.claudeSettings ??
        join(dirname(claudeMdPath), ".claude", "settings.json"),
    ),
    print,
  );

  // Done — point at the boot probe that proves the agent surface actually works.
  print(``);
  print(`[mcp install] done. Verify the agent surface boots: \`fbrain doctor --mcp\``);
  return { code: 0 };
}

// Register the fbrain MCP server with Claude Code. If `claude` is on PATH we
// shell out to `claude mcp add fbrain fbrain-mcp` and treat an
// already-registered result as success (idempotent — detect/skip, don't error).
// If `claude` is NOT on PATH we print the exact command for the user (plus the
// path-based form for a source checkout without `bun link`, matching the README).
function registerWithClaude(
  which: (name: string) => string | null,
  print: (line: string) => void,
  opts: McpInstallOptions,
): void {
  const claude = which(CLAUDE_BIN);
  if (claude === null) {
    print(`[mcp install] \`${CLAUDE_BIN}\` not on PATH — register fbrain with your agent by running:`);
    print(`    ${CLAUDE_BIN} mcp add ${MCP_SERVER_NAME} ${MCP_ENTRYPOINT}`);
    print(`  (From a source checkout without \`bun link\`: \`${CLAUDE_BIN} mcp add ${MCP_SERVER_NAME} bun "$(realpath src/mcp/main.ts)"\`.)`);
    return;
  }
  const runAdd = opts.runClaudeAdd ?? defaultRunClaudeAdd;
  const result = runAdd(claude);
  if (result.status === 0) {
    print(`[mcp install] registered \`${MCP_SERVER_NAME}\` with Claude Code (\`${CLAUDE_BIN} mcp add ${MCP_SERVER_NAME} ${MCP_ENTRYPOINT}\`).`);
    return;
  }
  // `claude mcp add` errors when the server name already exists. That's not a
  // failure for us — the desired end state (fbrain registered) already holds —
  // so detect it and report a skip rather than erroring. Match on the combined
  // output so we tolerate minor wording drift.
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (looksAlreadyRegistered(combined)) {
    print(`[mcp install] \`${MCP_SERVER_NAME}\` already registered with Claude Code — skipping.`);
    return;
  }
  const detail = (result.stderr ?? result.stdout ?? "").trim();
  print(`[mcp install] \`${CLAUDE_BIN} mcp add\` exited with status ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}.`);
  print(`  Register manually: \`${CLAUDE_BIN} mcp add ${MCP_SERVER_NAME} ${MCP_ENTRYPOINT}\``);
}

// Append the agent-instructions block to the target CLAUDE.md, idempotently:
// skip if the stable marker is already present so a second run never duplicates
// the block. Creates the file (and any missing parent dirs) when absent.
function appendInstructions(
  claudeMdPath: string,
  print: (line: string) => void,
): void {
  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf8");
    if (existing.includes(INSTRUCTIONS_MARKER)) {
      print(`[mcp install] agent-instructions block already in ${claudeMdPath} — skipping.`);
      return;
    }
  } else {
    mkdirSync(dirname(claudeMdPath), { recursive: true });
  }
  // A leading blank line keeps the block visually separated from whatever
  // precedes it (and is harmless prepended to a fresh file).
  appendFileSync(claudeMdPath, `\n${buildAgentInstructionsBlock()}\n`);
  print(`[mcp install] appended the agent-instructions block to ${claudeMdPath}.`);
}

export function appendSessionStartHook(
  claudeSettingsPath: string,
  print: (line: string) => void,
): void {
  const settings = readJsonObject(claudeSettingsPath);
  const hooks = objectValue(settings.hooks) ?? {};
  settings.hooks = hooks;
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : [];
  hooks.SessionStart = sessionStart;

  if (hasHookCommand(sessionStart, SESSION_START_HOOK_COMMAND)) {
    print(`[mcp install] SessionStart hook already in ${claudeSettingsPath} — skipping.`);
    return;
  }

  sessionStart.push({
    matcher: "startup",
    hooks: [{ type: "command", command: SESSION_START_HOOK_COMMAND }],
  });
  mkdirSync(dirname(claudeSettingsPath), { recursive: true });
  writeFileSync(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  print(`[mcp install] added SessionStart hook to ${claudeSettingsPath}.`);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return objectValue(parsed) ?? {};
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasHookCommand(entries: unknown[], command: string): boolean {
  for (const entry of entries) {
    const hooks = objectValue(entry)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (objectValue(hook)?.command === command) return true;
    }
  }
  return false;
}

// `claude mcp add <name>` rejects a name that's already registered. The exact
// wording varies across Claude Code versions, so match the stable substrings.
function looksAlreadyRegistered(output: string): boolean {
  const o = output.toLowerCase();
  return (
    o.includes("already exists") ||
    o.includes("already configured") ||
    o.includes("already registered")
  );
}

function defaultRunClaudeAdd(claudePath: string): ClaudeAddResult {
  const res = spawnSync(
    claudePath,
    ["mcp", "add", MCP_SERVER_NAME, MCP_ENTRYPOINT],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const out: ClaudeAddResult = { status: res.status };
  if (typeof res.stdout === "string" && res.stdout.length > 0) out.stdout = res.stdout;
  if (typeof res.stderr === "string" && res.stderr.length > 0) out.stderr = res.stderr;
  return out;
}

function isAffirmative(answer: string): boolean {
  const v = answer.trim().toLowerCase();
  // Default ("just hit enter") → yes, per the [Y/n] prompt convention.
  return v === "" || v === "y" || v === "yes";
}

const defaultAsk = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

function defaultIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}
