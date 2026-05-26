import { describe, expect, test } from "bun:test";

import {
  ensureStatus,
  fieldsFor,
  READ_RETRY_ATTEMPTS,
  READ_RETRY_BACKOFF_MS,
  rowToRecord,
  schemaHashFor,
  withReadRetry,
} from "../../src/record.ts";
import { FbrainError } from "../../src/client.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const cfg = buildTestCfg({
  schemaHashes: {
    ...TEST_HASHES,
    design: "designhash",
    task: "taskhash",
  },
});

describe("record", () => {
  test("schemaHashFor returns the right hash", () => {
    expect(schemaHashFor("design", cfg)).toBe("designhash");
    expect(schemaHashFor("task", cfg)).toBe("taskhash");
  });

  test("schemaHashFor throws for a missing type", () => {
    const partial = buildTestCfg({
      schemaHashes: { design: "d", task: "t" },
    });
    expect(() => schemaHashFor("concept", partial)).toThrow(FbrainError);
  });

  test("fieldsFor returns design fields", () => {
    const fs = fieldsFor("design");
    expect(fs).toContain("slug");
    expect(fs).toContain("tags");
    expect(fs).not.toContain("design_slug");
  });

  test("fieldsFor returns task fields with design_slug", () => {
    const fs = fieldsFor("task");
    expect(fs).toContain("design_slug");
  });

  test("rowToRecord converts a design row", () => {
    const row = {
      fields: {
        slug: "abc",
        title: "T",
        body: "B",
        status: "draft",
        tags: ["x", "y"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
      key: { hash: "abc", range: null },
    };
    const r = rowToRecord(row, "design");
    expect(r.slug).toBe("abc");
    expect(r.tags).toEqual(["x", "y"]);
    expect(r.design_slug).toBeUndefined();
  });

  test("rowToRecord converts a task row and reads design_slug", () => {
    const row = {
      fields: {
        slug: "t1",
        title: "Tt",
        body: "Bt",
        status: "open",
        tags: [],
        design_slug: "d1",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      key: { hash: "t1", range: null },
    };
    const r = rowToRecord(row, "task");
    expect(r.design_slug).toBe("d1");
  });

  test("rowToRecord tolerates missing/wrong-typed fields", () => {
    const row = { fields: {}, key: { hash: "x", range: null } };
    const r = rowToRecord(row, "design");
    expect(r.slug).toBe("");
    expect(r.tags).toEqual([]);
  });

  test("rowToRecord falls back to comma-split if tags came back as a string", () => {
    const row = {
      fields: { tags: "a,b,c" },
      key: { hash: "x", range: null },
    };
    const r = rowToRecord(row, "design");
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  test("ensureStatus accepts valid status", () => {
    expect(() => ensureStatus("design", "draft")).not.toThrow();
    expect(() => ensureStatus("task", "in_progress")).not.toThrow();
  });

  test("ensureStatus throws FbrainError on invalid", () => {
    expect(() => ensureStatus("design", "in_progress")).toThrow(FbrainError);
    expect(() => ensureStatus("task", "draft")).toThrow(FbrainError);
  });
});

describe("withReadRetry", () => {
  test("defaults match scripts/parity-smoketest.sh (5x, 250 ms)", () => {
    expect(READ_RETRY_ATTEMPTS).toBe(5);
    expect(READ_RETRY_BACKOFF_MS).toBe(250);
  });

  test("first-attempt hit returns immediately without sleeping", async () => {
    const sleepCalls: number[] = [];
    let calls = 0;
    const result = await withReadRetry(
      async () => {
        calls++;
        return ["hit"];
      },
      (r) => r.length > 0,
      { sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual(["hit"]);
    expect(calls).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  test("miss → miss → hit: retries the loop and returns the eventual hit", async () => {
    // The exact failure mode the polluted-daemon read flake produces:
    // identical query returns empty for the first attempts and then
    // returns the real row. Helper must surface the hit, not the miss.
    const responses: string[][] = [[], [], ["found"]];
    const sleepCalls: number[] = [];
    let calls = 0;
    const result = await withReadRetry(
      async () => responses[calls++] ?? [],
      (r) => r.length > 0,
      { backoffMs: 7, sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual(["found"]);
    expect(calls).toBe(3);
    expect(sleepCalls).toEqual([7, 7]);
  });

  test("all attempts miss: returns the last empty result after exhausting budget", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const result = await withReadRetry(
      async () => {
        calls++;
        return [] as string[];
      },
      (r) => r.length > 0,
      { maxAttempts: 4, backoffMs: 9, sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual([]);
    expect(calls).toBe(4);
    expect(sleepCalls).toEqual([9, 9, 9]);
  });

  test("backoffMs=0 still retries but skips the sleep", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const result = await withReadRetry(
      async () => (calls++ === 0 ? [] : ["hit"]),
      (r) => r.length > 0,
      { backoffMs: 0, sleep: async (ms) => void sleepCalls.push(ms) },
    );
    expect(result).toEqual(["hit"]);
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([]);
  });

  test("HTTP errors propagate — retry is not a catch-all", async () => {
    // The smoketest only retries on a clean empty result. A network-style
    // throw must bubble immediately so callers see the real cause.
    let calls = 0;
    await expect(
      withReadRetry(
        async () => {
          calls++;
          throw new Error("ECONNREFUSED");
        },
        (r: unknown[]) => r.length > 0,
        { backoffMs: 0 },
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(1);
  });
});
