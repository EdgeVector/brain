import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADMIN_SNAPSHOT_SLUG,
  SNAPSHOT_FIELDS,
  buildBrainAdminSnapshot,
  buildDeliveryStageRequest,
  deliverAdminSnapshot,
  parseHeartbeatLine,
  parseOpenDecisionLine,
  publishAdminSnapshot,
  snapshotToFields,
  type LastDbDeliveryClient,
} from "../../src/commands/admin-snapshot.ts";
import type { NativeIndexHit, NodeClient, QueryResponse, QueryRow } from "../../src/client.ts";
import type { RecordType } from "../../src/schemas.ts";
import { ADMIN_SNAPSHOT_SCHEMA_KEY } from "../../src/schemas.ts";
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
    const oldHeartbeatPath = process.env.LAST_STACK_HEARTBEATS_FILE;
    const tmp = mkdtempSync(join(tmpdir(), "fbrain-admin-snapshot-"));
    process.env.LAST_STACK_HEARTBEATS_FILE = join(tmp, "routine-heartbeats.log");
    writeFileSync(
      process.env.LAST_STACK_HEARTBEATS_FILE,
      [
        "kanban-pickup 2026-07-15T15:00:00Z ok cards=1",
        "noise without timestamp",
        "sentry-triage 2026-07-15T15:30:00Z noop nothing",
      ].join("\n"),
    );
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

    try {
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
    } finally {
      if (oldHeartbeatPath === undefined) delete process.env.LAST_STACK_HEARTBEATS_FILE;
      else process.env.LAST_STACK_HEARTBEATS_FILE = oldHeartbeatPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("parses heartbeat identity, timestamp, and outcome only", () => {
    expect(parseHeartbeatLine("kanban-pickup 2026-07-15T15:00:00Z ok cards=1 pr=x")).toEqual({
      slug: "kanban-pickup",
      ts: "2026-07-15T15:00:00Z",
      ok: "ok",
    });
    expect(parseHeartbeatLine("not enough")).toBeNull();
  });

  test("parseOpenDecisionLine keeps only status=open gates", () => {
    expect(
      parseOpenDecisionLine(
        "NEEDS-DECISION gate-a | program=x | status=open | actionable=yes — Decide something — blocks: y",
      ),
    ).toEqual({
      slug: "gate-a",
      title: "Decide something",
      status: "open",
    });
    expect(
      parseOpenDecisionLine(
        "NEEDS-DECISION gate-b | program=x | status=resolved | resolved=2026-07-01 — Done — unblocked: z",
      ),
    ).toBeNull();
  });

  test("buildDeliveryStageRequest targets the single BrainAdminSnapshot hash key", () => {
    const req = buildDeliveryStageRequest({
      schemaHash: "hash-BrainAdminSnapshot",
      slug: ADMIN_SNAPSHOT_SLUG,
      recipient: {
        recipientPubkey: "recipient-ed25519",
        messagingPublicKey: "messaging-x25519",
        messagingPseudonym: "00000000-0000-0000-0000-000000000001",
        recipientDisplayName: "admin",
      },
      maxRecords: 3,
    });
    expect(req).toMatchObject({
      recipient_pubkey: "recipient-ed25519",
      mode: "snapshot",
      max_records: 3,
    });
    expect(req.legs).toHaveLength(1);
    expect(req.legs[0]).toMatchObject({
      schema_name: "hash-BrainAdminSnapshot",
      hash_keys: [ADMIN_SNAPSHOT_SLUG],
    });
    expect(req.legs[0]!.fields).toEqual([...SNAPSHOT_FIELDS]);
  });

  test("publish + deliver stage/approve with injected clients", async () => {
    const node = mockNode({});
    const mutations: Array<{ kind: "create" | "update"; schemaHash: string }> = [];
    node.createRecord = async ({ schemaHash }) => {
      mutations.push({ kind: "create", schemaHash });
    };
    node.updateRecord = async ({ schemaHash }) => {
      mutations.push({ kind: "update", schemaHash });
    };
    node.queryByKey = async () => null;

    const cfg = buildTestCfg();
    cfg.schemaHashes[ADMIN_SNAPSHOT_SCHEMA_KEY] = "hash-BrainAdminSnapshot";

    const published = await publishAdminSnapshot({
      cfg,
      node,
      dryRun: true,
      now: NOW,
    });
    expect(published.written).toBe(false);
    expect(published.delivery_stage.legs[0]!.hash_keys).toEqual([ADMIN_SNAPSHOT_SLUG]);
    expect(mutations.filter((m) => m.schemaHash === cfg.schemaHashes[ADMIN_SNAPSHOT_SCHEMA_KEY])).toEqual([]);

    const delivery: LastDbDeliveryClient = {
      async stageDelivery(request) {
        expect(request.legs[0]!.hash_keys).toEqual([ADMIN_SNAPSHOT_SLUG]);
        return {
          deliveryId: "delivery-1",
          recordCount: 1,
          fields: [...SNAPSHOT_FIELDS],
          note: "staged only",
        };
      },
      async approveDelivery(deliveryId) {
        return { deliveryId, shared: 1, messageType: "delivery_slice" };
      },
    };

    const delivered = await deliverAdminSnapshot({
      cfg,
      node,
      deliveryClient: delivery,
      approve: true,
      maxRecords: 2,
      recipient: {
        recipientPubkey: "pk",
        messagingPublicKey: "mk",
        messagingPseudonym: "pseudo",
      },
      now: NOW,
    });
    expect(delivered.staged?.deliveryId).toBe("delivery-1");
    expect(delivered.approved?.messageType).toBe("delivery_slice");
    expect(delivered.delivery_request.max_records).toBe(2);
  });
});
