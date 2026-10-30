// Explicit owner conversion of an existing Brain home. Plan mode makes no change.
import { FbrainError, type NodeClient } from "../client.ts";
import { defaultConfigPath, type Config } from "../config.ts";
import { parseListCount } from "../count-state.ts";
import { DIRECTORY_RANGE } from "../list-page.ts";
import { ownedSchemas } from "../multi-key.ts";
import {
  conversionCall,
  conversionPlan,
  executeConversion,
  type ConversionEntry,
  type Metadata,
} from "../schema-conversion.ts";
import {
  BRAIN_LIST_COUNT_SCHEMA_KEY,
  BRAIN_TYPE_DIRECTORY_SCHEMA_KEY,
  RECORD_TYPES,
  isRecordType,
  type RecordType,
} from "../schemas.ts";

type Options = {
  apply?: boolean;
  maintenance?: boolean;
  abort?: boolean;
  retireLegacy?: boolean;
  configPath?: string;
};
type TypeCount = { count: number; membership: unknown };
/** A record type that an older Brain stored inside another type's installed schema (Sop inside Concept). */
type Split = { entry: ConversionEntry; type: RecordType; pin: string };

const fail = (message: string): never => {
  throw new FbrainError({ code: "multi_key_conversion_refused", message });
};
const keyOf = (entry: ConversionEntry): string => entry.keys[0]!;

/** The installed schema at a pin, or null when the node has no such schema. */
async function schemaAt(
  node: NodeClient,
  pin: string,
): Promise<Metadata | null> {
  const reply = await node.rawCall(
    "GET",
    `/api/schema/${encodeURIComponent(pin)}`,
  );
  if (reply.status === 404) return null;
  const root = reply.json as { data?: unknown; ok?: boolean };
  if (reply.status !== 200 || root?.ok === false)
    fail(
      `/api/schema/${pin}: HTTP ${reply.status}: ${reply.body.slice(0, 800)}`,
    );
  const value = (root?.data ?? root) as { schema?: Metadata };
  const schema = (value?.schema ?? value) as Metadata;
  if (typeof schema?.name !== "string" || !schema.name)
    fail(`/api/schema/${pin} returned no schema name.`);
  return schema;
}

export async function convertMultiKey(
  node: NodeClient,
  cfg: Config,
  options: Options = {},
) {
  if (options.retireLegacy)
    fail(
      "Unique legacy schemas cannot retire through this converter. Preserve them through a separate reviewed conversion.",
    );
  const entries = ownedSchemas();
  const pins = [
    ...new Set(
      entries
        .map((entry) => cfg.schemaHashes[keyOf(entry)])
        .filter((pin): pin is string => !!pin),
    ),
  ];
  const installed = new Map(
    await Promise.all(
      pins.map(async (pin) => [pin, await schemaAt(node, pin)] as const),
    ),
  );
  const kept: ConversionEntry[] = [],
    fresh: ConversionEntry[] = [],
    split: Split[] = [];
  const byRuntime = new Map<string, ConversionEntry[]>();
  for (const entry of entries) {
    const pin = cfg.schemaHashes[keyOf(entry)],
      source = pin ? installed.get(pin) : undefined;
    if (!source) fresh.push(entry);
    else
      byRuntime.set(source.name, [
        ...(byRuntime.get(source.name) ?? []),
        entry,
      ]);
  }
  for (const [runtime, group] of byRuntime) {
    if (group.length === 1) {
      kept.push(group[0]!);
      continue;
    }
    const source = installed.get(cfg.schemaHashes[keyOf(group[0]!)]!)!;
    const owner = group.find(
      (entry) => entry.schema.descriptive_name === source.descriptive_name,
    );
    if (!owner || group.some((entry) => !isRecordType(keyOf(entry))))
      fail(
        "Several record types share one schema without an exact owner. Review the config.",
      );
    kept.push(owner!);
    for (const entry of group)
      if (entry !== owner)
        split.push({ entry, type: keyOf(entry) as RecordType, pin: runtime });
  }
  if (split.length)
    fail(
      `The types ${split.map((item) => item.type).join(", ")} need native source-to-target conversion with current atom and author preservation. No declaration, record copy, or request pause occurred.`,
    );
  let counts: Promise<Map<RecordType, TypeCount>> | undefined;
  const typeCounts = () => (counts ??= readTypeCounts(node, cfg));
  const path = options.configPath ?? defaultConfigPath();
  const plan = await conversionPlan(
    node,
    cfg,
    kept,
    async (entry) => {
      const type = keyOf(entry);
      return isRecordType(type)
        ? (await typeCounts()).get(type)!.membership
        : null;
    },
    path,
    entries,
  );
  if (!plan.pending && !options.abort) {
    const state = fresh.some((entry) => isRecordType(keyOf(entry)))
      ? await typeCounts()
      : undefined;
    for (const entry of fresh) {
      const type = keyOf(entry);
      if (isRecordType(type) && state!.get(type)!.count !== 0)
        fail(
          `The ${type} schema is absent but its membership count is not zero. Review the config before conversion.`,
        );
    }
  }
  const result = await executeConversion(node, plan, options);
  return {
    ...result,
    fresh: fresh.map(keyOf),
    fresh_init_required: fresh.length > 0,
  };
}

async function readTypeCounts(
  node: NodeClient,
  cfg: Config,
): Promise<Map<RecordType, TypeCount>> {
  const countPin = cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY]!;
  const directoryPin = cfg.schemaHashes[BRAIN_TYPE_DIRECTORY_SCHEMA_KEY]!;
  if (!countPin || !directoryPin || !node.queryByKeys)
    throw new Error("The type directory and batch count read are required.");
  const [counter, directory, rows] = await Promise.all([
    conversionCall<Metadata>(
      node,
      "GET",
      `/api/schema/${encodeURIComponent(countPin)}`,
    ),
    conversionCall<Metadata>(
      node,
      "GET",
      `/api/schema/${encodeURIComponent(directoryPin)}`,
    ),
    node.queryByKeys({
      schemaHash: countPin,
      fields: ["bln_n"],
      keys: RECORD_TYPES.map((hash) => ({ hash })),
    }),
  ]);
  return new Map(
    RECORD_TYPES.map((type) => {
      const row = rows.find((row) => row.key.hash === type);
      const raw = row?.fields.bln_n;
      if (raw !== undefined && typeof raw !== "string")
        throw new Error("The type count is not text.");
      const state = raw === undefined ? { count: 0 } : parseListCount(raw);
      if (!state || state.count < 0)
        throw new Error(
          "The type count is invalid. Repair membership before conversion.",
        );
      return [
        type,
        {
          count: state.count,
          membership: {
            kind: "directory",
            schema: directory.name,
            field:
              cfg.schemaFieldAliases?.[directoryPin]?.btd_types ?? "btd_types",
            range: DIRECTORY_RANGE,
            contains: type,
            expected_keys: state.count,
            count_guard: {
              schema: counter.name,
              key: { hash: type, range: null },
              field: cfg.schemaFieldAliases?.[countPin]?.bln_n ?? "bln_n",
              expected: raw ?? null,
            },
          },
        },
      ];
    }),
  );
}
