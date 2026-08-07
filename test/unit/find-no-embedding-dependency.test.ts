// Guard: brain's dependency tree must never gain an embedding model.
//
// `find` (like `search`/`ask`) retrieves via the Search app's vector plane
// (search-plane.ts) over a subprocess/in-process boundary — brain itself
// never turns text into a vector. The Search app owns that (all-MiniLM-L6-v2,
// 384-d, search/src/vector/embedder.ts) as the SINGLE place a vector is
// produced. This test is what keeps that true: it fails the moment an
// embedding/tokenizer/tensor package lands in package.json or the resolved
// dependency tree, so a future PR that "just wires the model in for speed"
// trips here instead of silently duplicating the embedder inside brain.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Substrings, not exact names — a banned package can show up under a scoped
// name (`@xenova/transformers`) or a version-suffixed one. Matched
// case-insensitively against every dependency name in package.json AND every
// resolved package name in bun.lock (transitive deps included), so a banned
// package pulled in indirectly is caught too, not just a direct one.
const BANNED_SUBSTRINGS = [
  "onnxruntime",
  "onnx",
  "transformers",
  "sentence-transformers",
  "tokenizers",
  "tensorflow",
  "tfjs",
  "torch",
  "minilm",
  "embedder",
  "embedding-model",
  "text-embedding",
  "@huggingface",
  "sentencepiece",
  "llama.cpp",
  "llama-cpp",
  "gguf",
] as const;

function findBanned(names: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const banned of BANNED_SUBSTRINGS) {
      if (lower.includes(banned)) {
        hits.push(`${name} (matched "${banned}")`);
        break;
      }
    }
  }
  return hits;
}

describe("brain never embeds — dependency-tree guard", () => {
  test("package.json dependencies + devDependencies carry no embedding/ML package", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(findBanned(names)).toEqual([]);
  });

  test("bun.lock resolved package tree (incl. transitive deps) carries no embedding/ML package", () => {
    // bun.lock is JSONC (trailing commas allowed), not strict JSON, so
    // `JSON.parse` chokes on it — pull top-level package keys out of the
    // `"packages"` block with a regex instead of parsing the whole file.
    // Each entry is a 4-space-indented `"<name>": [...` line (see the
    // fixture-free real lockfile — every package, direct or transitive,
    // gets exactly one such line).
    const lockRaw = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    const names = [...lockRaw.matchAll(/^ {4}"([^"]+)":\s*\[/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0); // sanity: the regex actually matched entries
    expect(findBanned(names)).toEqual([]);
  });
});
