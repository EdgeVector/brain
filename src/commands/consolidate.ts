// `brain consolidate` is retired with the lifecycle schemas.

import { BrainError, type Verbose } from "../client.ts";
import type { Config } from "../config.ts";

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
  void opts;
  throw new BrainError({
    code: "lifecycle_retired",
    message: "The lifecycle schema is retired. brain consolidate does not run.",
  });
}
