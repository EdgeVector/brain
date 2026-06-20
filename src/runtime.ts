// Single source of truth for the minimum supported Bun runtime version.
//
// The README's Prerequisites section states a HARD requirement — "Bun ≥
// 1.3.10" — but until this module nothing enforced or even checked it, so a
// new dev on an older Bun hit an opaque low-level failure with no pointer to
// the real cause. We anchor the minimum to `package.json` `engines.bun` so
// `bun install` warns on an unsupported runtime AND the `runtime` doctor check
// (src/commands/doctor.ts) reports the same number — change it in one place
// (package.json) and both surfaces track it. README's prose number must be
// kept in lockstep by hand (there is no machine-readable hook into Markdown).

import pkg from "../package.json" with { type: "json" };

// Parse the minimum out of `engines.bun` (e.g. ">=1.3.10" → "1.3.10"). Falls
// back to a hard-coded floor if the field is missing/malformed so the check
// never silently no-ops on a packaging mistake.
const ENGINES_BUN_FALLBACK = "1.3.10";

export const MIN_BUN_VERSION: string = parseEnginesBun(
  (pkg as { engines?: { bun?: unknown } }).engines?.bun,
);

function parseEnginesBun(spec: unknown): string {
  if (typeof spec === "string") {
    // Strip a leading range operator (>=, >, ^, ~, =, v) and surrounding
    // whitespace; keep just the dotted version we compare against.
    const m = spec.trim().match(/(\d+\.\d+\.\d+)/);
    if (m) return m[1]!;
  }
  return ENGINES_BUN_FALLBACK;
}

// Parse a semver-ish string into [major, minor, patch], ignoring any
// prerelease/build suffix (e.g. "1.3.10-canary.1+abc" → [1,3,10]). Missing
// components default to 0 so "1.3" parses as [1,3,0]. Returns null when there
// is no leading numeric version at all.
export function parseVersionTriple(
  version: string,
): [number, number, number] | null {
  const m = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

// -1 / 0 / +1 for a < b / a == b / a > b. Compares only the numeric
// major.minor.patch triple — prerelease/build noise is ignored, matching how
// "is my Bun new enough?" should behave (a prerelease of the minimum counts as
// the minimum). Unparseable inputs sort as lowest so a garbage version is
// treated as "too old" rather than silently passing.
export function compareVersions(a: string, b: string): number {
  const ta = parseVersionTriple(a);
  const tb = parseVersionTriple(b);
  if (!ta && !tb) return 0;
  if (!ta) return -1;
  if (!tb) return 1;
  for (let i = 0; i < 3; i++) {
    const ai = ta[i] ?? 0;
    const bi = tb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

// True when `found` (a running `Bun.version`) is at least `min`.
export function bunVersionMeetsMinimum(
  found: string,
  min: string = MIN_BUN_VERSION,
): boolean {
  return compareVersions(found, min) >= 0;
}
