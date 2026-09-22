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

// ── Point-read fallback to the primary brain ────────────────────────────────
// While another brain is primary, settled records (SOPs, decisions, designs,
// preferences) live there, and the LastDB brain holds only what was written
// after the cutover. Instructions and routines still say `brain get <slug>`,
// so every such read missed: sop-forge-pr-workflow, open-cutovers,
// design-lastdb-platform-work-for-git-forge, the venue decision, and more
// (eleven papercuts, 2026-09-20..22). A MISS here now falls back to one
// point read on the primary, and says so on stderr. Writes are unchanged.

/** gbrain page directory for a record type (concepts live under wiki/). */
const GBRAIN_TYPE_DIRS: Record<string, string> = {
  concept: "wiki/concepts",
  concepts: "wiki/concepts",
  projects: "projects",
};

/** Candidate gbrain page paths for a bare slug, best guess first. */
export function gbrainCandidatePaths(slug: string, type?: string): string[] {
  if (slug.includes("/")) return [slug];
  const out: string[] = [];
  const add = (dir: string | undefined) => {
    if (!dir) return;
    const p = `${dir}/${slug}`;
    if (!out.includes(p)) out.push(p);
  };
  if (type) add(GBRAIN_TYPE_DIRS[type] ?? type);
  const head = slug.split("-", 1)[0]!.toLowerCase();
  for (const key of [head, head.replace(/s$/, ""), `${head}s`]) {
    if (["design", "decision", "preference", "reference", "sop", "task", "project", "spike", "agent", "papercut"].includes(key)) {
      add(key);
    }
    if (key === "concept" || key === "concepts") add("wiki/concepts");
  }
  // Records whose slug does not start with a type word (open-cutovers,
  // routine-heartbeats) are most often references.
  add("reference");
  if (type === "project" || head === "project") add("projects");
  return out;
}

function gbrainBin(): string | null {
  if (process.env.GBRAIN_BIN) return process.env.GBRAIN_BIN;
  const onPath = Bun.which("gbrain");
  if (onPath) return onPath;
  const bunGlobal = join(homedir(), ".bun", "bin", "gbrain");
  try {
    readFileSync(bunGlobal);
    return bunGlobal;
  } catch {
    return null;
  }
}

export type PrimaryRead = { path: string; text: string };

/**
 * One point read on the primary brain, or null. Only gbrain is supported;
 * each candidate path is one `gbrain get` with a bounded timeout.
 */
export function readFromPrimary(slug: string, type?: string, cfgPath = brainConfigPath()): PrimaryRead | null {
  if (!lastdbBrainIsNotPrimary(cfgPath)) return null;
  if (primaryBrain(cfgPath) !== "gbrain") return null;
  const bin = gbrainBin();
  if (!bin) return null;
  const timeoutMs = Number(process.env.BRAIN_PRIMARY_FALLBACK_TIMEOUT_MS ?? 30_000);
  for (const path of gbrainCandidatePaths(slug, type)) {
    const proc = Bun.spawnSync([bin, "get", path], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : 30_000,
    });
    if (proc.exitCode === 0) {
      const text = proc.stdout.toString();
      if (text.trim().length > 0) return { path, text };
    }
  }
  return null;
}
