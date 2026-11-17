// `brain index` names Brain's record schemas to LastSeek.
// Without `--wait` it returns as soon as LastSeek accepts the request.

import { BrainError, defaultFolddbSocketPath } from "../client.ts";
import type { Config } from "../config.ts";
import { resolvePrintSinks } from "../format.ts";
import { LASTSEEK_NOT_INSTALLED_LINE, requestLastSeekIndex } from "../lastseek-index.ts";
import { BRAIN_INDEX_COMMAND } from "../lastseek-schemas.ts";

export async function indexSearchCmd(opts: {
  cfg: Config;
  wait?: boolean;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}): Promise<void> {
  const { print } = resolvePrintSinks(opts);
  const indexed = requestLastSeekIndex({
    cfg: opts.cfg,
    socketPath: defaultFolddbSocketPath(opts.cfg.nodeSocketPath),
    wait: opts.wait === true,
  });
  if (indexed.kind === "ok") {
    print(indexed.json);
    return;
  }
  if (indexed.kind === "missing") {
    throw new BrainError({
      code: "lastseek_missing",
      message: LASTSEEK_NOT_INSTALLED_LINE,
      hint: `Install LastSeek, then run \`${BRAIN_INDEX_COMMAND}\`.`,
    });
  }
  throw new BrainError({
    code: "lastseek_index_failed",
    message: indexed.detail,
    hint: `Run \`${BRAIN_INDEX_COMMAND}\` to retry.`,
  });
}
