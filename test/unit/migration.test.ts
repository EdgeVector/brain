// Unit tests for the pure helpers in src/migration.ts (G15).
//
// Pure helpers only — no network. Manifest IO is exercised against a
// per-test tmpdir under FBRAIN_MIGRATIONS_DIR so the tests never touch
// the real ~/.fbrain/migrations/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bumpDescriptiveName,
  buildManifestId,
  defaultMigrationsDir,
  descriptiveNameVersion,
  formatStatusTable,
  listManifests,
  parseFieldType,
  readManifest,
  schemaWithExtraField,
  shortHash,
  validateDefault,
  versionMarkerField,
  versionMarkerValue,
  writeManifest,
  MIGRATION_DIR_ENV,
  type MigrationManifest,
} from "../../src/migration.ts";
import { noteSchema, designSchema } from "../../src/schemas.ts";

const HEX_HASH = "a".repeat(64);
const HEX_HASH_2 = "b".repeat(64);

let savedEnv: string | undefined;
let tmpDir = "";

beforeEach(() => {
  savedEnv = process.env[MIGRATION_DIR_ENV];
  tmpDir = mkdtempSync(join(tmpdir(), "fbrain-migration-test-"));
  process.env[MIGRATION_DIR_ENV] = tmpDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[MIGRATION_DIR_ENV];
  else process.env[MIGRATION_DIR_ENV] = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function manifest(overrides: Partial<MigrationManifest> = {}): MigrationManifest {
  return {
    id: "2026-05-24T00-00-00-000Z-add-note-urgency",
    scope: { schema_key: "note", affected_types: ["concept", "preference"] },
    from_hash: HEX_HASH,
    to_hash: HEX_HASH_2,
    descriptive_name_from: "FbrainKindNote",
    descriptive_name_to: "FbrainKindNote_v2",
    field_added: "urgency",
    field_type: "String",
    default: "normal",
    applied_at: "2026-05-24T00:00:00.000Z",
    status: "complete",
    migrated_count: 3,
    total_count: 3,
    ...overrides,
  };
}

describe("parseFieldType", () => {
  test("accepts String", () => {
    expect(parseFieldType("String")).toBe("String");
  });
  test("accepts Array:String", () => {
    expect(parseFieldType("Array:String")).toEqual({ Array: "String" });
  });
  test("rejects unknown spec", () => {
    expect(() => parseFieldType("number")).toThrow(/Unsupported field type/);
  });
});

describe("validateDefault", () => {
  test("String requires --default", () => {
    expect(() => validateDefault("String", undefined)).toThrow(/required for String/);
  });
  test("String accepts any string (including empty if explicit)", () => {
    expect(validateDefault("String", "normal")).toBe("normal");
    // Explicit empty string is allowed — user opted in.
    expect(validateDefault("String", "")).toBe("");
  });
  test("Array:String defaults to []", () => {
    expect(validateDefault({ Array: "String" }, undefined)).toEqual([]);
    expect(validateDefault({ Array: "String" }, "")).toEqual([]);
  });
  test("Array:String accepts JSON array of strings", () => {
    expect(validateDefault({ Array: "String" }, '["a","b"]')).toEqual(["a", "b"]);
  });
  test("Array:String rejects non-JSON", () => {
    expect(() => validateDefault({ Array: "String" }, "a,b")).toThrow(/JSON array/);
  });
  test("Array:String rejects array containing non-strings", () => {
    expect(() => validateDefault({ Array: "String" }, '["a", 1]')).toThrow(/array of strings/);
  });
});

describe("schemaWithExtraField", () => {
  test("appends a String field + version marker; bumps descriptive_name; preserves prior fields", () => {
    const out = schemaWithExtraField({
      base: noteSchema,
      fieldName: "urgency",
      fieldType: "String",
      description: "test field",
      newDescriptiveName: "FbrainKindNote_v2",
    });
    expect(out.schema.descriptive_name).toBe("FbrainKindNote_v2");
    expect(out.schema.name).toBe("FbrainKindNote_v2");
    const marker = versionMarkerField("FbrainKindNote_v2");
    expect(out.schema.fields).toEqual([
      ...noteSchema.schema.fields,
      "urgency",
      marker,
    ]);
    expect(out.schema.field_types.urgency).toBe("String");
    expect(out.schema.field_types[marker]).toBe("String");
    expect(out.schema.field_descriptions.urgency).toBe("test field");
    expect(out.schema.field_descriptions[marker]).toContain("schema-distinctness");
    expect(out.schema.field_data_classifications.urgency).toEqual({
      sensitivity_level: 0,
      data_domain: "general",
    });
    expect(out.schema.field_data_classifications[marker]).toEqual({
      sensitivity_level: 0,
      data_domain: "general",
    });
    // Prior field metadata preserved (didn't clobber the base).
    expect(out.schema.field_types.slug).toBe("String");
    expect(out.schema.field_data_classifications.slug).toEqual({
      sensitivity_level: 0,
      data_domain: "general",
    });
  });

  test("appends an Array:String field plus the marker", () => {
    const out = schemaWithExtraField({
      base: designSchema,
      fieldName: "watchers",
      fieldType: { Array: "String" },
      description: "watchers",
      newDescriptiveName: "Design_v2",
    });
    expect(out.schema.field_types.watchers).toEqual({ Array: "String" });
    expect(out.schema.fields).toContain(versionMarkerField("Design_v2"));
  });

  test("refuses to add a field that already exists", () => {
    expect(() =>
      schemaWithExtraField({
        base: noteSchema,
        fieldName: "tags",
        fieldType: { Array: "String" },
        description: "no-op",
        newDescriptiveName: "FbrainKindNote_v2",
      }),
    ).toThrow(/already exists/);
  });

  test("does not mutate the base schema", () => {
    const beforeFields = [...noteSchema.schema.fields];
    schemaWithExtraField({
      base: noteSchema,
      fieldName: "tmp_field",
      fieldType: "String",
      description: "tmp",
      newDescriptiveName: "FbrainKindNote_v9",
    });
    expect(noteSchema.schema.fields).toEqual(beforeFields);
    expect("tmp_field" in noteSchema.schema.field_types).toBe(false);
  });
});

describe("versionMarkerField / versionMarkerValue", () => {
  test("marker name is a sanitised wrap of the descriptive_name", () => {
    expect(versionMarkerField("FbrainKindNote_v2")).toBe("_FbrainKindNote_v2_marker");
    expect(versionMarkerField("Design_v3")).toBe("_Design_v3_marker");
    // Non-alnum chars get folded to _.
    expect(versionMarkerField("foo-bar.baz")).toBe("_foo_bar_baz_marker");
  });
  test("marker value is the descriptive_name itself", () => {
    expect(versionMarkerValue("FbrainKindNote_v2")).toBe("FbrainKindNote_v2");
  });
});

describe("bumpDescriptiveName / descriptiveNameVersion", () => {
  test("bumps unversioned to _v2 when no prior versions known", () => {
    expect(bumpDescriptiveName("FbrainKindNote", [])).toBe("FbrainKindNote_v2");
  });
  test("bumps past the highest known version", () => {
    expect(bumpDescriptiveName("FbrainKindNote", [2, 3])).toBe("FbrainKindNote_v4");
  });
  test("strips an existing _vN suffix before bumping", () => {
    expect(bumpDescriptiveName("FbrainKindNote_v3", [])).toBe("FbrainKindNote_v4");
  });
  test("extracts the version number", () => {
    expect(descriptiveNameVersion("FbrainKindNote")).toBe(1);
    expect(descriptiveNameVersion("FbrainKindNote_v2")).toBe(2);
    expect(descriptiveNameVersion("FbrainKindNote_v42")).toBe(42);
  });
});

describe("buildManifestId", () => {
  test("colons and dots in timestamp become dashes (safe for filenames)", () => {
    const id = buildManifestId("note", "urgency", "2026-05-24T22:30:00.000Z");
    expect(id).toBe("2026-05-24T22-30-00-000Z-add-note-urgency");
    expect(id).not.toContain(":");
    expect(id).not.toContain(".");
  });
});

describe("manifest IO", () => {
  test("writeManifest then readManifest round-trips", () => {
    const m = manifest();
    writeManifest(m);
    const read = readManifest(m.id);
    expect(read).toEqual(m);
  });

  test("writeManifest is atomic — the destination is never a partial write", () => {
    const m = manifest();
    writeManifest(m);
    // Manifest file exists with the final JSON in one read.
    const text = readFileSync(join(tmpDir, `${m.id}.json`), "utf8");
    expect(JSON.parse(text)).toEqual(m);
    // No leftover .tmp- files in the dir.
    for (const name of readdirSync(tmpDir)) {
      expect(name.startsWith(".") || name.includes(".tmp-")).toBe(false);
    }
  });

  test("writeManifest overwrites an existing manifest", () => {
    const m1 = manifest({ status: "in_progress", migrated_count: 1 });
    writeManifest(m1);
    const m2 = manifest({ status: "complete", migrated_count: 3 });
    writeManifest(m2);
    const read = readManifest(m1.id);
    expect(read.status).toBe("complete");
    expect(read.migrated_count).toBe(3);
  });

  test("readManifest throws on missing id", () => {
    expect(() => readManifest("no-such-manifest")).toThrow(/No migration manifest/);
  });

  test("listManifests returns empty when dir doesn't exist", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(listManifests()).toEqual([]);
  });

  test("listManifests returns manifests newest-first", () => {
    const older = manifest({
      id: "2026-05-23T00-00-00-000Z-add-design-priority",
      applied_at: "2026-05-23T00:00:00.000Z",
      field_added: "priority",
      scope: { schema_key: "design", affected_types: ["design"] },
    });
    const newer = manifest({
      id: "2026-05-24T00-00-00-000Z-add-note-urgency",
      applied_at: "2026-05-24T00:00:00.000Z",
    });
    writeManifest(older);
    writeManifest(newer);
    const list = listManifests();
    expect(list.map((m) => m.id)).toEqual([newer.id, older.id]);
  });

  test("listManifests skips malformed JSON without throwing", () => {
    writeManifest(manifest());
    writeFileSync(join(tmpDir, "bad.json"), "{ not valid json", "utf8");
    const list = listManifests();
    expect(list.length).toBe(1);
  });
});

describe("shortHash + formatStatusTable", () => {
  test("shortHash truncates to 12 chars + ellipsis", () => {
    expect(shortHash(HEX_HASH)).toBe(`${HEX_HASH.slice(0, 12)}…`);
    expect(shortHash("short")).toBe("short");
  });

  test("formatStatusTable handles empty list", () => {
    expect(formatStatusTable([])).toContain("(no migrations recorded");
  });

  test("formatStatusTable renders id/status/scope/field/hashes/count columns", () => {
    const out = formatStatusTable([manifest()]);
    expect(out).toContain("id");
    expect(out).toContain("status");
    expect(out).toContain("scope");
    expect(out).toContain("field");
    expect(out).toContain("from→to");
    expect(out).toContain("complete");
    expect(out).toContain("note:concept,preference");
    expect(out).toContain("urgency=normal");
    expect(out).toContain("3/3");
  });
});

describe("defaultMigrationsDir env override", () => {
  test("FBRAIN_MIGRATIONS_DIR is honored", () => {
    expect(defaultMigrationsDir()).toBe(tmpDir);
  });

  test("empty env falls back to ~/.fbrain/migrations", () => {
    delete process.env[MIGRATION_DIR_ENV];
    const dir = defaultMigrationsDir();
    expect(dir.endsWith("/.fbrain/migrations")).toBe(true);
    // Restore for afterEach.
    process.env[MIGRATION_DIR_ENV] = tmpDir;
  });

  test("writeManifest creates the dir if missing", () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(existsSync(tmpDir)).toBe(false);
    writeManifest(manifest());
    expect(existsSync(tmpDir)).toBe(true);
  });
});
