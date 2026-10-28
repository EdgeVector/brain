/** App-local field aliases scoped to exact registered schema identities.
 * Field values, cursor bytes, and key values remain opaque.
 */
import type { Transport } from "@lastdb/app-sdk";
export type FieldAliasProfiles = Record<string, Record<string, string>>;
type ObjectValue = Record<string, unknown>;
const dataRoute = /^\/api\/(query|queries|mutation|mutations|records|conflicts|app\/search)(\/|$)/;
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}
function profile(value: ObjectValue, profiles: FieldAliasProfiles): Record<string, string> | undefined {
  const id = value.schema_name ?? value.schema;
  return typeof id === "string" && Object.hasOwn(profiles, id) ? profiles[id] : undefined;
}
function rename(name: string, aliases: Record<string, string>, strict: boolean): string {
  const [root, ...path] = name.split(".");
  const target = root && Object.hasOwn(aliases, root) ? aliases[root] : undefined;
  if (target) return [target, ...path].join(".");
  if (strict && !Object.values(aliases).includes(root ?? "")) throw new Error(`Unmapped local field ${name}`);
  return name;
}
function renameObject(value: ObjectValue, aliases: Record<string,string>, strict: boolean): ObjectValue {
  const names = new Set<string>();
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const target = rename(name, aliases, strict);
    if (names.has(target)) throw new Error(`Field alias collision at ${target}`);
    names.add(target);
    return [target, item];
  }));
}
function encodeItem(input: unknown, profiles: FieldAliasProfiles): unknown {
  if (Array.isArray(input)) return input.map((item) => encodeItem(item, profiles));
  const value = object(input);
  if (!value) return input;
  const result = {...value};
  const aliases = profile(value, profiles);
  if (aliases) {
    for (const key of ["fields", "fields_and_values"]) {
      const fields = value[key];
      if (Array.isArray(fields)) result[key] = fields.map((field) => typeof field === "string" ? rename(field, aliases, true) : field);
      else if (object(fields)) result[key] = renameObject(fields as ObjectValue, aliases, true);
    }
    const expected = object(value.expected);
    if (expected && typeof expected.field === "string") result.expected = {...expected, field:rename(expected.field, aliases, true)};
  }
  for (const key of ["queries", "mutations", "keys"]) {
    if (Array.isArray(value[key])) result[key] = (value[key] as unknown[]).map((item) => encodeItem(item, profiles));
  }
  return result;
}
function decodeItem(input: unknown, profiles: FieldAliasProfiles, fallback?: Record<string,string>): unknown {
  if (Array.isArray(input)) return input.map((item) => decodeItem(item, profiles, fallback));
  const value = object(input);
  if (!value) return input;
  const aliases = profile(value, profiles) ?? fallback;
  const result = {...value};
  if (aliases) {
    const inverse = Object.fromEntries(Object.entries(aliases).map(([local, canonical]) => [canonical, local]));
    for (const key of ["fields", "metadata"]) {
      const fields = object(value[key]);
      if (fields) result[key] = renameObject(fields, inverse, false);
    }
  }
  for (const key of ["results", "result", "response", "rows", "records", "data", "hits"]) {
    if (value[key] !== undefined) result[key] = decodeItem(value[key], profiles, aliases);
  }
  return result;
}
export function encodeFieldRequest(path: string, body: unknown, profiles: FieldAliasProfiles = {}): unknown {
  return dataRoute.test(path) ? encodeItem(body, profiles) : body;
}
export function decodeFieldReply(path: string, request: unknown, reply: unknown, profiles: FieldAliasProfiles = {}): unknown {
  if (!dataRoute.test(path)) return reply;
  const input = object(request);
  const output = object(reply);
  if (input && Array.isArray(input.queries) && output && Array.isArray(output.results)) {
    return {...output, results:output.results.map((item, index) => {
      const query = object((input.queries as unknown[])[index]);
      return decodeItem(item, profiles, query ? profile(query, profiles) : undefined);
    })};
  }
  return decodeItem(reply, profiles, input ? profile(input, profiles) : undefined);
}
export function fieldAliasTransport(inner: Transport, profiles: FieldAliasProfiles = {}): Transport {
  return {
    target:inner.target,
    async send(method, path, options) {
      if (!Object.keys(profiles).length) return inner.send(method, path, options);
      const body = options?.body;
      const result = await inner.send(method, path, {...options, body:encodeFieldRequest(path, body, profiles)});
      return {...result, body:decodeFieldReply(path, body, result.body, profiles)};
    },
  };
}
export function parseFieldAliases(input: unknown): FieldAliasProfiles | undefined {
  if (input === undefined) return undefined;
  const value = object(input);
  if (!value) throw new Error("Invalid schema field aliases in config");
  const output: FieldAliasProfiles = {};
  for (const [schema, fields] of Object.entries(value)) {
    const aliases = object(fields);
    if (!schema || !aliases || Object.values(aliases).some((name) => typeof name !== "string" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name))) {
      throw new Error("Invalid canonical field alias in config");
    }
    const entries = Object.entries(aliases) as [string,string][];
    if (new Set(entries.map(([,name]) => name)).size !== entries.length) throw new Error("Duplicate canonical field aliases in config");
    Object.defineProperty(output, schema, {value:Object.fromEntries(entries),enumerable:true});
  }
  return output;
}
