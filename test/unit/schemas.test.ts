import { describe, expect, test } from "bun:test";

import {
  AGENT_STATUSES,
  CONCEPT_STATUSES,
  DESIGN_STATUSES,
  LEGACY_NOTE_SCHEMA_KEY,
  NOTE_SCHEMA_DESCRIPTIVE_NAME,
  PREFERENCE_STATUSES,
  PROJECT_STATUSES,
  RECORDS,
  RECORD_TYPES,
  REFERENCE_STATUSES,
  SPIKE_STATUSES,
  TASK_STATUSES,
  UNIQUE_SCHEMAS,
  agentSchema,
  conceptSchema,
  defaultStatusFor,
  designSchema,
  isRecordType,
  isValidStatus,
  noteSchema,
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

  test("each Phase 6 type owns a dedicated schema (post-Phase-E)", () => {
    // Pre-Phase-E all six aliased to noteSchema; Phase E gave each its own
    // 7-field schema distinguished by descriptive_name + purpose_statement.
    const phase6 = [
      ["concept", conceptSchema, CONCEPT_STATUSES, "active", "Concept"],
      ["preference", preferenceSchema, PREFERENCE_STATUSES, "active", "Preference"],
      ["reference", referenceSchema, REFERENCE_STATUSES, "active", "Reference"],
      ["agent", agentSchema, AGENT_STATUSES, "active", "Agent"],
      ["project", projectSchema, PROJECT_STATUSES, "planning", "Project"],
      ["spike", spikeSchema, SPIKE_STATUSES, "active", "Spike"],
    ] as const;
    for (const [typeKey, schema, statuses, defaultStatus, descriptive] of phase6) {
      expect(schema.schema.descriptive_name).toBe(descriptive);
      expect(schema.schema.fields.length).toBe(7);
      expect(schema.schema.fields).not.toContain("kind");
      expect(schema.schema.fields).not.toContain("v1_marker_a");
      expect(schema.schema.fields).not.toContain("v1_marker_b");
      expect(schema.schema.fields).toContain("slug");
      expect(schema.schema.fields).toContain("status");
      expect(schema.schema.fields).toContain("tags");
      expect(schema.schema.field_types.tags).toEqual({ Array: "String" });
      expect(schema.schema.purpose_statement).toBeDefined();
      expect(typeof schema.schema.purpose_statement).toBe("string");
      expect(schema.schema.purpose_statement!.length).toBeGreaterThan(10);
      const type = typeKey as RecordType;
      expect(statusValuesFor(type)).toEqual(statuses);
      expect(defaultStatusFor(type)).toBe(defaultStatus);
      expect(schemaFor(type)).toBe(schema);
      // legacyKind matches the type name — used by the legacy read-path to
      // filter FbrainKindNote rows back to this RecordType.
      expect(RECORDS[type].legacyKind).toBe(typeKey);
    }
  });

  test("the six per-kind schemas are distinct instances (not aliased)", () => {
    const distinct = new Set([
      conceptSchema,
      preferenceSchema,
      referenceSchema,
      agentSchema,
      projectSchema,
      spikeSchema,
    ]);
    expect(distinct.size).toBe(6);
  });

  test("purpose statements are pairwise distinct strings", () => {
    const purposes = [
      conceptSchema.schema.purpose_statement,
      preferenceSchema.schema.purpose_statement,
      referenceSchema.schema.purpose_statement,
      agentSchema.schema.purpose_statement,
      projectSchema.schema.purpose_statement,
      spikeSchema.schema.purpose_statement,
    ];
    expect(new Set(purposes).size).toBe(6);
  });

  test("FbrainKindNote stays registered with its legacy 10-field shape", () => {
    expect(noteSchema.schema.descriptive_name).toBe(NOTE_SCHEMA_DESCRIPTIVE_NAME);
    expect(noteSchema.schema.fields.length).toBe(10);
    expect(noteSchema.schema.fields).toContain("kind");
    expect(noteSchema.schema.fields).toContain("v1_marker_a");
    expect(noteSchema.schema.fields).toContain("v1_marker_b");
  });

  test("UNIQUE_SCHEMAS has 9 entries: design + task + 6 per-kind + 1 legacy", () => {
    expect(UNIQUE_SCHEMAS.length).toBe(9);
    const keys = UNIQUE_SCHEMAS.map((e) => e.key).sort();
    expect(keys).toEqual([
      LEGACY_NOTE_SCHEMA_KEY,
      "agent",
      "concept",
      "design",
      "preference",
      "project",
      "reference",
      "spike",
      "task",
    ].sort());
    // Legacy entry has no types — new writes never route there.
    const legacy = UNIQUE_SCHEMAS.find((e) => e.key === LEGACY_NOTE_SCHEMA_KEY)!;
    expect(legacy.types).toEqual([]);
    expect(legacy.schema).toBe(noteSchema);
  });

  test("legacyKind: null for design/task, matches type for Phase 6", () => {
    expect(RECORDS.design.legacyKind).toBeNull();
    expect(RECORDS.task.legacyKind).toBeNull();
    for (const t of ["concept", "preference", "reference", "agent", "project", "spike"] as const) {
      expect(RECORDS[t].legacyKind).toBe(t);
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
