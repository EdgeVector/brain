// Explicit owner conversion of an existing Brain home. Plan mode makes no change.
import { FbrainError, type NodeClient, type QueryRow } from "../client.ts";
import { defaultConfigPath, type Config } from "../config.ts";
import { parseListCount } from "../count-state.ts";
import { DIRECTORY_RANGE, readPageChain } from "../list-page.ts";
import { ownedSchemas } from "../multi-key.ts";
import { conversionCall, conversionPlan, executeConversion, type ConversionEntry, type Metadata } from "../schema-conversion.ts";
import {
  BRAIN_LIST_COUNT_SCHEMA_KEY, BRAIN_TYPE_DIRECTORY_SCHEMA_KEY, OWNER_APP_ID, RECORD_TYPES, isRecordType, type RecordType,
} from "../schemas.ts";

type Options = {apply?:boolean;maintenance?:boolean;abort?:boolean;retireLegacy?:boolean;configPath?:string};
type TypeCount = {count:number;membership:unknown};
/** A record type that an older Brain stored inside another type's installed schema (Sop inside Concept). */
type Split = {entry:ConversionEntry;type:RecordType;pin:string};

const fail = (message: string): never => { throw new FbrainError({ code: "multi_key_conversion_refused", message }); };
const keyOf = (entry: ConversionEntry): string => entry.keys[0]!;
const COPY_BATCH = 8;

export async function convertMultiKey(node: NodeClient, cfg: Config, options: Options = {}) {
  const directory = await conversionCall<{schemas:Metadata[]}>(node,"GET","/api/schemas");
  if (!Array.isArray(directory.schemas)) fail("The schema directory is incomplete.");
  const installed = (pin: string) => directory.schemas.find((item) => item.name === pin || item.identity_hash === pin);
  let counts: Promise<Map<RecordType,TypeCount>> | undefined;
  const typeCounts = () => counts ??= readTypeCounts(node,cfg);

  // Keep each installed schema once. A schema with no pin or no installed copy holds no values;
  // it is declared fresh. A second record type pinned to the same schema is split out.
  const kept: ConversionEntry[] = [], fresh: ConversionEntry[] = [], split: Split[] = [];
  const byPin = new Map<string, ConversionEntry[]>();
  for (const entry of ownedSchemas()) {
    const pin = cfg.schemaHashes[keyOf(entry)];
    if (!pin || !installed(pin)) fresh.push(entry);
    else byPin.set(pin, [...(byPin.get(pin) ?? []), entry]);
  }
  for (const [pin, entries] of byPin) {
    if (entries.length === 1) { kept.push(entries[0]!); continue; }
    const source = installed(pin)!;
    const owner = entries.find((entry) => entry.schema.descriptive_name === source.descriptive_name);
    if (!owner || entries.some((entry) => !isRecordType(keyOf(entry)))) {
      fail(`Brain schemas ${entries.map(keyOf).join(", ")} share one installed schema with no unique owner. Review the config.`);
    }
    kept.push(owner!);
    for (const entry of entries) if (entry !== owner) split.push({ entry, type: keyOf(entry) as RecordType, pin });
  }
  if (split.length && cfg.schemaFieldAliases) fail("A shared record schema with canonical field aliases needs a separate reviewed conversion.");

  // Each kept record schema selects only the slugs that the type directory assigns to its own type.
  const plan = await conversionPlan(node,cfg,kept,async(entry)=>{
    const type=keyOf(entry);
    return isRecordType(type) ? (await typeCounts()).get(type)!.membership : null;
  },[]);
  const added = [...fresh, ...split.map((item) => item.entry)];
  const checkFresh = async () => {
    for (const entry of fresh) {
      const type = keyOf(entry);
      if (isRecordType(type) && (await typeCounts()).get(type)!.count > 0) {
        fail(`The ${type} schema is absent, but its count is not zero. Repair the config before conversion.`);
      }
    }
  };
  if (!options.apply) {
    await checkFresh();
    const types = split.length ? await typeCounts() : undefined;
    return { ...await executeConversion(node,cfg,options.configPath ?? defaultConfigPath(),plan,options),
      fresh: fresh.map(keyOf),
      split: split.map((item) => ({ type: item.type, installed: item.pin, records: types!.get(item.type)!.count })) };
  }

  const declared = new Map<string,string>();
  return executeConversion(node,cfg,options.configPath ?? defaultConfigPath(),plan,{...options,
    // Requests still run here. Declare the new owned schemas and copy each split type
    // into its own schema, then the conversion freezes requests.
    beforeBegin: async () => {
      await checkFresh();
      for (const entry of added) declared.set(keyOf(entry), await declareOwned(node,entry));
      const types = await typeCounts();
      for (const item of split) await copySplit(node,cfg,item,declared.get(item.type)!,types.get(item.type)!.count);
    },
    extraPins: async () => {
      if (added.every((entry) => declared.has(keyOf(entry)))) {
        return Object.fromEntries(added.flatMap((entry) => entry.keys.map((key) => [key, declared.get(keyOf(entry))!])));
      }
      // A resumed conversion declared these schemas in its first run.
      const listing = await conversionCall<{schemas:Metadata[]}>(node,"GET","/api/schemas");
      return Object.fromEntries(added.flatMap((entry) => {
        const matches = listing.schemas.filter((item) => item.owner_app_id === OWNER_APP_ID && item.independent_fields
          && item.descriptive_name === entry.schema.descriptive_name);
        if (matches.length !== 1) fail(`The new ${keyOf(entry)} schema is not declared exactly once. Review it before resume.`);
        return entry.keys.map((key) => [key, matches[0]!.identity_hash ?? matches[0]!.name]);
      }));
    },
  });
}

async function declareOwned(node: NodeClient, entry: ConversionEntry): Promise<string> {
  if (!node.declareAppSchema) fail("The client cannot declare owned schemas.");
  const declaration = await node.declareAppSchema!(OWNER_APP_ID, entry.schema);
  if (!declaration.independentFields || !declaration.identityHash || !/^[a-f0-9]{64}$/.test(declaration.identityHash)) {
    fail(`The ${keyOf(entry)} declaration did not confirm independent values and a definition identity.`);
  }
  return declaration.identityHash!;
}

const present = (value: unknown): boolean => value !== undefined && value !== null;
function storedFields(row: QueryRow | undefined): Record<string,unknown> {
  return Object.fromEntries(Object.entries(row?.fields ?? {}).filter(([,value]) => present(value)));
}
function typeList(raw: unknown): string[] {
  try { const value = JSON.parse(String(raw)); return Array.isArray(value) ? value.map(String) : []; } catch { return []; }
}

/** Copy one split type's records, as stored, from the shared schema into the type's own schema. */
async function copySplit(node: NodeClient, cfg: Config, item: Split, identity: string, expected: number): Promise<void> {
  if (!node.queryByKeys || !node.mutateBatch) fail("The client cannot read and write record batches.");
  const cards = await readPageChain(node,cfg,item.type);
  const slugs = [...new Set((cards ?? []).filter((card) => card.slug && (card.type === undefined || card.type === item.type))
    .map((card) => card.slug))];
  if (slugs.length !== expected) {
    fail(`The ${item.type} list holds ${slugs.length} records, and its count is ${expected}. Repair membership before conversion.`);
  }
  if (!slugs.length) return;
  const keys = slugs.map((hash) => ({ hash }));
  const fields = item.entry.schema.fields;
  const [directoryRows, rows, existing] = await Promise.all([
    node.queryByKeys!({ schemaHash: cfg.schemaHashes[BRAIN_TYPE_DIRECTORY_SCHEMA_KEY]!, fields: ["btd_types"],
      keys: slugs.map((hash) => ({ hash, range: DIRECTORY_RANGE })) }),
    node.queryByKeys!({ schemaHash: item.pin, fields, keys }),
    node.queryByKeys!({ schemaHash: identity, fields: ["slug"], keys }),
  ]);
  const members = new Set(directoryRows.filter((row) => typeList(row.fields.btd_types).includes(item.type)).map((row) => row.key.hash));
  const values = new Map(rows.map((row) => [row.key.hash!, storedFields(row)]));
  const missing = slugs.find((slug) => !members.has(slug) || values.get(slug)?.slug !== slug);
  if (missing) fail(`The ${item.type} record ${missing} has no complete stored value or directory entry. Repair it before conversion.`);
  const copied = new Set(existing.filter((row) => present(row.fields.slug)).map((row) => row.key.hash));
  const ops = slugs.map((slug) => ({ mutationType: copied.has(slug) ? "update" as const : "create" as const,
    schemaHash: identity, keyHash: slug, fields: values.get(slug)! }));
  for (let offset = 0; offset < ops.length; offset += COPY_BATCH) {
    await node.mutateBatch!(ops.slice(offset, offset + COPY_BATCH), { durability: "durable" });
  }
  const written = new Map((await node.queryByKeys!({ schemaHash: identity, fields, keys }))
    .map((row) => [row.key.hash!, JSON.stringify(Object.entries(storedFields(row)).sort())]));
  const differs = slugs.find((slug) => written.get(slug) !== JSON.stringify(Object.entries(values.get(slug)!).sort()));
  if (differs) fail(`The copied ${item.type} record ${differs} differs from its source. The conversion did not begin.`);
}

async function readTypeCounts(node: NodeClient, cfg: Config): Promise<Map<RecordType,TypeCount>> {
  const countPin=cfg.schemaHashes[BRAIN_LIST_COUNT_SCHEMA_KEY]!;
  const directoryPin=cfg.schemaHashes[BRAIN_TYPE_DIRECTORY_SCHEMA_KEY]!;
  if (!countPin || !directoryPin || !node.queryByKeys) throw new Error("The type directory and batch count read are required.");
  const [counter,directory,rows]=await Promise.all([
    conversionCall<Metadata>(node,"GET",`/api/schema/${encodeURIComponent(countPin)}`),
    conversionCall<Metadata>(node,"GET",`/api/schema/${encodeURIComponent(directoryPin)}`),
    node.queryByKeys({schemaHash:countPin,fields:["bln_n"],keys:RECORD_TYPES.map((hash)=>({hash}))}),
  ]);
  return new Map(RECORD_TYPES.map((type)=>{
    const row=rows.find((row)=>row.key.hash===type);
    const raw=row?.fields.bln_n;
    if (raw!==undefined && typeof raw!=="string") throw new Error("The type count is not text.");
    const state=raw===undefined ? {count:0} : parseListCount(raw);
    if (!state || state.count<0) throw new Error("The type count is invalid. Repair membership before conversion.");
    return [type,{count:state.count,membership:{kind:"directory",schema:directory.name,
      field:cfg.schemaFieldAliases?.[directoryPin]?.btd_types ?? "btd_types",
      range:DIRECTORY_RANGE,contains:type,expected_keys:state.count,
      count_guard:{schema:counter.name,key:{hash:type,range:null},
        field:cfg.schemaFieldAliases?.[countPin]?.bln_n ?? "bln_n",expected:raw ?? null}}}];
  }));
}
