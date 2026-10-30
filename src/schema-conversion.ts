// Explicit owner maintenance; ordinary init never converts existing values.
import { FbrainError, type NodeClient } from "./client.ts";
import { readConfig, writeConfig, type Config } from "./config.ts";
import { canonicalSchema } from "./canonical-vocabulary.ts";
import { MULTI_KEY_MODEL } from "./multi-key.ts";
import { OWNER_APP_ID, type SchemaDefinition } from "./schemas.ts";

export type ConversionEntry = { keys: string[]; schema: SchemaDefinition };
export type Metadata = { name: string; identity_hash?: string; owner_app_id?: string; descriptive_name: string;
  fields: string[]; key: Record<string,string>; field_types: Record<string,unknown>; field_descriptions: Record<string,string>;
  independent_fields?: boolean; alternate_keys?: unknown; field_mappers?:Record<string,string> };
export type ConversionReport = { change_id: string; phase: string; converted_schemas: string[];
  retired_schemas: string[]; schemas: Array<{schema:string;membership:unknown}>; selected_keys: number; expected_selected_keys: number };
const fail = (message: string): never => { throw new FbrainError({ code: "multi_key_conversion_refused", message }); };
const same = (a: unknown,b: unknown): boolean => stable(a) === stable(b);
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+":"+stable(v)).join(",") + "}";
  return JSON.stringify(value);
}
export async function conversionCall<T>(node: NodeClient, method: string, path: string, body?: unknown): Promise<T> {
  const reply = await node.rawCall(method,path,body);
  const root = reply.json as { data?: unknown; ok?: boolean };
  if (reply.status !== 200 || root?.ok === false) fail(`${path}: HTTP ${reply.status}: ${reply.body.slice(0,800)}`);
  const value=(root?.data ?? root) as {schema?:unknown};
  return (value?.schema ?? value) as T;
}
export async function conversionPlan(node: NodeClient, cfg: Config, entries: ConversionEntry[],
  membership: (entry: ConversionEntry, source: Metadata) => Promise<unknown>, retiredKeys: string[]) {
  const version = await conversionCall<{capabilities?: Record<string,boolean>}>(node,"GET","/api/version");
  if (!version.capabilities?.app_schema_conversion_v1) fail("Upgrade this node before the explicit app conversion.");
  const status = await node.rawCall("POST","/api/db/alternate-keys",{action:"app_status"});
  const active = status.status === 200 ? ((status.json as {data?:unknown}).data ?? status.json) as ConversionReport : undefined;
  const pending = active && !["complete","aborted"].includes(active.phase) ? active : undefined;
  const sources = await Promise.all(entries.map(async(entry) => {
    const pin = cfg.schemaHashes[entry.keys[0]!] ?? fail("A kept schema pin is absent.");
    if (!pin) fail(`Missing schema pin: ${entry.keys[0]}`);
    const source = await conversionCall<Metadata>(node,"GET",`/api/schema/${encodeURIComponent(pin)}`);
    const definition = cfg.schemaFieldAliases?.[pin] ? canonicalSchema(entry.schema) : entry.schema;
    if (source.owner_app_id !== OWNER_APP_ID || source.descriptive_name !== definition.descriptive_name
      || !same([...source.fields].sort(),[...definition.fields].sort()) || !same([source.key.hash_field,source.key.range_field ?? null],[definition.key.hash_field,definition.key.range_field ?? null])
      || !same(source.field_types,definition.field_types) || !same(source.field_descriptions,definition.field_descriptions)) {
      fail(`The installed ${entry.keys[0]} definition differs. Review this schema before conversion.`);
    }
    return {entry,source, request:{schema:source.name, expected_identity:source.identity_hash ?? null,
      alternate_keys:definition.alternate_keys ?? {}, membership:pending ? pending.schemas.find((item)=>item.schema===source.name)?.membership : await membership(entry,source)}};
  }));
  if (new Set(sources.map(({source}) => source.name)).size !== sources.length) fail("Two kept schemas use the same runtime address.");
  const kept = new Set(sources.map(({source}) => source.name));
  if (pending) {
    if (!same([...pending.converted_schemas].sort(),[...kept].sort())) fail("Another app conversion is active.");
    return {sources,retire:pending.retired_schemas};
  }
  const retired = await Promise.all([...new Set(retiredKeys.map((key) => cfg.schemaHashes[key]).filter(Boolean))].map(
    (pin) => conversionCall<Metadata>(node,"GET",`/api/schema/${encodeURIComponent(pin!)}`)));
  const retire = retired.filter((source) => !kept.has(source.name)).map((source) => {
    if (source.owner_app_id !== OWNER_APP_ID || source.independent_fields) fail("A retired schema is not a legacy schema of this app.");
    return source.name;
  });
  const directory=await conversionCall<{schemas:Metadata[]}>(node,"GET","/api/schemas");
  if (!Array.isArray(directory.schemas)) fail("The schema directory is incomplete.");
  const aliasNames=new Set(entries.map((entry)=>OWNER_APP_ID+"/"+entry.schema.descriptive_name));
  const aliases=await Promise.all(directory.schemas.filter((item)=>aliasNames.has(item.name)&&!kept.has(item.name))
    .map((item)=>conversionCall<Metadata>(node,"GET",`/api/schema/${encodeURIComponent(item.name)}`)));
  for (const alias of aliases) {
    const mappings=Object.values(alias.field_mappers ?? {});
    if (alias.owner_app_id!==OWNER_APP_ID || alias.independent_fields || !mappings.length
      || mappings.some((mapping)=>!kept.has(mapping.split(".")[0]!))) fail("A local alias has data outside the kept sources. Review it before conversion.");
    retire.push(alias.name);
  }
  return {sources, retire:[...new Set(retire)]};
}
export async function executeConversion(node: NodeClient, cfg: Config, path: string,
  plan: Awaited<ReturnType<typeof conversionPlan>>, options: {apply?:boolean; maintenance?:boolean; abort?:boolean}) {
  if (!options.apply) return {phase:"plan", schemas:plan.sources.map(({request}) => request),retire:plan.retire};
  if (!options.maintenance) fail("Use --apply --maintenance for the explicit request pause and conversion.");
  let report: ConversionReport | undefined;
  const status = await node.rawCall("POST","/api/db/alternate-keys",{action:"app_status"});
  if (status.status === 200) report = ((status.json as {data?:unknown}).data ?? status.json) as ConversionReport;
  const names = plan.sources.map(({source}) => source.name).sort();
  if (report && !["complete","aborted"].includes(report.phase) && !same([...report.converted_schemas].sort(),names)) {
    fail("Another app conversion is active. Finish that conversion first.");
  }
  const step = (action: string) => conversionCall<ConversionReport>(node,"POST","/api/db/alternate-keys",
    {action,change_id:report!.change_id});
  if (options.abort) {
    if (!report || ["complete","aborted"].includes(report.phase)) fail("No unpublished conversion is active.");
    for (let page=0;page<100000;page++) { report=await step("app_abort"); if(report.phase==="aborted") return report; }
    fail("Abort page limit reached. Resume the abort.");
  }
  if (!report || ["complete","aborted"].includes(report.phase)) report=await conversionCall<ConversionReport>(
    node,"POST","/api/db/alternate-keys",{action:"app_begin",schemas:plan.sources.map(({request})=>request),
      retire:plan.retire,maintenance:true});
  try {
    for (let page=0;["backfill","verifying"].includes(report!.phase)&&page<100000;page++) report=await step("app_page");
    if (report!.phase==="verified") report=await step("app_commit");
    for (let page=0;report!.phase==="retiring"&&page<100000;page++) report=await step("app_cleanup");
    if (report!.phase!=="ready") fail("Conversion is incomplete. Resume the same command.");
    if (!same(readConfig(path).schemaHashes,cfg.schemaHashes)) fail("The config changed during conversion. Review it before resume.");
    for (const {source,request} of plan.sources) {
      const current=await conversionCall<Metadata>(node,"GET",`/api/schema/${encodeURIComponent(source.name)}`);
      if (!current.independent_fields || !same(current.alternate_keys ?? {},request.alternate_keys)) fail("The published key layout differs.");
    }
    const schemaHashes=Object.fromEntries(plan.sources.flatMap(({entry})=>entry.keys.map((key)=>[key,cfg.schemaHashes[key]!])));
    writeConfig({...cfg,storageModel:MULTI_KEY_MODEL,schemaHashes},path);
    report=await step("app_finish");
    return report;
  } catch(error) {
    // Before publication the owner can abort. After publication the same command resumes forward.
    throw new FbrainError({code:"multi_key_conversion_incomplete",
      message:`Conversion ${report!.change_id} remains in ${report!.phase}. Resume this command; use --abort only before publication.`,cause:error,
      hint:error instanceof Error ? error.message : String(error)});
  }
}

