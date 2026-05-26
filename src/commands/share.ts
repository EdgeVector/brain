// `fbrain share` — placeholder.
//
// The Phase 3 sharing spike concluded that cross-node data flow is a
// sign-in gap, not a missing-infra gap. Both halves of the transport
// are built and deployed: fold_db's sync engine (local Sled →
// SyncEngine → Auth Lambda → S3) and the exemem cloud lambdas
// (auth_service, discovery, storage_service, …, live in both dev and
// prod). What's missing is signing fbrain's homebrew daemon into them
// and running an end-to-end positive test: `GET
// /api/sharing/exemem-status` on the local daemon at `:9001` returns
// `{"connected": false}` because nobody has called the sign-in path.
//
// See docs/phase-3-sharing-memo.md for the full evidence, and
// docs/cloud-signin-spike-plan.md for what it would take to flip
// this on.
//
// Until then, calling `fbrain share` prints the same pointer and exits
// non-zero so callers don't believe a no-op succeeded.

const MEMO_PATH = "docs/phase-3-sharing-memo.md";
const SIGNIN_PLAN_PATH = "docs/cloud-signin-spike-plan.md";

export type ShareOptions = {
  print?: (line: string) => void;
};

export function shareCmd(opts: ShareOptions = {}): number {
  const print = opts.print ?? ((line: string) => console.error(line));
  print(
    "fbrain share is a Phase 3 v0+ placeholder — see " + MEMO_PATH + ".",
  );
  print(
    "Short version: the cross-node transport is deployed (fold_db's sync",
  );
  print(
    "engine + the exemem cloud lambdas, both live in dev and prod), but",
  );
  print(
    "this homebrew daemon has not been signed in to it — `GET",
  );
  print(
    "/api/sharing/exemem-status` returns `connected: false`. The sharing",
  );
  print(
    "METADATA (ShareRule, ShareInvite, ShareSubscription) is fully",
  );
  print(
    "wireable on loopback, but no records actually move until the daemon",
  );
  print(
    "authenticates against exemem and an end-to-end positive test passes.",
  );
  print(
    "See " + SIGNIN_PLAN_PATH + " for what it would take to flip this on.",
  );
  return 1;
}
