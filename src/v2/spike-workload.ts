// CI-only generated operational workload. Uses real Brain write paths and a
// real LastDB daemon; no mocks, fixture store, or alternate storage engine.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { newNodeClient, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { findBySlug, type FbrainRecord } from "../record.ts";
import { buildResidentWritePlan, commitResidentWritePlan } from "../resident-write-plan.ts";
import { UNIQUE_SCHEMAS, type RecordType } from "../schemas.ts";
import { BrainV2Store, rawData, recordKey, statusKey } from "./store.ts";
import { V2_RECORD_FIELDS, V2_SCHEMAS, type V2SchemaMap } from "./schemas.ts";

if (process.env.CI !== "true" || process.env.LASTDB_ISOLATED_COPY !== "1") throw new Error("Run this workload only in CI on a fresh generated home");
const [layout, phase, configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath || !["current", "v2"].includes(layout ?? "")) throw new Error("Usage: current|v2 phase config output");
const settings = JSON.parse(readFileSync(configPath, "utf8")) as { socket: string; records: number; bodyBytes: number };
let requests = 0;
const node: NodeClient = newNodeClient({ baseUrl: "http://127.0.0.1", userHash: "brain-v2-ci", socketPath: settings.socket,
  verbose: line => { if (line.startsWith("→")) requests++; } });
const cfg: Config = { configVersion: 4, nodeUrl: "http://127.0.0.1", schemaServiceUrl: "http://127.0.0.1:1",
  userHash: "brain-v2-ci", schemaHashes: Object.fromEntries(UNIQUE_SCHEMAS.map(entry => [entry.key, entry.schema.schema.name])),
  designSchemaHash: "Design", taskSchemaHash: "Task", nodeSocketPath: settings.socket, appIdentityEnforce: false };
const schemas = Object.fromEntries(Object.entries(V2_SCHEMAS).map(([key, schema]) => [key, schema.name])) as V2SchemaMap;
const store = new BrainV2Store(node, schemas);
const samples: Array<{ number: number; elapsed_ms: number; requests: number }> = [];
const digest = createHash("sha256");
const types: RecordType[] = ["concept", "reference"];

function input(number: number, updated = false): { type: RecordType; record: FbrainRecord } {
  const type = types[number % 2]!;
  const body = `${updated ? "Updated" : "Original"} content for record ${number}. ` + "A durable note about molecules and shared field values. ".repeat(Math.ceil(settings.bodyBytes / 54));
  const time = new Date(Date.UTC(2026, 0, 1) + number * 1000 + (updated ? 86_400_000 : 0)).toISOString();
  return { type, record: { slug: `record-${number}`, title: `Molecule design note ${number}`,
    body: body.slice(0, settings.bodyBytes), status: updated ? type === "concept" ? "parked" : "archived" : "active",
    tags: ["shared", `topic-${(number + (updated ? 1 : 0)) % 8}`],
    created_at: new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString(), updated_at: time } };
}

async function write(number: number, updated = false): Promise<void> {
  const { type, record } = input(number, updated);
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

async function verify(): Promise<Record<string, unknown>> {
  const expected = Array.from({ length: settings.records }, (_, number) => number).filter(number => number >= 16);
  const found = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < settings.records; offset += 100) {
    const numbers = Array.from({ length: Math.min(100, settings.records - offset) }, (_, i) => i + offset);
    if (!node.queryByKeys) throw new Error("Missing batch read support");
    if (layout === "v2") {
      const rows = await node.queryByKeys({ schemaHash: schemas.record, fields: V2_RECORD_FIELDS,
        keys: numbers.map(number => ({ hash: recordKey(input(number).type, `record-${number}`) })) });
      for (const row of rows) found.set(String(row.fields.slug), row.fields);
    } else {
      const batches = await Promise.all(types.map(type => node.queryByKeys!({ schemaHash: cfg.schemaHashes[type]!,
        fields: ["slug", "title", "body", "status", "tags", "created_at", "updated_at"],
        keys: numbers.filter(number => input(number).type === type).map(number => ({ hash: `record-${number}` })) })));
      for (const row of batches.flat()) found.set(String(row.fields.slug), row.fields);
    }
  }
  if (found.size !== expected.length) throw new Error(`Record membership differs: ${found.size} != ${expected.length}`);
  for (const number of expected) {
    const { record } = input(number, number < settings.records / 4);
    const actual = found.get(record.slug);
    for (const [field, value] of Object.entries(record)) {
      if (JSON.stringify(actual?.[field]) !== JSON.stringify(value)) throw new Error(`Stored value differs: ${record.slug}.${field}`);
    }
  }
  if (layout !== "v2") return { records_verified: found.size, limits: "Current list pages retain their existing concurrency and sample contract" };
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
  for (const type of types) {
    for (const status of ["active", type === "concept" ? "parked" : "archived"]) {
      const list = await store.list({ type, status, limit: 20 });
      if (!list.items.length) throw new Error(`V2 status list is empty: ${type}/${status}`);
    }
  }
  const tag = await store.list({ tag: "shared", limit: 20 });
  if (tag.items.length !== 20) throw new Error("V2 tag list is incomplete");
  const common = input(0).record;
  await store.put("concept", { ...common, slug: "same-slug", tags: [] });
  await store.put("reference", { ...common, slug: "same-slug", tags: [] });
  let ambiguous = false;
  try { await store.getUntyped("same-slug"); } catch (error) { ambiguous = String(error).includes("Specify a type"); }
  if (!ambiguous) throw new Error("V2 untyped get lost slug ambiguity");
  const previous = await store.get("concept", "same-slug");
  if (!previous) throw new Error("V2 collision record is absent");
  const contenders = await Promise.allSettled([0, 1].map(i => store.put("concept",
    { ...common, slug: "same-slug", title: `Concurrent edit ${i}`, tags: [], updated_at: new Date(Date.UTC(2026, 2, 1) + i).toISOString() }, previous)));
  if (contenders.filter(result => result.status === "fulfilled").length !== 1) throw new Error("V2 revision condition did not reject a concurrent edit");
  const deletion = input(2).record;
  await store.put("concept", { ...deletion, slug: "recreated", tags: ["new-only"] });
  await store.delete("concept", "recreated");
  if (await store.get("concept", "recreated")) throw new Error("V2 delete left the canonical record");
  const oldStatus = await store.list({ type: "concept", status: "active", limit: 100 });
  if (oldStatus.items.some(row => row.slug === "recreated")) throw new Error("V2 delete left a lookup member");
  await store.put("concept", { ...deletion, slug: "recreated", tags: ["new-only"] });
  if (!(await store.get("concept", "recreated"))) throw new Error("V2 recreation failed");
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.put("concept", { ...common, slug: `concurrent-${i}`, tags: [] })));
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => store.get("concept", `concurrent-${i}`)));
  if (concurrent.some(record => record === null)) throw new Error("V2 concurrent creates lost a record");
  return { records_verified: found.size, list_members_verified: ids.size, typed_status_and_tag_lists: true,
    duplicate_slugs: true, concurrent_revision_conflict: true, delete_and_recreate: true, concurrent_creates: 8,
    status_scope_example: statusKey("concept", "active") };
}

let verification: Record<string, unknown> | undefined;
if (phase === "setup") await setup();
else if (phase === "create") for (let number = 0; number < settings.records; number++) await write(number);
else if (phase === "update") for (let number = 0; number < settings.records / 4; number++) await write(number, true);
else if (phase === "delete") {
  for (let number = 0; number < 16; number++) {
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
