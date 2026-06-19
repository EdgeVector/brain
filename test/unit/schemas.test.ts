import { describe, expect, test } from "bun:test";

import {
  AGENT_STATUSES,
  CONCEPT_STATUSES,
  DESIGN_STATUSES,
  PREFERENCE_STATUSES,
  PROJECT_STATUSES,
  RECORDS,
  RECORD_PURPOSES,
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
  preferenceSchema,
  projectSchema,
  purposeFor,
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

  test("each Phase 6 type owns a dedicated schema", () => {
    // All six Phase 6 kinds share the same 7-field shape; the dual-signal
    // gate (descriptive_name + purpose_statement) is what keeps the
    // canonical hashes distinct.
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

  test("UNIQUE_SCHEMAS has 8 entries: design + task + 6 per-kind", () => {
    expect(UNIQUE_SCHEMAS.length).toBe(8);
    const keys = UNIQUE_SCHEMAS.map((e) => e.key).sort();
    expect(keys).toEqual([
      "agent",
      "concept",
      "design",
      "preference",
      "project",
      "reference",
      "spike",
      "task",
    ]);
    // Every entry covers exactly one RecordType.
    for (const entry of UNIQUE_SCHEMAS) {
      expect(entry.types.length).toBe(1);
      expect(entry.types[0]).toBe(entry.key as RecordType);
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

describe("RECORD_PURPOSES (new-dev 'use it for' one-liners)", () => {
  test("every record type has a non-trivial purpose one-liner", () => {
    for (const type of RECORD_TYPES) {
      const p = purposeFor(type);
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(10);
      // never the bare descriptive_name (which is what design/task carry as
      // their wire purpose_statement) — that's not a usable sentence.
      expect(p).not.toBe(RECORDS[type].schema.schema.descriptive_name);
    }
  });

  test("the six Phase 6 purposes ARE the canonical purpose_statement (no drift)", () => {
    for (const type of ["concept", "preference", "reference", "agent", "project", "spike"] as const) {
      const canonical = RECORDS[type].schema.schema.purpose_statement;
      expect(canonical).toBeDefined();
      expect(RECORD_PURPOSES[type]).toBe(canonical!);
    }
  });

  test("design/task carry hand-written one-liners distinct from their bare wire purpose_statement", () => {
    for (const type of ["design", "task"] as const) {
      const wire = RECORDS[type].schema.schema.purpose_statement;
      // wire value stays the bare name (presentation change must not touch it)
      expect(wire).toBe(RECORDS[type].schema.schema.descriptive_name);
      // but the surfaced one-liner is a real sentence, not the bare name
      expect(RECORD_PURPOSES[type]).not.toBe(wire);
    }
  });

  test("README 'Record types' table surfaces every purpose string (README<->CLI can't drift)", async () => {
    const readme = await Bun.file(new URL("../../README.md", import.meta.url)).text();
    for (const type of RECORD_TYPES) {
      expect(readme).toContain(RECORD_PURPOSES[type]);
    }
  });

  test("docs/agent-instructions.md surfaces every purpose string (agent doc<->CLI can't drift)", async () => {
    const doc = await Bun.file(
      new URL("../../docs/agent-instructions.md", import.meta.url),
    ).text();
    for (const type of RECORD_TYPES) {
      expect(doc).toContain(RECORD_PURPOSES[type]);
    }
  });
});
