import type { NodeClient } from "../client.ts";
import { defaultConfigPath, type Config } from "../config.ts";
import { parseListCount } from "../count-state.ts";
import { ownedSchemas } from "../multi-key.ts";
import { conversionCall, conversionPlan, executeConversion, type Metadata } from "../schema-conversion.ts";
import { BRAIN_LIST_COUNT_SCHEMA_KEY, BRAIN_TYPE_DIRECTORY_SCHEMA_KEY, RECORD_TYPES, type RecordType } from "../schemas.ts";

export async function convertMultiKey(node: NodeClient,cfg:Config,
  options:{apply?:boolean;maintenance?:boolean;abort?:boolean;configPath?:string}={}) {
  let membership: Promise<Map<string,unknown>> | undefined;
  const plan=await conversionPlan(node,cfg,ownedSchemas(),async(entry)=>{
    const type=entry.keys[0]!;
    if (!RECORD_TYPES.includes(type as RecordType)) return null;
    membership ??= memberships(node,cfg);
    return (await membership).get(type);
  },[]);
  return executeConversion(node,cfg,options.configPath ?? defaultConfigPath(),plan,options);
}

async function memberships(node:NodeClient,cfg:Config):Promise<Map<string,unknown>> {
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
    return [type,{kind:"directory",schema:directory.name,
      field:cfg.schemaFieldAliases?.[directoryPin]?.btd_types ?? "btd_types",
      range:"__types__",contains:type,expected_keys:state.count,
      count_guard:{schema:counter.name,key:{hash:type,range:null},
        field:cfg.schemaFieldAliases?.[countPin]?.bln_n ?? "bln_n",expected:raw ?? null}}];
  }));
}
