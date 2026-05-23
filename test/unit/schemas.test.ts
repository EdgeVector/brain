import { describe, expect, test } from "bun:test";

import {
  DESIGN_STATUSES,
  TASK_STATUSES,
  defaultStatusFor,
  designSchema,
  isValidStatus,
  schemaFor,
  statusValuesFor,
  taskSchema,
} from "../../src/schemas.ts";

describe("schemas", () => {
  test("Design schema has slug as hash key + 7 fields", () => {
    expect(designSchema.schema.key.hash_field).toBe("slug");
    expect(designSchema.schema.fields.length).toBe(7);
    expect(designSchema.schema.fields).toContain("status");
    expect(designSchema.schema.fields).toContain("tags");
    expect(designSchema.schema.fields).toContain("body");
  });

  test("Task schema has slug + design_slug + 8 fields", () => {
    expect(taskSchema.schema.key.hash_field).toBe("slug");
    expect(taskSchema.schema.fields.length).toBe(8);
    expect(taskSchema.schema.fields).toContain("design_slug");
  });

  test("tags is Array(String) on both schemas", () => {
    expect(designSchema.schema.field_types.tags).toEqual({ Array: "String" });
    expect(taskSchema.schema.field_types.tags).toEqual({ Array: "String" });
  });

  test("mutation_mappers is an empty map", () => {
    expect(designSchema.mutation_mappers).toEqual({});
    expect(taskSchema.mutation_mappers).toEqual({});
  });

  test("design status enum validation", () => {
    for (const s of DESIGN_STATUSES) expect(isValidStatus("design", s)).toBe(true);
    expect(isValidStatus("design", "in_progress")).toBe(false); // task value
    expect(isValidStatus("design", "")).toBe(false);
    expect(isValidStatus("design", "DRAFT")).toBe(false);
  });

  test("task status enum validation", () => {
    for (const s of TASK_STATUSES) expect(isValidStatus("task", s)).toBe(true);
    expect(isValidStatus("task", "draft")).toBe(false); // design value
    expect(isValidStatus("task", "todo")).toBe(false);
  });

  test("defaultStatusFor returns 'draft' and 'open'", () => {
    expect(defaultStatusFor("design")).toBe("draft");
    expect(defaultStatusFor("task")).toBe("open");
  });

  test("schemaFor picks the right schema", () => {
    expect(schemaFor("design")).toBe(designSchema);
    expect(schemaFor("task")).toBe(taskSchema);
  });

  test("statusValuesFor lists the right set", () => {
    expect(statusValuesFor("design")).toEqual(DESIGN_STATUSES);
    expect(statusValuesFor("task")).toEqual(TASK_STATUSES);
  });
});
