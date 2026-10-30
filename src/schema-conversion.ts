/** Scope-bound owner maintenance. Fresh setup never converts existing values. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { FbrainError, type NodeClient } from "./client.ts";
import { alternateKeyWire } from "./alternate-key-wire.ts";
import { configBytes, readConfig, writeConfig, type Config } from "./config.ts";
import { canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { MULTI_KEY_MODEL } from "./multi-key.ts";
import {
  BRAIN_COMPACT_LOCATOR_SCHEMA_KEY,
  OWNER_APP_ID,
  type SchemaDefinition,
} from "./schemas.ts";

export type ConversionEntry = {
  keys: string[];
  schema: SchemaDefinition;
  /** This exact reviewed layout owns one value by an external hash. */
  opaqueHash?: true;
};
export type Metadata = {
  name: string;
  identity_hash: string;
  owner_app_id: string;
  descriptive_name: string;
  schema_type: string;
  fields: string[];
  key: Record<string, string>;
  field_types: Record<string, unknown>;
  field_descriptions: Record<string, string>;
  independent_fields?: boolean;
  alternate_keys?: unknown;
  field_mappers?: Record<string, string>;
  transform_fields?: Record<string, unknown>;
  ref_fields?: Record<string, unknown>;
};
type Request = {
  schema: string;
  expected_identity: string;
  alternate_keys: NonNullable<SchemaDefinition["alternate_keys"]>;
  membership: unknown;
};
export type ConversionReport = {
  change_id: string;
  phase: string;
  durable: true;
  converted_schemas: string[];
  retired_schemas: string[];
  schemas: Request[];
  selected_keys: number;
  expected_selected_keys: number;
  processed_keys: number;
  expected_keys: number;
};
type Scope = {
  source_config_sha256: string;
  target_config_sha256: string;
  change_id: string;
  schemas: Request[];
  retire: string[];
};
const ROUTE = "/api/db/alternate-keys";
function fail(message: string): never {
  throw new FbrainError({ code: "multi_key_conversion_refused", message });
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const data = (value: unknown) => object(object(value).data ?? value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const same = (left: unknown, right: unknown) => stable(left) === stable(right);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const terminal = (report: ConversionReport) =>
  ["complete", "aborted"].includes(report.phase);
const names = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((name) => typeof name === "string" && name.length > 0) &&
  new Set(value).size === value.length;

function receipt(value: unknown): ConversionReport {
  const report = object(data(value).app_schema_conversion);
  if (
    report.durable !== true ||
    typeof report.change_id !== "string" ||
    !report.change_id ||
    typeof report.phase !== "string" ||
    ![
      "backfill",
      "verifying",
      "verified",
      "retiring",
      "ready",
      "aborting",
      "complete",
      "aborted",
    ].includes(report.phase) ||
    !names(report.converted_schemas) ||
    !names(report.retired_schemas) ||
    !Array.isArray(report.schemas) ||
    report.schemas.length !== report.converted_schemas.length ||
    !same(
      report.schemas.map((item) => object(item).schema).sort(),
      [...report.converted_schemas].sort(),
    ) ||
    ![
      "selected_keys",
      "expected_selected_keys",
      "processed_keys",
      "expected_keys",
    ].every(
      (key) => Number.isSafeInteger(report[key]) && Number(report[key]) >= 0,
    ) ||
    Number(report.selected_keys) > Number(report.expected_selected_keys) ||
    Number(report.processed_keys) > Number(report.expected_keys)
  )
    fail(
      "The node did not return a valid durable receipt. No next phase follows.",
    );
  return {
    ...report,
    schemas: report.schemas.map((request: Request) => ({
      ...request,
      alternate_keys: alternateKeyWire(request.alternate_keys),
    })),
  } as ConversionReport;
}
export async function conversionCall<T>(
  node: NodeClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await node.rawCall(method, path, body);
  if (response.status !== 200 || object(response.json).ok === false)
    // Keep the node's refusal text: a bare status hides which rule refused the request.
    fail(
      `${path} returned HTTP ${response.status}: ${response.body.slice(0, 800)}. No next phase follows.`,
    );
  if (path === ROUTE) return receipt(response.json) as T;
  const payload = data(response.json);
  return (payload.schema ?? payload) as T;
}
async function status(node: NodeClient): Promise<ConversionReport | undefined> {
  const response = await node.rawCall("POST", ROUTE, { action: "app_status" });
  if (response.status === 200) return receipt(response.json);
  if (
    response.status === 404 &&
    (response.json === "app conversion is absent" ||
      response.body === "app conversion is absent")
  )
    return undefined;
  return fail(
    "The conversion status is unavailable. No next phase follows this reply.",
  );
}

/** Exact old definitions remain valid inputs. No field rename is inferred. */
export function conversionDefinition(
  source: Metadata,
  local: SchemaDefinition,
): { definition: SchemaDefinition; canonical: boolean } {
  const canonical = canonicalSchema(local);
  const definition = same(
    [...(source.fields ?? [])].sort(),
    [...canonical.fields].sort(),
  )
    ? canonical
    : local;
  if (
    source.owner_app_id !== OWNER_APP_ID ||
    source.descriptive_name !== definition.descriptive_name ||
    source.schema_type !== definition.schema_type ||
    !identity(source.identity_hash) ||
    typeof source.name !== "string" ||
    !source.name ||
    !same([...(source.fields ?? [])].sort(), [...definition.fields].sort()) ||
    !same(
      [source.key?.hash_field ?? null, source.key?.range_field ?? null],
      [definition.key?.hash_field ?? null, definition.key?.range_field ?? null],
    ) ||
    !same(source.field_types, definition.field_types) ||
    !same(source.field_descriptions, definition.field_descriptions) ||
    Object.keys(source.transform_fields ?? {}).length
  )
    fail(
      `The installed ${local.descriptive_name} definition differs. Review it before conversion.`,
    );
  return { definition, canonical: definition === canonical };
}

function readScope(path: string): {
  raw: string | null;
  saved: Scope | undefined;
} {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (!raw) return { raw, saved: undefined };
  let saved: Scope;
  try {
    saved = JSON.parse(raw) as Scope;
  } catch {
    return fail("The saved scope is unreadable. Owner review is required.");
  }
  if (
    !identity(saved.source_config_sha256) ||
    !identity(saved.target_config_sha256) ||
    typeof saved.change_id !== "string" ||
    !Array.isArray(saved.schemas) ||
    !names(saved.retire)
  )
    fail("The saved scope is invalid. Owner review is required.");
  saved = {
    ...saved,
    schemas: saved.schemas.map((request) => ({
      ...request,
      alternate_keys: alternateKeyWire(request.alternate_keys),
    })),
  };
  return { raw, saved };
}
function barrier(path: string): void {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function saveScope(
  path: string,
  scope: Scope,
  previous: string | null,
): string {
  if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== previous)
    fail("The saved scope changed.");
  const raw = JSON.stringify(scope, null, 2) + "\n",
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (previous === null) {
      const placeholder = openSync(path, "wx", 0o600);
      closeSync(placeholder);
    } else if (readFileSync(path, "utf8") !== previous)
      fail("The saved scope changed before publication.");
    renameSync(temporary, path);
    barrier(path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return raw;
}
function removeScope(path: string, expected: string): void {
  if (readFileSync(path, "utf8") !== expected)
    fail("The saved scope changed before completion.");
  unlinkSync(path);
  barrier(path);
}
function checkScope(report: ConversionReport, scope: Scope): void {
  if (
    (scope.change_id && scope.change_id !== report.change_id) ||
    !same(report.schemas, scope.schemas) ||
    !same(
      [...report.converted_schemas].sort(),
      scope.schemas.map((request) => request.schema).sort(),
    ) ||
    !same([...report.retired_schemas].sort(), [...scope.retire].sort())
  )
    fail(
      "Another conversion owns this node, or its definitions, membership, or retirements differ.",
    );
}

export async function conversionPlan(
  node: NodeClient,
  supplied: Config,
  entries: ConversionEntry[],
  membership: (entry: ConversionEntry, source: Metadata) => Promise<unknown>,
  path: string,
  knownEntries: ConversionEntry[] = entries,
) {
  const initial = readFileSync(path, "utf8"),
    cfg = readConfig(path),
    scopePath = path + ".conversion.json";
  if (
    configBytes(cfg) !== configBytes(supplied) ||
    node.userHash !== cfg.userHash
  )
    fail(
      "The caller and saved config differ. Reopen the selected config before conversion.",
    );
  const { raw: scopeRaw, saved } = readScope(scopePath);
  const version = await conversionCall<{
    capabilities?: Record<string, boolean>;
  }>(node, "GET", "/api/version");
  if (!version.capabilities?.app_schema_conversion_v1)
    fail("Use the compatible conversion release before the removal upgrade.");
  const [directory, report] = await Promise.all([
    conversionCall<{ ready?: boolean; schemas?: Metadata[] }>(
      node,
      "GET",
      "/api/schemas",
    ),
    status(node),
  ]);
  if (directory.ready !== true || !Array.isArray(directory.schemas))
    fail("The schema directory is incomplete.");
  const installed = await Promise.all(
    directory.schemas
      .filter((source) => source.owner_app_id === OWNER_APP_ID)
      .map((source) =>
        conversionCall<Metadata>(
          node,
          "GET",
          `/api/schema/${encodeURIComponent(source.name)}`,
        ),
      ),
  );
  if (
    installed.some(
      (source) =>
        !knownEntries.some(
          (entry) => entry.schema.descriptive_name === source.descriptive_name,
        ),
    )
  )
    fail(
      "An unreviewed Brain schema is installed. Preserve it through an explicit reviewed conversion.",
    );
  if (
    [
      ...Object.keys(cfg.schemaHashes),
      ...Object.keys(cfg.schemaIdentities ?? {}),
    ].some((key) => !knownEntries.some((entry) => entry.keys.includes(key)))
  )
    fail("The saved config contains an unreviewed schema pin.");
  const sources = entries.flatMap((entry) => {
    const pin = cfg.schemaHashes[entry.keys[0]!];
    const candidates = installed.filter(
      (source) =>
        source.descriptive_name === entry.schema.descriptive_name &&
        !Object.keys(source.field_mappers ?? {}).length,
    );
    const matches = pin
      ? candidates.filter(
          (source) => source.name === pin || source.identity_hash === pin,
        )
      : candidates;
    if (matches.length !== 1) {
      return fail(`Cannot select one exact ${entry.keys[0]} source.`);
    }
    const source = matches[0]!,
      matched = conversionDefinition(source, entry.schema);
    if (
      entry.opaqueHash ||
      (!source.key?.hash_field && !source.key?.range_field)
    ) {
      if (
        entry.opaqueHash !== true ||
        entry.keys.length !== 1 ||
        entry.keys[0] !== BRAIN_COMPACT_LOCATOR_SCHEMA_KEY ||
        source.schema_type !== "Hash" ||
        source.key?.hash_field ||
        source.key?.range_field ||
        source.fields.length !== 1 ||
        entry.schema.fields[0] !== "bcl_page" ||
        Object.keys(alternateKeyWire(source.alternate_keys)).length ||
        Object.keys(alternateKeyWire(matched.definition.alternate_keys))
          .length ||
        Object.keys(source.field_mappers ?? {}).length ||
        Object.keys(source.transform_fields ?? {}).length ||
        Object.keys(source.ref_fields ?? {}).length
      )
        fail(
          "The reviewed compact locator must retain its exact single-field Hash coordinates, with no alternate keys, maps, transforms, or references.",
        );
      if (!version.capabilities?.app_schema_opaque_hash_ownership_v1)
        fail(
          "The compact locator needs app_schema_opaque_hash_ownership_v1 before ownership conversion.",
        );
    }
    if (
      entry.keys.some(
        (key) =>
          cfg.schemaIdentities?.[key] &&
          cfg.schemaIdentities[key] !== source.identity_hash,
      )
    )
      fail("A saved definition identity differs from its installed source.");
    return [{ entry, source, ...matched }];
  });
  const kept = new Set(sources.map(({ source }) => source.name));
  if (kept.size !== sources.length)
    fail("Two kept schemas use one runtime address.");
  const aliases = installed.filter((source) => !kept.has(source.name));
  for (const alias of aliases) {
    const entry = entries.find(
      (entry) => OWNER_APP_ID + "/" + entry.schema.name === alias.name,
    );
    const mappings = Object.values(alias.field_mappers ?? {});
    if (
      !entry ||
      alias.independent_fields === true ||
      !mappings.length ||
      mappings.some(
        (mapping) =>
          typeof mapping !== "string" || !kept.has(mapping.split(".")[0]!),
      )
    )
      fail("A local alias has data outside the kept sources.");
    conversionDefinition(alias, entry.schema);
  }
  const pending = report && !terminal(report) ? report : undefined;
  if (pending) {
    if (
      !saved ||
      ![saved.source_config_sha256, saved.target_config_sha256].includes(
        sha(initial),
      )
    )
      fail(
        "An active conversion needs this exact saved config and local scope.",
      );
    checkScope(pending, saved);
  }
  const retire =
    saved && report?.change_id === saved.change_id
      ? [...saved.retire]
      : aliases.map((source) => source.name).sort();
  if (retire.length && !version.capabilities.app_schema_alias_retirement_v1)
    fail(
      "This conversion needs app_schema_alias_retirement_v1 before it can retire an alias.",
    );
  const requests = await Promise.all(
    sources.map(async ({ entry, source, definition }): Promise<Request> => ({
      schema: source.name,
      expected_identity: source.identity_hash,
      alternate_keys: alternateKeyWire(definition.alternate_keys),
      membership: pending
        ? saved!.schemas.find((request) => request.schema === source.name)
            ?.membership
        : await membership(entry, source),
    })),
  );
  if (pending && !same(requests, saved!.schemas))
    fail(
      "The saved definitions, key layouts, or membership differ. No next phase follows.",
    );
  if (
    sources.some(
      ({ entry }, index) =>
        entry.opaqueHash && requests[index]!.membership !== null,
    )
  )
    fail(
      "The compact locator retains every original coordinate; a membership filter is not allowed.",
    );
  const retainedProfiles = new Set(
    sources.flatMap(({ source, entry }) => [
      source.name,
      source.identity_hash,
      entry.schema.name,
      entry.schema.descriptive_name,
      OWNER_APP_ID + "/" + entry.schema.name,
    ]),
  );
  const aliasesForKept = cfg.schemaFieldAliases
    ? Object.fromEntries(
        Object.entries(cfg.schemaFieldAliases).filter(([name]) =>
          retainedProfiles.has(name),
        ),
      )
    : undefined;
  const canonicalSources = sources.filter(({ canonical }) => canonical);
  const target: Config = {
    ...cfg,
    storageModel: MULTI_KEY_MODEL,
    schemaHashes: Object.fromEntries(
      sources.flatMap(({ entry, source }) =>
        entry.keys.map((key) => [key, source.name]),
      ),
    ),
    schemaIdentities: Object.fromEntries(
      sources.flatMap(({ entry, source }) =>
        entry.keys.map((key) => [key, source.identity_hash]),
      ),
    ),
    schemaFieldAliases: canonicalSources.length
      ? Object.assign(
          {},
          aliasesForKept,
          ...canonicalSources.map(({ entry, source }) =>
            profilesFor(entry.schema, [
              source.name,
              source.identity_hash,
              OWNER_APP_ID + "/" + entry.schema.name,
            ]),
          ),
        )
      : aliasesForKept,
  };
  return {
    cfg,
    initial,
    path,
    scopePath,
    scopeRaw,
    saved,
    report,
    pending,
    sources,
    requests,
    retire,
    target,
  };
}

export async function executeConversion(
  node: NodeClient,
  plan: Awaited<ReturnType<typeof conversionPlan>>,
  options: { apply?: boolean; maintenance?: boolean; abort?: boolean },
) {
  if (options.abort && (!options.apply || !options.maintenance))
    fail("Abort requires --apply --maintenance.");
  const { initial, path, scopePath, sources, requests, retire, target } = plan;
  let { scopeRaw, saved } = plan;
  let report = await status(node);
  const pending = report && !terminal(report) ? report : undefined;
  const currentSha = sha(initial),
    targetSha = sha(configBytes(target));
  if (pending) {
    if (
      !saved ||
      !same(saved.schemas, requests) ||
      saved.target_config_sha256 !== targetSha ||
      ![saved.source_config_sha256, saved.target_config_sha256].includes(
        currentSha,
      )
    )
      fail(
        "The active conversion does not match this config and durable scope.",
      );
    checkScope(pending, saved);
  }
  if (
    saved &&
    report?.phase === "aborted" &&
    report.change_id === saved.change_id
  ) {
    checkScope(report, saved);
    if (saved.source_config_sha256 !== currentSha)
      fail("The aborted scope does not match this config.");
    if (options.apply && scopeRaw) removeScope(scopePath, scopeRaw);
    return { phase: "aborted", local_cleanup_required: !options.apply };
  }
  if (options.abort && !pending) {
    if (
      saved &&
      !saved.change_id &&
      saved.source_config_sha256 === currentSha &&
      scopeRaw
    ) {
      removeScope(scopePath, scopeRaw);
      return { phase: "aborted", prepared_scope_only: true };
    }
    return fail("No unpublished conversion belongs to this saved scope.");
  }
  const allOwned = sources.every(
    ({ source }) => source.independent_fields === true,
  );
  if (!pending && allOwned) {
    if (
      sources.some(
        ({ source }, index) =>
          !same(
            alternateKeyWire(source.alternate_keys),
            requests[index]!.alternate_keys,
          ),
      )
    )
      fail("An existing alternate-key layout differs.");
    if (saved) {
      if (
        !report ||
        report.phase !== "complete" ||
        saved.target_config_sha256 !== currentSha
      )
        fail("The saved scope is incomplete.");
      checkScope(report, saved);
    }
    if (options.apply) {
      writeConfig(target, path, initial, scopeRaw ?? undefined);
      if (saved && scopeRaw) removeScope(scopePath, scopeRaw);
    }
    return {
      phase: "complete",
      already_converted: true,
      converted_schemas: sources.map(({ source }) => source.name),
    };
  }
  if (
    !pending &&
    sources.some(({ source }) => source.independent_fields === true)
  )
    fail("This app mixes legacy and owned schemas. Owner review is required.");
  if (!options.apply)
    return {
      phase: "plan",
      schemas: requests,
      retire,
      retained_coordinate_schemas: sources
        .filter(({ entry }) => entry.opaqueHash)
        .map(({ source }) => source.name),
    };
  if (!options.maintenance)
    fail("Use --apply --maintenance for the explicit node request pause.");
  if (!pending) {
    const scope: Scope = {
      source_config_sha256: currentSha,
      target_config_sha256: targetSha,
      change_id: "",
      schemas: requests,
      retire,
    };
    if (saved && !same(saved, scope))
      fail("A different saved conversion scope requires owner review.");
    scopeRaw = saveScope(scopePath, scope, scopeRaw);
    saved = scope;
    if (
      readFileSync(path, "utf8") !== initial ||
      readFileSync(scopePath, "utf8") !== scopeRaw
    )
      fail("The config or scope changed before the node request pause.");
    report = await conversionCall<ConversionReport>(node, "POST", ROUTE, {
      action: "app_begin",
      schemas: requests,
      retire,
      maintenance: true,
    });
    checkScope(report, saved);
  }
  if (!saved || !report || !scopeRaw)
    fail("The durable conversion scope is absent.");
  if (!saved.change_id) {
    saved = { ...saved, change_id: report.change_id };
    scopeRaw = saveScope(scopePath, saved, scopeRaw);
  }
  for (let page = 0; page < 100000; page++) {
    if (
      readFileSync(scopePath, "utf8") !== scopeRaw ||
      ![saved.source_config_sha256, saved.target_config_sha256].includes(
        sha(readFileSync(path, "utf8")),
      )
    )
      fail("The config or scope changed. No next phase follows.");
    checkScope(report, saved);
    let action: string;
    if (options.abort) {
      if (
        !["backfill", "verifying", "verified", "aborting"].includes(
          report.phase,
        )
      )
        fail("A published conversion cannot abort.");
      action = "app_abort";
    } else if (["backfill", "verifying"].includes(report.phase))
      action = "app_page";
    else if (report.phase === "verified") action = "app_commit";
    else if (report.phase === "retiring") action = "app_cleanup";
    else if (report.phase === "ready") {
      if (
        report.selected_keys !== report.expected_selected_keys ||
        report.processed_keys !== report.expected_keys
      )
        fail("The conversion membership is incomplete.");
      const current = await Promise.all(
        sources.map(({ source }) =>
          conversionCall<Metadata>(
            node,
            "GET",
            `/api/schema/${encodeURIComponent(source.name)}`,
          ),
        ),
      );
      current.forEach((source, index) => {
        conversionDefinition(source, sources[index]!.entry.schema);
        if (
          source.independent_fields !== true ||
          source.identity_hash !== requests[index]!.expected_identity ||
          !same(
            alternateKeyWire(source.alternate_keys),
            requests[index]!.alternate_keys,
          ) ||
          Object.keys(source.field_mappers ?? {}).length
        )
          fail("A published definition or key layout differs.");
      });
      const raw = readFileSync(path, "utf8");
      if (
        readFileSync(scopePath, "utf8") !== scopeRaw ||
        ![saved.source_config_sha256, saved.target_config_sha256].includes(
          sha(raw),
        )
      )
        fail("The config or scope changed before the final config write.");
      writeConfig(target, path, raw, scopeRaw);
      action = "app_finish";
    } else if (terminal(report)) {
      removeScope(scopePath, scopeRaw);
      return report;
    } else
      return fail(
        `Conversion ${report.change_id} remains in ${report.phase}. Resume or abort that scope.`,
      );
    report = await conversionCall<ConversionReport>(node, "POST", ROUTE, {
      action,
      change_id: report.change_id,
    });
    checkScope(report, saved);
  }
  return fail(
    "The page limit stopped the command. Resume the same saved conversion.",
  );
}
