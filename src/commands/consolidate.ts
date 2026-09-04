// `brain consolidate --topic T` — one named cluster, one live canonical.
// `--prove` seeds a dedicated topic, runs the loop, asserts, then cleans up.

import { FbrainError, type Verbose } from "../client.ts";
import { newWriteClientFromCfg } from "../write-context.ts";
import type { Config } from "../config.ts";
import { resolvePrintSink } from "../format.ts";
import {
  appendCmd,
} from "./append.ts";
import { deleteRecord } from "./delete.ts";
import { putCmd } from "./put.ts";
import { statusCmd } from "./status.ts";
import {
  findBySlug,
  schemaHashFor,
  type FbrainRecord,
} from "../record.ts";
import { isRecordType, type RecordType } from "../schemas.ts";
import {
  addUtcDays,
  CANONICAL_TAG,
  EPH_DAY_TAG_PREFIX,
  EPH_RETENTION_DAYS,
  SERIES_TAG_PREFIX,
  TOPIC_TAG_PREFIX,
  ephHash,
  expiredEphDays,
  factBlock,
  pickCanonical,
  uniqueFacts,
  utcDay,
  type ClusterMember,
} from "../lifecycle.ts";
import {
  deleteMembership,
  listMembership,
  liveIndexRegistered,
  membershipExists,
} from "../lifecycle-index.ts";

export const PROVE_TOPIC = "lifecycle-ship-proof";

export type ConsolidateOptions = {
  cfg: Config;
  topic: string;
  prove?: boolean;
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
  now?: Date;
};

export type ConsolidateResult = {
  topic: string;
  canonical: string | null;
  parked: string[];
  deleted: string[];
  appended: number;
  skipped: number;
};

export async function consolidateCmd(
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  if (opts.prove) {
    return proveConsolidate(opts);
  }
  return runConsolidate(opts);
}

async function runConsolidate(
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const print = resolvePrintSink(opts);
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const topic = opts.topic;
  const rows = await listMembership(node, opts.cfg, "cluster", topic);
  const members: ClusterMember[] = [];
  let skipped = 0;
  for (const row of rows) {
    const rec = row.record;
    if (!rec) {
      skipped++;
      continue;
    }
    const type = inferType(opts.cfg, rec);
    if (!type) {
      skipped++;
      continue;
    }
    if (type === "decision" || type === "project") {
      skipped++;
      continue;
    }
    members.push({ type, slug: rec.slug, record: rec });
  }

  const liveMembers = members.filter((m) => m.record.status !== "parked");
  const result: ConsolidateResult = {
    topic,
    canonical: null,
    parked: [],
    deleted: [],
    appended: 0,
    skipped,
  };
  if (liveMembers.length === 0) {
    print(`consolidate ${topic}: empty`);
    return result;
  }
  if (liveMembers.length === 1) {
    result.canonical = liveMembers[0]!.slug;
    print(`consolidate ${topic}: already one live slug ${result.canonical}`);
    return result;
  }

  const canonical = pickCanonical(liveMembers);
  result.canonical = canonical.slug;
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  let body = canonical.record.body;
  const prefix = body;

  for (const loser of liveMembers) {
    if (loser.slug === canonical.slug) continue;
    const facts = uniqueFacts(body, loser.record.body);
    if (facts.length === 0) {
      await deleteRecord({
        cfg: opts.cfg,
        slug: loser.slug,
        type: loser.type,
        verbose: opts.verbose,
      });
      result.deleted.push(loser.slug);
      continue;
    }
    for (const fact of facts) {
      const block = factBlock(fact, loser.slug, date);
      await appendCmd({
        cfg: opts.cfg,
        slug: canonical.slug,
        type: canonical.type,
        chunk: block,
        verbose: opts.verbose,
      });
      body = `${body}\n\n${block}`;
      result.appended++;
    }
    await statusCmd({
      cfg: opts.cfg,
      slug: loser.slug,
      type: loser.type,
      newStatus: "parked",
      verbose: opts.verbose,
    });
    result.parked.push(loser.slug);
  }

  void prefix;
  print(
    `consolidate ${topic}: canonical=${canonical.slug} parked=${result.parked.length} deleted=${result.deleted.length} appended=${result.appended}`,
  );
  return result;
}

async function proveConsolidate(
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const print = resolvePrintSink(opts);
  if (!liveIndexRegistered(opts.cfg)) {
    throw new FbrainError({
      code: "lifecycle_index_unregistered",
      message: "live/cluster/parked/eph indexes are not in config",
      hint: "Run `brain init` so the new HashRange schemas register, then re-run prove.",
    });
  }
  const topic = opts.topic || PROVE_TOPIC;
  const now = opts.now ?? new Date();
  const today = utcDay(now);
  const oldDay = addUtcDays(today, -(EPH_RETENTION_DAYS + 16));
  const canonSlug = `${topic}-canon`;
  const parkSlug = `${topic}-park`;
  const dupSlug = `${topic}-dup`;
  const ephSlug = `${topic}-eph`;

  await cleanupProve(opts.cfg, [canonSlug, parkSlug, dupSlug, ephSlug], opts.verbose);

  const canonBody = "FACT-CANON-KEEP\n\nShared sentence.";
  await putCmd({
    cfg: opts.cfg,
    slug: canonSlug,
    typeOverride: "preference",
    input: proveDoc(canonSlug, topic, canonBody, [CANONICAL_TAG]),
    verbose: opts.verbose,
  });
  await putCmd({
    cfg: opts.cfg,
    slug: parkSlug,
    typeOverride: "preference",
    input: proveDoc(
      parkSlug,
      topic,
      "FACT-PARK-UNIQUE unique-park-fact\n\nShared sentence.",
    ),
    verbose: opts.verbose,
  });
  await putCmd({
    cfg: opts.cfg,
    slug: dupSlug,
    typeOverride: "preference",
    input: proveDoc(dupSlug, topic, canonBody),
    verbose: opts.verbose,
  });
  await putCmd({
    cfg: opts.cfg,
    slug: ephSlug,
    typeOverride: "reference",
    input: proveEph(ephSlug, oldDay),
    verbose: opts.verbose,
  });

  const before = await getBody(opts.cfg, "preference", canonSlug);
  const result = await runConsolidate({ ...opts, topic, now });
  const reaped = await reapEphSeries(opts, "proof", today);
  if (reaped < 1) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: "eph reap deleted 0 rows",
    });
  }

  const after = await getBody(opts.cfg, "preference", canonSlug);
  if (!after.startsWith(before)) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: "canonical body prefix changed — rewrite is forbidden",
    });
  }
  if (!after.includes("unique-park-fact")) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: "canonical body missing unique fact from parked loser",
    });
  }
  if (result.canonical !== canonSlug) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: `expected canonical ${canonSlug}, got ${result.canonical}`,
    });
  }

  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const liveCanon = await membershipExists(node, opts.cfg, "live", "preference", canonSlug);
  const livePark = await membershipExists(node, opts.cfg, "live", "preference", parkSlug);
  const liveDup = await membershipExists(node, opts.cfg, "live", "preference", dupSlug);
  if (!liveCanon || livePark || liveDup) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: `live membership wrong canon=${liveCanon} park=${livePark} dup=${liveDup}`,
    });
  }
  const clusterCanon = await membershipExists(node, opts.cfg, "cluster", topic, canonSlug);
  if (!clusterCanon) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: `canonical missing from cluster:${topic}`,
    });
  }

  const parkRec = await findBySlug(
    node,
    "preference",
    schemaHashFor("preference", opts.cfg),
    parkSlug,
  );
  if (!parkRec) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: "parked loser is not gettable",
    });
  }
  const dupRec = await findBySlug(
    node,
    "preference",
    schemaHashFor("preference", opts.cfg),
    dupSlug,
  );
  if (dupRec) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: "duplicate loser still gettable after delete",
    });
  }
  const ephRec = await findBySlug(
    node,
    "reference",
    schemaHashFor("reference", opts.cfg),
    ephSlug,
  );
  if (ephRec) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: "back-dated ephemeral closeout still present after reap",
    });
  }

  print("PROOF: GREEN");
  await cleanupProve(opts.cfg, [canonSlug, parkSlug, dupSlug, ephSlug], opts.verbose);
  return result;
}

async function reapEphSeries(
  opts: ConsolidateOptions,
  series: string,
  today: string,
): Promise<number> {
  const { node } = newWriteClientFromCfg(opts.cfg, opts.verbose);
  const days = expiredEphDays(today);
  let n = 0;
  for (const day of days) {
    const hash = ephHash(series, day);
    const rows = await listMembership(node, opts.cfg, "eph", hash);
    for (const row of rows) {
      const rec = row.record;
      if (!rec) continue;
      const type = inferType(opts.cfg, rec);
      if (!type) continue;
      try {
        await deleteRecord({
          cfg: opts.cfg,
          slug: rec.slug,
          type,
          verbose: opts.verbose,
        });
        n++;
      } catch {
        await deleteMembership(node, opts.cfg, "eph", hash, rec.slug);
      }
    }
  }
  return n;
}

async function cleanupProve(
  cfg: Config,
  slugs: string[],
  verbose?: Verbose,
): Promise<void> {
  for (const slug of slugs) {
    for (const type of ["preference", "reference"] as RecordType[]) {
      try {
        await deleteRecord({ cfg, slug, type, verbose, force: true });
      } catch {
        // already gone
      }
    }
  }
}

async function getBody(
  cfg: Config,
  type: RecordType,
  slug: string,
): Promise<string> {
  const { node } = newWriteClientFromCfg(cfg);
  const rec = await findBySlug(node, type, schemaHashFor(type, cfg), slug);
  if (!rec) {
    throw new FbrainError({
      code: "consolidate_prove_failed",
      message: `missing ${type}/${slug} during prove`,
    });
  }
  return rec.body;
}

function proveDoc(
  slug: string,
  topic: string,
  body: string,
  extraTags: string[] = [],
): string {
  const tags = [`${TOPIC_TAG_PREFIX}${topic}`, ...extraTags].join(", ");
  return `---
type: preference
slug: ${slug}
title: ${slug}
status: active
tags: [${tags}]
---

${body}
`;
}

function proveEph(slug: string, day: string): string {
  return `---
type: reference
slug: ${slug}
title: ${slug}
status: active
tags: [${SERIES_TAG_PREFIX}proof, ${EPH_DAY_TAG_PREFIX}${day}]
---

ephemeral proof closeout
`;
}

/** Product type stamped on the membership payload. Missing type is not preference. */
export function inferType(
  _cfg: { schemaHashes: Record<string, string> },
  rec: FbrainRecord,
): RecordType | null {
  const extra = rec.type;
  if (typeof extra === "string" && isRecordType(extra)) return extra;
  return null;
}
