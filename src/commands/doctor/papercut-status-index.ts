// `brain doctor` probe for the status-keyed papercut index.
//
// The typed papercut ledger reads through ONE keyed index and refuses every
// read when that index is unregistered or its completeness marker cannot be
// found. Until this probe existed, doctor reported all-PASS on a node where
// `papercut census`, `papercut list` and the dedupe gate all failed — three
// fleet-wide outages (2026-08-09, 08-28, 08-29) were each discovered by a
// routine that tried to count and could not, never by the instrument whose
// job is to say what is wrong. Registration and completeness are two distinct
// states with two distinct fixes, so the probe names which.

import type { NodeClient, Verbose } from "../../client.ts";
import type { Config } from "../../config.ts";
import {
  papercutStatusIndexHash,
  papercutStatusIndexMarkerPresent,
} from "../../papercut-status-index.ts";
import type { CheckResult } from "../doctor.ts";

export const PAPERCUT_STATUS_INDEX_CHECK = "papercut-status-index";

export async function runPapercutStatusIndexProbe(
  node: NodeClient,
  cfg: Config,
  verbose?: Verbose,
): Promise<CheckResult> {
  const name = PAPERCUT_STATUS_INDEX_CHECK;
  if (cfg.schemaHashes.papercut === undefined) {
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: "papercut type not registered on this node; the ledger is not in use here",
    };
  }
  const entryHash = papercutStatusIndexHash(cfg);
  if (entryHash === null) {
    return {
      name,
      ok: false,
      detail:
        "the status-keyed papercut index is NOT registered: writes land without indexing and every " +
        "`papercut census` / `papercut list` / dedupe-gate read refuses",
      fix: "run `brain init`, then `brain reindex --papercut-status-index`",
    };
  }
  let present: boolean;
  try {
    present = await papercutStatusIndexMarkerPresent(node, entryHash);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    verbose?.(`${name}: marker read failed — ${detail}`);
    return {
      name,
      ok: false,
      tag: "WARN",
      detail: `could not read the completeness marker: ${detail}`,
      fix: "retry `brain doctor`; if it persists, `brain reindex --papercut-status-index --dry-run` reads the census gap",
    };
  }
  if (!present) {
    return {
      name,
      ok: false,
      detail:
        "the status-keyed papercut index is registered but its completeness marker is absent " +
        "(re-read with the point-read retry budget): every ledger read refuses until it is rebuilt",
      fix: "run `brain reindex --papercut-status-index --dry-run` to see the gap, then without --dry-run",
    };
  }
  return {
    name,
    ok: true,
    detail: "registered and marked complete; census/list/dedupe reads are served",
  };
}
