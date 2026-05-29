// Static guard against floating promises in `src/` and `scripts/`.
//
// fbrain has no eslint stack (Bun project, no @typescript-eslint), so the
// audit that proved every `.then()` call has rejection handling — see PR
// audit/floating-promises — is preserved as this test. New code that
// introduces an unhandled rejection site trips here instead of silently
// crashing on a rejected Promise at runtime.
//
// Rules enforced (heuristic, zero-dep):
//   1. Every `.then(` invocation must either supply a second argument
//      (the onRejected handler) OR be followed by a chained `.catch(`.
//   2. Iteration helpers whose semantics break with async callbacks
//      (.forEach / .filter / .find / .some / .every) must not be passed
//      an `async` function — those swallow rejections (forEach) or
//      misinterpret the always-truthy returned Promise (filter / find /
//      some / every).
//
// `test/` is intentionally NOT scanned: the harness uses `void
// readStream(...)` patterns and Bun's test runner already surfaces
// unhandled rejections there.

import { describe, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "scripts"] as const;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const s = statSync(path);
    if (s.isDirectory()) out.push(...walkTs(path));
    else if (s.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

// Find the index of the close paren matching the open paren at `openIdx`.
// Returns -1 on mismatch. Tracks comma positions at the immediate top
// level so callers can tell `then(a, b)` from `then(a)`.
function matchParen(src: string, openIdx: number): { closeIdx: number; topLevelComma: boolean } {
  let depth = 0;
  let inString: string | null = null;
  let topLevelComma = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      if (ch === inString && src[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { closeIdx: i, topLevelComma };
    } else if (ch === "," && depth === 1) topLevelComma = true;
  }
  return { closeIdx: -1, topLevelComma };
}

// Walk forward from `closeIdx + 1`, skipping whitespace, through any
// chained `.method(...)` calls. Returns true the moment a `.catch(` link
// is found, false if the chain ends without one.
function chainHasCatch(src: string, closeIdx: number): boolean {
  let i = closeIdx + 1;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== ".") return false;
    const m = /^\.([a-zA-Z_$][a-zA-Z0-9_$]*)\(/.exec(src.slice(i));
    if (!m) return false;
    if (m[1] === "catch") return true;
    const openParen = i + m[0].length - 1;
    const { closeIdx: next } = matchParen(src, openParen);
    if (next === -1) return false;
    i = next + 1;
  }
  return false;
}

function findFloatingThens(src: string): Array<{ line: number; snippet: string }> {
  const issues: Array<{ line: number; snippet: string }> = [];
  let from = 0;
  while (true) {
    const idx = src.indexOf(".then(", from);
    if (idx === -1) break;
    const openParen = idx + ".then(".length - 1;
    const { closeIdx, topLevelComma } = matchParen(src, openParen);
    if (closeIdx === -1) break;
    if (!topLevelComma && !chainHasCatch(src, closeIdx)) {
      const lineNo = src.slice(0, idx).split("\n").length;
      const line = src.split("\n")[lineNo - 1] ?? "";
      issues.push({ line: lineNo, snippet: line.trim() });
    }
    from = closeIdx + 1;
  }
  return issues;
}

const FORBIDDEN_ASYNC_CALLBACK =
  /\.(forEach|filter|find|some|every)\(\s*async\b/g;

function findAsyncIterationBugs(src: string): Array<{ line: number; snippet: string }> {
  const out: Array<{ line: number; snippet: string }> = [];
  for (const m of src.matchAll(FORBIDDEN_ASYNC_CALLBACK)) {
    const lineNo = src.slice(0, m.index!).split("\n").length;
    const line = src.split("\n")[lineNo - 1] ?? "";
    out.push({ line: lineNo, snippet: line.trim() });
  }
  return out;
}

describe("no floating promises (src/ + scripts/)", () => {
  const files = SCAN_DIRS.flatMap((d) => walkTs(join(REPO_ROOT, d)));
  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length + 1);
    test(rel, () => {
      const src = readFileSync(file, "utf8");
      const floating = findFloatingThens(src);
      const asyncCbs = findAsyncIterationBugs(src);
      if (floating.length === 0 && asyncCbs.length === 0) return;
      const parts: string[] = [];
      if (floating.length > 0) {
        parts.push(
          `${rel}: \`.then(\` without rejection handling (need a second argument or chained \`.catch(\`):\n` +
            floating.map((f) => `  L${f.line}: ${f.snippet}`).join("\n"),
        );
      }
      if (asyncCbs.length > 0) {
        parts.push(
          `${rel}: async callback in iteration helper (rejection is swallowed, or truthy-Promise breaks semantics):\n` +
            asyncCbs.map((f) => `  L${f.line}: ${f.snippet}`).join("\n"),
        );
      }
      throw new Error(parts.join("\n\n"));
    });
  }
});
