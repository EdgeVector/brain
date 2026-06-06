// Dedupe `NativeIndexHit[]` down to one entry per (schema, slug), keeping the
// highest-score fragment. Shared between `search` (top-K vector results) and
// `ask` (per-query vector pass in the hybrid pipeline) — both ingest the
// node's fragment-granular `/api/native-index/search` response.
//
// Dedupes by `schema_name` (the canonical schema hash) + slug. The hash is the
// schema's stable identity — the field is `string` (required, non-null) on
// `NativeIndexHit`, so it is always usable as a key. An earlier version used
// `schema_display_name` with a fallback to `schema_name` when the display name
// was missing; that fallback was unsafe because `schema_display_name` is
// `string | null | undefined` on the wire, so two fragments of the SAME record
// could land under DIFFERENT keys (`"Concept::slug"` vs `"<hash>::slug"`) if
// the server omitted the display name on some fragments but not others. Both
// fragments then survived dedupe, both resolved via findBySlug to the same
// record, and the search output carried a duplicate row for that record.

import type { NativeIndexHit, Verbose } from "../client.ts";

export function dedupeHits(
  hits: NativeIndexHit[],
  verbose?: Verbose,
): NativeIndexHit[] {
  const best = new Map<string, NativeIndexHit>();
  for (const hit of hits) {
    const slug = hit.key_value.hash;
    if (!slug) continue;
    const key = `${hit.schema_name}::${slug}`;
    const score = typeof hit.metadata?.score === "number" ? hit.metadata.score : -1;
    const prior = best.get(key);
    const priorScore = typeof prior?.metadata?.score === "number" ? prior.metadata.score : -1;
    if (!prior || score > priorScore) {
      if (prior) verbose?.(`dedupe: ${key} (score ${priorScore} → ${score})`);
      best.set(key, hit);
    } else {
      verbose?.(`dedupe: drop fragment of ${key} (score ${score} ≤ ${priorScore})`);
    }
  }
  return Array.from(best.values());
}
