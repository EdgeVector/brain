export type PutConfirmation = {
  action: "created" | "updated";
  type: string;
  slug: string;
  indexPending: boolean;
};

export function indexPendingNote(indexPending: boolean): string {
  return indexPending
    ? " (indexPending: semantic index still catching up; immediate search may miss it; retry shortly)"
    : "";
}

export function formatPutConfirmation(result: PutConfirmation): string {
  return `${result.action} ${result.type} ${result.slug}${indexPendingNote(result.indexPending)}`;
}
