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
  durability?: "queued" | "local";
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
