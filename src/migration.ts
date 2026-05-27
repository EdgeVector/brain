// Pure helpers for the `fbrain migrate` command (G15 — schema
// evolution playbook). Kept network- and config-free so the unit suite
// stays fast.
//
// fold_db is append-only and computes a schema's identity hash from
// `(descriptive_name, sorted_field_names)` (see
// `fold_db/crates/core/src/schema/types/declarative_schemas.rs:672-694`),
// so adding a field necessarily produces a new schema hash. There is
// no in-place "evolve" API; the playbook in
// docs/g15-schema-evolution-playbook.md walks through the
// re-register-and-re-put dance these helpers support.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AddSchemaRequest, FieldType, RecordType } from "./schemas.ts";

export const MIGRATION_DIR_ENV = "FBRAIN_MIGRATIONS_DIR";

export type MigrationStatus = "in_progress" | "complete" | "dry_run";

export type MigrationManifest = {
  id: string;
  scope: { schema_key: string; affected_types: RecordType[] };
  from_hash: string;
  to_hash: string;
  descriptive_name_from: string;
  descriptive_name_to: string;
  field_added: string;
  field_type: FieldType;
  default: unknown;
  applied_at: string;
  status: MigrationStatus;
  migrated_count: number;
  total_count: number;
};

export function defaultMigrationsDir(): string {
  const override = process.env[MIGRATION_DIR_ENV];
  if (override && override.length > 0) return override;
  return join(homedir(), ".fbrain", "migrations");
}

export function manifestPath(id: string, dir: string = defaultMigrationsDir()): string {
  return join(dir, `${id}.json`);
}

export function readManifest(id: string, dir: string = defaultMigrationsDir()): MigrationManifest {
  const path = manifestPath(id, dir);
  if (!existsSync(path)) {
    throw new Error(`No migration manifest at ${path} (id="${id}").`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed as MigrationManifest;
}

// Atomic write: temp file alongside the destination, then rename(2).
// fs.renameSync is atomic on the same filesystem; we rely on that to
// keep a half-written manifest from ever being readable by a concurrent
// `migrate --status`.
export function writeManifest(
  manifest: MigrationManifest,
  dir: string = defaultMigrationsDir(),
): void {
  mkdirSync(dir, { recursive: true });
  const path = manifestPath(manifest.id, dir);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function listManifests(dir: string = defaultMigrationsDir()): MigrationManifest[] {
  if (!existsSync(dir)) return [];
  const out: MigrationManifest[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      out.push(parsed as MigrationManifest);
    } catch {
      // skip malformed manifests; doctor + migrate --status surface them
    }
  }
  // Newest first by applied_at.
  out.sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1));
  return out;
}

// Build a manifest id from scope + field + timestamp. Stable enough to
// `--resume` against, sortable on disk by name, and uniquely
// identifiable in `--status` output.
export function buildManifestId(scope: string, fieldName: string, appliedAt: string): string {
  const safeWhen = appliedAt.replace(/[:.]/g, "-");
  return `${safeWhen}-add-${scope}-${fieldName}`;
}

// Clone an AddSchemaRequest, appending a single new field plus a
// per-version distinctness marker. The new schema's descriptive_name
// is bumped to `<old>_v2` (or `_v3` etc. — see `bumpDescriptiveName`);
// fold_db recomputes the underlying hash from (descriptive_name,
// sorted field names).
//
// **Why the version marker.** fold_db's schema service has a known
// "overlap-merge" behavior on `/api/schemas/load`: registering a
// schema whose field set is a near-superset of an existing schema
// can collapse onto the existing canonical hash. That breaks our
// migration: the schema service reports success, but our new field
// isn't actually addressable under the returned hash. The marker
// adds `<descriptive_name>_marker` (e.g. `Concept_v2_marker`) so
// each migration's field set is unambiguously distinct from any
// prior registration.
export function schemaWithExtraField(opts: {
  base: AddSchemaRequest;
  fieldName: string;
  fieldType: FieldType;
  description: string;
  newDescriptiveName: string;
}): AddSchemaRequest {
  const { base, fieldName, fieldType, description, newDescriptiveName } = opts;
  if (base.schema.fields.includes(fieldName)) {
    throw new Error(
      `Field "${fieldName}" already exists in schema "${base.schema.descriptive_name}".`,
    );
  }
  const markerName = versionMarkerField(newDescriptiveName);
  return {
    schema: {
      name: newDescriptiveName,
      descriptive_name: newDescriptiveName,
      schema_type: base.schema.schema_type,
      key: { ...base.schema.key },
      fields: [...base.schema.fields, fieldName, markerName],
      field_types: {
        ...base.schema.field_types,
        [fieldName]: fieldType,
        [markerName]: "String",
      },
      field_descriptions: {
        ...base.schema.field_descriptions,
        [fieldName]: description,
        [markerName]: `schema-distinctness marker for ${newDescriptiveName} (G15)`,
      },
      field_classifications: base.schema.field_classifications
        ? { ...base.schema.field_classifications }
        : {},
      field_data_classifications: {
        ...base.schema.field_data_classifications,
        [fieldName]: { sensitivity_level: 0, data_domain: "general" },
        [markerName]: { sensitivity_level: 0, data_domain: "general" },
      },
    },
    mutation_mappers: { ...base.mutation_mappers },
  };
}

// The marker-field name embeds the descriptive_name so each
// migration's marker is unique across all prior registrations. Field
// names must match [A-Za-z_][A-Za-z0-9_]* (the parser in
// `put.ts:parseFrontmatter` uses the same shape and fold_db's
// declarative schemas accept it); we sanitise the descriptive_name
// to fit.
export function versionMarkerField(descriptiveName: string): string {
  const safe = descriptiveName.replace(/[^A-Za-z0-9]/g, "_");
  return `_${safe}_marker`;
}

// Default value stamped on records during migration for the version
// marker field.
export function versionMarkerValue(descriptiveName: string): string {
  return descriptiveName;
}

// Bump `FbrainKindNote` → `FbrainKindNote_v2` → `..._v3`. For Design /
// Task this also gives `Design_v2`, `Task_v2`, etc. The "version"
// number comes from manifests already on disk that target the same
// scope, so successive `migrate` invocations stay deterministic.
export function bumpDescriptiveName(currentDescriptiveName: string, existingVersions: number[]): string {
  const stripped = currentDescriptiveName.replace(/_v(\d+)$/, "");
  const observed = currentDescriptiveName.match(/_v(\d+)$/);
  const observedNum = observed ? parseInt(observed[1]!, 10) : 1;
  const maxKnown = Math.max(observedNum, ...existingVersions);
  return `${stripped}_v${maxKnown + 1}`;
}

// Extract the trailing _v<N> from a descriptive_name, returning N or
// 1 if absent. Used by `bumpDescriptiveName` to walk past prior
// migrations.
export function descriptiveNameVersion(name: string): number {
  const m = name.match(/_v(\d+)$/);
  return m ? parseInt(m[1]!, 10) : 1;
}

// Parse a CLI field-type spec into the FieldType union.
export function parseFieldType(spec: string): FieldType {
  if (spec === "String") return "String";
  if (spec === "Array:String") return { Array: "String" };
  throw new Error(`Unsupported field type "${spec}". Use "String" or "Array:String".`);
}

// Validate a default value matches the declared field type. Throws
// with a user-actionable message if it doesn't.
export function validateDefault(fieldType: FieldType, raw: string | undefined): unknown {
  if (fieldType === "String") {
    if (raw === undefined) {
      throw new Error(
        '--default <value> is required for String fields (no implicit empty default — too easy to silently corrupt).',
      );
    }
    return raw;
  }
  // Array:String — accept a JSON literal or default to [].
  if (raw === undefined || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--default for Array:String must be a JSON array (got ${JSON.stringify(raw)}; ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
    throw new Error(
      `--default for Array:String must be an array of strings (got ${JSON.stringify(parsed)}).`,
    );
  }
  return parsed;
}

// Format a hash for human consumption (config snapshots, log lines).
export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

// Pretty-print the migration manifest table for `fbrain migrate --status`.
export function formatStatusTable(manifests: MigrationManifest[]): string {
  if (manifests.length === 0) {
    return "(no migrations recorded under " + defaultMigrationsDir() + ")";
  }
  const rows: string[][] = [["id", "status", "scope", "field", "from→to", "count"]];
  for (const m of manifests) {
    rows.push([
      m.id,
      m.status,
      `${m.scope.schema_key}:${m.scope.affected_types.join(",")}`,
      `${m.field_added}=${typeof m.default === "string" ? m.default : JSON.stringify(m.default)}`,
      `${shortHash(m.from_hash)}→${shortHash(m.to_hash)}`,
      `${m.migrated_count}/${m.total_count}`,
    ]);
  }
  const widths = rows[0]!.map((_, col) =>
    rows.reduce((max, row) => Math.max(max, row[col]?.length ?? 0), 0),
  );
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  "))
    .join("\n");
}

// Look up the manifest dir without requiring an instance — convenient
// for migrate's verbose lines.
export function describeManifestLocation(dir: string = defaultMigrationsDir()): string {
  return dir;
}

// Resolve the unique base directory shared between writes; useful so
// the caller can pass a single override to test code (Bun test sets
// FBRAIN_MIGRATIONS_DIR per-test).
export function ensureMigrationsDir(dir: string = defaultMigrationsDir()): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Make sure `dirname(path)` exists — used when writing a manifest with
// a custom path (e.g. tests passing a sibling temp dir).
export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
