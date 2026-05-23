// `fbrain share` — placeholder.
//
// The Phase 3 sharing spike concluded that the cross-node data-flow path
// is not testable on a single machine: it requires the Auth Lambda + S3
// transport configured at the discovery service. The sharing METADATA
// primitives (ShareRule, ShareInvite, ShareSubscription) are wireable
// end-to-end on loopback, but no data ever moves between nodes without
// the cloud sync layer.
//
// See docs/phase-3-sharing-memo.md for the full evidence + the conditions
// under which this command can become a real, working share.
//
// Until then, calling `fbrain share` prints the same pointer and exits
// non-zero so callers don't believe a no-op succeeded.

const MEMO_PATH = "docs/phase-3-sharing-memo.md";

export type ShareOptions = {
  print?: (line: string) => void;
};

export function shareCmd(opts: ShareOptions = {}): number {
  const print = opts.print ?? ((line: string) => console.error(line));
  print(
    "fbrain share is a Phase 3 v0+ feature — see " + MEMO_PATH + ".",
  );
  print(
    "Short version: cross-node data flow requires fold_db's S3 + Auth-Lambda",
  );
  print(
    "sync layer, which is unreachable from a localhost-only spike. The",
  );
  print(
    "sharing METADATA (ShareRule, ShareInvite, ShareSubscription) is",
  );
  print(
    "fully wireable on loopback, but no records actually move without",
  );
  print(
    "the cloud transport configured.",
  );
  return 1;
}
