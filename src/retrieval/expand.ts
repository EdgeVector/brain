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
      // `(?:\s+|$)` instead of `\s+`: also strip when the bullet IS the
      // entire content (line is just `-`, `*`, or `•`, optionally indented).
      // Without the `$` alternative those bare-bullet lines didn't match
      // any strip, survived `.trim()` as a single-character "expansion",
      // and flowed into ask.ts as a wasteful vector query (`fbrain ask`
      // would round-trip the node for a `-` search whose garbage hits
      // then polluted the RRF fused ranking). Same shape as PR #119's
      // quote-only-line skip — collapse to empty, let the existing
      // empty-after-strip check drop the line.
      .replace(/^\s*[-*•](?:\s+|$)/, "")
      // `(?:\s+|$)` instead of `\s+`: same shape as the bullet-strip fix above,
      // applied one regex over. A line that is just `3.` or `2)` (LLM hit
      // max_tokens mid-numbered-list, or emitted an empty numbered item as
      // filler) used to survive `.trim()` as a two-character "expansion" like
      // `"3."`, get pushed into the expansions list, and waste a per-query
      // BM25+vector round-trip whose garbage hits then polluted the RRF fused
      // ranking. Letting the trailing `\s+` also match end-of-string collapses
      // the line to empty so the existing empty-after-strip check drops it.
      .replace(/^\s*\d+[.)](?:\s+|$)/, "")
      // Whitespace allowance on BOTH halves: the leading half handles an
      // indented quoted phrasing like `  "foo"`; the trailing half handles
      // a phrasing emitted with trailing whitespace like `"foo"   ` — common
      // when an LLM right-pads a bullet list. Without the trailing `\s*`
      // the closing-quote regex couldn't reach `$` (whitespace sat between
      // the quote and end-of-string), the leading half stripped only the
      // opening quote, and the final `.trim()` left a stray trailing `"` —
      // same shape of corruption as the pre-fix leading-whitespace case.
      .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
      // Re-run bullet/number strip after the outer quotes come off: a line
      // like `"1. foo"` or `"- foo"` (LLM wraps a numbered/bulleted list
      // in outer quotes — system prompt asks for neither but models combine
      // both) used to leak the `1.`/`-` prefix into the cleaned phrasing.
      // The leading `"` blocked the prefix-strips up top, and by the time
      // the quote-strip exposed the bare prefix the strips above had already
      // run and wouldn't re-fire. That noise flowed verbatim into the vector
      // embedder as the per-expansion query string and silently degraded
      // recall — its ranks then leaked into the RRF fused ordering. BM25
      // absorbed the prefix via its length-< 2 token filter so the bug was
      // vector-only, the kind of partial regression that's invisible without
      // a targeted test. Same shape as PR #155 (bare bullet) / PR #166 (bare
      // number), one quote-layer in.
      .replace(/^\s*[-*•](?:\s+|$)/, "")
      .replace(/^\s*\d+[.)](?:\s+|$)/, "")
      .trim();
    if (cleaned.length === 0) continue;
    out.push(cleaned);
    if (out.length >= count) break;
  }
  return out;
}

export type ModelPricing = {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** USD per million cache-read input tokens. */
  cacheRead: number;
};

// Exact API model IDs → published rates. Substring matching is deliberately
// avoided: a future model whose name happens to contain "sonnet" but ships
// at a different price would otherwise be silently misreported. If you add
// a model, add it here too; estimateCostUsd returns null for anything
// missing so the caller can surface "unknown" instead of a wrong number.
//
// Rates sourced from anthropic.com/pricing on 2026-05-25; re-check when
// adding a new entry.
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0, cacheRead: 0.1 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "claude-opus-4-7": { input: 15.0, output: 75.0, cacheRead: 1.5 },
};

/**
 * Rough cost estimate for --verbose telemetry. Returns null when the model
 * is not in {@link MODEL_PRICING} — callers must surface that as "unknown"
 * rather than substituting a default, because guessing here silently
 * produces a number that doesn't match the bill.
 */
export function estimateCostUsd(
  tokens: { input: number; output: number; cacheRead: number },
  model: string,
): number | null {
  const rates = MODEL_PRICING[model];
  if (!rates) return null;
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead) /
    1_000_000
  );
}
