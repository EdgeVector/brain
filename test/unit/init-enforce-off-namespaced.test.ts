// Verifies that `runInit` under `FBRAIN_APP_IDENTITY_ENFORCE=off` uses the
// SAME schema-identity path as enforce-on — i.e. posts namespaced
// (`owner_app_id: "fbrain"`) schemas to the cloud schema service and, when
// the service returns 401 cert_required (the expected fresh-consumer state),
// resolves the published `fbrain/*` canonical hashes from the node.
//
// Pre-fix, enforce-off stripped `owner_app_id` and POSTed bare un-owned
// schemas to the cloud schema service, which `APP_IDENTITY_ROOT_PUBKEYS`
// rejects with 400. That made the documented escape hatch unusable: init
// died before writing a config, and every subsequent fbrain command errored
// `Config not found ... Run \`fbrain init\` first.`
//
// The two cases (enforce off / enforce on) are paired so a future
// re-introduction of the bug — accidentally stripping `owner_app_id` in
// either branch — fails one of them.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/commands/init.ts";
import { OWNER_APP_ID, UNIQUE_SCHEMAS } from "../../src/schemas.ts";
import type { Config } from "../../src/config.ts";

type CapturedPost = { url: string; body: unknown };

const realFetch = globalThis.fetch;
const savedEnforce = process.env.FBRAIN_APP_IDENTITY_ENFORCE;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Models the cloud schema service as it actually behaves for a fresh consumer:
// `POST /v1/schemas` is rejected with 401 cert_required (no DevCert), and the
// node's `GET /api/schemas` exposes each pre-published schema's authoritative
// `identity_hash`. init must resolve, not die.
function installCertGatedMock(posts: CapturedPost[]): void {
  const loaded = UNIQUE_SCHEMAS.map((e, i) => ({
    descriptive_name: e.schema.schema.descriptive_name,
    owner_app_id: e.schema.schema.owner_app_id,
    identity_hash: `resolvedhash${i}` + "0".repeat(52 - String(i).length),
  }));
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/system/auto-identity")) {
      return jsonResponse(200, { user_hash: "synthetic-user-hash-0001", provisioned: true });
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
      return jsonResponse(401, { reason: "cert_required" });
    }
    if (url.endsWith("/api/schemas/load")) {
      return jsonResponse(200, {
        available_schemas_loaded: loaded.length,
        schemas_loaded_to_db: loaded.length,
        failed_schemas: [],
      });
    }
    if (url.endsWith("/api/schemas") && method === "GET") {
      return jsonResponse(200, { ok: true, schemas: loaded });
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

describe("runInit — FBRAIN_APP_IDENTITY_ENFORCE off vs on use the same namespaced schema identity", () => {
  let tmpDir: string | null = null;
  let posts: CapturedPost[] = [];

  beforeEach(() => {
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

  test("enforce=off → POSTs namespaced (owner_app_id=fbrain), then resolves from node on 401 cert_required", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-enforce-off-"));
    const configPath = join(tmpDir, "config.json");
    installCertGatedMock(posts);

    const lines: string[] = [];
    const result = await runInit({
      configPath,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      print: (l) => lines.push(l),
      consent: { isTty: () => false },
    });

    // EVERY POST carries owner_app_id="fbrain". The bug was the opposite —
    // stripping owner_app_id and hitting 400 owner_app_id_required.
    expect(posts.length).toBe(10);
    for (const p of posts) {
      const body = p.body as { schema?: Record<string, unknown> } | null;
      expect(body?.schema?.owner_app_id).toBe(OWNER_APP_ID);
    }

    // init didn't die on the 401: it resolved every type to the node's
    // authoritative hash (NOT a bare-publish variant).
    for (const t of ["design", "task", "concept", "preference", "reference", "agent", "project", "spike", "sop"]) {
      expect(result.config.schemaHashes[t]).toMatch(/^resolvedhash\d/);
    }

    // The user-visible log surfaces the enforce-off + node-resolve story so
    // a transcript reader can tell the two modes apart at a glance.
    expect(lines.some((l) => l.includes("FBRAIN_APP_IDENTITY_ENFORCE=off") && l.includes("NodeOwner"))).toBe(true);
    expect(lines.some((l) => l.includes("resolving from node"))).toBe(true);
    expect(lines.some((l) => l.includes("no DevCert needed"))).toBe(true);

    // Config was actually written — the original bug was init exit rc=1 with
    // no config, so every subsequent fbrain command errored.
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Config;
    expect(onDisk.schemaHashes.design).toMatch(/^resolvedhash/);
  });

  test("enforce=on → identical schema-identity path (namespaced POST + resolve from node)", async () => {
    process.env.FBRAIN_APP_IDENTITY_ENFORCE = "true";
    tmpDir = mkdtempSync(join(tmpdir(), "fbrain-init-enforce-on-"));
    const configPath = join(tmpDir, "config.json");
    installCertGatedMock(posts);

    const result = await runInit({
      configPath,
      nodeUrl: "http://127.0.0.1:9001",
      schemaServiceUrl: "https://schema.example/v1",
      print: () => {},
      consent: { isTty: () => false },
    });

    expect(posts.length).toBe(10);
    for (const p of posts) {
      const body = p.body as { schema?: Record<string, unknown> } | null;
      expect(body?.schema?.owner_app_id).toBe(OWNER_APP_ID);
    }
    for (const t of ["design", "task", "concept", "preference", "reference", "agent", "project", "spike", "sop"]) {
      expect(result.config.schemaHashes[t]).toMatch(/^resolvedhash\d/);
    }
  });
});
