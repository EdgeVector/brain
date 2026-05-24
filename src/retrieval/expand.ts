// LLM query expansion — ask Claude for 3 alternative phrasings of the
// user's query, then run BM25+vector over the original + 3 expansions and
// fuse via RRF across all 4 lists.
//
// API surface: direct fetch to https://api.anthropic.com/v1/messages. We
// don't pull in the SDK — keeps the dep tree thin and the cost surface
// auditable. Key resolution order:
//   1) process.env.ANTHROPIC_API_KEY
//   2) ~/.fbrain/config.json's `anthropicApiKey` field (optional, undocumented)
//
// When the key is missing, the caller is expected to fall back to
// "no expansion" mode automatically — see ask.ts.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export type ExpansionResult = {
  expansions: string[];
  // Empirical cost telemetry — surfaced under --verbose.
  latencyMs: number;
  tokens: { input: number; output: number; cacheRead: number };
  model: string;
};

export type ExpandOptions = {
  query: string;
  count?: number; // default 3
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

export class ExpansionError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ExpansionError";
    this.status = status;
  }
}

export function resolveAnthropicKey(): string | null {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && env.length > 0) return env;
  // Optional config field — undocumented because env is the conventional
  // path. We read it so users on machines without a shell-env can still
  // wire ask up by editing ~/.fbrain/config.json.
  const cfgPath = process.env.FBRAIN_CONFIG ?? join(homedir(), ".fbrain", "config.json");
  if (!existsSync(cfgPath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (raw && typeof raw === "object" && "anthropicApiKey" in raw) {
      const v = (raw as Record<string, unknown>).anthropicApiKey;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function expandQuery(opts: ExpandOptions): Promise<ExpansionResult> {
  const count = opts.count ?? 3;
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchFn = opts.fetchImpl ?? fetch;
  const system =
    "You generate alternative phrasings of a user's search query to help retrieval over a personal knowledge base. " +
    "Preserve the intent. Vary surface form (synonyms, expansions of acronyms, different nouns). " +
    `Reply with exactly ${count} alternative phrasings, one per line, no numbering, no quotes, no preamble.`;
  const user = `Original query:\n${opts.query}\n\nReturn ${count} alternative phrasings:`;

  const body = {
    model,
    max_tokens: 256,
    system,
    messages: [{ role: "user", content: user }],
  };

  const started = performance.now();
  let res: Response;
  try {
    res = await fetchFn(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ExpansionError(
      `Anthropic API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
  const latencyMs = performance.now() - started;

  const text = await res.text();
  if (!res.ok) {
    throw new ExpansionError(
      `Anthropic API returned HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExpansionError(`Anthropic API returned non-JSON body: ${text.slice(0, 200)}`);
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  if (!obj) throw new ExpansionError(`Anthropic API returned non-object body`);

  const content = Array.isArray(obj.content) ? obj.content : [];
  let textOut = "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textOut += b.text;
      }
    }
  }
  const expansions = parseExpansions(textOut, count);

  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  const tokens = {
    input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cacheRead:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
  };

  return { expansions, latencyMs, tokens, model };
}

// Exported for tests — strip blank lines, leading bullets/numbers/quotes,
// and trim. Cap to `count` lines.
export function parseExpansions(raw: string, count: number): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^\s*[-*•]\s+/, "")
      .replace(/^\s*\d+[.)]\s+/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    if (cleaned.length === 0) continue;
    out.push(cleaned);
    if (out.length >= count) break;
  }
  return out;
}

// Rough cost estimate for --verbose. Haiku 4.5 pricing as of 2026-05:
// $1/M input, $5/M output (cache read $0.10/M). Numbers are approximate —
// surfaced for awareness, not billing.
export function estimateCostUsd(
  tokens: { input: number; output: number; cacheRead: number },
  model: string,
): number {
  // Default to haiku rates if we don't recognize the model.
  let inRate = 1.0, outRate = 5.0, cacheRate = 0.1;
  if (model.includes("sonnet")) {
    inRate = 3.0;
    outRate = 15.0;
    cacheRate = 0.3;
  } else if (model.includes("opus")) {
    inRate = 15.0;
    outRate = 75.0;
    cacheRate = 1.5;
  }
  return (
    (tokens.input * inRate +
      tokens.output * outRate +
      tokens.cacheRead * cacheRate) /
    1_000_000
  );
}
