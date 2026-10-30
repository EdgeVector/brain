// CI measurements use the normal app on owned generated homes. No responses are simulated.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.LASTDB_ISOLATED_COPY !== "1") {
  throw Error("This command runs only against generated CI homes");
}
const [phase, settingsPath, outputPath] = process.argv.slice(2);
if (!phase || !settingsPath || !outputPath) throw Error("Expected phase, settings, and output paths");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const source = settings.label === "before" || (["setup", "seed"].includes(phase) && settings.label !== "fresh")
  ? settings.baseline : settings.candidate;
const load = (root, name) => import(join(resolve(root), "src", name + ".ts"));
const require = (condition, message) => { if (!condition) throw Error(message); };
const quiet = () => {};
const types = ["concept", "reference"];
const fields = ["slug", "title", "body", "status", "tags", "created_at", "updated_at"];
function ordered(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(ordered);
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => [key, ordered(value[key])]));
}
const stable = (value) => JSON.stringify(ordered(value));

function input(number) {
  const time = new Date(Date.UTC(2026, 0, 1) + number * 1000).toISOString();
  return { type: types[number % 2], record: { slug: `read-${number}`, title: `Molecule note ${number}`,
    body: settings.bodyBytes ? (`Record ${number}. ` + "molecule ".repeat(settings.bodyBytes)).slice(0, settings.bodyBytes)
      : `Record ${number}. ` + "molecule ".repeat(512),
    status: number % 4 === 0 ? "parked" : "active", tags: ["shared"], created_at: time, updated_at: time } };
}
const corpus = Array.from({ length: settings.records }, (_, number) => input(number));
const inputSha = createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
const samples = [];
let verification;

async function catalog() {
  const results = [];
  for (const root of [settings.baseline, settings.candidate]) {
    const definitions = await load(root, "schemas");
    const { canonicalSchema } = await load(root, "canonical-vocabulary");
    for (let offset = 0; offset < definitions.UNIQUE_SCHEMAS.length; offset += 4) {
      results.push(...await Promise.all(definitions.UNIQUE_SCHEMAS.slice(offset, offset + 4).map(async (entry) => {
        const schema = canonicalSchema(entry.schema.schema);
        // This public replay returns an existing definition. It grants no publisher authority.
        const reply = await fetch("https://axo709qs11.execute-api.us-east-1.amazonaws.com/v1/schemas", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schema, mutation_mappers: {} }), signal: AbortSignal.timeout(60000),
        });
        const body = await reply.json(), stored = body.schema ?? body;
        const exact = reply.status === 200 && ["owner_app_id", "schema_type", "field_types", "field_descriptions"]
          .every((key) => stable(stored[key] ?? null) === stable(schema[key] ?? null))
          && stored.key?.hash_field === schema.key.hash_field
          && (stored.key?.range_field ?? null) === (schema.key.range_field ?? null)
          && stable([...(stored.fields ?? [])].sort()) === stable([...schema.fields].sort());
        return { source: root, schema: schema.descriptive_name, status: reply.status, exact_definition: exact };
      })));
    }
  }
  verification = { definitions: results };
  writeFileSync(outputPath, JSON.stringify(verification, null, 2) + "\n");
  require(results.every((entry) => entry.exact_definition),
    "Publish the exact Brain definitions with their registered owner before this comparison");
}

async function client(root, cfg, canonicalVocabulary = false) {
  const { newNodeClient } = await load(root, "client");
  return newNodeClient({ baseUrl: "http://127.0.0.1", userHash: cfg?.userHash ?? "", socketPath: settings.socket,
    schemaFieldAliases: cfg?.schemaFieldAliases, canonicalVocabulary, timeoutMs: 120000 });
}

async function setup() {
  if (settings.label === "fresh") {
    const { runInit } = await load(settings.candidate, "commands/init");
    const result = await runInit({ configPath: settings.config, nodeUrl: "http://127.0.0.1", nodeSocketPath: settings.socket,
      bootstrapName: "CI Brain named-key operations", print: quiet });
    require(result.config.storageModel === "multi-key-v1", "Normal init did not select named keys");
    return;
  }
  const root = settings.baseline;
  let node = await client(root);
  const identity = await node.autoIdentity();
  const userHash = identity.provisioned ? identity.userHash : (await node.bootstrap("CI Brain latency")).userHash;
  node = await client(root, { userHash }, true);
  const definitions = await load(root, "schemas"), vocabulary = await load(root, "canonical-vocabulary");
  const schemaHashes = {}, schemaFieldAliases = {};
  for (let offset = 0; offset < definitions.UNIQUE_SCHEMAS.length; offset += 4) {
    const resolved = await Promise.all(definitions.UNIQUE_SCHEMAS.slice(offset, offset + 4).map(async (entry) => ({
      entry, receipt: await node.declareAppSchema(definitions.OWNER_APP_ID, entry.schema.schema),
    })));
    for (const { entry, receipt } of resolved) {
      require(receipt.canonical, "The declaration lacks a canonical schema identity");
      for (const key of definitions.schemaConfigKeys(entry)) schemaHashes[key] = receipt.canonical;
      Object.assign(schemaFieldAliases, vocabulary.profilesFor(entry.schema.schema, [receipt.canonical, receipt.schema]));
    }
  }
  const config = await load(settings.candidate, "config");
  config.writeConfig({ configVersion: config.CONFIG_VERSION, nodeUrl: "http://127.0.0.1", nodeSocketPath: settings.socket,
    schemaServiceUrl: "https://axo709qs11.execute-api.us-east-1.amazonaws.com", userHash, schemaHashes,
    schemaFieldAliases, designSchemaHash: schemaHashes.design, taskSchemaHash: schemaHashes.task,
    appIdentityEnforce: false }, settings.config);
}

async function writeRecords(root, node, cfg, records, patchOnly = false) {
  const r = await load(root, "record"), plans = await load(root, "resident-write-plan");
  const writes = await Promise.all(records.map(async ({ type, previous = null, record }) => ({ type, slug: record.slug,
    plan: await plans.buildResidentWritePlan({ node, cfg, type, schemaHash: cfg.schemaHashes[type], previous, next: record,
      primaryFields: patchOnly ? { title: record.title, updated_at: record.updated_at } : r.buildRecordFields(type, record),
      now: record.updated_at }),
  })));
  const receipt = await plans.commitResidentWritePlans({ node, writes, durable: true, failOnIndexPartial: true });
  require(receipt.durability === "durable", "The app write lacks a durable receipt");
}

async function run() {
  if (phase === "catalog") return catalog();
  if (phase === "setup") {
    await setup();
    const cfg = JSON.parse(readFileSync(settings.config, "utf8")), node = await client(source, cfg);
    const definitions = await load(source, "schemas");
    const schemaHash = cfg.schemaHashes[definitions.BRAIN_LIST_COUNT_SCHEMA_KEY];
    const keys = ["all", ...definitions.RECORD_TYPES];
    // These are known-empty generated homes, not discovered application data.
    // Retain the original corpus's explicit zero counters for unused record types.
    const existing = await node.queryByKeys({ schemaHash, fields: ["bln_n"], keys: keys.map((hash) => ({ hash })) });
    require(existing.length === 0, "The new generated home already contains app counters");
    const receipt = await node.mutateBatch(keys.map((hash) => ({ mutationType: "create", schemaHash, keyHash: hash,
      fields: { bln_h: hash, bln_n: "0" } })), { durability: "durable" });
    require(receipt.durability === "durable", "The initial generated counters lack a durable receipt");
    return;
  }
  const root = phase === "seed" && settings.label !== "fresh" ? settings.baseline : source;
  const cfg = JSON.parse(readFileSync(settings.config, "utf8")), node = await client(root, cfg);
  const r = await load(root, "record");
  if (phase === "convert") {
    const { convertMultiKey } = await load(settings.candidate, "commands/multi-key-convert");
    verification = await convertMultiKey(await client(settings.candidate, cfg), cfg,
      { apply: true, maintenance: true, configPath: settings.config });
    require(verification.phase === "complete" && verification.selected_keys === verification.expected_selected_keys,
      "The app conversion is incomplete");
    return;
  }
  if (phase === "seed" || phase === "create") {
    for (let offset = 0; offset < corpus.length; offset += 8) {
      const batch = corpus.slice(offset, offset + 8);
      const start = performance.now(), calls = requests, bytes = responseBytes;
      await writeRecords(root, node, cfg, batch);
      if (phase === "create") samples.push({ elapsed_ms: performance.now() - start, records: batch.length,
        requests: requests - calls, response_bytes: responseBytes - bytes, verified: true });
    }
    return;
  }
  if (phase === "update" || phase === "partial") {
    const edits = phase === "partial" ? 64 : settings.records / 4;
    const partialBefore = phase === "partial" ? await primaryRows(node, cfg, Array.from({ length: 8 }, (_, i) => settings.records - 16 + i)) : null;
    for (let operation = 0; operation < edits; operation++) {
      const number = settings.records - 16 + operation % (phase === "partial" ? 8 : 16);
      const { type, record } = input(number);
      const previous = await r.findBySlug(node, type, cfg.schemaHashes[type], record.slug, cfg);
      require(previous, "An update target is absent");
      const next = { ...previous, title: `${phase} ${operation}`, updated_at: new Date(Date.UTC(2026, 2, 1) + operation * 1000).toISOString(),
        ...(phase === "update" ? { status: type === "concept" ? "parked" : "archived" } : {}) };
      const start = performance.now(), calls = requests, bytes = responseBytes;
      await writeRecords(root, node, cfg, [{ type, previous, record: next }], phase === "partial");
      samples.push({ elapsed_ms: performance.now() - start, records: 1,
        requests: requests - calls, response_bytes: responseBytes - bytes, verified: true });
    }
    if (partialBefore) {
      const after = await primaryRows(node, cfg, Array.from({ length: 8 }, (_, i) => settings.records - 16 + i));
      for (const [slug, prior] of partialBefore) {
        const next = after.get(slug);
        require(prior.metadata?.body?.atom_uuid && prior.metadata.body.atom_uuid === next?.metadata?.body?.atom_uuid,
          "A title-only update replaced its body atom");
        for (const field of ["body", "tags", "status", "created_at"]) require(stable(prior.fields[field]) === stable(next.fields[field]), "A title-only update changed " + field);
      }
      verification = { content_atoms: Object.fromEntries([...after].map(([slug, row]) => [slug, row.metadata.body.atom_uuid])) };
    }
    return;
  }
  const deletion = await load(root, "commands/delete");
  if (phase === "delete") {
    for (let number = settings.records - 8; number < settings.records; number++) {
      const { type, record } = input(number), start = performance.now(), calls = requests, bytes = responseBytes;
      await deletion.deleteRecord({ cfg, type, slug: record.slug, print: quiet });
      samples.push({ elapsed_ms: performance.now() - start, records: 1,
        requests: requests - calls, response_bytes: responseBytes - bytes, verified: true });
    }
    return;
  }
  if (phase === "verify" || phase === "reopen_partial") {
    const found = await primaryRows(node, cfg, Array.from({ length: settings.records }, (_, i) => i));
    require(found.size === settings.records - 8, "The operational record count differs");
    for (let number = 0; number < settings.records - 8; number++) {
      const { type, record } = input(number), row = found.get(record.slug);
      require(row, "An expected operational record is absent");
      require(row.fields.body === record.body && stable(row.fields.tags) === stable(record.tags), "A body or tag differs after restart");
      if (number >= settings.records - 16) {
        const offset = number - (settings.records - 16);
        const operation = phase === "reopen_partial" ? 56 + offset : settings.records / 4 - 16 + offset;
        require(row.fields.title === `${phase === "reopen_partial" ? "partial" : "update"} ${operation}`, "An update is absent after restart");
        require(row.fields.status === (type === "concept" ? "parked" : "archived")
          && row.fields.updated_at === new Date(Date.UTC(2026, 2, 1) + operation * 1000).toISOString()
          && row.fields.created_at === record.created_at, "An update changed or lost an expected field");
      } else for (const field of fields) require(stable(row.fields[field]) === stable(record[field]), "An unchanged field differs after restart");
    }
    const listed = (await Promise.all(types.map((type) => r.listRecords(node, type, cfg, { onMissing: "throw" })))).flat();
    require(listed.length === found.size && new Set(listed.map((row) => row.slug)).size === found.size, "The app list differs from primary membership");
    const snapshot = await (await load(root, "commands/admin-snapshot")).buildBrainAdminSnapshot(node, cfg);
    require(snapshot.unavailable_types.length === 0 && types.every((type) => snapshot.type_counts[type] === found.size / 2), "The app count differs after deletes");
    if (phase === "reopen_partial") {
      const prior = JSON.parse(readFileSync(settings.partialProof, "utf8")).verification.content_atoms;
      for (const [slug, atom] of Object.entries(prior)) require(found.get(slug)?.metadata?.body?.atom_uuid === atom, "A body atom differs after restart");
    }
    verification = { records_verified: found.size, list_members_verified: listed.length, exact_counts: true, bodies_after_restart: true };
    return;
  }
  const [get, list, snapshot, search] = await Promise.all(["get", "list", "admin-snapshot", "search"].map((name) => load(root, "commands/" + name)));
  for (let sample = 0; sample < settings.samples; sample++) {
    let result;
    const before = requests, bytes = responseBytes, start = performance.now();
    profile = new Map();
    if (phase === "get") {
      await get.getRecord({ cfg, type: "concept", slug: "read-0", json: true, print: quiet, onResult: (value) => { result = value; } });
    } else if (phase === "first_page") {
      await list.listCmd({ cfg, type: "concept", limit: 20, json: true, print: quiet, printErr: quiet, onResult: (value) => { result = value.items; } });
    } else if (phase === "all_summaries" || phase === "all_records") {
      result = (await Promise.all(types.map((type) => r.listRecords(node, type, cfg,
        phase === "all_records" ? { onMissing: "throw" } : { summary: true })))).flat();
    } else if (phase === "migration_read") {
      result = await r.listRecordsAdminScan(node, "concept", cfg.schemaHashes.concept);
    } else if (phase === "snapshot_counts") {
      result = await snapshot.buildBrainAdminSnapshot(node, cfg);
    } else if (phase === "bulk_selection") {
      await deletion.deleteByFilter({ cfg, type: "concept", status: "parked", yes: false, print: quiet, onResult: (value) => { result = value; } });
    } else if (phase === "search_fallback") {
      await search.searchCmd({ cfg, query: "molecule", limit: 5, json: true, print: quiet, printErr: quiet, onResult: (value) => { result = value; } });
    } else throw Error("Unknown phase " + phase);
    const elapsed = performance.now() - start;
    // Value checks run outside the measured operation. No successful sample skips a check.
    if (phase === "snapshot_counts") {
      const { RECORD_TYPES } = await load(root, "schemas");
      require(result.unavailable_types.length === 0 && RECORD_TYPES.every((type) => result.type_counts[type] === (types.includes(type) ? settings.records / 2 : 0)), "The snapshot count differs");
    } else if (phase === "bulk_selection") {
      require(result.ok && result.dryRun === true && result.failed.length === 0
        && result.deleted.length === settings.records / 4 && result.deleted.every((item) => item.type === "concept"), "The bulk selection differs");
      checkRecords(result.deleted, settings.records / 4, ["slug"], (number) => number % 4 === 0);
    } else if (phase === "search_fallback") {
      checkRecords(result, 5, ["slug", "title"], () => true);
      require(result.every((hit) => types.includes(hit.type)), "Search returned another record type");
    } else {
      const full = ["get", "all_records", "migration_read"].includes(phase);
      const expected = phase === "get" ? 1 : phase === "first_page" ? 20 : phase === "migration_read" ? settings.records / 2 : settings.records;
      checkRecords(phase === "get" ? [result] : result, expected, full ? fields : ["slug", "title", "status", "updated_at"],
        (number) => phase === "get" ? number === 0 : phase === "first_page" ? number % 2 === 0 && number >= settings.records - 40 : phase !== "migration_read" || number % 2 === 0);
    }
    samples.push({ elapsed_ms: elapsed, requests: requests - before, response_bytes: responseBytes - bytes, verified: true, profile: Object.fromEntries(profile) });
  }
}

function checkRecords(items, expected, selectedFields, allowed) {
  require(Array.isArray(items) && items.length === expected && new Set(items.map((item) => item.slug)).size === expected, "The read membership differs");
  for (const item of items) {
    const number = Number(String(item.slug).slice(5));
    require(Number.isInteger(number) && number >= 0 && number < settings.records && allowed(number), "An unexpected record is present");
    const { record } = input(number);
    for (const field of selectedFields) require(stable(item[field] ?? (field === "updated_at" ? item.updatedAt : null)) === stable(record[field]), `The value differs: ${record.slug}.${field}`);
  }
}

async function primaryRows(node, cfg, numbers) {
  const rows = new Map();
  for (let offset = 0; offset < numbers.length; offset += 100) {
    const keys = numbers.slice(offset, offset + 100);
    // The SDK's ordinary record shape omits per-field metadata. This actual batch
    // response retains the body atoms needed for the title-only operation proof.
    const queries = types.map((type) => ({ schema_name: cfg.schemaHashes[type], fields,
      filter: { HashRangeKeys: keys.filter((number) => input(number).type === type).map((number) => [`read-${number}`, ""]) }, limit: 100 }));
    const response = await node.rawCall("POST", "/api/queries/batch", { queries });
    const result = response.json?.data ?? response.json;
    require(response.status === 200 && result?.count === queries.length && result.results?.length === queries.length,
      "The primary batch reply is incomplete");
    const pages = result.results.map((entry) => {
      const page = entry.response?.data ?? entry.response;
      require(entry.status === 200 && page?.ok !== false && page?.has_more === false && Array.isArray(page?.results),
        "The primary batch contains an incomplete page");
      return page.results;
    });
    for (const row of pages.flat()) {
      const slug = row.fields.slug;
      require(!rows.has(slug) && row.key.hash === slug, "The primary read repeats or changes an identity");
      rows.set(slug, row);
    }
  }
  return rows;
}

let requests = 0, responseBytes = 0, profile = new Map();
globalThis.fetch = new Proxy(globalThis.fetch, {
  async apply(target, receiver, args) {
    requests++;
    const start = performance.now(), captured = profile;
    const request = typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : {};
    const label = JSON.stringify({ path: String(args[0]).split("?")[0], schema: request.schema_name,
      fields: request.fields, key_name: request.key_name, filter: Object.keys(request.filter ?? {})[0], response_format: request.response_format });
    const response = await Reflect.apply(target, receiver, args), reader = response.body?.getReader();
    if (!reader) return response;
    let bytes = 0;
    const body = new ReadableStream({
      async pull(controller) {
        const part = await reader.read();
        if (part.done) {
          const elapsed = performance.now() - start;
          const aggregate = captured.get(label) ?? { requests: 0, elapsed_sum_ms: 0, max_ms: 0, response_bytes: 0 };
          aggregate.requests++; aggregate.elapsed_sum_ms += elapsed; aggregate.max_ms = Math.max(aggregate.max_ms, elapsed); aggregate.response_bytes += bytes;
          captured.set(label, aggregate); controller.close();
        } else { bytes += part.value.byteLength; responseBytes += part.value.byteLength; controller.enqueue(part.value); }
      }, cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  },
});

try {
  await run();
  if (phase !== "catalog") writeFileSync(outputPath, JSON.stringify({ phase, source, label: settings.label, records: settings.records,
    input_sha256: inputSha, body_bytes: corpus.reduce((total, item) => total + Buffer.byteLength(item.record.body), 0), samples, verification }, null, 2) + "\n");
} catch (error) {
  writeFileSync(outputPath, JSON.stringify({ phase, source, label: settings.label, records: settings.records,
    input_sha256: inputSha, samples, verification, failure: String(error).slice(0, 1000) }, null, 2) + "\n");
  throw error;
}
