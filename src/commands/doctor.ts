// `fbrain doctor` — Phase 1 stub. Phase 2 fills in:
//   - reachability of both services
//   - bootstrap state
//   - schema drift between schemas.ts and the canonical schema fetched via
//     GET /v1/schema/<canonicalHash> (descriptiveName route 404s)
//   - schemas-loaded sanity on the node
//
// The Phase 1 stub still reports config presence so the user knows fbrain
// is wired enough to run.

import { tryReadConfig } from "../config.ts";

export type DoctorOptions = {
  configPath?: string;
  print?: (line: string) => void;
};

export function doctorStub(opts: DoctorOptions = {}): void {
  const print = opts.print ?? ((line: string) => console.log(line));
  const cfg = tryReadConfig(opts.configPath);
  if (!cfg) {
    print("[doctor] config:  MISSING — run `fbrain init` first");
  } else {
    print("[doctor] config:  ok");
    print(`        nodeUrl:           ${cfg.nodeUrl}`);
    print(`        schemaServiceUrl:  ${cfg.schemaServiceUrl}`);
    print(`        userHash:          ${cfg.userHash.slice(0, 8)}…`);
    print(`        designSchemaHash:  ${cfg.designSchemaHash}`);
    print(`        taskSchemaHash:    ${cfg.taskSchemaHash}`);
  }
  print("[doctor] live checks: TODO Phase 2");
  print("        — reachability of node + schema service");
  print("        — schema drift (GET /v1/schema/<canonicalHash> vs schemas.ts)");
  print("        — schemas-loaded sanity");
}
