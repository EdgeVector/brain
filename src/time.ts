import { FbrainError } from "./client.ts";

// Parse an updated-since value into epoch-millis. Accepts either an absolute
// ISO-8601 timestamp or a relative "ago" token such as `45s`, `30m`, `24h`,
// `7d`, or `2w`.
const RELATIVE_SINCE_RE = /^(\d+)\s*(s|m|h|d|w)$/i;
const RELATIVE_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseUpdatedSince(raw: string, now: number = Date.now()): number {
  const trimmed = raw.trim();
  const rel = RELATIVE_SINCE_RE.exec(trimmed);
  if (rel) {
    const magnitude = parseInt(rel[1]!, 10);
    const unitMs = RELATIVE_UNIT_MS[rel[2]!.toLowerCase()]!;
    return now - magnitude * unitMs;
  }
  if (/^\d+$/.test(trimmed)) {
    throw new FbrainError({
      code: "invalid_updated_since",
      message: `--updated-since "${raw}" is ambiguous — add a unit for a relative window (e.g. \`${trimmed}d\`) or pass a full ISO-8601 timestamp.`,
    });
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new FbrainError({
      code: "invalid_updated_since",
      message: `--updated-since "${raw}" is not a valid ISO-8601 timestamp or relative window (e.g. \`7d\`, \`24h\`, \`2026-07-01\`).`,
    });
  }
  return ms;
}
