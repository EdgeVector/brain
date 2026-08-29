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
// contributor to do (`brew services start lastdb`) — that socket EXISTS, so
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

// Keep the unit suite hermetic w.r.t. the resolved node home. `resolveNodeHome`
// probes `${LASTDB_HOME ?? FOLDDB_HOME ?? ~/.lastdb|~/.folddb}` for a live
// socket; on a dev machine running the daemon those dirs EXIST, which would
// shift home-derived assertions. Point FOLDDB_HOME at a guaranteed-nonexistent
// dir so the suite resolves identically with or without a live folddb on the
// machine. (The socket default is unaffected: FBRAIN_FOLDDB_SOCKET above wins
// over FOLDDB_HOME for the socket path.)
if (process.env.FOLDDB_HOME === undefined) {
  process.env.FOLDDB_HOME = "/nonexistent/fbrain-unit-suite-no-folddb-home";
}

// Keep semantic-plane tests hermetic w.r.t. a host-installed LastSeek binary.
// Tests that exercise LastSeek set LASTSEEK_BIN to their own fake subprocess
// and restore this default afterward. Production never loads this preload.
if (process.env.LASTSEEK_BIN === undefined) {
  process.env.LASTSEEK_BIN = "/nonexistent/fbrain-unit-suite-no-lastseek";
}

// Resident-commit writes POST `/api/mutations/batch`. Most unit fetch stubs
// only answer `/api/mutation`. Fan a 404 batch out into per-item mutation
// calls so those stubs keep working.
const nativeFetch = globalThis.fetch.bind(globalThis);
let installedFetch: typeof fetch = nativeFetch;

async function batchAwareFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const url = typeof input === "string" ? input : String(input);
  if (url.endsWith("/api/mutations/batch")) {
    const direct = await installedFetch(input, init);
    if (direct.status !== 404) return direct;
    const raw = typeof init?.body === "string" ? init.body : "";
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(raw) as { mutations?: unknown[] } | unknown[];
      items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.mutations)
          ? parsed.mutations
          : [];
    } catch {
      return new Response(JSON.stringify({ error: "bad batch" }), { status: 400 });
    }
    const mutationUrl = url.replace(/\/api\/mutations\/batch$/, "/api/mutation");
    for (const item of items) {
      const itemInit = { ...(init ?? {}), body: JSON.stringify(item) };
      const itemRes = await installedFetch(mutationUrl, itemInit);
      if (itemRes.status !== 200) return itemRes;
    }
    return new Response(
      JSON.stringify({
        mutation_ids: items.map((_, i) => `m${i}`),
        count: items.length,
        background_tasks_drained: false,
        convergence_pending: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return installedFetch(input, init);
}

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  get() {
    return batchAwareFetch as typeof fetch;
  },
  set(value: typeof fetch) {
    installedFetch = value;
  },
});
