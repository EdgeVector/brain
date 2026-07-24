/**
 * Search plane cutover: uses vendored @edgevector/search engine (committed under
 * vendor/edgevector-search) so CI isolated checkouts pass without sibling worktrees.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  querySearchPlane,
  resolveSearchModulePath,
} from "../../src/search-plane.ts";

const VENDOR_ENGINE = resolve(
  import.meta.dirname,
  "../../vendor/edgevector-search/src/engine.ts",
);

describe("brain search-plane cutover", () => {
  test("resolveSearchModulePath finds vendored engine without env", () => {
    delete process.env.LASTDB_SEARCH_MODULE;
    expect(existsSync(VENDOR_ENGINE)).toBe(true);
    const p = resolveSearchModulePath();
    expect(p).not.toBeNull();
    expect(p!.endsWith("vendor/edgevector-search/src/engine.ts")).toBe(true);
  });

  test("after SearchEngine ingest, querySearchPlane finds the fixture", async () => {
    const home = mkdtempSync(join(tmpdir(), "brain-sp-"));
    const indexDir = join(home, "index");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(join(home, "inbox"), { recursive: true });

    const unique = `brain-plane-fixture-${Date.now()}-m7k2`;
    // Prefer vendor path (no LASTDB_SEARCH_MODULE required).
    delete process.env.LASTDB_SEARCH_MODULE;
    process.env.SEARCH_HOME = home;

    const engMod = (await import(pathToFileURL(VENDOR_ENGINE).href)) as {
      openSearchEngine: (d: string) => {
        applyChangeBatch: (b: unknown) => number;
        persist: () => void;
      };
    };
    const eng = engMod.openSearchEngine(indexDir);
    eng.applyChangeBatch({
      schema_name: "1aac3ad7b6d111689ec336adc7efe5efa0cd3b8b4aae2da05808520897b4183e",
      searchable_fields: ["title", "body"],
      changes: [
        {
          mutation_id: "m-brain-1",
          kind: "upsert",
          key_value: { hash: "design-plane-1", range: null },
          fields_and_values: {
            title: "plane cutover",
            body: unique,
          },
        },
      ],
    });
    eng.persist();

    const hits = await querySearchPlane({
      query: unique,
      k: 10,
      searchHome: home,
      drain: false,
    });
    expect(hits).not.toBeNull();
    expect(hits!.length).toBeGreaterThanOrEqual(1);
    expect(hits![0]!.text).toContain(unique);
    expect(hits![0]!.key_hash).toBe("design-plane-1");
  });
});
