import { describe, expect, test } from "bun:test";

import {
  buildBrainAdminSnapshot,
  parseHeartbeatLine,
  snapshotToFields,
} from "../../src/commands/admin-snapshot.ts";
import type { NativeIndexHit, NodeClient, QueryResponse, QueryRow } from "../../src/client.ts";
import type { RecordType } from "../../src/schemas.ts";
import { buildTestCfg, TEST_HASHES } from "../util.ts";

const NOW = new Date("2026-07-15T16:00:00.000Z");

function row(fields: Record<string, unknown>): QueryRow {
  return {
    key: { hash: String(fields.slug ?? ""), range: null },
    fields,
    author_pub_key: "pub",
  };
}

function base(slug: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    slug,
    title: slug,
    body: "",
    status: "active",
    tags: [],
    created_at: "2026-07-15T10:00:00.000Z",
    updated_at: "2026-07-15T10:00:00.000Z",
    ...over,
  };
}

function mockNode(records: Partial<Record<RecordType, QueryRow[]>>): NodeClient {
  return {
    baseUrl: "mock",
    userHash: "uh-test",
    async autoIdentity() { return { provisioned: true, userHash: "uh-test" }; },
    async health() { return { ok: true, uptime_s: 1 }; },
    async bootstrap() { return { userHash: "uh-test" }; },
    async requestConsent() { return { status: 202, body: { request_id: "r" } }; },
    async consentStatus() { return { status: 200, body: { status: "granted" } }; },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async listLoadedSchemas() { return []; },
    async createRecord() {},
    async updateRecord() {},
    async deleteRecord() {},
    async queryAll({ schemaHash }): Promise<QueryResponse> {
      const type = (Object.entries(TEST_HASHES) as Array<[RecordType, string]>)
        .find(([, hash]) => hash === schemaHash)?.[0];
      const results = type ? (records[type] ?? []) : [];
      return { ok: true, results, total_count: results.length, returned_count: results.length };
    },
    async search(): Promise<NativeIndexHit[]> { return []; },
    async rawCall() { return { status: 200, headers: new Headers(), body: "", json: null }; },
  };
}

describe("brain admin snapshot", () => {
  test("builds a privacy-pruned admin payload", async () => {
    const node = mockNode({
      design: [row(base("design-one"))],
      decision: [
        row(base("decide-open", {
          title: "Pick dashboard transport",
          status: "proposed",
          body: "SECRET_DECISION_BODY",
          program: "admin",
        })),
        row(base("decide-done", {
          title: "Already done",
          status: "done",
          body: "DONE_BODY_SHOULD_NOT_APPEAR",
        })),
      ],
      project: [
        row(base("active-programs", {
          title: "Active programs",
          status: "in_progress",
          body: [
            "# Active Programs",
            "",
            "North Star: deliver data slices",
            "This line is safe summary text.",
          ].join("\n"),
        })),
      ],
      reference: [
        row(base("open-decisions", {
          title: "Open decisions ledger",
          body: [
            "SECRET_REFERENCE_BODY",
            "NEEDS-DECISION decide-open | program=admin | status=open - Pick dashboard transport - blocks: admin",
          ].join("\n"),
        })),
        row(base("routine-heartbeats", {
          title: "Routine heartbeats",
          body: [
            "kanban-pickup 2026-07-15T15:00:00Z ok cards=1",
            "noise without timestamp",
            "sentry-triage 2026-07-15T15:30:00Z noop nothing",
          ].join("\n"),
        })),
      ],
    });

    const snapshot = await buildBrainAdminSnapshot(node, buildTestCfg(), { now: NOW });
    const fields = snapshotToFields(snapshot);
    const serialized = JSON.stringify({ snapshot, fields });

    expect(snapshot.captured_at).toBe(NOW.toISOString());
    expect(snapshot.type_counts.design).toBe(1);
    expect(snapshot.type_counts.decision).toBe(2);
    expect(snapshot.open_decisions).toContainEqual({
      slug: "decide-open",
      title: "Pick dashboard transport",
      status: "open",
    });
    expect(snapshot.open_decisions.some((d) => d.slug === "decide-done")).toBe(false);
    expect(snapshot.active_programs_head[0]?.lines).toEqual([
      "# Active Programs",
      "North Star: deliver data slices",
      "This line is safe summary text.",
    ]);
    expect(snapshot.recent_heartbeats).toEqual([
      { slug: "sentry-triage", ts: "2026-07-15T15:30:00Z", ok: "noop" },
      { slug: "kanban-pickup", ts: "2026-07-15T15:00:00Z", ok: "ok" },
    ]);

    expect(serialized).not.toContain("SECRET_DECISION_BODY");
    expect(serialized).not.toContain("DONE_BODY_SHOULD_NOT_APPEAR");
    expect(serialized).not.toContain("SECRET_REFERENCE_BODY");
  });

  test("parses heartbeat identity, timestamp, and outcome only", () => {
    expect(parseHeartbeatLine("kanban-pickup 2026-07-15T15:00:00Z ok cards=1 pr=x")).toEqual({
      slug: "kanban-pickup",
      ts: "2026-07-15T15:00:00Z",
      ok: "ok",
    });
    expect(parseHeartbeatLine("not enough")).toBeNull();
  });
});
