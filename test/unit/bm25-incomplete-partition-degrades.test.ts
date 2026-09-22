// Pins: an incomplete record-list partition DEGRADES a request-path BM25
// load; it does not fail the read. Search is a candidate sample, never a
// census (papercut-decision-check-typed-enumeration-blocks-all-kind-pr-filing-20260922:
// an incomplete `design` marker made every untyped `brain search` / `ask`
// fail, and with them the Kind:pr admission gate).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BM25Index,
  bm25CachePath,
  bm25DegradedLine,
  loadOrBuildBm25Index,
  saveCachedIndex,
  type Bm25DegradedNotice,
} from "../../src/retrieval/bm25.ts";
import { listIndexRepairHint } from "../../src/primary-brain.ts";
import { buildTestCfg } from "../util.ts";
import type { NodeClient } from "../../src/client.ts";

let cacheDir = "";
let savedCacheEnv: string | undefined;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "bm25-degrade-"));
  savedCacheEnv = process.env.FBRAIN_CACHE_DIR;
  process.env.FBRAIN_CACHE_DIR = cacheDir;
});

afterEach(() => {
  if (savedCacheEnv === undefined) delete process.env.FBRAIN_CACHE_DIR;
  else process.env.FBRAIN_CACHE_DIR = savedCacheEnv;
  rmSync(cacheDir, { recursive: true, force: true });
});

// Every list-index partition read returns no completeness marker.
function incompleteNode(): NodeClient {
  return {
    async queryAll() {
      return { results: [], total_count: 0, returned_count: 0 };
    },
  } as unknown as NodeClient;
}

describe("request-path BM25 load with an incomplete partition", () => {
  test("no cache: returns an unsaved partial index and names the skipped type", async () => {
    const cfg = buildTestCfg();
    const notices: Bm25DegradedNotice[] = [];
    const loaded = await loadOrBuildBm25Index(incompleteNode(), cfg, ["design"], {
      onDegraded: (n) => notices.push(n),
    });
    expect(loaded.degradedTypes).toEqual(["design"]);
    expect(notices).toEqual([{ skippedTypes: ["design"], served: "partial" }]);
    expect(existsSync(bm25CachePath(cfg.userHash, ["design"]))).toBe(false);
  });

  test("stale cache: serves the previous index instead of failing", async () => {
    const cfg = buildTestCfg();
    const prev = BM25Index.build(
      [{ type: "design", slug: "design-octopus", title: "Octopus", body: "octopus arms", updatedAt: "2026-01-01T00:00:00Z" }],
      ["design"],
    );
    saveCachedIndex(cfg.userHash, prev, ["design"]);
    const notices: Bm25DegradedNotice[] = [];
    const loaded = await loadOrBuildBm25Index(incompleteNode(), cfg, ["design"], {
      ttlMs: 0,
      onDegraded: (n) => notices.push(n),
    });
    expect(loaded.degradedTypes).toEqual(["design"]);
    expect(notices[0]?.served).toBe("stale-cache");
    expect(loaded.index.search("octopus", 5).map((h) => h.slug)).toEqual(["design-octopus"]);
  });

  test("offline --force rebuild stays strict", async () => {
    const cfg = buildTestCfg();
    await expect(
      loadOrBuildBm25Index(incompleteNode(), cfg, ["design"], { forceRebuild: true }),
    ).rejects.toMatchObject({ code: "list_index_incomplete" });
  });

  test("warning line names the type and the point-read fallback", () => {
    const line = bm25DegradedLine({ skippedTypes: ["design", "preference"], served: "partial" });
    expect(line).toContain("design, preference");
    expect(line).toContain("brain get <slug>");
  });
});

describe("listIndexRepairHint", () => {
  test("does not prescribe a reindex when another brain is primary", () => {
    const p = join(cacheDir, "brain-config.json");
    writeFileSync(p, JSON.stringify({ primary: "gbrain" }));
    const hint = listIndexRepairHint("design", p);
    expect(hint).toContain("NOT the primary");
    expect(hint).toContain("Do NOT run");
    expect(hint).toContain("gbrain get design/<slug>");
  });

  test("prescribes the reindex when this brain is primary or config is absent", () => {
    const p = join(cacheDir, "brain-config.json");
    writeFileSync(p, JSON.stringify({ primary: "brain" }));
    expect(listIndexRepairHint("design", p)).toContain("brain reindex --list-index");
    expect(listIndexRepairHint("design", join(cacheDir, "missing.json"))).toContain(
      "brain reindex --list-index",
    );
  });
});
