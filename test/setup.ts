// Bun test preload (wired via bunfig.toml `[test] preload`).
//
// fbrain's app_identity enforcement defaults ON in production (matching the
// node's APP_IDENTITY_ENFORCE), which means every write command would try to
// acquire a capability — talking to /api/apps/* — on the first mutation. The
// existing command unit tests exercise the write path against a stubbed fetch
// or a mock NodeClient that knows nothing about consent, so we default
// enforcement OFF for the suite. Tests that specifically cover the capability
// flow (test/unit/capability*.test.ts) drive `newWriteNodeClient` / the
// session directly with an in-memory store + transport, or set the env back
// on for the duration of the test — so they're unaffected by this default.
//
// Real-world behavior is unchanged: nothing reads test/setup.ts outside `bun
// test`, and the production default (enforce ON) is the env-unset case.

if (process.env.FBRAIN_APP_IDENTITY_ENFORCE === undefined) {
  process.env.FBRAIN_APP_IDENTITY_ENFORCE = "false";
}
