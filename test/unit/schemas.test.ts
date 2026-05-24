import { describe, expect, test } from "bun:test";

import {
  AGENT_STATUSES,
  CONCEPT_STATUSES,
  DESIGN_STATUSES,
  PREFERENCE_STATUSES,
  PROJECT_STATUSES,
  RECORDS,
  RECORD_TYPES,
  REFERENCE_STATUSES,
  SPIKE_STATUSES,
  TASK_STATUSES,
  agentSchema,
  conceptSchema,
  defaultStatusFor,
  designSchema,
  isRecordType,
  isValidStatus,
  preferenceSchema,
  projectSchema,
  referenceSchema,
  schemaFor,
  spikeSchema,
  statusValuesFor,
  taskSchema,
  type RecordType,
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

  test("isRecordType accepts every RECORD_TYPES entry and nothing else", () => {
    for (const t of RECORD_TYPES) expect(isRecordType(t)).toBe(true);
    expect(isRecordType("desogn")).toBe(false);
    expect(isRecordType("")).toBe(false);
    expect(isRecordType("Design")).toBe(false); // case-sensitive
  });

  test("All 6 Phase 6 types share the FbrainKindNote schema", () => {
    // The Phase 6 schema is shared across kinds (see schemas.ts comment)
    // — fbrain reads/writes a `kind` field to discriminate. Each
    // RecordType still has its own status enum + defaults.
    const phase6 = [
      ["concept", conceptSchema, CONCEPT_STATUSES, "active"],
      ["preference", preferenceSchema, PREFERENCE_STATUSES, "active"],
      ["reference", referenceSchema, REFERENCE_STATUSES, "active"],
      ["agent", agentSchema, AGENT_STATUSES, "active"],
      ["project", projectSchema, PROJECT_STATUSES, "planning"],
      ["spike", spikeSchema, SPIKE_STATUSES, "active"],
    ] as const;
    for (const [typeKey, schema, statuses, defaultStatus] of phase6) {
      // All six exports point at the same noteSchema instance.
      expect(schema.schema.descriptive_name).toBe("FbrainKindNote");
      expect(schema.schema.fields).toContain("kind");
      expect(schema.schema.fields).toContain("slug");
      expect(schema.schema.field_types.tags).toEqual({ Array: "String" });
      const type = typeKey as RecordType;
      expect(statusValuesFor(type)).toEqual(statuses);
      expect(defaultStatusFor(type)).toBe(defaultStatus);
      expect(schemaFor(type)).toBe(schema);
      // Each type's kind discriminator matches its key.
      expect(RECORDS[type].kind).toBe(typeKey);
    }
  });

  test.each([...RECORD_TYPES])(
    "isValidStatus accepts %s's default status",
    (type) => {
      expect(isValidStatus(type, RECORDS[type].defaultStatus)).toBe(true);
      expect(isValidStatus(type, "totally-bogus")).toBe(false);
    },
  );

  test("Task is the only type that has design_slug", () => {
    for (const type of RECORD_TYPES) {
      expect(RECORDS[type].hasDesignSlug).toBe(type === "task");
    }
  });
});
