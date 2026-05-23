import { describe, expect, test } from "bun:test";

import {
  ensureStatus,
  fieldsFor,
  rowToRecord,
  schemaHashFor,
} from "../../src/record.ts";
import { FbrainError } from "../../src/client.ts";
import { CONFIG_VERSION, type Config } from "../../src/config.ts";

const cfg: Config = {
  configVersion: CONFIG_VERSION,
  nodeUrl: "http://127.0.0.1:9101",
  schemaServiceUrl: "http://127.0.0.1:9102",
  userHash: "uh",
  designSchemaHash: "designhash",
  taskSchemaHash: "taskhash",
};

describe("record", () => {
  test("schemaHashFor returns the right hash", () => {
    expect(schemaHashFor("design", cfg)).toBe("designhash");
    expect(schemaHashFor("task", cfg)).toBe("taskhash");
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
