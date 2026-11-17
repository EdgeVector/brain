// `brain index` names Brain's record schemas to LastSeek and builds the index.

import { defaultFolddbSocketPath } from "../client.ts";
import type { Config } from "../config.ts";
import { resolvePrintSinks } from "../format.ts";
import { registerLastSeekSchemas } from "../lastseek-index.ts";

export async function indexSearchCmd(opts: {
  cfg: Config;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}): Promise<void> {
  const { print, printErr } = resolvePrintSinks(opts);
  await registerLastSeekSchemas({
    cfg: opts.cfg,
    socketPath: defaultFolddbSocketPath(opts.cfg.nodeSocketPath),
    print,
    printErr,
    when: "always",
  });
}
