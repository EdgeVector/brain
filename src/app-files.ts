// A file the app API can reference. LastDB keeps the path. It does not copy the bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { brainDataDir } from "./config.ts";

/** Write bytes under the Brain data directory and return the absolute path. */
export function writeStoredFile(name: string, bytes: Uint8Array): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safe.length === 0) throw new Error("A stored file needs a name.");
  const dir = join(brainDataDir(), "files");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safe);
  writeFileSync(path, bytes);
  return path;
}
