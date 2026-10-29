// Real-node checks and partial-write measurements for the CI spike.
import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import type { RecordType } from "../schemas.ts";
import { decodeV2Record, rawData, recordKey } from "./store.ts";
import { V2_STORED_FIELDS, type V2SchemaMap } from "./schemas.ts";
import type { FbrainRecord } from "../record.ts";

// Real app writes force a bounded summary page to split, then remove its
// leading records. No source mutation bypasses the adapter's guarded batch.
export async function verifySummaryPageLifecycle(store: any, common: FbrainRecord): Promise<Record<string, unknown>> {
  const snapshot = async () => {
    const rows: string[] = [];
    for await (const page of store.pages()) for (const r of page.items) rows.push(JSON.stringify(
      [r.br2_type, r.slug, r.title, r.status, r.tags, r.updated_at]));
    return rows.sort();
  };
  const before = await snapshot(), counts = await store.counts();
  const slugs = Array.from({ length: 3 }, (_, i) => `page-lifecycle-${i}`);
  for (let i = 0; i < slugs.length; i++) await store.put("concept", { ...common, slug: slugs[i], tags: [],
    title: "Page split guard ".repeat(1500), updated_at: new Date(Date.UTC(2027, 0, 1) + i * 1000).toISOString() });
  for (const slug of [...slugs].reverse()) await store.delete("concept", slug);
  if (JSON.stringify(await snapshot()) !== JSON.stringify(before) || JSON.stringify(await store.counts()) !== JSON.stringify(counts)) throw new Error("Summary page lifecycle changed an existing record or count");
  return { inserted_and_removed: 3, existing_summaries_unchanged: true, exact_counts_unchanged: true };
}

export async function verifyQueryFormats(node: NodeClient, schemas: V2SchemaMap, total: number, paged = false): Promise<unknown> {
  const query = { schema_name: schemas.record, fields: paged ? ["br2_id", "br2_content", "br2_revision"] : ["br2_card", "br2_content", "br2_count_hash"],
    filter: { HashKey: recordKey("concept", "record-16") }, limit: 1 };
  const full = await rawData(node, "POST", "/api/query", query);
  const values = await rawData(node, "POST", "/api/query", { ...query, response_format: "values" });
  if (full.results.length !== 1 || values.results.length !== 1
      || JSON.stringify(full.results[0].fields) !== JSON.stringify(values.results[0].fields)
      || !full.results[0].metadata || "metadata" in values.results[0] || "author_pub_key" in values.results[0]
      || !("has_conflicts" in values.results[0])) throw new Error("Compact values differ from the full query");
  for (const name of ["unresolved_rows", "tombstoned_rows", "key_form", "conflict_flags", "has_more", "next_cursor"]) {
    if (!(name in values) || JSON.stringify(values[name]) !== JSON.stringify(full[name])) throw new Error(`Compact query lost ${name}`);
  }
  const hash = paged ? recordKey("concept", "record-16") : full.results[0].fields.br2_count_hash;
  const countQuery = { schema_name: paged ? schemas.record : schemas.count, fields: ["br2_id"], filter: { HashKey: hash } };
  const legacy = await rawData(node, "POST", "/api/query", { ...countQuery, sort_order: "Desc", limit: 1 });
  const batch = await rawData(node, "POST", "/api/queries/batch", { queries: [
    { ...query, response_format: "values" }, { ...countQuery, response_format: "count" }, query,
  ] });
  const replies = batch.results?.map((entry: any) => {
    if (entry.status !== 200 || entry.response?.ok === false) throw new Error("Mixed query format batch failed");
    return entry.response.data ?? entry.response;
  });
  if (batch.count !== 3 || !replies || replies[1].exact !== true || replies[1].total_count !== legacy.total_count
      || replies[1].total_count > total || replies[1].results !== undefined
      || "metadata" in replies[0].results[0] || !replies[2].results[0].metadata) throw new Error("Batch reply formats changed order or leaked between items");
  const rejected = await Promise.all([
    node.rawCall("POST", "/api/query", { ...query, response_format: "invalid" }),
    node.rawCall("POST", "/api/query", { ...countQuery, response_format: "count", offset: 1 }),
    node.rawCall("POST", "/api/query", { ...countQuery, response_format: "count", expected_total_count: legacy.total_count + 1 }),
  ]);
  if (rejected.map(reply => reply.status).join() !== "400,400,409") throw new Error("Query format refusals differ");
  return { equal_values: true, integrity_flags: true, mixed_batch: true, invalid_format: 400, count_continuation: 400, count_conflict: 409 };
}

type PatchContext = { node: NodeClient; store: any; schemas: V2SchemaMap; cfg: Config; layout: string; records: number;
  nativeReads: boolean; requests: () => number; findBySlug: any; buildResidentWritePlan: any; commitResidentWritePlan: any;
  recordKey: typeof recordKey; decodeV2Record: typeof decodeV2Record };

export async function summaryPatchOperations(ctx: PatchContext): Promise<{ samples: any[]; verification: Record<string, unknown> }> {
  const numbers = Array.from({ length: 8 }, (_, offset) => ctx.records - 16 + offset);
  const identity = (number: number) => ({ type: (number % 2 ? "reference" : "concept") as RecordType, slug: `record-${number}` });
  async function snapshot(): Promise<Map<string, any>> {
    const layouts = ctx.layout === "v2" ? ["v2"] : ["concept", "reference"];
    const pages = await Promise.all(layouts.map(async layout => {
      const keys = numbers.filter(number => layout === "v2" || identity(number).type === layout);
      const [result, records] = await Promise.all([rawData(ctx.node, "POST", "/api/query", { schema_name: layout === "v2" ? ctx.schemas.record : ctx.cfg.schemaHashes[layout],
        fields: layout === "v2" ? ctx.store.paged ? ["br2_id", "br2_content"] : V2_STORED_FIELDS : ["slug", "title", "body", "status", "tags", "created_at", "updated_at"],
        filter: { HashRangeKeys: keys.map(number => { const key = identity(number); return [layout === "v2" ? ctx.recordKey(key.type, key.slug) : key.slug, ""]; }) }, limit: 100 }),
        ctx.store.paged && layout === "v2" ? ctx.store.getMany(keys.map(identity)) : Promise.resolve([])]);
      const byId = new Map<string, any>(records.map((record: any) => [record.br2_id, record]));
      if (result.unresolved_rows !== 0 || result.tombstoned_rows !== 0 || result.has_more || result.results.length !== keys.length) throw new Error("Partial-write snapshot is incomplete");
      return result.results.map((row: any) => ({ record: layout === "v2" ? ctx.store.paged ? byId.get(row.fields.br2_id) : ctx.decodeV2Record(row.fields, true) : row.fields,
        atom: row.metadata?.[layout === "v2" ? "br2_content" : "body"]?.atom_uuid }));
    }));
    return new Map(pages.flat().map((item: any) => [item.record.slug, item]));
  }
  const before = await snapshot(), samples = [];
  const titles = new Map<string, string>();
  for (let operation = 0; operation < 64; operation++) {
    const { type, slug } = identity(numbers[operation % numbers.length]!);
    const patch = { title: `Summary-only edit ${operation}`, updated_at: new Date(Date.UTC(2026, 3, 1) + operation * 1000).toISOString() };
    const started = performance.now(), calls = ctx.requests();
    if (ctx.layout === "v2") {
      if (ctx.nativeReads) await ctx.store.patchSummary(type, slug, patch);
      else await ctx.store.patch(type, slug, patch);
    } else {
      const schemaHash = ctx.cfg.schemaHashes[type]!;
      const previous = await ctx.findBySlug(ctx.node, type, schemaHash, slug, ctx.cfg);
      if (!previous) throw new Error("Current Brain partial-write target is absent");
      const plan = await ctx.buildResidentWritePlan({ node: ctx.node, cfg: ctx.cfg, type, schemaHash, previous,
        next: { ...previous, ...patch }, primaryFields: patch, now: patch.updated_at });
      await ctx.commitResidentWritePlan({ node: ctx.node, plan, type, slug, durable: true });
    }
    samples.push({ number: operation, elapsed_ms: performance.now() - started, requests: ctx.requests() - calls });
    titles.set(slug, patch.title);
  }
  const after = await snapshot();
  for (const [slug, prior] of before) {
    const next = after.get(slug);
    if (!prior.atom || next?.atom !== prior.atom || next.record.title !== titles.get(slug)) throw new Error("Partial edit rewrote the content atom or lost its title");
    for (const field of ["body", "created_at", "status", "tags"]) {
      if (JSON.stringify(prior.record[field]) !== JSON.stringify(next.record[field])) throw new Error(`Partial edit changed ${field}`);
    }
  }
  if (ctx.layout === "v2") {
    await Promise.all((["recent", "type", "status"] as const).map(async layout => {
      const coordinates = [...after.values()].map(({ record }) => [layout === "recent" ? record.br2_scope : layout === "type" ? record.br2_type : record.br2_status, record.br2_order]);
      const page = await rawData(ctx.node, "POST", "/api/query", { schema_name: ctx.schemas[layout], fields: [ctx.store.paged ? "br2_id" : "br2_card", "br2_content"], filter: { HashRangeKeys: coordinates }, limit: 100 });
      if (page.unresolved_rows !== 0 || page.tombstoned_rows !== 0 || page.results.length !== after.size) throw new Error("Partial key move lost a protein member");
      for (const row of page.results) {
        const record = ctx.store.paged ? [...after.values()].find(item => item.record.br2_id === row.fields.br2_id)?.record : ctx.decodeV2Record(row.fields, true);
        const canonical = after.get(record?.slug);
        const body = ctx.store.paged ? JSON.parse(row.fields.br2_content).body : record.body;
        if (row.metadata.br2_content.atom_uuid !== canonical?.atom || record.title !== canonical.record.title || body !== canonical.record.body) throw new Error("Protein member did not retain its shared content atom");
      }
    }));
    if ((await ctx.store.counts()).total !== ctx.records + 3) throw new Error("Partial edits changed counts");
  }
  return { samples, verification: { edits: 64, distinct_records: after.size, unchanged_content_atoms: true, native_member_key_moves: ctx.layout === "v2",
    content_atoms: Object.fromEntries([...after].map(([slug, value]) => [slug, value.atom])) } };
}

export async function verifyPartialAfterRestart(node: NodeClient, layout: string, schemas: V2SchemaMap, cfg: Config,
  records: number, proof: any, codec: { key: typeof recordKey; decode: typeof decodeV2Record }, store?: any): Promise<Record<string, unknown>> {
  const identities = Array.from({ length: 8 }, (_, offset) => ({ type: ((records - 16 + offset) % 2 ? "reference" : "concept") as RecordType,
    slug: `record-${records - 16 + offset}`, title: `Summary-only edit ${56 + offset}` }));
  const pages = await Promise.all((layout === "v2" ? ["v2"] : ["concept", "reference"]).map(async type => {
    const keys = identities.filter(key => type === "v2" || key.type === type);
    const page = await rawData(node, "POST", "/api/query", { schema_name: type === "v2" ? schemas.record : cfg.schemaHashes[type],
      fields: type === "v2" ? store?.paged ? ["br2_id", "br2_content"] : V2_STORED_FIELDS : ["slug", "title", "body"],
      filter: { HashRangeKeys: keys.map(key => [type === "v2" ? codec.key(key.type, key.slug) : key.slug, ""]) }, limit: 100 });
    if (page.unresolved_rows !== 0 || page.tombstoned_rows !== 0 || page.has_more || page.results.length !== keys.length) throw new Error("Partial restart read is incomplete");
    return page.results;
  }));
  const decoded = store?.paged && layout === "v2" ? await store.getMany(identities) : [];
  for (const row of pages.flat()) {
    const record = layout === "v2" ? store?.paged ? decoded.find((record: any) => record.br2_id === row.fields.br2_id) : codec.decode(row.fields, true) : row.fields;
    const expected = identities.find(key => key.slug === record.slug);
    if (!expected || record.title !== expected.title || !record.body
        || row.metadata?.[layout === "v2" ? "br2_content" : "body"]?.atom_uuid !== proof.content_atoms?.[record.slug]) throw new Error("Partial restart lost its title or content atom");
  }
  return { records_verified: 8, title_and_content_atoms_after_restart: true };
}
