// Doctor names the papercut ledger read. List and census read the list page.
// They do not read PapercutStatusIndex.

import type { NodeClient, Verbose } from "../../client.ts";
import type { Config } from "../../config.ts";
import type { CheckResult } from "../doctor.ts";

export const PAPERCUT_STATUS_INDEX_CHECK = "papercut-status-index";

export async function runPapercutStatusIndexProbe(
  _node: NodeClient,
  cfg: Config,
  _verbose?: Verbose,
): Promise<CheckResult> {
  const name = PAPERCUT_STATUS_INDEX_CHECK;
  if (cfg.schemaHashes.papercut === undefined) {
    return {
      name,
      ok: true,
      tag: "SKIP",
      detail: "papercut type not registered on this node",
    };
  }
  return {
    name,
    ok: true,
    detail:
      "papercut list and census read the list page. This check does not read PapercutStatusIndex.",
  };
}
