import { describe, expect, test } from "bun:test";

import {
  ADMIN_SNAPSHOT_SLUG,
  SNAPSHOT_FIELDS,
  buildDeliveryStageRequest,
  deliverAdminSnapshot,
  parseHeartbeatLine,
  parseOpenDecisionLine,
  publishAdminSnapshot,
  snapshotToFields,
  type BrainAdminSnapshot,
  type LastDbDeliveryClient,
} from "../../src/commands/admin-snapshot.ts";
import type { NodeClient, QueryRow, RawResponse } from "../../src/client.ts";
import type { Config } from "../../src/config.ts";
import { ADMIN_SNAPSHOT_SCHEMA_KEY, RECORD_TYPES } from "../../src/schemas.ts";

function baseSnapshot(overrides: Partial<BrainAdminSnapshot> = {}): BrainAdminSnapshot {
  const type_counts = Object.fromEntries(RECORD_TYPES.map((t) => [t, 0])) as BrainAdminSnapshot["type_counts"];
  type_counts.reference = 2;
  type_counts.project = 1;
  return {
    slug: ADMIN_SNAPSHOT_SLUG,
    source_app: "fbrain",
    schema_version: "1",
    captured_at: "2026-07-15T12:00:00.000Z",
    type_counts,
    open_decisions: [{ slug: "gate-a", title: "Decide A", status: "open" }],
    active_programs_head: [
      {
        slug: "active-programs",
        title: "Active programs",
        status: "planning",
        lines: ["# Active programs", "**program-slug:** north-star-x"],
      },
    ],
    recent_heartbeats: [{ slug: "kanban-pickup", ts: "2026-07-15T11:00:00Z", ok: "ok" }],
    ...overrides,
  };
}

function makeCfg(schemaHash = "hash-BrainAdminSnapshot"): Config {
  return {
    nodeUrl: "http://127.0.0.1:9",
    schemaServiceUrl: "http://127.0.0.1:9",
    userHash: "user",
    schemaHashes: {
      [ADMIN_SNAPSHOT_SCHEMA_KEY]: schemaHash,
      reference: "hash-ref",
      project: "hash-proj",
      design: "hash-design",
      task: "hash-task",
      concept: "hash-concept",
      preference: "hash-pref",
      agent: "hash-agent",
      spike: "hash-spike",
      sop: "hash-sop",
      decision: "hash-decision",
    },
  } as unknown as Config;
}

function makeNode(opts: {
  existing?: boolean;
  rawCalls?: Array<{ method: string; path: string; body?: unknown }>;
} = {}): NodeClient {
  const rawCalls = opts.rawCalls ?? [];
  return {
    baseUrl: "http://127.0.0.1:9",
    async autoIdentity() {
      return { userHash: "user" };
    },
    async health() {
      return { status: "ok" };
    },
    async bootstrap() {
      return { user_hash: "user" };
    },
    async consentStatus() {
      return { status: "granted" };
    },
    async grantConsent() {
      return { status: "granted" };
    },
    async loadSchemas() {
      return { available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] };
    },
    async listLoadedSchemas() {
      return [];
    },
    async createRecord() {},
    async updateRecord() {},
    async deleteRecord() {},
    async queryAll(_opts: { schemaHash: string; fields: string[] }) {
      return { results: [], total_count: 0 };
    },
    async queryByKey(q: { keyHash: string }): Promise<QueryRow | null> {
      if (opts.existing) {
        return { key: { hash: q.keyHash, range: null }, fields: { slug: q.keyHash } };
      }
      return null;
    },
    async search() {
      return [];
    },
    async rawCall(method: string, path: string, body?: unknown): Promise<RawResponse> {
      rawCalls.push({ method, path, body });
      if (path === "/api/sharing/deliver") {
        return {
          status: 200,
          headers: new Headers(),
          body: "",
          json: {
            data: {
              note: "staged",
              delivery: {
                delivery_id: "delivery-brain-1",
                preview: { record_count: 1, fields: [...SNAPSHOT_FIELDS] },
              },
            },
          },
        };
      }
      if (path.includes("/approve")) {
        return {
          status: 200,
          headers: new Headers(),
          body: "",
          json: {
            data: {
              delivery_id: "delivery-brain-1",
              shared: 1,
              message_type: "delivery_slice",
            },
          },
        };
      }
      return { status: 404, headers: new Headers(), body: "missing", json: null };
    },
  } as unknown as NodeClient;
}

describe("parseHeartbeatLine", () => {
  test("parses slug/ts/ok and ignores the rest", () => {
    expect(
      parseHeartbeatLine(
        "kanban-pickup 2026-07-15T15:50:53Z ok cards=1 worked=foo result=merged",
      ),
    ).toEqual({
      slug: "kanban-pickup",
      ts: "2026-07-15T15:50:53Z",
      ok: "ok",
    });
  });

  test("rejects non-timestamp second token", () => {
    expect(parseHeartbeatLine("foo bar baz")).toBeNull();
  });
});

describe("parseOpenDecisionLine", () => {
  test("parses live open gates only", () => {
    const line =
      "NEEDS-DECISION lastgit-migrate-fold-last | program=north-star-lastgit-native-forge | status=open | actionable=no | surfaced=2026-07-14 — Clear fold becoming LastGit-primary — blocks: fold LastGit-primary migration.";
    expect(parseOpenDecisionLine(line)).toEqual({
      slug: "lastgit-migrate-fold-last",
      title: "Clear fold becoming LastGit-primary",
      status: "open",
    });
  });

  test("skips resolved gates", () => {
    const line =
      "NEEDS-DECISION already-done | program=x | status=resolved | resolved=2026-07-13 — Done — unblocked: y.";
    expect(parseOpenDecisionLine(line)).toBeNull();
  });
});

describe("snapshotToFields", () => {
  test("serializes only string fields — no nested bodies", () => {
    const fields = snapshotToFields(baseSnapshot());
    expect(Object.keys(fields).sort()).toEqual([...SNAPSHOT_FIELDS].sort());
    for (const value of Object.values(fields)) {
      expect(typeof value).toBe("string");
    }
    expect(fields.open_decisions_json).toContain("gate-a");
    expect(fields.open_decisions_json).not.toContain("full body secret");
  });
});

describe("buildDeliveryStageRequest", () => {
  test("targets the single BrainAdminSnapshot hash key", () => {
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
      recipient_display_name: "admin",
      messaging_public_key: "messaging-x25519",
      messaging_pseudonym: "00000000-0000-0000-0000-000000000001",
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
});

describe("publishAdminSnapshot", () => {
  test("dry-run builds delivery stage plan without writing", async () => {
    const writes: string[] = [];
    const node = makeNode();
    const originalCreate = node.createRecord;
    node.createRecord = async () => {
      writes.push("create");
      return originalCreate.call(node, {
        schemaHash: "x",
        fields: {},
        keyHash: "y",
      });
    };
    const lines: string[] = [];
    const result = await publishAdminSnapshot({
      cfg: makeCfg(),
      node,
      dryRun: true,
      now: new Date("2026-07-15T12:00:00.000Z"),
      print: (line) => lines.push(line),
    });
    expect(result.written).toBe(false);
    expect(result.dry_run).toBe(true);
    expect(result.record_key).toBe(ADMIN_SNAPSHOT_SLUG);
    expect(result.delivery_stage.legs[0]!.hash_keys).toEqual([ADMIN_SNAPSHOT_SLUG]);
    expect(writes).toEqual([]);
    expect(lines.join("\n")).toContain("DRY-RUN");
  });

  test("upserts when schema hash is already configured", async () => {
    const mutations: Array<"create" | "update"> = [];
    const node = makeNode({ existing: false });
    node.createRecord = async () => {
      mutations.push("create");
    };
    node.updateRecord = async () => {
      mutations.push("update");
    };
    const result = await publishAdminSnapshot({
      cfg: makeCfg(),
      node,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(result.written).toBe(true);
    expect(mutations).toEqual(["create"]);
  });
});

describe("deliverAdminSnapshot", () => {
  test("publishes, stages, and optionally approves", async () => {
    const delivery: LastDbDeliveryClient = {
      stagedRequests: [] as unknown[],
      approvedIds: [] as string[],
      async stageDelivery(request) {
        (this.stagedRequests as unknown[]).push(request);
        return {
          deliveryId: "delivery-1",
          recordCount: 1,
          fields: [...SNAPSHOT_FIELDS],
          note: "staged only",
        };
      },
      async approveDelivery(deliveryId) {
        (this.approvedIds as string[]).push(deliveryId);
        return {
          deliveryId,
          shared: 1,
          messageType: "delivery_slice",
        };
      },
    } as LastDbDeliveryClient & {
      stagedRequests: unknown[];
      approvedIds: string[];
    };

    const node = makeNode();
    node.createRecord = async () => {};
    const result = await deliverAdminSnapshot({
      cfg: makeCfg(),
      node,
      deliveryClient: delivery,
      approve: true,
      maxRecords: 2,
      recipient: {
        recipientPubkey: "recipient-ed25519",
        messagingPublicKey: "messaging-x25519",
        messagingPseudonym: "00000000-0000-0000-0000-000000000001",
      },
      now: new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(result.staged?.deliveryId).toBe("delivery-1");
    expect(result.approved?.messageType).toBe("delivery_slice");
    expect(result.delivery_request.max_records).toBe(2);
    expect(result.delivery_request.legs[0]!.hash_keys).toEqual([ADMIN_SNAPSHOT_SLUG]);
  });

  test("dry-run stages nothing", async () => {
    let staged = 0;
    const result = await deliverAdminSnapshot({
      cfg: makeCfg(),
      node: makeNode(),
      dryRun: true,
      deliveryClient: {
        async stageDelivery() {
          staged += 1;
          throw new Error("should not stage");
        },
        async approveDelivery() {
          throw new Error("should not approve");
        },
      },
      recipient: {
        recipientPubkey: "pk",
        messagingPublicKey: "mk",
        messagingPseudonym: "pseudo",
      },
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(result.staged).toBeNull();
    expect(result.approved).toBeNull();
    expect(staged).toBe(0);
  });
});
