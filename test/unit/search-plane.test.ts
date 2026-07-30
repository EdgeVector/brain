/**
 * Search plane is semantic-only (keyword LastStore product path removed 2026-07-30).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  querySearchPlane,
  resolveSemanticModulePath,
} from "../../src/search-plane.ts";

const HOST_SEMANTIC = resolve(
  process.env.HOME ?? "",
  ".host-track/apps/search/current/src/semantic.ts",
);

const HOST_DETERMINISTIC = resolve(
  process.env.HOME ?? "",
  ".host-track/apps/search/current/src/vector/deterministic.ts",
);

describe("brain search-plane semantic-only", () => {
  test("resolveSemanticModulePath is exported and stable", () => {
    const p = resolveSemanticModulePath();
    // May be null in bare CI without host-track Search; when present must be semantic.ts.
    if (p) expect(p.endsWith("semantic.ts")).toBe(true);
  });

  test("querySearchPlane does not return keyword-engine hits without semantic", async () => {
    // Populate a keyword engine home, but do not provide semantic module.
    const home = mkdtempSync(join(tmpdir(), "brain-sp-kw-"));
    const indexDir = join(home, "index");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(join(home, "inbox"), { recursive: true });

    const unique = `brain-kw-should-not-hit-${Date.now()}`;
    const prevSem = process.env.LASTDB_SEARCH_SEMANTIC_MODULE;
    const prevBin = process.env.LASTDB_SEARCH_BIN;
    delete process.env.LASTDB_SEARCH_SEMANTIC_MODULE;
    // Point CLI at missing bin so semantic CLI fails too.
    process.env.LASTDB_SEARCH_BIN = "/nonexistent/search-bin-xyz";
    process.env.SEARCH_HOME = home;

    const vendorEngine = resolve(
      import.meta.dirname,
      "../../vendor/edgevector-search/src/engine.ts",
    );
    if (existsSync(vendorEngine)) {
      const engMod = (await import(pathToFileURL(vendorEngine).href)) as {
        openSearchEngine: (d: string) => {
          applyChangeBatch: (b: unknown) => number;
          persist: () => void;
        };
      };
      const eng = engMod.openSearchEngine(indexDir);
      eng.applyChangeBatch({
        schema_name: "schema-x",
        searchable_fields: ["body"],
        changes: [
          {
            mutation_id: "m1",
            kind: "upsert",
            key_value: { hash: "k1", range: null },
            fields_and_values: { body: unique },
          },
        ],
      });
      eng.persist();
    }

    const hits = await querySearchPlane({
      query: unique,
      k: 10,
      searchHome: home,
      drain: false,
    });
    // No semantic corpus for this home → null (CLI missing) or empty (CLI live).
    // Must not return keyword-engine hits containing the unique marker.
    if (hits !== null) {
      expect(hits.every((h) => !h.text.includes(unique))).toBe(true);
    }

    process.env.SEARCH_HOME = undefined;
    process.env.LASTDB_SEARCH_BIN = prevBin;
    process.env.LASTDB_SEARCH_SEMANTIC_MODULE = prevSem;
  });

  test("semantic ingest + query when host-track Search is present", async () => {
    if (!existsSync(HOST_SEMANTIC) || !existsSync(HOST_DETERMINISTIC)) {
      // Isolated CI without Search install — skip positive path.
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "brain-sp-sem-"));
    mkdirSync(join(home, "inbox"), { recursive: true });
    const unique = `brain-sem-fixture-${Date.now()}-m7k2`;

    process.env.SEARCH_HOME = home;
    process.env.SEARCH_EMBEDDER = "deterministic";
    process.env.LASTDB_SEARCH_SEMANTIC_MODULE = HOST_SEMANTIC;

    const detMod = (await import(pathToFileURL(HOST_DETERMINISTIC).href)) as {
      DeterministicMiniLmCompatEmbedder: new () => {
        id: string;
        dimensions: number;
        embed: (t: string[]) => Promise<number[][]>;
      };
    };
    const semMod = (await import(pathToFileURL(HOST_SEMANTIC).href)) as {
      openSearchSession: (o?: { embedder?: unknown }) => {
        semantic: {
          ensureReady: () => Promise<void>;
          applyBatch: (b: unknown) => Promise<number>;
        };
      };
    };

    const emb = new detMod.DeterministicMiniLmCompatEmbedder();
    const session = semMod.openSearchSession({ embedder: emb });
    await session.semantic.ensureReady();
    await session.semantic.applyBatch({
      schema_name: "1aac3ad7b6d111689ec336adc7efe5efa0cd3b8b4aae2da05808520897b4183e",
      searchable_fields: ["title", "body"],
      changes: [
        {
          mutation_id: "m-brain-1",
          kind: "upsert",
          key_value: { hash: "design-plane-1", range: null },
          fields_and_values: { title: "plane cutover", body: unique },
        },
      ],
    });

    const hits = await querySearchPlane({
      query: unique,
      k: 10,
      searchHome: home,
      drain: false,
    });
    expect(hits).not.toBeNull();
    expect(hits!.length).toBeGreaterThanOrEqual(1);
    expect(hits![0]!.text).toContain(unique);

    delete process.env.SEARCH_HOME;
    delete process.env.SEARCH_EMBEDDER;
    delete process.env.LASTDB_SEARCH_SEMANTIC_MODULE;
  });
});
