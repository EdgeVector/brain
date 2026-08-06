// Papercut helpers: the dedupe key, and validation for the typed columns.
//
// Why a hash AND a search (see `findDuplicateCandidates` in
// commands/papercut.ts): the hash catches a run restating a symptom in
// near-identical words, which is the common case when the same detector fires
// twice. It CANNOT catch a paraphrase, and two different agents describing one
// defect paraphrase almost every time — that is exactly how the same defect got
// filed twice, two hours apart, by different runs on 2026-08-04, with neither
// filing aware of the other. So the hash is the cheap exact net and the
// similarity search is the net that catches the rest. Neither alone is dedupe.

import { createHash } from "node:crypto";
import { FbrainError } from "./client.ts";
import {
  PAPERCUT_KINDS,
  PAPERCUT_SEVERITIES,
  PAPERCUT_STATUSES,
} from "./schemas.ts";

// Usage-error codes raised from this module and commands/papercut.ts. Every
// one is registered in cli.ts's USAGE_ERROR_CODES so a malformed invocation
// exits 2, not 1 — the same contract the rest of the CLI honours.
export const PAPERCUT_USAGE_CODES = [
  "invalid_papercut_field",
  "missing_symptom",
  "missing_evidence",
  "missing_verification",
  "missing_duplicate_target",
  "papercut_exists",
] as const;

// Statuses that mean "this defect is still costing us something". `partial`
// counts as live on purpose: a correctly-partial record is the one case the
// prose ledger got RIGHT (it stayed open), and collapsing it into `fixed`
// would reintroduce the over-closure this type exists to prevent.
export const LIVE_PAPERCUT_STATUSES = ["open", "partial", "fixed"] as const;

export function isLivePapercutStatus(status: string): boolean {
  return (LIVE_PAPERCUT_STATUSES as readonly string[]).includes(status);
}

// Normalize a symptom statement to its comparable core.
//
// Deliberately does NOT strip digits. Measurements drift between runs ("70 of
// 84 packs" vs "71 of 84"), so keeping them makes the hash UNDER-collide rather
// than over-collide. Under-colliding is the safe direction: a missed hash match
// still meets the similarity search, whereas an over-collision silently folds
// two real defects into one record and loses the second one's evidence.
export function normalizeSymptom(symptom: string): string {
  return symptom
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// The dedupe key. Scoped by component so the same phrase about two different
// subsystems ("the count is wrong") stays two records.
export function symptomHash(component: string, symptom: string): string {
  const normalizedComponent = normalizeSymptom(component);
  const normalized = normalizeSymptom(symptom);
  return createHash("sha256")
    .update(`${normalizedComponent}\n${normalized}`)
    .digest("hex")
    .slice(0, 16);
}

function ensureOneOf(
  value: string,
  allowed: readonly string[],
  flag: string,
): string {
  if (!allowed.includes(value)) {
    throw new FbrainError({
      code: "invalid_papercut_field",
      message: `Invalid ${flag}: ${value}\nExpected one of: ${allowed.join(" | ")}`,
    });
  }
  return value;
}

export function ensureSeverity(value: string): string {
  return ensureOneOf(value, PAPERCUT_SEVERITIES, "--severity");
}

export function ensureKind(value: string): string {
  return ensureOneOf(value, PAPERCUT_KINDS, "--kind");
}

export function ensurePapercutStatus(value: string): string {
  return ensureOneOf(value, PAPERCUT_STATUSES, "--status");
}

// A component is a bare lowercase token: it is a query key, not prose. The
// whole point of the column is that it cannot be evaded by naming things
// creatively, so the format is narrow and enforced at the door.
export const COMPONENT_MAX_LENGTH = 32;

export function ensureComponent(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(trimmed) || trimmed.length > COMPONENT_MAX_LENGTH) {
    throw new FbrainError({
      code: "invalid_papercut_field",
      message:
        `Invalid --component: ${value}\n` +
        `Expected a bare lowercase token of at most ${COMPONENT_MAX_LENGTH} chars, ` +
        "e.g. lastdb | lastgit | kanban | brain | routines.",
    });
  }
  // Reject the old habit at the door. The prose ledger scoped families by the
  // slug prefix `papercut-<component>-`, and a component that IS such a prefix
  // reintroduces exactly the thing the column replaced — `component` would
  // become a second copy of the slug rather than an axis you can group by.
  if (trimmed.startsWith("papercut-")) {
    throw new FbrainError({
      code: "invalid_papercut_field",
      message:
        `Invalid --component: ${value}\n` +
        "A component is the subsystem, not a slug prefix — pass `lastgit`, not `papercut-lastgit-…`.",
    });
  }
  return trimmed;
}

// `verified` is the one status that asserts a fact about the live world, so it
// is the one status that demands its evidence inline. This is the guard for the
// failure the whole type exists to end: a record closed on the strength of a
// merge, which is a fact about a repository and not about anything running.
export function ensureVerificationEvidence(
  status: string,
  verifiedBy: string,
): void {
  if (status !== "verified") return;
  const evidence = verifiedBy.trim();
  if (evidence.length === 0) {
    throw new FbrainError({
      code: "missing_verification",
      message:
        "status `verified` requires --verified-by: the LIVE check you ran.\n" +
        "A merge is not a verification — name the command or measurement that " +
        "showed the defect gone.",
    });
  }
  if (/^merged\b/i.test(evidence) || /^(pr|cr)\b/i.test(evidence)) {
    throw new FbrainError({
      code: "missing_verification",
      message:
        `--verified-by looks like a merge reference, not a live check: ${evidence}\n` +
        "Record the merge in --fixed-by and use status `fixed`. `verified` means " +
        "you re-measured and the defect was gone.",
    });
  }
}

// `duplicate` is only meaningful with a target; without one the record is just
// silently dropped work.
export function ensureDuplicateTarget(status: string, duplicateOf: string): void {
  if (status !== "duplicate") return;
  if (duplicateOf.trim().length === 0) {
    throw new FbrainError({
      code: "missing_duplicate_target",
      message:
        "status `duplicate` requires --duplicate-of <slug>: the papercut this one folds into.",
    });
  }
}
