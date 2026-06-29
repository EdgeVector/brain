// `fbrain gates` / `fbrain gate ...` — structured accessor over the single
// canonical `open-decisions` reference record. This deliberately does NOT add
// a gate schema: the markdown record remains the source of truth, with stable
// one-line field entries that a CLI can parse mechanically.

import { spawn } from "bun";

import { FbrainError, newReadClientFromCfg, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  findBySlug,
  nowIso,
  resolveBySlug,
  schemaHashFor,
  verifyRecordVisible,
  type FbrainRecord,
} from "../record.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import { RECORD_TYPES, isRecordType, type RecordType } from "../schemas.ts";

export const OPEN_DECISIONS_SLUG = "open-decisions";
const OPEN_DECISIONS_TYPE: RecordType = "reference";

export type GateStatus = "open" | "cleared";

export type GateEntry = {
  status: GateStatus;
  slug: string;
  program: string;
  unblocks: string;
  evidence: string;
  surfaced: string;
  recommendation?: string;
  cleared?: string;
  resolution?: string;
};

type LoadedLedger = {
  record: FbrainRecord;
  body: string;
};

export type GatePrintOptions = {
  cfg: Config;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type GatesOpenOptions = GatePrintOptions;

export type GateAddOptions = GatePrintOptions & {
  slug: string;
  program: string;
  unblocks: string;
  evidence: string;
  recommendation?: string;
  surfaced?: string;
};

export type GateClearOptions = GatePrintOptions & {
  slug: string;
  resolution: string;
  cleared?: string;
};

export type EvidenceCheck = {
  stale: boolean;
  detail: string;
};

export type GateVerifyOptions = GatePrintOptions & {
  checkEvidence?: (evidence: string, cfg: Config) => Promise<EvidenceCheck>;
};

export async function gatesOpen(opts: GatesOpenOptions): Promise<GateEntry[]> {
  const print = resolvePrintSink(opts);
  const { body } = await loadOpenDecisions(opts.cfg, opts.verbose);
  const open = parseGateEntries(body).filter((g) => g.status === "open");
  if (open.length === 0) {
    print("(no open gates)");
    return open;
  }
  for (const gate of open) {
    print(
      `${gate.slug} · program=${gate.program} · unblocks=${gate.unblocks} · evidence=${gate.evidence} · surfaced=${gate.surfaced}`,
    );
  }
  return open;
}

export async function gateAdd(opts: GateAddOptions): Promise<GateEntry> {
  const print = resolvePrintSink(opts);
  const entry: GateEntry = {
    status: "open",
    slug: opts.slug,
    program: opts.program,
    unblocks: opts.unblocks,
    evidence: opts.evidence,
    surfaced: opts.surfaced ?? today(),
  };
  if (opts.recommendation !== undefined) entry.recommendation = opts.recommendation;
  const loaded = await loadOpenDecisions(opts.cfg, opts.verbose);
  const nextBody = addGateToBody(loaded.body, entry);
  if (nextBody === loaded.body) {
    print(`gate already present: ${entry.slug}`);
    return entry;
  }
  await writeOpenDecisions(opts.cfg, loaded.record, nextBody, opts.verbose);
  print(`added gate ${entry.slug}`);
  return entry;
}

export async function gateClear(opts: GateClearOptions): Promise<GateEntry> {
  const print = resolvePrintSink(opts);
  const loaded = await loadOpenDecisions(opts.cfg, opts.verbose);
  const result = clearGateInBody(
    loaded.body,
    opts.slug,
    opts.resolution,
    opts.cleared ?? today(),
  );
  if (!result.cleared) {
    throw new FbrainError({
      code: "not_found",
      message: `No open gate with slug "${opts.slug}".`,
      hint: "Run `fbrain gates --open` to see live gates.",
    });
  }
  await writeOpenDecisions(opts.cfg, loaded.record, result.body, opts.verbose);
  print(`cleared gate ${opts.slug}`);
  return result.entry;
}

export async function gateVerify(opts: GateVerifyOptions): Promise<{
  stale: GateEntry[];
  checked: GateEntry[];
}> {
  const print = resolvePrintSink(opts);
  const { body } = await loadOpenDecisions(opts.cfg, opts.verbose);
  const open = parseGateEntries(body).filter((g) => g.status === "open");
  const stale: GateEntry[] = [];
  const check = opts.checkEvidence ?? verifyEvidence;
  for (const gate of open) {
    const result = await check(gate.evidence, opts.cfg);
    if (result.stale) {
      stale.push(gate);
      print(`${gate.slug}: ⚠️ stale — likely resolved (${result.detail})`);
    } else {
      print(`${gate.slug}: ok — ${result.detail}`);
    }
  }
  if (open.length === 0) print("(no open gates)");
  return { stale, checked: open };
}

async function loadOpenDecisions(
  cfg: Config,
  verbose?: Verbose,
): Promise<LoadedLedger> {
  const node = newReadClientFromCfg(cfg, verbose);
  const found = await resolveBySlug({
    node,
    cfg,
    slug: OPEN_DECISIONS_SLUG,
    type: OPEN_DECISIONS_TYPE,
    notFoundMessage: {
      typed: (t, slug) => `No ${t}: ${slug}`,
    },
    recoveryVerb: "get",
  });
  return { record: found.record, body: found.record.body };
}

async function writeOpenDecisions(
  cfg: Config,
  existing: FbrainRecord,
  body: string,
  verbose?: Verbose,
): Promise<void> {
  const { node } = newWriteClientFromCfg(cfg, verbose);
  const hash = schemaHashFor(OPEN_DECISIONS_TYPE, cfg);
  const fields: Record<string, unknown> = {
    ...existing,
    body,
    updated_at: nowIso(),
  };
  await node.updateRecord({
    schemaHash: hash,
    keyHash: OPEN_DECISIONS_SLUG,
    fields,
  });
  const visible = await verifyRecordVisible(
    node,
    OPEN_DECISIONS_TYPE,
    hash,
    OPEN_DECISIONS_SLUG,
  );
  if (visible === null) {
    throw new FbrainError({
      code: "put_not_visible",
      message: `Updated ${OPEN_DECISIONS_TYPE} "${OPEN_DECISIONS_SLUG}" but the row was not visible to a follow-up read within the retry budget.`,
      hint: "Re-run `fbrain get open-decisions` shortly; if it stays stale the write may not have persisted.",
    });
  }
}

export function parseGateEntries(body: string): GateEntry[] {
  const entries: GateEntry[] = [];
  for (const line of body.split("\n")) {
    const entry = parseGateLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function parseGateLine(line: string): GateEntry | null {
  const trimmed = line.trim();
  const raw = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
  if (!raw.startsWith("status=")) return null;
  const fields = parseFieldLine(raw);
  const status = fields.get("status");
  if (status !== "open" && status !== "cleared") return null;
  const slug = requiredField(fields, "slug");
  const program = requiredField(fields, "program");
  const unblocks = requiredField(fields, "unblocks");
  const evidence = requiredField(fields, "evidence");
  const surfaced = requiredField(fields, "surfaced");
  const entry: GateEntry = { status, slug, program, unblocks, evidence, surfaced };
  const recommendation = fields.get("recommendation");
  if (recommendation !== undefined) entry.recommendation = recommendation;
  const cleared = fields.get("cleared");
  if (cleared !== undefined) entry.cleared = cleared;
  const resolution = fields.get("resolution");
  if (resolution !== undefined) entry.resolution = resolution;
  return entry;
}

function requiredField(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value.length === 0) {
    throw new FbrainError({
      code: "malformed_gate_line",
      message: `Structured gate line is missing ${key}=...`,
    });
  }
  return value;
}

function parseFieldLine(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === " ") i++;
    const keyStart = i;
    while (i < raw.length && raw[i] !== "=" && raw[i] !== " ") i++;
    const key = raw.slice(keyStart, i);
    if (raw[i] !== "=" || key.length === 0) break;
    i++;
    let value = "";
    if (raw[i] === '"') {
      i++;
      while (i < raw.length) {
        const ch = raw[i]!;
        if (ch === "\\") {
          const next = raw[i + 1];
          if (next !== undefined) {
            value += next;
            i += 2;
            continue;
          }
        }
        if (ch === '"') {
          i++;
          break;
        }
        value += ch;
        i++;
      }
    } else {
      const valueStart = i;
      while (i < raw.length && raw[i] !== " ") i++;
      value = raw.slice(valueStart, i);
    }
    fields.set(key, value);
  }
  return fields;
}

export function formatGateEntry(entry: GateEntry): string {
  const parts = [
    `status=${entry.status}`,
    `slug=${entry.slug}`,
    `program=${quoteField(entry.program)}`,
    `unblocks=${quoteField(entry.unblocks)}`,
    `evidence=${quoteField(entry.evidence)}`,
    `surfaced=${entry.surfaced}`,
  ];
  if (entry.recommendation !== undefined) {
    parts.push(`recommendation=${quoteField(entry.recommendation)}`);
  }
  if (entry.cleared !== undefined) parts.push(`cleared=${entry.cleared}`);
  if (entry.resolution !== undefined) {
    parts.push(`resolution=${quoteField(entry.resolution)}`);
  }
  return `- ${parts.join(" ")}`;
}

function quoteField(value: string): string {
  return `"${value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function addGateToBody(body: string, entry: GateEntry): string {
  const lines = body.split("\n");
  let lastGateLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const gate = parseGateLine(lines[i] ?? "");
    if (!gate) continue;
    if (gate.slug === entry.slug) return body;
    lastGateLine = i;
  }
  const rendered = formatGateEntry(entry);
  if (lastGateLine >= 0) {
    lines.splice(lastGateLine + 1, 0, rendered);
    return lines.join("\n");
  }
  const section = lines.findIndex((l) => l.trim() === "## Structured gate ledger");
  if (section >= 0) {
    lines.splice(section + 1, 0, "", rendered);
    return lines.join("\n");
  }
  const insert = lines.findIndex((l) => l.trim() === "---");
  if (insert >= 0) {
    lines.splice(insert + 1, 0, "", "## Structured gate ledger", "", rendered);
    return lines.join("\n");
  }
  return `${body.trimEnd()}\n\n## Structured gate ledger\n\n${rendered}\n`;
}

export function clearGateInBody(
  body: string,
  slug: string,
  resolution: string,
  cleared: string,
): { body: string; cleared: boolean; entry: GateEntry } {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const gate = parseGateLine(lines[i] ?? "");
    if (!gate || gate.slug !== slug || gate.status !== "open") continue;
    const entry: GateEntry = {
      ...gate,
      status: "cleared",
      cleared,
      resolution,
    };
    lines[i] = formatGateEntry(entry);
    return { body: lines.join("\n"), cleared: true, entry };
  }
  return {
    body,
    cleared: false,
    entry: {
      status: "cleared",
      slug,
      program: "",
      unblocks: "",
      evidence: "",
      surfaced: "",
      cleared,
      resolution,
    },
  };
}

export async function verifyEvidence(
  evidence: string,
  cfg: Config,
): Promise<EvidenceCheck> {
  const checks = splitEvidence(evidence);
  if (checks.length === 0) {
    return { stale: false, detail: "no mechanically-checkable evidence pointer" };
  }
  const details: string[] = [];
  for (const check of checks) {
    const result = await verifyOneEvidence(check, cfg);
    details.push(result.detail);
    if (result.stale) return { stale: true, detail: result.detail };
  }
  return { stale: false, detail: details.join("; ") };
}

function splitEvidence(evidence: string): string[] {
  return evidence
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter(
      (s) =>
        s.startsWith("fbrain:") ||
        s.startsWith("[[") ||
        s.startsWith("origin/main:"),
    );
}

async function verifyOneEvidence(
  evidence: string,
  cfg: Config,
): Promise<EvidenceCheck> {
  if (evidence.startsWith("fbrain:")) {
    return verifyFbrainEvidence(evidence.slice("fbrain:".length), cfg);
  }
  if (evidence.startsWith("[[") && evidence.endsWith("]]")) {
    return verifyFbrainEvidence(evidence.slice(2, -2), cfg);
  }
  if (evidence.startsWith("origin/main:")) {
    return verifyOriginMainEvidence(evidence.slice("origin/main:".length));
  }
  return { stale: false, detail: `unchecked ${evidence}` };
}

async function verifyFbrainEvidence(
  raw: string,
  cfg: Config,
): Promise<EvidenceCheck> {
  const trimmed = raw.trim();
  const [maybeType, ...rest] = trimmed.split(":");
  const head = maybeType ?? "";
  const type =
    rest.length > 0 && isEvidenceRecordType(head) ? head : undefined;
  const slug = type ? rest.join(":") : trimmed;
  const node = newReadClientFromCfg(cfg);
  const types: RecordType[] = type ? [type] : [...RECORD_TYPES];
  for (const t of types) {
    const record = await findBySlug(node, t, schemaHashFor(t, cfg), slug);
    if (record === null) continue;
    if (isResolvedStatus(record.status)) {
      return {
        stale: true,
        detail: `evidence fbrain:${slug} is ${record.status}`,
      };
    }
    return {
      stale: false,
      detail: `evidence fbrain:${slug} is ${record.status}`,
    };
  }
  return { stale: true, detail: `evidence fbrain:${slug} is missing` };
}

function isEvidenceRecordType(value: string): value is RecordType {
  return isRecordType(value);
}

function isResolvedStatus(status: string): boolean {
  return new Set([
    "done",
    "moot",
    "resolved",
    "cleared",
    "closed",
    "cancelled",
    "canceled",
    "dropped",
  ]).has(status.trim().toLowerCase());
}

async function verifyOriginMainEvidence(raw: string): Promise<EvidenceCheck> {
  const { file, needle } = parseOriginMainRef(raw);
  const proc = spawn(["git", "show", `origin/main:${file}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const err = stderr.trim();
    return {
      stale: true,
      detail: `origin/main:${file} is missing${err ? ` (${err})` : ""}`,
    };
  }
  if (needle !== undefined && !stdout.includes(needle)) {
    return {
      stale: true,
      detail: `origin/main:${file} no longer contains ${JSON.stringify(needle)}`,
    };
  }
  return {
    stale: false,
    detail:
      needle === undefined
        ? `origin/main:${file} exists`
        : `origin/main:${file} still contains ${JSON.stringify(needle)}`,
  };
}

function parseOriginMainRef(raw: string): { file: string; needle?: string } {
  const doubleColon = raw.indexOf("::");
  if (doubleColon >= 0) {
    return {
      file: raw.slice(0, doubleColon),
      needle: raw.slice(doubleColon + 2),
    };
  }
  const hash = raw.indexOf("#");
  if (hash >= 0) {
    return { file: raw.slice(0, hash), needle: raw.slice(hash + 1) };
  }
  return { file: raw };
}

function today(): string {
  return nowIso().slice(0, 10);
}
