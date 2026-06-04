// Verifies that `runInit` honours `FBRAIN_APP_IDENTITY_ENFORCE=off` on the
// schema-register step — i.e. that remedy (c) of `CERT_REQUIRED_HINT` is
// not a false promise. Pre-fix, the env var was consulted only by writes /
// consent / doctor; init step 3 always sent `owner_app_id: "fbrain"` and
// hit the same 401 cert_required against a roots-configured schema service
// regardless of the env. Post-fix, enforce-off init posts the bare
// (un-owned) variant of each schema, which a not-active schema service
// accepts without a cert.
//
// The two cases (enforce off → bare; enforce on → owned) are paired so a
// future re-introduction of the bug — accidentally stripping in both
// branches, or accidentally tagging in both — fails one of them.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/commands/init.ts";
import { OWNER_APP_ID, withoutOwnerAppId, designSchema } from "../../src/schemas.ts";

type CapturedPost = { url: string; body: unknown };

const realFetch = globalThis.fetch;
const savedEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Mock /v1/schemas as a not-active schema service: every register succeeds
// (any owner_app_id-tagged body would also 200 in this stub — the assertion
// is on what fbrain sends, not what the service rejects).
function installCapturingMock(posts: CapturedPost[]): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/system/auto-identity")) {
      return jsonResponse(200, {
        provisioned: true,
        user_hash: "synthetic-user-hash",
      });
    }
    if (url.endsWith("/v1/schemas") && method === "POST") {
      let body: unknown = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      posts.push({ url, body });
      // Stable canonical hash per call — runInit only uses it as the value
      // for schemaHashes[type], so identity content doesn't matter.
      return jsonResponse(201, {
        schema: { name: `hash-${posts.length.toString().padStart(2, "0")}-${"x".repeat(50)}`, descriptive_name: "x" },
        replaced_schema: null,
      });
    }
    if (url.endsWith("/api/schemas/load")) {
      return jsonResponse(200, {
        available_schemas_loaded: 8,
        schemas_loaded_to_db: 8,
        failed_schemas: [],
      });
    }
    return jsonResponse(404, { error: "unexpected_url", url });
  }) as unknown as typeof globalThis.fetch;
}

function restoreEnforce(): void {
  if (savedEnforce === undefined) {
    delete process.env.FBRAIN_APP_IDENTITY_ENFORCE;
  } else {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = savedEnforce;
  }
}

afterAll(() => {
  globalThis.fetch = realFetch;
  restoreEnforce();
});

describe("withoutOwnerAppId (helper)", () => {
  test("omits owner_app_id entirely (not coerced to empty string)", () => {
    const bare = withoutOwnerAppId(designSchema);
    expect("owner_app_id" in bare.schema).toBe(false);
    // Other identity-bearing fields survive untouched — the bare publish
    // path still needs descriptive_name + field shape to produce a
    // canonical hash, so don't accidentally also drop those.
    expect(bare.schema.descriptive_name).toBe(designSchema.schema.descriptive_name);
    expect(bare.schema.fields).toEqual(designSchema.schema.fields);
  });

  test("does not mutate the input — re-running init in the same process must keep the owned variant intact", () => {
    const before = designSchema.schema.owner_app_id;
    withoutOwnerAppId(designSchema);
    expect(designSchema.schema.owner_app_id).toBe(before);
  });

  test("JSON-stringified body has no owner_app_id key (Rust serde treats missing ≠ empty string)", () => {
    // The schema service distinguishes a missing `owner_app_id` (treated as
    // Option::None → legacy passthrough on a not-active stage) from `""`
    // (Some("") that gets filtered to None but is still folded into the
    // JCS canonical-hash bytes). Pinning the wire-shape here keeps a future
    // refactor that "helpfully" sets `owner_app_id: ""` from silently
    // re-breaking remedy (c).
    const bare = withoutOwnerAppId(designSchema);
    const wire = JSON.stringify(bare);
    expect(wire.includes("owner_app_id")).toBe(false);
  });
});

describe("runInit — FBRAIN_APP_IDENTITY_ENFORCE controls owner_app_id on /v1/schemas POST", () => {
  let tmpDir: string | null = null;
  let posts: CapturedPost[] = [];

  beforeAll(() => {
    posts = [];
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    posts = [];
    restoreEnforce();
  });

  test("enforce=off → all 8 schemas POSTed bare (no owner_app_id) — remedy (c) is honest", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-enforce-off-"));
    installCapturingMock(posts);

    const lines: string[] = [];
    await runInit({
      configPath: join(tmpDir, "config.json"),
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      print: (l) => lines.push(l),
      consent: { isTty: () => false },
    });

    expect(posts.length).toBe(8);
    for (const p of posts) {
      const body = p.body as { schema?: Record<string, unknown> } | null;
      expect(body).not.toBeNull();
      expect(body?.schema).toBeDefined();
      expect("owner_app_id" in (body?.schema ?? {})).toBe(false);
    }
    // The "what just happened" line surfaces the bare-publish branch in
    // the user-visible log so a contributor reading transcripts can tell
    // the two modes apart at a glance.
    expect(lines.some((l) => l.includes("FBRAIN_APP_IDENTITY_ENFORCE=off") && l.includes("bare"))).toBe(true);
  });

  test("enforce=on → all 8 schemas POSTed with owner_app_id=\"fbrain\" — normal/prod path unchanged", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-enforce-on-"));
    installCapturingMock(posts);

    await runInit({
      configPath: join(tmpDir, "config.json"),
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      print: () => {},
      consent: { isTty: () => false },
    });

    expect(posts.length).toBe(8);
    for (const p of posts) {
      const body = p.body as { schema?: Record<string, unknown> } | null;
      expect(body?.schema?.owner_app_id).toBe(OWNER_APP_ID);
    }
  });
});
