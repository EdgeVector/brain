// Structural guard: product modules must not call listRecords without cfg
// (the omit-cfg path was deleted). Product paths go through RecordListIndex.
// Admin-only drains use listRecordsAdminScan explicitly.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../src");

/** Product command / retrieval modules that must never full-drain. */
const PRODUCT_GLOBS = [
  "commands/get.ts",
  "commands/search.ts",
  "commands/list.ts",
  "commands/ask.ts",
  "commands/delete.ts",
  "retrieval/bm25.ts",
  "record.ts",
];

describe("no product listRecords omit-cfg / bare allowFullScan", () => {
  test("product modules never call listRecords with only 3 args (cfg required)", () => {
    // listRecords(node, type, hash) without cfg was the silent full-scan trap.
    const violations: string[] = [];
    for (const rel of PRODUCT_GLOBS) {
      const path = join(SRC, rel);
      const text = readFileSync(path, "utf8");
      // Skip the definition itself and listRecordKeys internal call (4 args).
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (line.includes("export async function listRecords")) return;
        if (line.includes("listRecordsAdminScan")) return;
        // Match listRecords(...) with exactly 3 comma-separated args (no 4th).
        const m = line.match(/listRecords\s*\(([^)]*)\)/);
        if (!m) return;
        const args = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
        if (args.length === 3) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test("product commands do not stamp allowFullScan outside cold-seed comment sites", () => {
    // allowFullScan in product command files is forbidden (admin/seed only in record.ts).
    const productCmds = ["commands/get.ts", "commands/search.ts", "commands/list.ts", "commands/ask.ts"];
    const violations: string[] = [];
    for (const rel of productCmds) {
      const text = readFileSync(join(SRC, rel), "utf8");
      if (text.includes("allowFullScan")) {
        violations.push(rel);
      }
    }
    expect(violations).toEqual([]);
  });

  test("listRecords signature requires cfg (source contract)", () => {
    const text = readFileSync(join(SRC, "record.ts"), "utf8");
    // Required cfg: ListRecordsCfg (not optional cfg?)
    expect(text).toMatch(/export async function listRecords\([\s\S]*?cfg: ListRecordsCfg/);
    // No legacy omit-cfg branch that allowFullScans without index-first
    expect(text).not.toMatch(/Legacy callers without cfg/);
    // Admin drain is a separate export
    expect(text).toMatch(/export async function listRecordsAdminScan/);
  });
});
