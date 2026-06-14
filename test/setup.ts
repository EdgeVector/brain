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

// Keep the unit suite hermetic w.r.t. owner-session attestation (fold#739).
// `attestOwnerSession` fires a real UDS `fetch` whenever a control socket
// exists on disk at the resolved path (default `~/.folddb/data/folddb.sock`).
// On any dev machine running the daemon — exactly what the README tells a new
// contributor to do (`brew services start folddb`) — that socket EXISTS, so
// the attestation fetch lands on the global-`fetch` stub the unit tests
// install, silently consuming the first canned response and shifting every
// later assertion (HTTP 500 fall-through, dropped pagination rows, etc.). CI
// passes only because no socket exists there. Default the socket path to a
// guaranteed-nonexistent file so `existsSync` is false and no attestation
// fetch is ever issued — making the suite pass identically with or without a
// live folddb on the machine. Tests that specifically exercise attestation
// (test/unit/owner-session-attest.test.ts) point this env at a real fixture
// socket for their duration; the env override is the documented highest-
// precedence socket selector, so it cleanly wins for those.
if (process.env.FBRAIN_FOLDDB_SOCKET === undefined) {
  process.env.FBRAIN_FOLDDB_SOCKET = "/nonexistent/fbrain-unit-suite-no-socket.sock";
}
