// `fbrain task new <slug> [--title T] [--design D] [--tag T]... [--body STR]` — create a Task.
// Thin shim over the shared table-driven creator in `./new.ts`. Task is the
// one type that carries an optional `--design` parent-link arg.

import { recordNew, type RecordNewOptions, type RecordNewResult } from "./new.ts";

export type TaskNewOptions = Omit<RecordNewOptions, "type">;

export function taskNew(opts: TaskNewOptions): Promise<RecordNewResult> {
  return recordNew({ ...opts, type: "task" });
}
