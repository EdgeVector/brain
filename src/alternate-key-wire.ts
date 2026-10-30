import type { SchemaDefinition } from "./schemas.ts";

type Keys = NonNullable<SchemaDefinition["alternate_keys"]>;
type Part = NonNullable<Keys[string]["range_parts"]>[number];

function invalid(path: string): never {
  throw new Error(`Invalid alternate-key wire value at ${path}.`);
}

function object(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid(path);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path);
  return value as string;
}

function part(value: unknown, path: string): Part {
  const item = object(value, ["field", "format"], path);
  const field = text(item.field, path + ".field");
  if (!field) invalid(path + ".field");
  const format = item.format === undefined ? "text" : item.format;
  if (format === "text" || format === "reverse_time_millis")
    return { field, format };
  const padded = object(format, ["padded_text"], path + ".format");
  const config = object(
    padded.padded_text,
    ["width"],
    path + ".format.padded_text",
  );
  if (
    !Number.isInteger(config.width) ||
    Number(config.width) < 0 ||
    Number(config.width) > 255
  )
    invalid(path + ".format.padded_text.width");
  return { field, format: { padded_text: { width: config.width as number } } };
}

/** Exact serde defaults; key order, fields, formats, and omission rules stay intact. */
export function alternateKeyWire(value: unknown): Keys {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid("alternate_keys");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
      if (!name) invalid("alternate_keys.name");
      const path = "alternate_keys." + name;
      const key = object(
        raw,
        [
          "hash_field",
          "range_field",
          "hash_literal",
          "range_parts",
          "range_separator",
          "omit_empty_hash",
          "missing",
        ],
        path,
      );
      const missing = key.missing === undefined ? "reject" : key.missing;
      if (missing !== "reject" && missing !== "omit")
        invalid(path + ".missing");
      const wire: Keys[string] = {
        hash_field:
          key.hash_field === undefined
            ? ""
            : text(key.hash_field, path + ".hash_field"),
        range_field:
          key.range_field === undefined || key.range_field === null
            ? null
            : text(key.range_field, path + ".range_field"),
        missing,
      };
      for (const property of ["hash_literal", "range_separator"] as const) {
        if (key[property] !== undefined && key[property] !== null)
          wire[property] = text(key[property], path + "." + property);
      }
      if (
        key.omit_empty_hash !== undefined &&
        typeof key.omit_empty_hash !== "boolean"
      )
        invalid(path + ".omit_empty_hash");
      if (key.omit_empty_hash === true) wire.omit_empty_hash = true;
      if (key.range_parts !== undefined) {
        if (!Array.isArray(key.range_parts)) invalid(path + ".range_parts");
        const parts = (key.range_parts as unknown[]).map((item, index) =>
          part(item, path + ".range_parts." + index),
        );
        if (parts.length) wire.range_parts = parts;
      }
      return [name, wire];
    }),
  );
}
