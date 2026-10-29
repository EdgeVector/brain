// CI operational benchmark against generated data in a real, isolated node.
// The source directory selects the retained baseline or the candidate code.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const paged = process.env.BRAIN_SHARED_READS === "1" && existsSync(resolve(source, "src/v2/paged.ts"))
  ? await import(resolve(source, "src/v2/paged.ts")) : null;
const activeSchemas = paged?.PAGED_SCHEMAS ?? v2Schemas.V2_SCHEMAS;
const [getCommand, listCommand, snapshotCommand, deleteCommand, searchCommand] = await Promise.all([
  "get", "list", "admin-snapshot", "delete", "search",
].map(name => import(resolve(source, `src/commands/${name}.ts`))));
let requests = 0, responseBytes = 0;
let profile = new Map<string, { requests: number; elapsed_sum_ms: number; max_ms: number; response_bytes: number }>();
globalThis.fetch = new Proxy(globalThis.fetch, {
  async apply(target, receiver, args) {
    requests++;
    const start = performance.now();
    const request = typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : {};
    const label = JSON.stringify({ path: String(args[0]).split("?")[0], schema: request.schema_name,
      fields: request.fields, filter: Object.keys(request.filter ?? {})[0], sort_order: request.sort_order,
      response_format: request.response_format,
      batch: request.queries?.map((query: any) => ({ schema: query.schema_name, fields: query.fields,
        filter: Object.keys(query.filter ?? {})[0], response_format: query.response_format })) });
    const captured = profile;
    let bytes = 0;
    const response = await Reflect.apply(target, receiver, args);
    // Count bytes actually delivered to the caller, without a second body copy.
    const reader = response.body?.getReader();
    if (!reader) return response;
    const body = new ReadableStream({
      async pull(controller) {
        const part = await reader.read();
        if (part.done) {
          const elapsed = performance.now() - start;
          const aggregate = captured.get(label) ?? { requests: 0, elapsed_sum_ms: 0, max_ms: 0, response_bytes: 0 };
          aggregate.requests++; aggregate.elapsed_sum_ms += elapsed; aggregate.max_ms = Math.max(aggregate.max_ms, elapsed); aggregate.response_bytes += bytes;
          captured.set(label, aggregate); controller.close();
        } else { bytes += part.value.byteLength; responseBytes += part.value.byteLength; controller.enqueue(part.value); }
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
const schemas = Object.fromEntries(Object.entries(activeSchemas).map(([key, schema]: [string, any]) => [key, schema.name]));
const store = paged ? new paged.PagedBrainV2Store(node, schemas) : new v2Module.BrainV2Store(node, schemas, { nativeReads: process.env.BRAIN_SHARED_READS === "1" });
const types: RecordType[] = ["concept", "reference"];
const fields = ["slug", "title", "body", "status", "tags", "created_at", "updated_at"];
function input(number: number): { type: RecordType; record: FbrainRecord } {
  const type = types[number % 2]!;
  const time = new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString();
  return { type, record: { slug: `read-${number}`, title: `Molecule note ${number}`, body: `Record ${number}. ` + "molecule ".repeat(512),
    status: number % 4 === 0 ? "parked" : "active", tags: ["shared"], created_at: time, updated_at: time } };
}
async function setup(): Promise<void> {
  const declarations = layout === "v2" ? Object.values(activeSchemas) : definitions.UNIQUE_SCHEMAS.map((entry: any) => entry.schema.schema);
  for (const definition of declarations as any[]) {
    const { owner_app_id: _owner, ...schema } = definition;
    await v2Module.rawData(node, "POST", "/api/schemas/seed-system", { isolated_copy: true, schema: { ...schema, source: "system_seed" } });
  }
  if (layout === "v2" && paged) {
    const { seedPaged } = await import(resolve(source, "src/v2/paged-seed.ts"));
    await seedPaged(node, schemas, Array.from({ length: settings.records }, (_, number) => input(number)));
    return;
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
      const logical = { ...record, br2_id: id, br2_type: type, br2_scope: "brain", br2_status: v2Module.statusKey(type, record.status),
        br2_order: order, br2_revision: `seed-${number}` };
      await add(schemas.record!, id, v2Module.encodeV2Record ? v2Module.encodeV2Record(logical) : logical);
      await add(schemas.tag!, "shared", { bt2_tag: "shared", bt2_order: order, bt2_id: id }, order);
    } else {
      await add(cfg.schemaHashes[type]!, record.slug, record);
      if (settings.extended) await add(cfg.schemaHashes.__braintypedirectory__!, record.slug,
        { btd_h: record.slug, btd_r: "__types__", btd_types: JSON.stringify([type]) }, "__types__");
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
    for await (const page of store.pages({ ...options, fields: full ? ["br2_id", "br2_type", ...fields] : v2Schemas.V2_SUMMARY_FIELDS })) yield page.items;
    return;
  }
  // Baseline uses the existing public page API, followed by a body batch only
  // when the operation explicitly requests whole records.
  let cursor: unknown;
  const seen = new Set<string>();
  for (let page = 0; page <= settings.records; page++) {
    const result = await store.list({ ...options, limit: 100, cursor });
    if (full && result.items.length) {
      const rows = await node.queryByKeys({ schemaHash: schemas.record, fields: ["br2_id", "br2_type", ...fields],
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
let verificationChecks: Array<() => void> = [];
function check(items: any[], expected: number, full = false, allowed: (number: number) => boolean = () => true): number {
  verificationChecks.push(() => {
  const ids = new Set(items.map(item => `${item.br2_type ?? item.type ?? ""}:${item.slug}`));
  if (items.length !== expected || ids.size !== expected) throw new Error(`Incomplete result: ${items.length}/${ids.size}, expected ${expected}`);
  for (const item of items) {
    const number = Number(String(item.slug).slice(5));
    if (!Number.isInteger(number) || number < 0 || number >= settings.records || !allowed(number)) throw new Error(`Unexpected identity ${item.slug}`);
    const { record } = input(number);
    for (const field of full ? fields : ["slug", "title", "status", "updated_at"]) {
      const actual = item[field] ?? (field === "updated_at" ? item.updatedAt : undefined);
      if (JSON.stringify(actual) !== JSON.stringify(record[field])) throw new Error(`Value mismatch ${record.slug}.${field}`);
    }
  }
  });
  return items.length;
}
async function operation(name: string): Promise<number> {
  if (name === "get_untyped") {
    if (layout === "v2") return check([await store.getUntyped("read-0")], 1, true, number => number === 0);
    let result: any;
    await getCommand!.getRecord({ cfg, slug: "read-0", json: true, print: () => {}, onResult: (value: any) => { result = value; } });
    return check([result], 1, true, number => number === 0);
  }
  if (name === "get_many") {
    const keys = Array.from({ length: 100 }, (_, number) => ({ ...input(number), number }));
    const items = layout === "v2" ? await store.getMany(keys.map(({ type, record }) => ({ type, slug: record.slug })))
      : (await Promise.all(types.map(async type => (await node.queryByKeys({ schemaHash: cfg.schemaHashes[type], fields,
        keys: keys.filter(key => key.type === type).map(({ record }) => ({ hash: record.slug })) })).map((row: any) => row.fields)))).flat();
    return check(items, 100, true, number => number < 100);
  }
  if (name === "tag_page" || name === "status_page") {
    const options = name === "tag_page" ? { tag: "shared" } : { type: "concept", status: "parked" };
    if (layout === "v2") return check((await store.list({ ...options, limit: 20 })).items, 20, false,
      number => name === "tag_page" ? number >= settings.records - 20 : number % 4 === 0 && number >= settings.records - 80);
    let result: any;
    await listCommand!.listCmd({ cfg, ...options, limit: 20, json: true, print: () => {}, printErr: () => {}, onResult: (value: any) => { result = value; } });
    return check(result.items, 20, false,
      number => name === "tag_page" ? number >= settings.records - 20 : number % 4 === 0 && number >= settings.records - 80);
  }
  if (name === "get") {
    if (layout === "v2") return check([await store.get("concept", "read-0")], 1, true, number => number === 0);
    let result: any;
    await getCommand!.getRecord({ cfg, type: "concept", slug: "read-0", json: true, print: () => {}, onResult: (value: any) => { result = value; } });
    return check([result], 1, true, number => number === 0);
  }
  if (name === "first_page") {
    if (layout === "v2") return check((await store.list({ type: "concept", limit: 20 })).items, 20, false, number => number % 2 === 0 && number >= settings.records - 40);
    let result: any;
    await listCommand!.listCmd({ cfg, type: "concept", limit: 20, json: true, print: () => {}, printErr: () => {}, onResult: (value: any) => { result = value; } });
    return check(result.items, 20, false, number => number % 2 === 0 && number >= settings.records - 40);
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
    if (layout === "v2") { const items: any[] = []; for await (const page of v2Pages({ type: "concept" }, true)) items.push(...page); return check(items, settings.records / 2, true, number => number % 2 === 0); }
    return check(await records.listRecordsAdminScan(node, "concept", cfg.schemaHashes.concept), settings.records / 2, true, number => number % 2 === 0);
  }
  if (name === "snapshot_counts") {
    if (layout === "v2") {
      if (store.counts) {
        const result = await store.counts();
        verificationChecks.push(() => {
          if (result.total !== settings.records || definitions.RECORD_TYPES.some((type: RecordType) => result.types[type] !== (types.includes(type) ? settings.records / 2 : 0))) throw new Error("V2 counts incomplete");
        });
        return result.total;
      }
      const ids = new Set<string>(), counts = new Map<string, number>();
      const pages = store.pages ? store.pages({ fields: ["br2_id", "br2_type"] }) : v2Pages();
      for await (const page of pages) for (const item of (Array.isArray(page) ? page : page.items)) {
        if (ids.has(item.br2_id)) throw new Error("V2 count repeats an identity");
        ids.add(item.br2_id); counts.set(item.br2_type, (counts.get(item.br2_type) ?? 0) + 1);
      }
      verificationChecks.push(() => { if (ids.size !== settings.records || types.some(type => counts.get(type) !== settings.records / 2)) throw new Error("V2 count incomplete"); });
      return ids.size;
    }
    const snapshot = await snapshotCommand!.buildBrainAdminSnapshot(node, cfg);
    verificationChecks.push(() => {
      if (snapshot.unavailable_types.length || definitions.RECORD_TYPES.some((type: RecordType) => snapshot.type_counts[type] !== (types.includes(type) ? settings.records / 2 : 0))) throw new Error("Snapshot counts incomplete");
    });
    return settings.records;
  }
  if (name === "bulk_selection") {
    if (layout === "v2") { const items: any[] = []; for await (const page of v2Pages({ type: "concept", status: "parked" })) items.push(...page); return check(items, settings.records / 4, false, number => number % 4 === 0); }
    let result: any;
    await deleteCommand!.deleteByFilter({ cfg, type: "concept", status: "parked", yes: false, print: () => {}, onResult: (value: any) => { result = value; } });
    verificationChecks.push(() => {
      const ids = new Set(result.deleted.map((item: any) => item.slug));
      if (!result.ok || result.deleted.length !== settings.records / 4 || ids.size !== settings.records / 4 || result.deleted.some((item: any) => item.type !== "concept" || !/^read-\d+$/.test(item.slug) || Number(item.slug.slice(5)) % 4 !== 0 || Number(item.slug.slice(5)) >= settings.records)) throw new Error("Bulk selection incomplete");
    });
    return result.deleted.length;
  }
  if (name === "search_fallback") {
    if (layout === "v2") return -1; // V2 has no search adapter; do not invent one for a comparison.
    let result: any;
    await searchCommand!.searchCmd({ cfg, query: "molecule", limit: 5, json: true, print: () => {}, printErr: () => {}, onResult: (value: any) => { result = value; } });
    if (result.length !== 5) throw new Error("Keyword search page incomplete");
    return result.length;
  }
  throw new Error(`Unknown operation ${name}`);
}
const samples: any[] = [];
if (phase === "setup") await setup();
else {
  for (let sample = 0; sample < settings.samples; sample++) {
    const before = requests, bytes = responseBytes, start = performance.now();
    profile = new Map();
    verificationChecks = [];
    try {
      const count = await operation(phase!);
      const elapsed = performance.now() - start;
      for (const verify of verificationChecks) verify();
      samples.push({ elapsed_ms: elapsed, requests: requests - before, response_bytes: responseBytes - bytes, count, verified: true,
        profile: Object.fromEntries(profile) });
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
