// Static guard: every `commitResidentWritePlan(` call in `src/` must BIND the
// receipt it returns.
//
// Why a structural test and not a review note: this helper returns the node's
// `durability` claim for the one resident batch it commits, and of its seven
// call sites exactly one (`put`) ever read it. The other six used a bare
// `await`, so `papercut close`, `papercut file`, `papercut set`, the reference
// twin, `brain status` and `brain new` each printed a transition with nothing
// in it to say whether the write was on disk.
//
// That is a shared-helper-plus-per-caller silent-drop machine: the information
// exists, the helper hands it over, and each new caller has to remember to
// take it. One did. The measured cost is on
// papercut-brain-papercut-close-acks-a-status-transition-with-no-durability-
// and-the-write-can-revert-20261001 — a reopen of a live defect printed its
// transition, verified `open` on an immediate re-read, and read `wontfix`
// again ten minutes later with its evidence stanza gone, because a queued
// write is served from the state it landed in and a re-read cannot tell that
// from a flushed one.
//
// SCOPE, stated because a guard is only as wide as its matcher: binding the
// receipt is NECESSARY, not SUFFICIENT. This test cannot check that a caller
// then SURFACES the durability — a bound-and-ignored receipt passes here. What
// it does guarantee is that the next call site added to this helper cannot
// throw the claim away without someone deciding to.
//
// Comments are stripped before matching: the rationale above and the one in
// src/write-confirmation.ts both name the function, and a guard that reads its
// own explanation as a call site fires on correct source (see
// last-stack item 175).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SRC = join(REPO_ROOT, "src");
const HELPER = "commitResidentWritePlan";
/** Where the helper is defined and imported — neither is a call site. */
const DEFINITION_FILE = "src/resident-write-plan.ts";

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

/**
 * Blank out `//` and block comments so a comment that names the helper is not
 * read as a call. Line numbers are preserved: newlines survive, everything
 * else inside a comment becomes a space.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** A call whose value goes nowhere: `await commitResidentWritePlan(` with no `=` before it. */
export function findUnboundCalls(
  src: string,
): Array<{ line: number; snippet: string }> {
  const code = stripComments(src);
  const lines = code.split("\n");
  const rawLines = src.split("\n");
  const out: Array<{ line: number; snippet: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const idx = line.indexOf(`${HELPER}(`);
    if (idx === -1) continue;
    // Everything on the line up to the call. A binding puts `=` (assignment or
    // a destructuring/arrow form) or `return` there; a bare statement does not.
    const before = line.slice(0, idx);
    if (/[=]|\breturn\b/.test(before)) continue;
    out.push({ line: i + 1, snippet: (rawLines[i] ?? line).trim() });
  }
  return out;
}

describe(`${HELPER} receipts are bound, not discarded`, () => {
  const files = walkTs(SRC).filter(
    (f) => f.slice(REPO_ROOT.length + 1) !== DEFINITION_FILE,
  );

  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length + 1);
    test(rel, () => {
      const unbound = findUnboundCalls(readFileSync(file, "utf8"));
      if (unbound.length === 0) return;
      throw new Error(
        `${rel}: ${HELPER}() receipt discarded — bind it and surface its ` +
          `durability (see src/write-confirmation.ts: writeDurabilityOf / ` +
          `writeDurabilityTokens / writeDurabilityWarning):\n` +
          unbound.map((u) => `  L${u.line}: ${u.snippet}`).join("\n"),
      );
    });
  }

  // The matcher itself, against both directions. Without these the guard could
  // silently stop matching anything and still read as coverage.
  test("matcher flags a bare await and accepts a binding", () => {
    expect(
      findUnboundCalls(`await ${HELPER}({ node, plan });`),
    ).toHaveLength(1);
    expect(
      findUnboundCalls(`const r = await ${HELPER}({ node, plan });`),
    ).toHaveLength(0);
    expect(
      findUnboundCalls(`return ${HELPER}({ node, plan });`),
    ).toHaveLength(0);
  });

  // The item-175 case: a comment that quotes the defective line must not fire.
  test("a comment naming the helper is not a call site", () => {
    expect(
      findUnboundCalls(`// was: await ${HELPER}({ node, plan });\nconst x = 1;`),
    ).toHaveLength(0);
    expect(
      findUnboundCalls(`/* await ${HELPER}(...) threw the receipt away */`),
    ).toHaveLength(0);
  });
});
