import { FbrainError } from "./client.ts";

export type FieldProjectionSource = Record<string, unknown>;

export function parseFieldProjection(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const fields = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (fields.length === 0) {
    throw new FbrainError({
      code: "invalid_field",
      message: "--field requires at least one non-empty field path.",
    });
  }
  return fields;
}

export function printFieldProjection(
  rows: readonly FieldProjectionSource[],
  fields: readonly string[],
  print: (line: string) => void,
): void {
  if (fields.length === 0) return;
  for (const row of rows) {
    print(fields.map((field) => renderProjectedValue(resolveField(row, field))).join("\t"));
  }
}

export function resolveField(
  source: FieldProjectionSource,
  path: string,
): unknown {
  const segments = parsePath(path);
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function renderProjectedValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => isScalar(item))) {
      return value.map((item) => renderProjectedValue(item)).join(",");
    }
  }
  return JSON.stringify(value);
}

function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of path.split(".")) {
    if (part.length === 0) {
      throw invalidFieldPath(path);
    }
    let rest = part;
    const head = /^([^\[\]]+)/.exec(rest);
    if (head) {
      segments.push(head[1]!);
      rest = rest.slice(head[1]!.length);
    }
    while (rest.length > 0) {
      const m = /^\[(\d+)\]/.exec(rest);
      if (!m) throw invalidFieldPath(path);
      segments.push(Number(m[1]));
      rest = rest.slice(m[0].length);
    }
  }
  return segments;
}

function invalidFieldPath(path: string): FbrainError {
  return new FbrainError({
    code: "invalid_field",
    message: `Invalid --field path "${path}".`,
    hint: "Use dot paths like `slug` or `extra_fields.program`, and array indexes like `tags[0]`.",
  });
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
