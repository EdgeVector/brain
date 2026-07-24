/**
 * Search plane cutover: shipped querySearchPlane + Search engine fixture
 * must retrieve distinctive text after applyChangeBatch (real engine path).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { querySearchPlane } from "../../src/search-plane.ts";

const SEARCH_ENGINE = resolve(
  import.meta.dirname,
  "../../../search-kanban-search-as-app-implement/src/engine.ts",
);

describe("brain search-plane cutover", () => {
  test("after SearchEngine ingest, querySearchPlane finds the fixture", async () => {
    const home = mkdtempSync(join(tmpdir(), "brain-sp-"));
    const indexDir = join(home, "index");
    const inbox = join(home, "inbox");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(inbox, { recursive: true });

    const unique = `brain-plane-fixture-${Date.now()}-m7k2`;
    process.env.LASTDB_SEARCH_MODULE = SEARCH_ENGINE;
    process.env.SEARCH_HOME = home;

    const engMod = await import(pathToFileURL(SEARCH_ENGINE).href) as {
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
