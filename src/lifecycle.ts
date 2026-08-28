// Pure helpers for the record-lifecycle keep set.
// Membership lives in HashRange indexes (see lifecycle-index.ts), not in a
// list-of-slugs field.

import type { FbrainRecord } from "./record.ts";
import type { RecordType } from "./schemas.ts";

export const TOPIC_TAG_PREFIX = "topic:";
export const SERIES_TAG_PREFIX = "series:";
export const EPH_DAY_TAG_PREFIX = "eph-day:";
export const CANONICAL_TAG = "canonical";

export const EPH_RETENTION_DAYS = 14;
export const EPH_REAP_LOOKBACK_DAYS = 45;

export function tagValue(tags: readonly string[], prefix: string): string | null {
  for (const t of tags) {
    if (t.startsWith(prefix) && t.length > prefix.length) {
      return t.slice(prefix.length);
    }
  }
  return null;
}

export function hasTag(tags: readonly string[], exact: string): boolean {
  return tags.includes(exact);
}

export function topicFromTags(tags: readonly string[]): string | null {
  return tagValue(tags, TOPIC_TAG_PREFIX);
}

export function seriesFromTags(tags: readonly string[]): string | null {
  return tagValue(tags, SERIES_TAG_PREFIX);
}

export function ephDayFromTags(tags: readonly string[]): string | null {
  return tagValue(tags, EPH_DAY_TAG_PREFIX);
}

export function isEphRecord(record: FbrainRecord): boolean {
  return seriesFromTags(record.tags) !== null && ephDayFromTags(record.tags) !== null;
}

/** Live = default ask may return this row. Ephemeral closeouts are never live. */
export function isLiveStatus(type: RecordType, status: string): boolean {
  switch (type) {
    case "preference":
    case "sop":
    case "concept":
    case "reference":
    case "agent":
    case "spike":
      return status === "active";
    case "papercut":
      return status === "open" || status === "partial";
    case "project":
      return status === "planning" || status === "in_progress";
    case "design":
      return (
        status === "draft" ||
        status === "reviewed" ||
        status === "approved" ||
        status === "implemented"
      );
    case "task":
      return status !== "done" && status !== "cancelled";
    case "decision":
      return true;
    default:
      return false;
  }
}

export function uniqueFacts(canonicalBody: string, loserBody: string): string[] {
  const paras = loserBody
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paras.filter((p) => !canonicalBody.includes(p));
}

export function factBlock(fact: string, sourceSlug: string, date: string): string {
  return `### FACT · ${date} · from ${sourceSlug}\n\n${fact}`;
}

export type ClusterMember = {
  type: RecordType;
  slug: string;
  record: FbrainRecord;
};

export function pickCanonical(members: ClusterMember[]): ClusterMember {
  const tagged = members.find((m) => hasTag(m.record.tags, CANONICAL_TAG));
  if (tagged) return tagged;
  const named = members.find((m) =>
    members.some(
      (o) => o.slug !== m.slug && o.record.body.includes(`[[${m.slug}]]`),
    ),
  );
  if (named) return named;
  const sorted = [...members].sort((a, b) => {
    const ac = a.record.created_at ?? "";
    const bc = b.record.created_at ?? "";
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.slug < b.slug ? -1 : 1;
  });
  return sorted[0]!;
}

export function utcDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addUtcDays(isoDay: string, delta: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return utcDay(dt);
}

/** Day hashes the reaper may name: expired days inside a bounded lookback. */
export function expiredEphDays(
  today: string,
  retentionDays = EPH_RETENTION_DAYS,
  lookbackDays = EPH_REAP_LOOKBACK_DAYS,
): string[] {
  const out: string[] = [];
  for (let i = retentionDays; i < retentionDays + lookbackDays; i++) {
    out.push(addUtcDays(today, -i));
  }
  return out;
}

export function ephHash(series: string, day: string): string {
  return `${series}:${day}`;
}
