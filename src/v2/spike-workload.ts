// CI-only generated operational workload. Uses real Brain write paths and a
// real LastDB daemon; no mocks, fixture store, or alternate storage engine.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import type { FbrainRecord } from "../record.ts";
import type { RecordType } from "../schemas.ts";
import type { V2SchemaMap } from "./schemas.ts";
import { verifyQueryFormats, summaryPatchOperations, verifyPartialAfterRestart, verifySummaryPageLifecycle } from "./shared-operations.ts";

const source = resolve(process.env.BRAIN_SPIKE_SOURCE ?? ".");
const { newNodeClient } = await import(resolve(source, "src/client.ts"));
const { findBySlug } = await import(resolve(source, "src/record.ts"));
const { buildResidentWritePlan, commitResidentWritePlan } = await import(resolve(source, "src/resident-write-plan.ts"));
const { UNIQUE_SCHEMAS } = await import(resolve(source, "src/schemas.ts"));
const { BrainV2Store, rawData, statusKey, recordKey, decodeV2Record } = await import(resolve(source, "src/v2/store.ts"));
const { V2_SCHEMAS } = await import(resolve(source, "src/v2/schemas.ts"));
const paged = process.env.BRAIN_SHARED_READS === "1" && existsSync(resolve(source, "src/v2/paged.ts"))
  ? await import(resolve(source, "src/v2/paged.ts")) : null;
const activeSchemas = paged?.PAGED_SCHEMAS ?? V2_SCHEMAS;

if (process.env.CI !== "true" || process.env.LASTDB_ISOLATED_COPY !== "1") throw new Error("Run this workload only in CI on a fresh generated home");
const [layout, phase, configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath || !["current", "v2"].includes(layout ?? "")) throw new Error("Usage: current|v2 phase config output");
const settings = JSON.parse(readFileSync(configPath, "utf8")) as { socket: string; records: number; bodyBytes: number };
let requests = 0;
let lastNodeRefusal = "";
// Count the actual I/O boundary, including clients constructed by commands.
// Every call still reaches the native fetch; no response or transport is mocked.
globalThis.fetch = new Proxy(globalThis.fetch, {
  async apply(target, receiver, argumentsList) {
    requests++;
    const response = await Reflect.apply(target, receiver, argumentsList);
    if (response.status >= 400) {
      lastNodeRefusal = (await response.clone().text()).slice(0, 2000);
      console.error("CI node refusal", response.status, lastNodeRefusal);
    }
    return response;
  },
});
const node: NodeClient = newNodeClient({ baseUrl: "http://127.0.0.1", userHash: "brain-v2-ci", socketPath: settings.socket });
const cfg: Config = { configVersion: 4, nodeUrl: "http://127.0.0.1", schemaServiceUrl: "http://127.0.0.1:1",
  userHash: "brain-v2-ci", schemaHashes: Object.fromEntries(UNIQUE_SCHEMAS.map((entry: any) => [entry.key, entry.schema.schema.name])),
  designSchemaHash: "Design", taskSchemaHash: "Task", nodeSocketPath: settings.socket, appIdentityEnforce: false };
const schemas = Object.fromEntries(Object.entries(activeSchemas).map(([key, schema]: [string, any]) => [key, schema.name])) as V2SchemaMap;
const nativeReads = process.env.BRAIN_SHARED_READS === "1";
const store = paged ? new paged.PagedBrainV2Store(node, schemas) : new BrainV2Store(node, schemas, { nativeReads });
const samples: Array<{ number: number; elapsed_ms: number; requests: number }> = [];
const digest = createHash("sha256");
const types: RecordType[] = ["concept", "reference"];

function input(number: number, updated = false, revision = 1): { type: RecordType; record: FbrainRecord } {
  const type = types[number % 2]!;
  const body = `${updated ? `Updated revision ${revision}` : "Original"} content for record ${number}. ` + "A durable note about molecules and shared field values. ".repeat(Math.ceil(settings.bodyBytes / 54));
  const time = new Date(Date.UTC(2026, 0, 1) + number * 1000 + (updated ? 86_400_000 * revision : 0)).toISOString();
  return { type, record: { slug: `record-${number}`, title: `Molecule design note ${number}`,
    body: body.slice(0, settings.bodyBytes), status: updated ? type === "concept" ? "parked" : "archived" : "active",
    tags: ["shared", `topic-${(number + (updated ? 1 : 0)) % 8}`],
    created_at: new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString(), updated_at: time } };
}

async function write(number: number, updated = false, revision = 1): Promise<void> {
  const { type, record } = input(number, updated, revision);
  digest.update(JSON.stringify([type, record]));
  const started = performance.now(), before = requests;
  if (layout === "v2") await store.put(type, record);
  else {
    const schemaHash = cfg.schemaHashes[type]!;
    const previous = await findBySlug(node, type, schemaHash, record.slug, cfg);
    const plan = await buildResidentWritePlan({ node, cfg, type, schemaHash, previous, next: record, primaryFields: record, now: record.updated_at });
    await commitResidentWritePlan({ node, plan, type, slug: record.slug, durable: true });
  }
  samples.push({ number, elapsed_ms: performance.now() - started, requests: requests - before });
}

async function setup(): Promise<void> {
  const definitions = layout === "v2" ? Object.values(activeSchemas) : UNIQUE_SCHEMAS.map((entry: any) => entry.schema.schema);
  // CI system roots are local to this fresh generated home. Production app
  // registration and declaration-issued identities remain a rollout task.
  for (const definition of definitions) {
    const { owner_app_id: _owner, ...schema } = definition;
    await rawData(node, "POST", "/api/schemas/seed-system", { isolated_copy: true, schema: { ...schema, source: "system_seed" } });
  }
}

async function proteinBinding(field = "br2_id"): Promise<{ identity: string; members: number }> {
  const layouts = paged ? ["record", "recent", "type", "status"] : field === "br2_id" ? ["record", "recent", "type", "status", "count"] : ["record", "recent", "type", "status"];
  const molecules = await Promise.all(layouts.map(async layout => {
    const name = schemas[layout as keyof V2SchemaMap];
    const metadata = await rawData(node, "GET", `/api/schema/${encodeURIComponent(name)}`);
    const definition = metadata.schema?.schema ?? metadata.schema;
    if (!definition?.name) throw new Error("Schema metadata has no canonical name");
    if (definition.field_molecule_uuids?.[field]) return String(definition.field_molecule_uuids[field]);
    const digest = createHash("sha256");
    for (const part of ["lastdb:molecule-uuid:v1", String(definition.name), field]) {
      const bytes = Buffer.from(part), length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      digest.update(length).update(bytes);
    }
    return digest.digest("base64url");
  }));
  const bindings = await Promise.all(molecules.map(molecule => rawData(node, "GET", `/api/protein/of-molecule/${molecule}`)));
  const identity = bindings[0]?.protein_uuid;
  if (typeof identity !== "string" || bindings.some(binding => binding.protein_uuid !== identity)) throw new Error("The native layouts do not share one identity protein");
  const protein = await rawData(node, "GET", `/api/protein/${identity}`);
  const members = new Set((protein.members as Array<{ molecule_uuid: string }>).map(member => member.molecule_uuid));
  if (molecules.some(molecule => !members.has(molecule))) throw new Error("The protein lacks a native lookup member");
  return { identity, members: members.size };
}

async function verify(): Promise<Record<string, unknown>> {
  const expected = Array.from({ length: settings.records - 8 }, (_, number) => number);
  const found = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < settings.records; offset += 100) {
    const numbers = Array.from({ length: Math.min(100, settings.records - offset) }, (_, i) => i + offset);
    if (!node.queryByKeys) throw new Error("Missing batch read support");
    if (layout === "v2") {
      const rows = await store.getMany(numbers.map(number => ({ type: input(number).type, slug: `record-${number}` })));
      for (const row of rows) found.set(row.slug, row);
    } else {
      const batches = await Promise.all(types.map(type => node.queryByKeys!({ schemaHash: cfg.schemaHashes[type]!,
        fields: ["slug", "title", "body", "status", "tags", "created_at", "updated_at"],
        keys: numbers.filter(number => input(number).type === type).map(number => ({ hash: `record-${number}` })) })));
      for (const row of batches.flat()) found.set(String(row.fields.slug), row.fields);
    }
  }
  if (found.size !== expected.length) throw new Error(`Record membership differs: ${found.size} != ${expected.length}`);
  for (const number of expected) {
    const { record } = input(number, number >= settings.records - 16, settings.records / 64);
    const actual = found.get(record.slug);
    for (const [field, value] of Object.entries(record)) {
      if (JSON.stringify(actual?.[field]) !== JSON.stringify(value)) throw new Error(`Stored value differs: ${record.slug}.${field}`);
    }
  }
  if (layout !== "v2") {
    let olderUpdate: string | null = null;
    try { await write(16, true); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "list_membership_unproven") throw error;
      olderUpdate = String(error.code);
    }
    return { records_verified: found.size, older_record_update: olderUpdate ?? "accepted",
      limits: "Recent-update latency is paired. The older-record attempt is a separate operational result." };
  }
  const ids = new Set<string>();
  let cursor: unknown;
  for (let page = 0; page < Math.ceil(settings.records / 100) + 2; page++) {
    const result = await store.list({ limit: 100, cursor });
    for (const record of result.items) {
      const id = String(record.br2_id);
      if (ids.has(id)) throw new Error("V2 continuation repeats an identity");
      ids.add(id);
    }
    if (!result.hasMore) break;
    if (!result.cursor) throw new Error("V2 continuation is absent");
    cursor = result.cursor;
  }
  if (ids.size !== found.size) throw new Error(`V2 list membership differs: ${ids.size} != ${found.size}`);
  const initialCounts = await store.counts();
  if (initialCounts.total !== found.size || initialCounts.types.concept !== found.size / 2 || initialCounts.types.reference !== found.size / 2) throw new Error("V2 counts differ after deletes");
  for (const type of types) {
    for (const status of ["active", type === "concept" ? "parked" : "archived"]) {
      const list = await store.list({ type, status, limit: 20 });
      if (!list.items.length) throw new Error(`V2 status list is empty: ${type}/${status}`);
    }
  }
  const tag = await store.list({ tag: "shared", limit: 20 });
  if (tag.items.length !== 20) throw new Error("V2 tag list is incomplete");
  for (const status of [undefined, "parked"]) {
    const mixed = await store.list({ tag: "shared", type: "concept", ...(status ? { status } : {}), limit: 100 });
    if (!mixed.items.length || mixed.items.some((r: any) => r.br2_type !== "concept" || !r.tags.includes("shared")
        || (status && r.status !== status))) throw new Error("Mixed tag/type/status selection differs");
  }
  let olderResult = "accepted";
  const priorOlder = await store.get("concept", "record-16");
  try { await write(16, true); }
  catch (error) {
    if (process.env.BRAIN_PROFILE_BASELINE !== "1" || !lastNodeRefusal.includes("the typed molecule has no admitted range profile")) throw error;
    const unchanged = await store.get("concept", "record-16");
    if (!priorOlder || !unchanged || Object.entries(priorOlder).some(([field, value]) => JSON.stringify(value) !== JSON.stringify(unchanged[field]))) throw new Error("Baseline profile refusal changed its source record");
    const peers = [["recent", priorOlder.br2_scope, priorOlder.br2_order], ["type", priorOlder.br2_type, priorOlder.br2_order],
      ["status", priorOlder.br2_status, priorOlder.br2_order], ["count", priorOlder.br2_count_hash, priorOlder.br2_id],
      ...priorOlder.tags.map((tag: string) => ["tag", tag, priorOlder.br2_order])];
    await Promise.all(peers.map(async ([layout, hash, range]: string[]) => {
      const page = await rawData(node, "POST", "/api/query", { schema_name: schemas[layout as keyof V2SchemaMap],
        fields: [layout === "tag" ? "bt2_id" : "br2_id"], filter: { HashRangeKey: { hash, range } }, limit: 1 });
      if (page.unresolved_rows !== 0 || page.tombstoned_rows !== 0 || page.results.length !== 1
          || page.results[0].fields[layout === "tag" ? "bt2_id" : "br2_id"] !== priorOlder.br2_id) throw new Error("Baseline profile refusal changed its membership");
    }));
    olderResult = "failed: missing molecule range profile after restart; source and memberships unchanged";
  }
  const older = await store.get("concept", "record-16");
  if (olderResult === "accepted" && (!older || older.status !== "parked")) throw new Error("V2 older-record update failed");
  const common = input(0).record;
  await store.put("concept", { ...common, slug: "same-slug", tags: [] });
  await store.put("reference", { ...common, slug: "same-slug", tags: [] });
  let ambiguous = false;
  try { await store.getUntyped("same-slug"); } catch (error) { ambiguous = String(error).includes("Specify a type"); }
  if (!ambiguous) throw new Error("V2 untyped get lost slug ambiguity");
  const previous = await store.get("concept", "same-slug");
  if (!previous) throw new Error("V2 collision record is absent");
  const partial = await store.patch("concept", "same-slug", { title: "Partial title update", updated_at: "2026-02-01T00:00:00.000Z" });
  if (partial.body !== previous.body || JSON.stringify(partial.tags) !== JSON.stringify(previous.tags)) throw new Error("V2 partial update lost unchanged fields");
  const contenders = await Promise.allSettled([0, 1].map(i => store.put("concept",
    { ...common, slug: "same-slug", title: `Concurrent edit ${i}`, tags: [], updated_at: new Date(Date.UTC(2026, 2, 1) + i).toISOString() }, partial)));
  if (contenders.filter(result => result.status === "fulfilled").length !== 1) throw new Error("V2 revision condition did not reject a concurrent edit");
  const deletion = input(2).record;
  const removed = await store.put("concept", { ...deletion, slug: "recreated", tags: ["new-only"] });
  await store.delete("concept", "recreated");
  if (await store.get("concept", "recreated")) throw new Error("V2 delete left the canonical record");
  for (const [layout, hash] of (paged ? [["recent", removed.br2_scope], ["type", removed.br2_type], ["status", removed.br2_status], ["tag", "new-only"]]
    : [["recent", removed.br2_scope], ["type", removed.br2_type], ["status", removed.br2_status], ["tag", "new-only"]]) as Array<[keyof V2SchemaMap, string]>) {
    const result = await rawData(node, "POST", "/api/query", { schema_name: schemas[layout], fields: [layout === "tag" ? "bt2_id" : paged ? "br2_id" : "br2_card"],
      filter: { HashRangeKey: { hash, range: removed.br2_order } }, limit: 1 });
    if ((result.results ?? result.rows)?.length !== 0) throw new Error(`V2 delete left the exact ${layout} key`);
  }
  if (!paged) {
    const countKey = await rawData(node, "POST", "/api/query", { schema_name: schemas.count, fields: ["br2_id"],
      filter: { HashRangeKey: { hash: removed.br2_count_hash, range: removed.br2_id } }, limit: 1 });
    if (countKey.results?.length !== 0) throw new Error("V2 delete left the exact count key");
  }
  await store.put("concept", { ...deletion, slug: "recreated", tags: ["new-only"] });
  if (!(await store.get("concept", "recreated"))) throw new Error("V2 recreation failed");
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.put("concept", { ...common, slug: `concurrent-${i}`, tags: [] })));
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => store.get("concept", `concurrent-${i}`)));
  if (concurrent.some(record => record === null)) throw new Error("V2 concurrent creates lost a record");
  if ((await store.counts()).total !== settings.records + 3) throw new Error("V2 count differs after recreation and concurrent creates");
  const pageLifecycle = await verifySummaryPageLifecycle(store, common);
  const queryFormats = nativeReads ? await verifyQueryFormats(node, schemas, settings.records + 3, !!paged) : undefined;
  return { records_verified: found.size, list_members_verified: ids.size, typed_status_and_tag_lists: true,
    duplicate_slugs: true, partial_update: true, concurrent_revision_conflict: true, delete_and_recreate: true, concurrent_creates: 8,
    identity_protein: await proteinBinding(),
    summary_protein: paged ? "canonical summary pages; no per-record summary copies" : await proteinBinding("br2_card"), content_protein: await proteinBinding("br2_content"),
    older_record_update: olderResult, status_scope_example: statusKey("concept", "active"), query_formats: queryFormats, summary_page_lifecycle: pageLifecycle };
}

let verification: Record<string, unknown> | undefined;
if (phase === "setup") await setup();
else if (phase === "create") for (let number = 0; number < settings.records; number++) await write(number);
else if (phase === "update") {
  for (let operation = 0; operation < settings.records / 4; operation++) {
    await write(settings.records - 16 + operation % 16, true, Math.floor(operation / 16) + 1);
  }
}
else if (phase === "delete") {
  for (let number = settings.records - 8; number < settings.records; number++) {
    const { type, record } = input(number, true), started = performance.now(), before = requests;
    digest.update(JSON.stringify([type, record.slug]));
    if (layout === "v2") await store.delete(type, record.slug);
    else {
    const { deleteRecord } = await import(resolve(source, "src/commands/delete.ts"));
      await deleteRecord({ cfg, type, slug: record.slug, print: () => {} });
    }
    samples.push({ number, elapsed_ms: performance.now() - started, requests: requests - before });
  }
} else if (phase === "verify") verification = await verify();
else if (phase === "partial") {
  const result = await summaryPatchOperations({ node, store, schemas, cfg, layout: layout!, records: settings.records,
    nativeReads, requests: () => requests, findBySlug, buildResidentWritePlan, commitResidentWritePlan, recordKey, decodeV2Record });
  samples.push(...result.samples); verification = result.verification;
}
else if (phase === "reopen_partial") {
  const proof = JSON.parse(readFileSync(resolve(dirname(outputPath), "partial.json"), "utf8")).verification;
  verification = await verifyPartialAfterRestart(node, layout!, schemas, cfg, settings.records, proof, { key: recordKey, decode: decodeV2Record }, store);
}
else throw new Error(`Unknown spike phase: ${phase}`);
writeFileSync(outputPath, JSON.stringify({ layout, phase, requests, input_sha256: digest.digest("hex"), samples, verification }, null, 2) + "\n");
