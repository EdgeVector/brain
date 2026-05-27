// `fbrain migrate` — schema-evolution playbook command (G15).
//
// fold_db is append-only and computes a schema's identity hash from
// `(descriptive_name, sorted_field_names)` (see fold_db
// `crates/core/src/schema/types/declarative_schemas.rs:672-694`), so
// adding a field always produces a new schema hash. There is no
// in-place "evolve" API in fold_db (the only existing migration
// primitive is `apple_consolidation`, a one-shot consolidate-and-
// re-ingest pattern with marker-file idempotency).
//
// The dance this command implements (see
// docs/g15-schema-evolution-playbook.md):
//   1. Build a new AddSchemaRequest by cloning the base and appending
//      the new field; bump descriptive_name (FbrainKindNote_v2, etc).
//   2. Register the new schema with the schema service → new hash.
//   3. Load schemas into the node (POST /api/schemas/load).
//   4. Write a manifest under ~/.fbrain/migrations/ as `in_progress`.
//   5. Enumerate records under the old hash; for each, probe new hash;
//      if absent, re-put with the new field at the configured default.
//   6. Atomic config swap: rewrite ~/.fbrain/config.json with all
//      affected schemaHashes entries pointing at the new hash, via
//      tmp-file + rename.
//   7. Mark manifest `complete`.
//
// Crash recovery: if step 5 dies mid-flight, the manifest stays
// `in_progress`; `fbrain migrate --resume <manifest-id>` re-enters at
// step 5 and finishes through step 7. Resume is idempotent — a single
// bulk `listRecords(to_hash)` per affected type pre-builds the skip
// set, then the loop checks each record's slug in O(1).
//
// Phase 6 sharding: noteSchema backs six logical types. A migration
// of any one Phase 6 type re-puts every Phase 6 record and swaps all
// six schemaHashes entries atomically, preserving the Phase 6
// "one-schema-for-six-kinds" invariant.

import { renameSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";

import {
  newNodeClient,
  newSchemaServiceClient,
  FbrainError,
  type NodeClient,
  type Verbose,
} from "../client.ts";
import {
  CONFIG_VERSION,
  defaultConfigPath,
  readConfig,
  type Config,
} from "../config.ts";
import {
  listRecords,
  nowIso,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import {
  RECORDS,
  UNIQUE_SCHEMAS,
  type FieldType,
  type RecordType,
} from "../schemas.ts";
import {
  buildManifestId,
  bumpDescriptiveName,
  defaultMigrationsDir,
  ensureMigrationsDir,
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
  type MigrationManifest,
} from "../migration.ts";

export type MigrateMode =
  | { kind: "add-field"; type: RecordType; fieldName: string; fieldSpec: string; defaultRaw?: string; dryRun?: boolean }
  | { kind: "resume"; manifestId: string }
  | { kind: "status" };

export type MigrateOptions = {
  cfg: Config;
  mode: MigrateMode;
  verbose?: Verbose;
  print?: (line: string) => void;
  // For tests: inject a fault mid-flight to exercise --resume.
  failAfterRecords?: number;
  // For tests: override the migrations dir + config path.
  migrationsDir?: string;
  configPath?: string;
};

export type MigrateResult = {
  manifest?: MigrationManifest;
  table?: string;
};

export async function migrateCmd(opts: MigrateOptions): Promise<MigrateResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const verbose = opts.verbose;

  if (opts.mode.kind === "status") {
    const dir = opts.migrationsDir ?? defaultMigrationsDir();
    const manifests = listManifests(dir);
    const table = formatStatusTable(manifests);
    print(table);
    return { table };
  }

  if (opts.mode.kind === "resume") {
    const manifest = readManifest(opts.mode.manifestId, opts.migrationsDir);
    if (manifest.status === "complete") {
      print(`Migration ${manifest.id} is already complete — nothing to do.`);
      return { manifest };
    }
    if (manifest.status === "dry_run") {
      throw new FbrainError({
        code: "resume_dry_run",
        message: `Cannot --resume a dry-run manifest (${manifest.id}). Re-run \`fbrain migrate --add-field\` to start a real migration.`,
      });
    }
    return resumeMigration({
      cfg: opts.cfg,
      manifest,
      print,
      verbose,
      ...(opts.failAfterRecords !== undefined ? { failAfterRecords: opts.failAfterRecords } : {}),
      ...(opts.migrationsDir !== undefined ? { migrationsDir: opts.migrationsDir } : {}),
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    });
  }

  return startAddFieldMigration({
    cfg: opts.cfg,
    mode: opts.mode,
    print,
    verbose,
    ...(opts.failAfterRecords !== undefined ? { failAfterRecords: opts.failAfterRecords } : {}),
    ...(opts.migrationsDir !== undefined ? { migrationsDir: opts.migrationsDir } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
}

type StartCtx = {
  cfg: Config;
  mode: Extract<MigrateMode, { kind: "add-field" }>;
  print: (line: string) => void;
  verbose?: Verbose;
  failAfterRecords?: number;
  migrationsDir?: string;
  configPath?: string;
};

async function startAddFieldMigration(ctx: StartCtx): Promise<MigrateResult> {
  const { cfg, mode, print, verbose } = ctx;
  const dir = ctx.migrationsDir ?? defaultMigrationsDir();

  // 1. Resolve scope. Post-Phase-E each Phase 6 type owns its own
  // per-kind schema, so a migration covers one type at a time. Legacy
  // FbrainKindNote rows are untouched here — they need the consolidation
  // pass before per-kind migrations apply to them (separate follow-up).
  const scope = resolveScope(mode.type);
  const baseSchema = scope.schemaEntry.schema;

  // 2. Parse + validate the field-add args (fail fast before touching
  // the network).
  const fieldType: FieldType = parseFieldType(mode.fieldSpec);
  const defaultValue = validateDefault(fieldType, mode.defaultRaw);
  if (baseSchema.schema.fields.includes(mode.fieldName)) {
    throw new FbrainError({
      code: "field_already_present",
      message: `Field "${mode.fieldName}" already exists on schema "${baseSchema.schema.descriptive_name}".`,
      hint: "Pick a new field name or check `fbrain migrate --status` for a prior migration.",
    });
  }

  // 3. Pick a new descriptive_name. Walk existing manifests for this
  // scope to find the highest _v<N> already in use and bump past it.
  const newDescriptiveName = nextDescriptiveName(baseSchema.schema.descriptive_name, scope.schemaKey, dir);

  // 4. Build the new AddSchemaRequest.
  const newSchema = schemaWithExtraField({
    base: baseSchema,
    fieldName: mode.fieldName,
    fieldType,
    description: `migration-added field (G15): ${scope.schemaKey} :: ${mode.fieldName}`,
    newDescriptiveName,
  });

  // 5. Register + load.
  print(`[1/7] registering ${newDescriptiveName} with schema service`);
  const schemaClient = newSchemaServiceClient(cfg.schemaServiceUrl, verbose);
  const reg = await schemaClient.registerSchema(newSchema);
  const toHash = reg.canonicalHash;
  print(`        ${newDescriptiveName} → ${toHash}`);

  // Schema-service overlap-merge sanity check. fold_db's schema
  // service can collapse a new registration onto an existing canonical
  // hash if the field set looks similar enough. If that happened our
  // requested field WILL NOT BE WRITABLE on the returned hash, even
  // though the registration succeeded. Probe the registered schema and
  // bail out early with an actionable error.
  await assertFieldRegistered(schemaClient, toHash, mode.fieldName, newDescriptiveName);

  print(`[2/7] loading schemas into the node`);
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose });
  const loadResult = await node.loadSchemas();
  if (loadResult.failed_schemas.length > 0) {
    throw new FbrainError({
      code: "schema_load_partial",
      message: `partial schema load — failed_schemas: ${loadResult.failed_schemas.join(", ")}`,
      hint: "check the node logs; the new schema is registered but not loaded.",
    });
  }

  // 6. Build manifest + persist as in_progress.
  const fromHash = schemaHashFor(scope.affectedTypes[0]!, cfg);
  const appliedAt = nowIso();
  const id = buildManifestId(scope.schemaKey, mode.fieldName, appliedAt);
  const manifest: MigrationManifest = {
    id,
    scope: { schema_key: scope.schemaKey, affected_types: scope.affectedTypes },
    from_hash: fromHash,
    to_hash: toHash,
    descriptive_name_from: baseSchema.schema.descriptive_name,
    descriptive_name_to: newDescriptiveName,
    field_added: mode.fieldName,
    field_type: fieldType,
    default: defaultValue,
    applied_at: appliedAt,
    status: mode.dryRun ? "dry_run" : "in_progress",
    migrated_count: 0,
    total_count: 0,
  };
  ensureMigrationsDir(dir);
  writeManifest(manifest, dir);
  print(`[3/7] manifest ${id} written (${manifest.status})`);

  // 7. Enumerate old-hash records. Phase 6 migrations use the first
  // affected_type as the read scope (listRecords filters by kind) and
  // we walk every affected type to get the full bundle.
  print(`[4/7] enumerating records under ${shortHash(fromHash)}`);
  const records = await enumerateAllRecords(node, scope, fromHash);
  manifest.total_count = records.length;
  writeManifest(manifest, dir);
  print(`        found ${records.length} record(s) to migrate`);

  if (mode.dryRun) {
    print(`[dry-run] no record writes, no config swap. Manifest left as dry_run.`);
    print(
      `migrated 0/${records.length} (dry-run) · old=${shortHash(fromHash)} · new=${shortHash(toHash)} · field=${mode.fieldName}=${JSON.stringify(defaultValue)}`,
    );
    return { manifest };
  }

  // 8 + 9. Re-put under new hash; swap config; mark complete.
  await rePutAndSwap({
    cfg: ctx.cfg,
    node,
    manifest,
    records,
    defaultValue,
    print,
    verbose,
    dir,
    ...(ctx.failAfterRecords !== undefined ? { failAfterRecords: ctx.failAfterRecords } : {}),
    ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
  });

  return { manifest };
}

type ResumeCtx = {
  cfg: Config;
  manifest: MigrationManifest;
  print: (line: string) => void;
  verbose?: Verbose;
  failAfterRecords?: number;
  migrationsDir?: string;
  configPath?: string;
};

async function resumeMigration(ctx: ResumeCtx): Promise<MigrateResult> {
  const { cfg, manifest, print, verbose } = ctx;
  const dir = ctx.migrationsDir ?? defaultMigrationsDir();

  print(`[resume] picking up ${manifest.id} (${manifest.migrated_count}/${manifest.total_count} so far)`);
  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, verbose });
  const scope: ScopeInfo = {
    schemaKey: manifest.scope.schema_key,
    affectedTypes: manifest.scope.affected_types,
    schemaEntry: lookupUniqueSchema(manifest.scope.schema_key),
  };

  // Re-enumerate against the old hash. Records already migrated will
  // be skipped at write-time via findBySlug(newHash).
  const records = await enumerateAllRecords(node, scope, manifest.from_hash);
  // Refresh count in case more records landed under the old hash
  // between the original run and resume (rare but cheap to handle).
  manifest.total_count = Math.max(manifest.total_count, records.length);
  writeManifest(manifest, dir);

  await rePutAndSwap({
    cfg: ctx.cfg,
    node,
    manifest,
    records,
    defaultValue: manifest.default,
    print,
    verbose,
    dir,
    ...(ctx.failAfterRecords !== undefined ? { failAfterRecords: ctx.failAfterRecords } : {}),
    ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
  });
  return { manifest };
}

type RePutCtx = {
  cfg: Config;
  node: NodeClient;
  manifest: MigrationManifest;
  records: Array<{ type: RecordType; record: FbrainRecord }>;
  defaultValue: unknown;
  print: (line: string) => void;
  verbose?: Verbose;
  dir: string;
  failAfterRecords?: number;
  configPath?: string;
};

async function rePutAndSwap(ctx: RePutCtx): Promise<void> {
  const { cfg, node, manifest, records, defaultValue, print, verbose, dir } = ctx;
  let migrated = manifest.migrated_count;
  let writtenThisRun = 0;

  // fold_db's schema service has known overlap-merge behavior on
  // `/api/schemas/load` (the same root cause that drove the Phase 6
  // single-schema design — see src/schemas.ts:8-20): registering a
  // strict-superset schema with the same shape family can return the
  // EXISTING canonical hash instead of allocating a new one. When
  // that happens, `from_hash === to_hash` and the migration becomes
  // an in-place backfill: every record stays where it is, but we
  // UPDATE each to set the new field to the configured default. The
  // playbook calls this the "in-place evolve" path.
  const inPlaceEvolve = manifest.from_hash === manifest.to_hash;
  const mode = inPlaceEvolve ? "in-place evolve (from_hash == to_hash)" : "copy-and-migrate";
  print(`[5/7] ${mode}: ${inPlaceEvolve ? "updating" : "re-putting"} ${records.length} record(s) under ${shortHash(manifest.to_hash)}`);

  // Build the resume idempotency-skip set ONCE per affected type, not
  // per record. The earlier per-record findBySlugRaw issued one
  // queryAll(to_hash) per iteration — each returning the full record
  // set at to_hash — so a resume of N records cost N round-trips with
  // ~N²/2 total rows transferred. On a non-trivial dataset that's the
  // difference between a resume that finishes and one that hangs / OOMs
  // the node. A bulk listRecords per type is a strict drop-in (each
  // call already returns every slug under the kind-filtered hash) and
  // the Set lookup is O(1).
  const presentAtTarget = new Map<RecordType, Set<string>>();
  if (!inPlaceEvolve) {
    for (const t of new Set(records.map((r) => r.type))) {
      const list = await listRecords(node, t, manifest.to_hash);
      presentAtTarget.set(t, new Set(list.map((r) => r.slug)));
    }
  }

  for (const { type, record } of records) {
    if (ctx.failAfterRecords !== undefined && writtenThisRun >= ctx.failAfterRecords) {
      throw new FbrainError({
        code: "injected_failure",
        message: `Injected mid-flight failure after ${writtenThisRun} record writes (test hook).`,
      });
    }

    if (presentAtTarget.get(type)?.has(record.slug)) {
      verbose?.(`skip ${type}/${record.slug} — already present under to_hash`);
      continue;
    }

    const fields = buildMigratedFields(
      type,
      record,
      manifest.field_added,
      defaultValue,
      nowIso(),
      manifest.descriptive_name_to,
    );
    if (inPlaceEvolve) {
      // Update in place. fold_db's mutation pipeline is append-only —
      // each update writes a new atom and rebinds the slug-key. On
      // resume, re-applying the same default-fill is idempotent in
      // value if not in atom count (a noop on read).
      await node.updateRecord({ schemaHash: manifest.to_hash, fields, keyHash: record.slug });
    } else {
      await node.createRecord({ schemaHash: manifest.to_hash, fields, keyHash: record.slug });
    }
    migrated++;
    writtenThisRun++;
    manifest.migrated_count = migrated;
    writeManifest(manifest, dir);
    verbose?.(`migrated ${type}/${record.slug}`);
  }

  // [6/7] Atomic config swap. We write a sibling temp file then
  // rename(2). The renamed file replaces ~/.fbrain/config.json
  // atomically on the same filesystem.
  const configPath = ctx.configPath ?? defaultConfigPath();
  const swapped: Config = {
    ...cfg,
    configVersion: CONFIG_VERSION,
    schemaHashes: { ...cfg.schemaHashes },
  };
  for (const t of manifest.scope.affected_types) {
    swapped.schemaHashes[t] = manifest.to_hash;
  }
  swapped.designSchemaHash = swapped.schemaHashes.design ?? swapped.designSchemaHash;
  swapped.taskSchemaHash = swapped.schemaHashes.task ?? swapped.taskSchemaHash;

  const tmpPath = join(dirname(configPath), `.${basename(configPath)}.migrate-${process.pid}-${Date.now()}`);
  writeFileSync(tmpPath, JSON.stringify(swapped, null, 2) + "\n", "utf8");
  renameSync(tmpPath, configPath);
  print(`[6/7] swapped ${manifest.scope.affected_types.length} type(s) in ${configPath}`);

  // [7/7] Mark complete.
  manifest.status = "complete";
  manifest.migrated_count = migrated;
  writeManifest(manifest, dir);
  print(`[7/7] manifest ${manifest.id} marked complete`);

  print(
    `migrated ${migrated}/${records.length} record(s) across ${manifest.scope.affected_types.join(",")}` +
      ` · old=${shortHash(manifest.from_hash)} · new=${shortHash(manifest.to_hash)}` +
      ` · field=${manifest.field_added}=${JSON.stringify(defaultValue)}`,
  );
  print(
    `note: update src/schemas.ts to add "${manifest.field_added}" to the affected schema so the next \`fbrain init\` keeps the new hash.`,
  );
}

type ScopeInfo = {
  schemaKey: string;
  affectedTypes: RecordType[];
  schemaEntry: (typeof UNIQUE_SCHEMAS)[number];
};

function resolveScope(type: RecordType): ScopeInfo {
  for (const entry of UNIQUE_SCHEMAS) {
    if (entry.types.includes(type)) {
      return {
        schemaKey: entry.key,
        affectedTypes: [...entry.types],
        schemaEntry: entry,
      };
    }
  }
  throw new FbrainError({
    code: "unknown_record_type",
    message: `RecordType "${type}" is not present in UNIQUE_SCHEMAS — internal mismatch.`,
  });
}

function lookupUniqueSchema(schemaKey: string): (typeof UNIQUE_SCHEMAS)[number] {
  const found = UNIQUE_SCHEMAS.find((e) => e.key === schemaKey);
  if (!found) {
    throw new FbrainError({
      code: "manifest_unknown_schema_key",
      message: `Manifest references schema_key "${schemaKey}" but UNIQUE_SCHEMAS has no such entry.`,
      hint: "If the schema list changed, the manifest is for a retired schema — re-run init or trash the manifest.",
    });
  }
  return found;
}

function nextDescriptiveName(currentName: string, scopeKey: string, dir: string): string {
  const priorVersions: number[] = [];
  for (const m of listManifests(dir)) {
    if (m.scope.schema_key !== scopeKey) continue;
    const match = m.descriptive_name_to.match(/_v(\d+)$/);
    if (match) priorVersions.push(parseInt(match[1]!, 10));
  }
  return bumpDescriptiveName(currentName, priorVersions);
}

async function enumerateAllRecords(
  node: NodeClient,
  scope: ScopeInfo,
  fromHash: string,
): Promise<Array<{ type: RecordType; record: FbrainRecord }>> {
  // For Phase 6 (kind-discriminated) we still walk per-type since
  // listRecords already filters by `kind` for us. For Design/Task this
  // is a single iteration.
  const out: Array<{ type: RecordType; record: FbrainRecord }> = [];
  for (const t of scope.affectedTypes) {
    const list = await listRecords(node, t, fromHash);
    for (const r of list) out.push({ type: t, record: r });
  }
  return out;
}

// Build the field payload to write under the new schema hash. Mirrors
// reindex.ts's buildReindexFields: preserve every user-meaningful
// field; add the new field with the configured default; bump
// updated_at; preserve created_at, tags (including tombstone), and
// v1_marker_*. Also stamps the per-migration version marker (see
// `versionMarkerField` in `src/migration.ts`) so the new schema's
// field set is structurally distinct from any prior registration.
export function buildMigratedFields(
  type: RecordType,
  record: FbrainRecord,
  fieldAdded: string,
  defaultValue: unknown,
  now: string,
  descriptiveNameTo?: string,
): Record<string, unknown> {
  const entry = RECORDS[type];
  const fields: Record<string, unknown> = {
    slug: record.slug,
    title: record.title,
    body: record.body,
    status: record.status,
    tags: record.tags,
    created_at: record.created_at,
    updated_at: now,
  };
  if (entry.hasDesignSlug) {
    fields.design_slug = record.design_slug ?? "";
  }
  // Pre-Phase-E this added `kind` + `v1_marker_a/b` because Phase 6 types
  // shared the FbrainKindNote schema. Post-Phase-E migrations operate on
  // each per-kind schema, which doesn't carry those fields.
  fields[fieldAdded] = defaultValue;
  if (descriptiveNameTo) {
    fields[versionMarkerField(descriptiveNameTo)] = versionMarkerValue(descriptiveNameTo);
  }
  return fields;
}

// Confirm the schema returned by registerSchema actually carries our
// requested field. fold_db's schema service can silently collapse a
// new registration onto an existing canonical hash whose field set
// differs (the well-known overlap-merge behavior). When that happens
// we fail fast with a hint pointing the user at the playbook.
async function assertFieldRegistered(
  schemaClient: ReturnType<typeof newSchemaServiceClient>,
  hash: string,
  fieldName: string,
  descriptiveName: string,
): Promise<void> {
  const registered = await schemaClient.getSchemaByHash(hash);
  if (!registered) {
    throw new FbrainError({
      code: "post_register_schema_missing",
      message: `Registered schema ${hash} was not retrievable from the schema service.`,
      hint: "Check the schema service logs — registration claimed success but lookup returned 404.",
    });
  }
  if (!registered.fields.includes(fieldName)) {
    throw new FbrainError({
      code: "schema_overlap_merge",
      message:
        `Schema service collapsed "${descriptiveName}" onto an existing canonical hash ` +
        `(${hash}) whose field set does NOT include "${fieldName}". ` +
        `Registered fields: ${registered.fields.join(", ")}.`,
      hint:
        "This is the fold_db `/api/schemas/load` overlap-merge bug (see " +
        "docs/g15-schema-evolution-playbook.md → 'Failure modes'). " +
        "Re-run with a structurally-distinct field set (the per-migration " +
        "version marker is added automatically; if you're still hitting this, " +
        "the schema service has a prior FbrainKindNote_vN with overlapping fields).",
    });
  }
}

// Convenience re-export so the CLI can read a manifest by id without
// also importing src/migration.ts.
export { readManifest, listManifests } from "../migration.ts";

// Read the config from the CLI's `configPath` perspective (or
// homedir). Exposed so the CLI can pass `cfg` to migrateCmd.
export function loadCfg(configPath?: string): Config {
  return readConfig(configPath);
}
