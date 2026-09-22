/**
 * Which brain is PRIMARY on this host.
 *
 * `~/.claude/brain-config.json` `.primary` is the workspace switch that says
 * which store holds the settled corpus (it also drives the recall hook). Since
 * 2026-09-06 it can be `gbrain`: the LastDB brain then holds only what was
 * written to it after that cutover (measured 2026-09-22: design=1, decision=3,
 * preference=2 records against gbrain's ~12,900 pages).
 *
 * Remedy text must read this switch. The list-index guard used to prescribe
 * `reindex --list-index` unconditionally; on a non-primary node that re-stamps
 * "complete" over a near-empty corpus, and any fail-closed gate that reads the
 * marker then passes vacuously (papercut
 * papercut-brain-list-index-reindex-hint-disarms-gate-when-gbrain-primary-20260922).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function brainConfigPath(): string {
  return process.env.BRAIN_PRIMARY_CONFIG ?? join(homedir(), ".claude", "brain-config.json");
}

/** `.primary` from the workspace brain config, or null when unset/unreadable. */
export function primaryBrain(path = brainConfigPath()): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object") {
      const p = (raw as { primary?: unknown }).primary;
      if (typeof p === "string" && p.trim()) return p.trim();
    }
  } catch {
    // Missing or unreadable config: treat as "this brain is primary".
  }
  return null;
}

/** True when another store (for example gbrain) is primary on this host. */
export function lastdbBrainIsNotPrimary(path = brainConfigPath()): boolean {
  const p = primaryBrain(path);
  return p !== null && p !== "brain" && p !== "fbrain";
}

/**
 * Remedy for an incomplete record-list index partition. Prescribes the
 * reindex only when this brain is primary.
 */
export function listIndexRepairHint(type: string, path = brainConfigPath()): string {
  if (lastdbBrainIsNotPrimary(path)) {
    const p = primaryBrain(path);
    return (
      `This LastDB brain is NOT the primary brain (.primary=${p} in ${path}). ` +
      `Do NOT run \`brain reindex --list-index\` here: it would stamp \`${type}\` complete over the ` +
      "small post-cutover corpus, and a fail-closed gate that reads the marker would then pass vacuously. " +
      `Read the primary instead (for gbrain: \`gbrain search "<q>" --types ${type}\` or \`gbrain get ${type}/<slug>\`), ` +
      "or point-read a known slug here with `brain get <slug>`."
    );
  }
  return (
    "Point-read a known slug with `brain get <slug>` meanwhile. " +
    "Repair: run `brain reindex --list-index` (admin/offline) to rebuild the partition from source of truth, then retry."
  );
}
