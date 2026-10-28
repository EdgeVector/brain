// CI-only generated operational workload. Uses real Brain write paths and a
// real LastDB daemon; no mocks, fixture store, or alternate storage engine.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { newNodeClient, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { findBySlug, type FbrainRecord } from "../record.ts";
import { buildResidentWritePlan, commitResidentWritePlan } from "../resident-write-plan.ts";
import { UNIQUE_SCHEMAS, type RecordType } from "../schemas.ts";
import { BrainV2Store, rawData, statusKey } from "./store.ts";
import { V2_SCHEMAS, type V2SchemaMap } from "./schemas.ts";

if (process.env.CI !== "true" || process.env.LASTDB_ISOLATED_COPY !== "1") throw new Error("Run this workload only in CI on a fresh generated home");
const [layout, phase, configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath || !["current", "v2"].includes(layout ?? "")) throw new Error("Usage: current|v2 phase config output");
const settings = JSON.parse(readFileSync(configPath, "utf8")) as { socket: string; records: number; bodyBytes: number };
let requests = 0;
// Count the actual I/O boundary, including clients constructed by commands.
// Every call still reaches the native fetch; no response or transport is mocked.
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, receiver, argumentsList) {
    requests++;
    return Reflect.apply(target, receiver, argumentsList);
  },
});
const node: NodeClient = newNodeClient({ baseUrl: "http://127.0.0.1", userHash: "brain-v2-ci", socketPath: settings.socket });
const cfg: Config = { configVersion: 4, nodeUrl: "http://127.0.0.1", schemaServiceUrl: "http://127.0.0.1:1",
  userHash: "brain-v2-ci", schemaHashes: Object.fromEntries(UNIQUE_SCHEMAS.map(entry => [entry.key, entry.schema.schema.name])),
  designSchemaHash: "Design", taskSchemaHash: "Task", nodeSocketPath: settings.socket, appIdentityEnforce: false };
const schemas = Object.fromEntries(Object.entries(V2_SCHEMAS).map(([key, schema]) => [key, schema.name])) as V2SchemaMap;
const store = new BrainV2Store(node, schemas);
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
  const definitions = layout === "v2" ? Object.values(V2_SCHEMAS) : UNIQUE_SCHEMAS.map(entry => entry.schema.schema);
  // CI system roots are local to this fresh generated home. Production app
  // registration and declaration-issued identities remain a rollout task.
  for (const definition of definitions) {
    const { owner_app_id: _owner, ...schema } = definition;
    await rawData(node, "POST", "/api/schemas/seed-system", { isolated_copy: true, schema: { ...schema, source: "system_seed" } });
  }
}

async function proteinBinding(field = "br2_id"): Promise<{ identity: string; members: number }> {
  const layouts = field === "br2_id" ? ["record", "recent", "type", "status", "count"] : ["record", "recent", "type", "status"];
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
  if (initialCounts.total !== found.size || initialCounts.types.concept !== found.size / 2 || initialCounts.types.reference !== found.size / 2) throw new Error("V2 native counts differ after deletes");
  for (const type of types) {
    for (const status of ["active", type === "concept" ? "parked" : "archived"]) {
      const list = await store.list({ type, status, limit: 20 });
      if (!list.items.length) throw new Error(`V2 status list is empty: ${type}/${status}`);
    }
  }
  const tag = await store.list({ tag: "shared", limit: 20 });
  if (tag.items.length !== 20) throw new Error("V2 tag list is incomplete");
  await write(16, true);
  const older = await store.get("concept", "record-16");
  if (!older || older.status !== "parked") throw new Error("V2 older-record update failed");
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
  for (const [layout, hash] of [["recent", removed.br2_scope], ["type", removed.br2_type], ["status", removed.br2_status], ["tag", "new-only"]] as const) {
    const result = await rawData(node, "POST", "/api/query", { schema_name: schemas[layout], fields: [layout === "tag" ? "bt2_id" : "br2_id"],
      filter: { HashRangeKey: { hash, range: removed.br2_order } }, limit: 1 });
    if ((result.results ?? result.rows)?.length !== 0) throw new Error(`V2 delete left the exact ${layout} key`);
  }
  const countKey = await rawData(node, "POST", "/api/query", { schema_name: schemas.count, fields: ["br2_id"],
    filter: { HashRangeKey: { hash: removed.br2_count_hash, range: removed.br2_id } }, limit: 1 });
  if (countKey.results?.length !== 0) throw new Error("V2 delete left the exact count key");
  await store.put("concept", { ...deletion, slug: "recreated", tags: ["new-only"] });
  if (!(await store.get("concept", "recreated"))) throw new Error("V2 recreation failed");
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.put("concept", { ...common, slug: `concurrent-${i}`, tags: [] })));
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => store.get("concept", `concurrent-${i}`)));
  if (concurrent.some(record => record === null)) throw new Error("V2 concurrent creates lost a record");
  if ((await store.counts()).total !== settings.records + 3) throw new Error("V2 native count differs after recreation and concurrent creates");
  return { records_verified: found.size, list_members_verified: ids.size, typed_status_and_tag_lists: true,
    duplicate_slugs: true, partial_update: true, concurrent_revision_conflict: true, delete_and_recreate: true, concurrent_creates: 8,
    identity_protein: await proteinBinding(),
    summary_protein: await proteinBinding("br2_card"), content_protein: await proteinBinding("br2_content"),
    older_record_update: "accepted", status_scope_example: statusKey("concept", "active") };
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
      const { deleteRecord } = await import("../commands/delete.ts");
      await deleteRecord({ cfg, type, slug: record.slug, print: () => {} });
    }
    samples.push({ number, elapsed_ms: performance.now() - started, requests: requests - before });
  }
} else if (phase === "verify") verification = await verify();
else throw new Error(`Unknown spike phase: ${phase}`);
writeFileSync(outputPath, JSON.stringify({ layout, phase, requests, input_sha256: digest.digest("hex"), samples, verification }, null, 2) + "\n");
