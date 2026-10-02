type PutConfirmation = {
  action: "created" | "updated";
  type: string;
  slug: string;
  indexPending: boolean;
  // The record persisted but the record-list index patch did not. Unlike
  // `indexPending` this does NOT heal itself: the list index is patched by
  // read-modify-write, so a dropped entry stays dropped until a migration or
  // cold seed rebuilds it. Silence here is what let the primary's rollup fall
  // 760 live records behind `brain list` before anyone noticed (2026-07-28).
  listIndexFailed?: boolean;
  revision?: string;
  durability?: "queued" | "durable";
  search?: "queued" | "ready";
};

export function indexPendingNote(indexPending: boolean): string {
  return indexPending
    ? " (indexPending: semantic index still catching up; immediate search may miss it; retry shortly)"
    : "";
}

export function listIndexFailedNote(listIndexFailed: boolean | undefined): string {
  return listIndexFailed
    ? " (WARNING: record saved but the record-list index patch FAILED — `brain list` and" +
      " `brain ask` will not see this record until the index is rebuilt; this does not self-heal)"
    : "";
}

export function formatPutConfirmation(result: PutConfirmation): string {
  const extras: string[] = [];
  if (result.revision) extras.push(`revision=${result.revision}`);
  if (result.durability) extras.push(`durability=${result.durability}`);
  if (result.search) extras.push(`search=${result.search}`);
  return (
    `${result.action} ${result.type} ${result.slug}` +
    (extras.length > 0 ? ` ${extras.join(" ")}` : "") +
    indexPendingNote(result.indexPending) +
    listIndexFailedNote(result.listIndexFailed)
  );
}

// ---------------------------------------------------------------------------
// Durability of a resident batch, for the verbs that are not `put`.
//
// `commitResidentWritePlan` returns a `BatchMutationResult` carrying the
// node's durability claim. Of its seven call sites in `src/`, exactly one
// (`put`) read that receipt; the other six discarded it with a bare `await`,
// so `papercut close`, `papercut file`, `papercut set`, the reference twin and
// `brain status` all printed a transition with no indication of whether the
// write was on disk.
//
// Measured consequence (papercut-brain-papercut-close-acks-a-status-
// transition-with-no-durability-and-the-write-can-revert-20261001): a
// `wontfix -> open` reopen of a live defect printed its transition, verified
// `open` on an immediate re-read, and read `wontfix` again ten minutes later
// with the closure stanza absent. It had not been re-closed — a second close
// appends a second stanza and the record carried one. The write was queued and
// lost across a node restart, and nothing in the acknowledgement or in the
// re-read could tell that from a flushed write, because a queued write is
// served from the state it landed in.
// ---------------------------------------------------------------------------

/**
 * What the node said about flushing one resident batch to disk.
 *
 * Three-valued on purpose. `durability` is OPTIONAL on `BatchMutationResult`
 * — an older node omits it entirely — and an absent field is not the same
 * claim as `"queued"`. Both mean "do not assume this is on disk", but they
 * want different follow-ups: a queued write is expected to flush on its own,
 * an unreported one cannot be asked about at all. Collapsing them (as `put`'s
 * `?? "queued"` does) is conservative about the guarantee and wrong about the
 * cause.
 */
export type WriteDurability = "durable" | "queued" | "unreported";

export function writeDurabilityOf(
  receipt: { durability?: string } | null | undefined,
): WriteDurability {
  const reported = receipt?.durability;
  if (reported === "durable") return "durable";
  if (reported === "queued") return "queued";
  return "unreported";
}

/**
 * The ack tokens for a write that is not a `put`: the durability state always,
 * and the revision when the receipt carries a mutation id. Always printing
 * `durability=` is the point — a token that appears only on the bad path reads
 * as noise and gets filtered; one that is always there is a field a caller can
 * condition on.
 */
export function writeDurabilityTokens(
  receipt: { durability?: string; mutationIds?: string[] } | null | undefined,
): string[] {
  const tokens = [`durability=${writeDurabilityOf(receipt)}`];
  const revision = receipt?.mutationIds?.[0];
  if (revision) tokens.push(`revision=${revision}`);
  return tokens;
}

/**
 * The warning that follows a status transition the node did not confirm on
 * disk, or `null` when it did.
 *
 * It names the one thing a caller cannot work out for itself: that the
 * re-read-after-write check every routine on this fleet uses — including the
 * papercut resolver's standing "re-read every brain write" protocol — cannot
 * detect this. That check passed on the measured revert and was wrong.
 */
export function writeDurabilityWarning(
  state: WriteDurability,
  opts: { verb: string; retryHint?: string },
): string | null {
  if (state === "durable") return null;
  const cause =
    state === "queued"
      ? "the node accepted this write but has NOT flushed it to disk"
      : "this node did not report durability, so the write cannot be assumed to be on disk";
  const retry = opts.retryHint ? ` ${opts.retryHint}` : "";
  return (
    `warning: ${cause}. An immediate re-read CANNOT tell a queued write from a ` +
    `durable one — it is served from the state the write landed in — so ` +
    `re-reading now proves nothing about persistence. A queued status write has ` +
    `been observed to revert across a node restart ` +
    `(papercut-brain-papercut-close-acks-a-status-transition-with-no-durability-and-the-write-can-revert-20261001).` +
    `${retry} Otherwise re-read ${opts.verb}'s record again after the node flushes.`
  );
}
