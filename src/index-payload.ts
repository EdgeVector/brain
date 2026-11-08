// Short text helper and the summary shape a type-page list returns.

import type { BrainRecord } from "./record.ts";

/** The first `maxBytes` bytes of `text`, cut on a code point boundary. */
export function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const next = used + Buffer.byteLength(ch);
    if (next > maxBytes) break;
    used = next;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * The fields a summary list carries. There is no `body` field: `body` is typed
 * as maybe-missing, so a summary cannot be passed where a `BrainRecord` is required.
 */
export type SnapshotSummary = {
  slug: string;
  title: string;
  status: string;
  tags: string[];
  design_slug?: string;
  created_at: string;
  updated_at: string;
  [extraField: string]: string | string[] | undefined;
};

/** One parsed index payload: the whole record, or a cut summary that needs completing. */
export type IndexSnapshot =
  | { cut: false; record: BrainRecord }
  | { cut: true; summary: SnapshotSummary; cutFields: string[] };
