// `fbrain raw <method> <path> [body]` — authenticated passthrough to the
// node or the schema service. Path prefix picks the service:
//   /api/  → node (X-User-Hash auto-added)
//   /v1/   → schema service (no auth header)
//
// Body sources:
//   omitted | "-"   → read raw bytes from stdin
//   <string>        → treated as the literal request body (must be valid
//                     JSON if you want the server to parse it as JSON)

import {
  newNodeClient,
  newSchemaServiceClient,
  FbrainError,
  type RawResponse,
  type Verbose,
} from "../client.ts";
import type { Config } from "../config.ts";

export const RAW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RawMethod = (typeof RAW_METHODS)[number];

export type RawOptions = {
  cfg: Config;
  method: string;
  path: string;
  body?: string;
  readStdin?: () => Promise<string>;
  verbose?: Verbose;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
};

export async function rawCmd(opts: RawOptions): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const printErr = opts.printErr ?? ((line: string) => console.error(line));
  const method = normalizeMethod(opts.method);
  const target = pickService(opts.path);
  const body = await resolveBody(opts.body, opts.readStdin);

  let res: RawResponse;
  if (target === "node") {
    const node = newNodeClient({
      baseUrl: opts.cfg.nodeUrl,
      userHash: opts.cfg.userHash,
      verbose: opts.verbose,
    });
    res = await node.rawCall(method, opts.path, body);
  } else {
    const schema = newSchemaServiceClient(opts.cfg.schemaServiceUrl, opts.verbose);
    res = await schema.rawCall(method, opts.path, body);
  }

  opts.verbose?.(`status=${res.status}`);
  if (opts.verbose) {
    res.headers.forEach((value, key) => {
      opts.verbose?.(`  ${key}: ${value}`);
    });
  }

  const sink = res.status >= 200 && res.status < 300 ? print : printErr;
  if (res.json !== undefined && res.json !== null && res.body.length > 0) {
    sink(JSON.stringify(res.json, null, 2));
  } else if (res.body.length > 0) {
    sink(res.body);
  }

  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

export function normalizeMethod(raw: string): RawMethod {
  const upper = raw.toUpperCase();
  if (!(RAW_METHODS as readonly string[]).includes(upper)) {
    throw new FbrainError({
      code: "invalid_raw_method",
      message: `Unsupported method "${raw}". Use one of: ${RAW_METHODS.join(", ")}.`,
    });
  }
  return upper as RawMethod;
}

export function pickService(path: string): "node" | "schema" {
  if (path.startsWith("/api/")) return "node";
  if (path.startsWith("/v1/")) return "schema";
  throw new FbrainError({
    code: "invalid_raw_path",
    message: `Path "${path}" must start with /api/ (node) or /v1/ (schema service).`,
  });
}

export async function resolveBody(
  arg: string | undefined,
  readStdin: (() => Promise<string>) | undefined,
): Promise<string | undefined> {
  if (arg === undefined || arg === "-") {
    if (!readStdin) return undefined;
    const text = await readStdin();
    return text.length > 0 ? text : undefined;
  }
  return arg;
}
