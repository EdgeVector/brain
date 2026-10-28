// CI operational benchmark against generated data in a real, isolated node.
// The source directory selects the retained baseline or the candidate code.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config.ts";
import type { FbrainRecord } from "../record.ts";
import type { RecordType } from "../schemas.ts";

if (process.env.CI !== "true" || process.env.LASTDB_ISOLATED_COPY !== "1") throw new Error("CI generated homes only");
const [layout, phase, settingsPath, outputPath] = process.argv.slice(2);
if (!settingsPath || !outputPath || !["current", "v2"].includes(layout ?? "")) throw new Error("Invalid read workload arguments");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const source = resolve(process.env.BRAIN_READ_SOURCE ?? ".");
const clientModule = await import(resolve(source, "src/client.ts"));
const records = await import(resolve(source, "src/record.ts"));
const definitions = await import(resolve(source, "src/schemas.ts"));
const v2Module = await import(resolve(source, "src/v2/store.ts"));
const v2Schemas = await import(resolve(source, "src/v2/schemas.ts"));
const [getCommand, listCommand, snapshotCommand, deleteCommand, searchCommand] = await Promise.all([
  "get", "list", "admin-snapshot", "delete", "search",
].map(name => import(resolve(source, `src/commands/${name}.ts`))));
let requests = 0, responseBytes = 0;
globalThis.fetch = new Proxy(globalThis.fetch, {
  async apply(target, receiver, args) {
    requests++;
    const response = await Reflect.apply(target, receiver, args);
    // Count bytes actually delivered to the caller, without a second body copy.
    const reader = response.body?.getReader();
    if (!reader) return response;
    const body = new ReadableStream({
      async pull(controller) {
        const part = await reader.read();
        if (part.done) controller.close();
        else { responseBytes += part.value.byteLength; controller.enqueue(part.value); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  },
});
const node = clientModule.newNodeClient({ baseUrl: "http://127.0.0.1", userHash: "brain-read-ci", socketPath: settings.socket });
const cfg: Config = { configVersion: 4, nodeUrl: "http://127.0.0.1", schemaServiceUrl: "http://127.0.0.1:1",
  userHash: "brain-read-ci", schemaHashes: Object.fromEntries(definitions.UNIQUE_SCHEMAS.map((entry: any) => [entry.key, entry.schema.schema.name])),
  designSchemaHash: "Design", taskSchemaHash: "Task", nodeSocketPath: settings.socket, appIdentityEnforce: false };
const schemas = Object.fromEntries(Object.entries(v2Schemas.V2_SCHEMAS).map(([key, schema]: [string, any]) => [key, schema.name]));
const store = new v2Module.BrainV2Store(node, schemas);
const types: RecordType[] = ["concept", "reference"];
const fields = ["slug", "title", "body", "status", "tags", "created_at", "updated_at"];
function input(number: number): { type: RecordType; record: FbrainRecord } {
  const type = types[number % 2]!;
  const time = new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString();
  return { type, record: { slug: `read-${number}`, title: `Molecule note ${number}`, body: `Record ${number}. ` + "molecule ".repeat(512),
    status: number % 4 === 0 ? "parked" : "active", tags: ["shared"], created_at: time, updated_at: time } };
}
async function setup(): Promise<void> {
  const declarations = layout === "v2" ? Object.values(v2Schemas.V2_SCHEMAS) : definitions.UNIQUE_SCHEMAS.map((entry: any) => entry.schema.schema);
  for (const definition of declarations as any[]) {
    const { owner_app_id: _owner, ...schema } = definition;
    await v2Module.rawData(node, "POST", "/api/schemas/seed-system", { isolated_copy: true, schema: { ...schema, source: "system_seed" } });
  }
  // Equal generated corpora, seeded with native mutation batches. Setup cost is
  // outside read timings; this does not replay or simulate any read response.
  let ops: any[] = [];
  const flush = async () => { if (ops.length) { await node.mutateBatch(ops, { durability: "durable" }); ops = []; } };
  const add = async (schemaHash: string, keyHash: string, value: Record<string, unknown>, keyRange?: string) => {
    ops.push({ mutationType: "create", schemaHash, keyHash, keyRange, fields: value });
    if (ops.length >= 100) await flush();
  };
  const scopes = new Map<string, any[]>();
  for (let number = settings.records - 1; number >= 0; number--) {
    const { type, record } = input(number);
    if (layout === "v2") {
      const id = v2Module.recordKey(type, record.slug), order = v2Module.orderKey(id, record.updated_at);
      await add(schemas.record!, id, { ...record, br2_id: id, br2_type: type, br2_scope: "brain", br2_status: v2Module.statusKey(type, record.status),
        br2_order: order, br2_revision: `seed-${number}` });
      await add(schemas.tag!, "shared", { bt2_tag: "shared", bt2_order: order, bt2_id: id }, order);
    } else {
      await add(cfg.schemaHashes[type]!, record.slug, record);
      const card = { type, slug: record.slug, title: record.title, status: record.status, updated_at: record.updated_at };
      for (const hash of ["all", type, `${type}#${record.status}`, "tag#shared"]) {
        const cards = scopes.get(hash) ?? []; cards.push(card); scopes.set(hash, cards);
      }
    }
  }
  if (layout === "current") {
    for (const [hash, cards] of scopes) {
      for (let offset = 0; offset < cards.length; offset += 20) {
        const range = offset === 0 ? "__head__" : `p${String(offset / 20).padStart(8, "0")}`;
        const older = offset + 20 < cards.length ? `p${String(offset / 20 + 1).padStart(8, "0")}` : "";
        await add(cfg.schemaHashes.__brainlistpage__!, hash,
          { blp_h: hash, blp_r: range, blp_page: JSON.stringify({ cards: cards.slice(offset, offset + 20), older, linked: true }) }, range);
      }
    }
    for (const type of ["all", ...definitions.RECORD_TYPES]) {
      await add(cfg.schemaHashes.__brainlistcount__!, type, { bln_h: type, bln_n: String(type === "all" ? settings.records : types.includes(type) ? settings.records / 2 : 0) });
    }
    const cards = Array.from({ length: 25 }, (_, i) => { const { type, record } = input(settings.records - i - 1); return { type, slug: record.slug, weight: 1 }; });
    await add(cfg.schemaHashes.__brainlistpage__!, "kw#molecule", { blp_h: "kw#molecule", blp_r: "__head__", blp_page: JSON.stringify({ cards }) }, "__head__");
  }
  await flush();
}

async function* v2Pages(options: Record<string, unknown> = {}, full = false): AsyncGenerator<any[]> {
  if (store.pages) {
    for await (const page of store.pages({ ...options, fields: full ? v2Schemas.V2_RECORD_FIELDS : v2Schemas.V2_SUMMARY_FIELDS })) yield page.items;
    return;
  }
  // Baseline uses the existing public page API, followed by a body batch only
  // when the operation explicitly requests whole records.
  let cursor: unknown;
  const seen = new Set<string>();
  for (let page = 0; page <= settings.records; page++) {
    const result = await store.list({ ...options, limit: 100, cursor });
    if (full && result.items.length) {
      const rows = await node.queryByKeys({ schemaHash: schemas.record, fields: v2Schemas.V2_RECORD_FIELDS,
        keys: result.items.map((item: any) => ({ hash: item.br2_id })) });
      yield rows.map((row: any) => row.fields);
    } else yield result.items;
    if (!result.hasMore) return;
    const token = JSON.stringify(result.cursor);
    if (!result.cursor || seen.has(token)) throw new Error("Baseline V2 continuation stalled");
    seen.add(token); cursor = result.cursor;
  }
  throw new Error("Baseline V2 continuation exceeded its bound");
}
function check(items: any[], expected: number, full = false): number {
  const ids = new Set(items.map(item => `${item.br2_type ?? item.type ?? ""}:${item.slug}`));
  if (items.length !== expected || ids.size !== expected) throw new Error(`Incomplete result: ${items.length}/${ids.size}, expected ${expected}`);
  for (const item of items) {
    const number = Number(String(item.slug).slice(5));
    const { record } = input(number);
    for (const field of full ? fields : ["slug", "title", "status", "updated_at"]) {
      const actual = item[field] ?? (field === "updated_at" ? item.updatedAt : undefined);
      if (JSON.stringify(actual) !== JSON.stringify(record[field])) throw new Error(`Value mismatch ${record.slug}.${field}`);
    }
  }
  return items.length;
}
async function operation(name: string): Promise<number> {
  if (name === "get") {
    if (layout === "v2") return check([await store.get("concept", "read-0")], 1, true);
    let result: any;
    await getCommand!.getRecord({ cfg, type: "concept", slug: "read-0", json: true, print: () => {}, onResult: (value: any) => { result = value; } });
    return check([result], 1, true);
  }
  if (name === "first_page") {
    if (layout === "v2") return check((await store.list({ type: "concept", limit: 20 })).items, 20);
    let result: any;
    await listCommand!.listCmd({ cfg, type: "concept", limit: 20, json: true, print: () => {}, printErr: () => {}, onResult: (value: any) => { result = value; } });
    return check(result.items, 20);
  }
  if (name === "all_summaries" || name === "all_records") {
    const full = name === "all_records", items: any[] = [];
    if (layout === "v2") for await (const page of v2Pages({}, full)) items.push(...page);
    else {
      for (const type of types) {
        const found = await records.listRecords(node, type, cfg, full ? { onMissing: "throw" } : { summary: true });
        items.push(...found);
      }
    }
    return check(items, settings.records, full);
  }
  if (name === "migration_read") {
    if (layout === "v2") { const items: any[] = []; for await (const page of v2Pages({ type: "concept" }, true)) items.push(...page); return check(items, settings.records / 2, true); }
    return check(await records.listRecordsAdminScan(node, "concept", cfg.schemaHashes.concept), settings.records / 2, true);
  }
  if (name === "snapshot_counts") {
    if (layout === "v2") { let count = 0; for await (const page of v2Pages()) count += page.length; if (count !== settings.records) throw new Error("V2 count incomplete"); return count; }
    const snapshot = await snapshotCommand!.buildBrainAdminSnapshot(node, cfg);
    if (snapshot.unavailable_types.length || snapshot.type_counts.concept !== settings.records / 2 || snapshot.type_counts.reference !== settings.records / 2) throw new Error("Snapshot counts incomplete");
    return settings.records;
  }
  if (name === "bulk_selection") {
    if (layout === "v2") { const items: any[] = []; for await (const page of v2Pages({ type: "concept", status: "parked" })) items.push(...page); return check(items, settings.records / 4); }
    let result: any;
    await deleteCommand!.deleteByFilter({ cfg, type: "concept", status: "parked", yes: false, print: () => {}, onResult: (value: any) => { result = value; } });
    if (!result.ok || result.deleted.length !== settings.records / 4) throw new Error("Bulk selection incomplete");
    return result.deleted.length;
  }
  if (name === "search_fallback") {
    if (layout === "v2") return -1; // V2 has no search adapter; do not invent one for a comparison.
    let result: any;
    await searchCommand!.searchCmd({ cfg, query: "molecule", limit: 20, json: true, print: () => {}, printErr: () => {}, onResult: (value: any) => { result = value; } });
    if (result.length !== 20) throw new Error("Keyword search page incomplete");
    return result.length;
  }
  throw new Error(`Unknown operation ${name}`);
}
const samples: any[] = [];
if (phase === "setup") await setup();
else {
  for (let sample = 0; sample < settings.samples; sample++) {
    const before = requests, bytes = responseBytes, start = performance.now();
    try {
      const count = await operation(phase!);
      samples.push({ elapsed_ms: performance.now() - start, requests: requests - before, response_bytes: responseBytes - bytes, count, verified: true });
    } catch (error) {
      if (process.env.BRAIN_READ_VERSION !== "before" || !String(error).includes("[read_resource_limit]")) throw error;
      // A broken baseline is a measured failure, never a successful latency.
      samples.push({ elapsed_ms: performance.now() - start, requests: requests - before, response_bytes: responseBytes - bytes,
        verified: false, error: String(error).slice(0, 1000) });
    }
  }
}
writeFileSync(outputPath, JSON.stringify({ layout, phase, source, records: settings.records,
  input_sha256: createHash("sha256").update(JSON.stringify(Array.from({ length: settings.records }, (_, i) => input(i)))).digest("hex"), samples }, null, 2) + "\n");
