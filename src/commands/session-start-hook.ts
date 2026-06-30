import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import type { Config } from "../config.ts";
import type { SearchHitJson } from "./search.ts";
import { askCmd } from "./ask.ts";

const DEFAULT_LIMIT = 3;
const MAX_QUERY_PART = 600;
const MAX_SNIPPET = 180;

export type SessionStartHookInput = {
  cwd?: unknown;
  source?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  prompt?: unknown;
  user_prompt?: unknown;
  userPrompt?: unknown;
  initial_user_message?: unknown;
  message?: unknown;
};

export type RepoContext = {
  root?: string;
  repo?: string;
  branch?: string;
};

export type SessionStartHookOptions = {
  cfg: Config;
  input?: string;
  cwd?: string;
  limit?: number;
  print?: (line: string) => void;
  ask?: (query: string, limit: number) => Promise<SearchHitJson[]>;
  repoContext?: (cwd: string) => RepoContext;
};

export async function runSessionStartHook(
  opts: SessionStartHookOptions,
): Promise<number> {
  const print = opts.print ?? console.log;
  let parsed: SessionStartHookInput = {};
  try {
    parsed = parseHookInput(opts.input ?? "");
  } catch {
    return 0;
  }

  const cwd = stringValue(parsed.cwd) ?? opts.cwd ?? process.cwd();
  const repo = (opts.repoContext ?? defaultRepoContext)(cwd);
  const query = buildSessionStartQuery(parsed, cwd, repo);
  if (query.trim().length === 0) return 0;

  try {
    const ask =
      opts.ask ??
      (async (q: string, limit: number) => {
        let payload: SearchHitJson[] = [];
        await askCmd({
          cfg: opts.cfg,
          query: q,
          limit,
          print: () => {},
          printErr: () => {},
          isTty: () => false,
          onResult: (p) => {
            payload = p;
          },
        });
        return payload;
      });
    const payload = await ask(query, opts.limit ?? DEFAULT_LIMIT);
    const strong = payload
      .filter((m) => m.confidence === "strong")
      .slice(0, opts.limit ?? DEFAULT_LIMIT);
    if (strong.length === 0) return 0;
    print(JSON.stringify(buildClaudeSessionStartOutput(strong)));
  } catch {
    return 0;
  }
  return 0;
}

export async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

export function parseHookInput(input: string): SessionStartHookInput {
  const trimmed = input.trim();
  if (trimmed.length === 0) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as SessionStartHookInput) : {};
}

export function buildSessionStartQuery(
  input: SessionStartHookInput,
  cwd: string,
  repo: RepoContext,
): string {
  const parts = [
    "Claude Code session start",
    field("event", stringValue(input.hook_event_name)),
    field("source", stringValue(input.source)),
    field("cwd", cwd),
    field("repo", repo.repo),
    field("repo_root", repo.root),
    field("branch", repo.branch),
    field("prompt", firstPrompt(input)),
    field("transcript", transcriptPrompt(stringValue(input.transcript_path))),
  ];
  return parts.filter((p): p is string => Boolean(p)).join("\n");
}

export function buildClaudeSessionStartOutput(matches: SearchHitJson[]): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildAdditionalContext(matches),
    },
  };
}

export function buildAdditionalContext(matches: readonly SearchHitJson[]): string {
  const lines = [
    "fbrain surfaced strong-confidence records relevant to this session:",
  ];
  for (const match of matches) {
    lines.push(`- ${match.slug} - ${match.title}`);
    const snippet = compact(match.snippet, MAX_SNIPPET);
    if (snippet) lines.push(`  ${snippet}`);
  }
  return lines.join("\n");
}

function firstPrompt(input: SessionStartHookInput): string | undefined {
  return (
    stringValue(input.prompt) ??
    stringValue(input.user_prompt) ??
    stringValue(input.userPrompt) ??
    stringValue(input.initial_user_message) ??
    stringValue(input.message)
  );
}

function field(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `${name}: ${compact(value, MAX_QUERY_PART)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function compact(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function transcriptPrompt(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).slice(-50);
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]!) as unknown;
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (r.type !== "user") continue;
      const message = r.message;
      if (typeof message === "string") return message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content
            .map((part) =>
              part && typeof part === "object"
                ? stringValue((part as Record<string, unknown>).text)
                : undefined,
            )
            .filter((part): part is string => Boolean(part))
            .join(" ");
          if (text.trim().length > 0) return text;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function defaultRepoContext(cwd: string): RepoContext {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = git(cwd, ["branch", "--show-current"]);
  const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
  const repo = remote ? repoName(remote) : undefined;
  return {
    ...(root ? { root } : {}),
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
  };
}

function git(cwd: string, args: string[]): string | undefined {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0) return undefined;
  const out = (res.stdout ?? "").trim();
  return out.length > 0 ? out : undefined;
}

function repoName(remote: string): string | undefined {
  const normalized = remote
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  return normalized.includes("/") ? normalized : undefined;
}
