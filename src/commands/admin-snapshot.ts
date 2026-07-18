// Privacy-safe brain admin snapshot publisher + LastDB deliver dogfood.
//
// Mirrors the routines `publish-status` / `deliver-status` pattern: write a
// slim Mini record (counts + short summaries only — NEVER full brain bodies),
// then stage (and optionally approve) a delivery_slice to the existing admin
// kanban-consumer recipient.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { FbrainError, newReadClientFromCfg, type NodeClient, type QueryRow, type Verbose } from "../client.ts";
import { writeConfig, type Config } from "../config.ts";
import { findBySlug, isTombstoned, listRecords, schemaHashFor, type FbrainRecord } from "../record.ts";
import {
  ADMIN_SNAPSHOT_SCHEMA_KEY,
  OWNER_APP_ID,
  RECORD_TYPES,
  adminSnapshotSchema,
  type RecordType,
} from "../schemas.ts";

export const ADMIN_SNAPSHOT_SLUG = "admin-brain-snapshot";
export const ADMIN_SNAPSHOT_SCHEMA_VERSION = "1";
export const SNAPSHOT_FIELDS = [
  "slug",
  "source_app",
  "schema_version",
  "captured_at",
  "type_counts_json",
  "open_decisions_json",
  "active_programs_head_json",
  "recent_heartbeats_json",
] as const;

export type BrainAdminSnapshot = {
  slug: string;
  source_app: "fbrain";
  schema_version: string;
  captured_at: string;
  type_counts: Record<RecordType, number>;
  /** Live open-decisions ledger lines: slug + short title only (no bodies). */
  open_decisions: Array<{ slug: string; title: string; status: string }>;
  active_programs_head: Array<{ slug: string; title: string; status: string; lines: string[] }>;
  /** Recent heartbeats: routine slug / timestamp / ok|noop|error token. */
  recent_heartbeats: Array<{ slug: string; ts: string; ok: string }>;
};

export type DeliveryRecipient = {
  recipientPubkey: string;
  messagingPublicKey: string;
  messagingPseudonym: string;
  recipientDisplayName?: string;
};

export type DeliveryStageRequest = {
  recipient_pubkey: string;
  recipient_display_name?: string;
  messaging_public_key: string;
  messaging_pseudonym: string;
  mode: "snapshot";
  max_records: number;
  legs: Array<{
    schema_name: string;
    fields: string[];
    hash_keys?: string[];
  }>;
};

export type DeliveryStageResult = {
  deliveryId: string;
  recordCount: number;
  fields: string[];
  note: string;
};

export type DeliveryApproveResult = {
  deliveryId: string;
  shared: number;
  messageType: string;
};

export type LastDbDeliveryClient = {
  stageDelivery(request: DeliveryStageRequest): Promise<DeliveryStageResult>;
  approveDelivery(deliveryId: string): Promise<DeliveryApproveResult>;
};

export type PublishAdminSnapshotResult = {
  snapshot: BrainAdminSnapshot;
  schema_hash: string;
  record_key: string;
  written: boolean;
  dry_run: boolean;
  delivery_stage: {
    schema_name: string;
    legs: Array<{
      schema_name: string;
      fields: string[];
      hash_keys: string[];
    }>;
  };
};

export type DeliverAdminSnapshotResult = PublishAdminSnapshotResult & {
  delivery_request: DeliveryStageRequest;
  staged: DeliveryStageResult | null;
  approved: DeliveryApproveResult | null;
};

export type PublishAdminSnapshotOptions = {
  cfg: Config;
  slug?: string;
  dryRun?: boolean;
  json?: boolean;
  now?: Date;
  node?: NodeClient;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type DeliverAdminSnapshotOptions = PublishAdminSnapshotOptions & {
  recipient: DeliveryRecipient;
  maxRecords?: number;
  approve?: boolean;
  deliveryClient?: LastDbDeliveryClient;
};

export async function publishAdminSnapshot(
  opts: PublishAdminSnapshotOptions,
): Promise<PublishAdminSnapshotResult> {
  const node = opts.node ?? newReadClientFromCfg(opts.cfg, opts.verbose);
  const slug = opts.slug ?? ADMIN_SNAPSHOT_SLUG;
  const now = opts.now ?? new Date();
  const schemaHash = await ensureAdminSnapshotSchema(node, opts.cfg, {
    persist: !opts.dryRun,
  });
  const snapshot = await buildBrainAdminSnapshot(node, opts.cfg, { slug, now });
  if (!opts.dryRun) {
    await upsertSnapshotRecord(node, schemaHash, snapshot);
  }
  const result: PublishAdminSnapshotResult = {
    snapshot,
    schema_hash: schemaHash,
    record_key: slug,
    written: !opts.dryRun,
    dry_run: opts.dryRun === true,
    delivery_stage: {
      schema_name: schemaHash,
      legs: [
        {
          schema_name: schemaHash,
          fields: [...SNAPSHOT_FIELDS],
          hash_keys: [slug],
        },
      ],
    },
  };
  if (opts.json) {
    opts.print?.(JSON.stringify(result));
  } else {
    const action = opts.dryRun ? "DRY-RUN" : "published";
    opts.print?.(
      [
        `${action} ${slug} (${snapshot.captured_at})`,
        `schema_name: ${schemaHash}`,
        `fields: ${SNAPSHOT_FIELDS.join(",")}`,
        `hash_keys: ${slug}`,
        `type_counts: ${summarizeTypeCounts(snapshot.type_counts)}`,
        `open_decisions: ${snapshot.open_decisions.length}`,
        `heartbeats: ${snapshot.recent_heartbeats.length}`,
      ].join("\n"),
    );
  }
  return result;
}

export async function deliverAdminSnapshot(
  opts: DeliverAdminSnapshotOptions,
): Promise<DeliverAdminSnapshotResult> {
  // Publish quietly — deliver owns the single human/JSON result document.
  const publication = await publishAdminSnapshot({
    ...opts,
    json: false,
    print: undefined,
  });
  const deliveryRequest = buildDeliveryStageRequest({
    schemaHash: publication.schema_hash,
    slug: publication.record_key,
    recipient: opts.recipient,
    maxRecords: opts.maxRecords,
  });

  if (opts.dryRun) {
    const result: DeliverAdminSnapshotResult = {
      ...publication,
      delivery_request: deliveryRequest,
      staged: null,
      approved: null,
    };
    if (opts.json) {
      opts.print?.(JSON.stringify(result));
    } else {
      opts.print?.(
        [
          `DRY-RUN brain admin delivery slug=${publication.record_key} max_records=${deliveryRequest.max_records}`,
          `schema_name: ${publication.schema_hash}`,
          `legs: ${deliveryRequest.legs.length}`,
        ].join("\n"),
      );
    }
    return result;
  }

  const client =
    opts.deliveryClient ??
    newLastDbDeliveryClient(opts.node ?? newReadClientFromCfg(opts.cfg, opts.verbose));
  const staged = await client.stageDelivery(deliveryRequest);
  const approved = opts.approve ? await client.approveDelivery(staged.deliveryId) : null;
  const result: DeliverAdminSnapshotResult = {
    ...publication,
    delivery_request: deliveryRequest,
    staged,
    approved,
  };
  if (opts.json) {
    opts.print?.(JSON.stringify(result));
  } else if (approved) {
    opts.print?.(
      [
        `DELIVERED brain admin snapshot delivery_id=${approved.deliveryId} shared=${approved.shared} message_type=${approved.messageType}`,
        `schema_name: ${publication.schema_hash}`,
        `record_count: ${staged.recordCount}`,
      ].join("\n"),
    );
  } else {
    opts.print?.(
      [
        `STAGED brain admin snapshot delivery_id=${staged.deliveryId} records=${staged.recordCount}; re-run with --approve to send`,
        `schema_name: ${publication.schema_hash}`,
      ].join("\n"),
    );
  }
  return result;
}

export function buildDeliveryStageRequest(opts: {
  schemaHash: string;
  slug: string;
  recipient: DeliveryRecipient;
  maxRecords?: number;
}): DeliveryStageRequest {
  const maxRecords = positiveInt(opts.maxRecords, 5);
  return {
    recipient_pubkey: opts.recipient.recipientPubkey,
    ...(opts.recipient.recipientDisplayName
      ? { recipient_display_name: opts.recipient.recipientDisplayName }
      : {}),
    messaging_public_key: opts.recipient.messagingPublicKey,
    messaging_pseudonym: opts.recipient.messagingPseudonym,
    mode: "snapshot",
    max_records: maxRecords,
    legs: [
      {
        schema_name: opts.schemaHash,
        fields: [...SNAPSHOT_FIELDS],
        hash_keys: [opts.slug],
      },
    ],
  };
}

export async function buildBrainAdminSnapshot(
  node: NodeClient,
  cfg: Config,
  opts: { slug?: string; now?: Date } = {},
): Promise<BrainAdminSnapshot> {
  const slug = opts.slug ?? ADMIN_SNAPSHOT_SLUG;
  const now = opts.now ?? new Date();
  const byType = new Map<RecordType, FbrainRecord[]>();
  for (const type of RECORD_TYPES) {
    byType.set(type, await safeListLiveRecords(node, cfg, type));
  }

  const typeCounts = Object.fromEntries(
    RECORD_TYPES.map((type) => [type, byType.get(type)?.length ?? 0]),
  ) as Record<RecordType, number>;

  return {
    slug,
    source_app: "fbrain",
    schema_version: ADMIN_SNAPSHOT_SCHEMA_VERSION,
    captured_at: now.toISOString(),
    type_counts: typeCounts,
    open_decisions: await buildOpenDecisionLines(node, cfg),
    active_programs_head: await buildActiveProgramsHead(node, cfg),
    recent_heartbeats: await buildRecentHeartbeats(node, cfg),
  };
}

export function snapshotToFields(snapshot: BrainAdminSnapshot): Record<string, string> {
  return {
    slug: snapshot.slug,
    source_app: snapshot.source_app,
    schema_version: snapshot.schema_version,
    captured_at: snapshot.captured_at,
    type_counts_json: JSON.stringify(snapshot.type_counts),
    open_decisions_json: JSON.stringify(snapshot.open_decisions),
    active_programs_head_json: JSON.stringify(snapshot.active_programs_head),
    recent_heartbeats_json: JSON.stringify(snapshot.recent_heartbeats),
  };
}

/** Parse one routine-heartbeats body line: `<slug> <ts> <ok> …`. */
export function parseHeartbeatLine(line: string): { slug: string; ts: string; ok: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;
  const [slug, ts, ok] = parts;
  if (!slug || !ts || !ok) return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(ts)) return null;
  return { slug, ts, ok };
}

/**
 * Parse a live open-decisions ledger line.
 * Format: `NEEDS-DECISION <slug> | … | status=open | … — <title> — blocks: …`
 */
export function parseOpenDecisionLine(
  line: string,
): { slug: string; title: string; status: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("NEEDS-DECISION ")) return null;
  if (!/\bstatus=open\b/.test(trimmed)) return null;
  const afterPrefix = trimmed.slice("NEEDS-DECISION ".length);
  const pipeIdx = afterPrefix.indexOf("|");
  const slug = (pipeIdx === -1 ? afterPrefix : afterPrefix.slice(0, pipeIdx)).trim();
  if (!slug || !/^[a-z0-9][a-z0-9-_]*$/i.test(slug)) return null;
  // Prefer the free-text after the first em/en dash separator (title prose).
  const dashMatch = afterPrefix.match(/\s[—–-]\s+(.+?)(?:\s[—–-]\s+(?:blocks|unblocked):|$)/);
  let title = dashMatch?.[1]?.trim() ?? "";
  if (!title) {
    // Fallback: use the slug as title so the payload stays non-empty.
    title = slug;
  }
  // Hard cap — titles only, never full bodies.
  if (title.length > 180) title = `${title.slice(0, 179)}…`;
  return { slug, title, status: "open" };
}

export function newLastDbDeliveryClient(node: NodeClient): LastDbDeliveryClient {
  return {
    async stageDelivery(request) {
      const res = await node.rawCall("POST", "/api/sharing/deliver", request);
      if (res.status < 200 || res.status >= 300) {
        throw new FbrainError({
          code: "delivery_stage_failed",
          message: `LastDB deliver stage returned ${res.status}: ${messageFor(res.json ?? res.body)}`,
          hint: "Confirm Mini is signed in to Exemem and the recipient keys match the admin kanban-consumer bundle.",
        });
      }
      const data = dataObject(res.json);
      const delivery = dataObject(data.delivery);
      const preview = dataObject(delivery.preview);
      const deliveryId = objectString(delivery, "delivery_id");
      if (!deliveryId) {
        throw new FbrainError({
          code: "delivery_stage_bad_response",
          message: "LastDB deliver stage returned no delivery_id.",
        });
      }
      return {
        deliveryId,
        recordCount: objectNumber(preview, "record_count"),
        fields: objectStringArray(preview, "fields"),
        note: objectString(data, "note"),
      };
    },
    async approveDelivery(deliveryId) {
      const res = await node.rawCall(
        "POST",
        `/api/sharing/deliveries/${encodeURIComponent(deliveryId)}/approve`,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new FbrainError({
          code: "delivery_approve_failed",
          message: `LastDB deliver approve returned ${res.status}: ${messageFor(res.json ?? res.body)}`,
        });
      }
      const data = dataObject(res.json);
      return {
        deliveryId: objectString(data, "delivery_id") || deliveryId,
        shared: objectNumber(data, "shared"),
        messageType: objectString(data, "message_type"),
      };
    },
  };
}

async function ensureAdminSnapshotSchema(
  node: NodeClient,
  cfg: Config,
  opts: { persist: boolean },
): Promise<string> {
  const existing = cfg.schemaHashes[ADMIN_SNAPSHOT_SCHEMA_KEY];
  if (existing) return existing;
  if (!node.declareAppSchema) {
    throw new FbrainError({
      code: "admin_snapshot_schema_unavailable",
      message: "This node cannot declare the fbrain admin snapshot schema.",
      hint: "Run `fbrain init` against a current Mini node, then retry `fbrain admin-snapshot publish`.",
    });
  }
  const declared = await node.declareAppSchema(OWNER_APP_ID, adminSnapshotSchema.schema);
  cfg.schemaHashes[ADMIN_SNAPSHOT_SCHEMA_KEY] = declared.canonical;
  if (opts.persist) writeConfig(cfg);
  return declared.canonical;
}

async function upsertSnapshotRecord(
  node: NodeClient,
  schemaHash: string,
  snapshot: BrainAdminSnapshot,
): Promise<void> {
  const fields = snapshotToFields(snapshot);
  const existing = node.queryByKey
    ? await node.queryByKey({ schemaHash, fields: ["slug"], keyHash: snapshot.slug })
    : await findSnapshotRow(node, schemaHash, snapshot.slug);
  if (existing) {
    await node.updateRecord({ schemaHash, keyHash: snapshot.slug, fields });
  } else {
    await node.createRecord({ schemaHash, keyHash: snapshot.slug, fields });
  }
}

async function findSnapshotRow(
  node: NodeClient,
  schemaHash: string,
  slug: string,
): Promise<QueryRow | null> {
  const res = await node.queryAll({ schemaHash, fields: ["slug"] });
  return res.results.find((row) => row.key?.hash === slug || row.fields.slug === slug) ?? null;
}

async function safeListLiveRecords(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
): Promise<FbrainRecord[]> {
  try {
    const records = await listRecords(node, type, schemaHashFor(type, cfg), cfg);
    return records.filter((record) => !isTombstoned(record));
  } catch {
    return [];
  }
}

async function buildOpenDecisionLines(
  node: NodeClient,
  cfg: Config,
): Promise<BrainAdminSnapshot["open_decisions"]> {
  const record = await safeFindBySlug(node, cfg, "reference", "open-decisions");
  if (!record) return [];
  const lines: BrainAdminSnapshot["open_decisions"] = [];
  for (const raw of record.body.split(/\r?\n/)) {
    const parsed = parseOpenDecisionLine(raw);
    if (parsed) lines.push(parsed);
    if (lines.length >= 25) break;
  }
  return lines;
}

async function buildActiveProgramsHead(
  node: NodeClient,
  cfg: Config,
): Promise<BrainAdminSnapshot["active_programs_head"]> {
  const record = await safeFindBySlug(node, cfg, "project", "active-programs");
  if (!record) return [];
  return [
    {
      slug: record.slug,
      title: record.title,
      status: record.status,
      lines: headLines(record.body, 12, 180),
    },
  ];
}

async function buildRecentHeartbeats(
  _node: NodeClient,
  _cfg: Config,
): Promise<BrainAdminSnapshot["recent_heartbeats"]> {
  // Heartbeats live on the filesystem (not LastDB). Prefer env override, then
  // ~/.last-stack/logs/routine-heartbeats.log.
  const path =
    process.env.LAST_STACK_HEARTBEATS_FILE ||
    process.env.ROUTINES_HEARTBEATS_FILE ||
    join(homedir(), ".last-stack", "logs", "routine-heartbeats.log");
  if (!existsSync(path)) return [];
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return body
    .split(/\r?\n/)
    .map(parseHeartbeatLine)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .slice(-20)
    .reverse();
}

async function safeFindBySlug(
  node: NodeClient,
  cfg: Config,
  type: RecordType,
  slug: string,
): Promise<FbrainRecord | null> {
  try {
    const record = await findBySlug(node, type, schemaHashFor(type, cfg), slug);
    return record && !isTombstoned(record) ? record : null;
  } catch {
    return null;
  }
}

function headLines(body: string, maxLines: number, maxChars: number): string[] {
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function summarizeTypeCounts(counts: Record<RecordType, number>): string {
  return RECORD_TYPES.map((type) => `${type}=${counts[type] ?? 0}`).join(" ");
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function objectString(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function objectNumber(value: unknown, key: string): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function objectStringArray(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function dataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const nested = obj.data;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : obj;
}

function messageFor(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  return (
    objectString(body, "message") ||
    objectString(body, "error") ||
    (body ? JSON.stringify(body).slice(0, 300) : "")
  );
}
