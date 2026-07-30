/**
 * Search plane is semantic-only (host-track Search or explicit module path).
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

  test("querySearchPlane returns null when semantic module and CLI are unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "brain-sp-nosem-"));
    mkdirSync(join(home, "inbox"), { recursive: true });
    // Isolate from this machine's host-track Search install.
    const fakeHome = mkdtempSync(join(tmpdir(), "brain-sp-home-"));

    const prevSem = process.env.LASTDB_SEARCH_SEMANTIC_MODULE;
    const prevBin = process.env.LASTDB_SEARCH_BIN;
    const prevSearchHome = process.env.SEARCH_HOME;
    const prevHome = process.env.HOME;
    delete process.env.LASTDB_SEARCH_SEMANTIC_MODULE;
    process.env.LASTDB_SEARCH_BIN = "/nonexistent/search-bin-xyz";
    process.env.SEARCH_HOME = home;
    process.env.HOME = fakeHome;

    const hits = await querySearchPlane({
      query: "anything-unique-marker-xyz",
      k: 10,
      searchHome: home,
      drain: false,
    });
    expect(hits).toBeNull();

    process.env.HOME = prevHome;
    process.env.SEARCH_HOME = prevSearchHome;
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
