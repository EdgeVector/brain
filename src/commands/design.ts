// `fbrain design new <slug> [--title T] [--tag T]... [--body STR]` — create a Design.
// Thin shim over the shared table-driven creator in `./new.ts`.

import { recordNew, type RecordNewOptions } from "./new.ts";

export type DesignNewOptions = Omit<RecordNewOptions, "type" | "designSlug">;

export function designNew(opts: DesignNewOptions): Promise<void> {
  return recordNew({ ...opts, type: "design" });
}
