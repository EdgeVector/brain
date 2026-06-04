# MCP server smoketest

End-to-end check that fbrain's MCP server (`fbrain mcp`) exposes the
six tools — read: `fbrain_search`, `fbrain_get`, `fbrain_list`; write:
`fbrain_put`, `fbrain_delete`, `fbrain_link` — and that an MCP client
(Claude Code or `@modelcontextprotocol/inspector`) can call them
against a live `~/.fbrain/config.json`.

> Prerequisite: `fbrain init` has been run and `fbrain doctor` is green.
> The MCP server reads the same config file as the CLI.

## A. Register with Claude Code

After the Quick start `bun link` (puts `fbrain-mcp` on your `PATH`),
from any directory:

```bash
claude mcp add fbrain fbrain-mcp
```

This writes an entry to your Claude Code MCP servers list. Restart any
running Claude Code session so the new server is picked up. The
`fbrain-mcp` binary is published from `package.json`'s `bin` field and
points at `src/mcp/main.ts`.

Running from a source checkout without `bun link`? From the repo root:

```bash
claude mcp add fbrain bun "$(realpath src/mcp/main.ts)"
```

That form bakes an absolute path to this clone into the MCP config —
move or delete the clone and the registration breaks. Prefer the
linked-binary form above.

## B. Verify the tools are discoverable

In a new Claude Code session, ask:

> List the tools exposed by the `fbrain` MCP server.

Expected: Claude reports six tools — `fbrain_search`, `fbrain_get`,
`fbrain_list`, `fbrain_put`, `fbrain_delete`, `fbrain_link`. If you
see "no tools" or "server not connected", check the Claude Code logs
(`~/Library/Logs/Claude` on macOS) for stderr from the
`bun src/mcp/main.ts` process. The most common failure is
`ConfigMissingError` — run `fbrain init` first.

## C. Smoketest each tool

Run each prompt in a fresh Claude Code turn. The expected behavior is
that Claude picks the right MCP tool, invokes it with sensible args,
and surfaces results in chat.

### C.1 — `fbrain_search`

> Use the fbrain MCP server to search for "replacement direction".
> Show me the top 3 hits.

Expected: Claude calls `fbrain_search` with `{query: "replacement
direction", limit: 3}` and returns a text block with `slug · score ·
type · title` lines. With the readiness-gate placeholder seeded in the
brain (see `docs/g0-replacement-readiness-gate.md`), expect at least
one hit referencing that page.

### C.2 — `fbrain_get`

> Use fbrain to get the record with slug `g0-replacement-readiness-gate`.

Expected: Claude calls `fbrain_get` with `{slug:
"g0-replacement-readiness-gate"}` and prints the record (title, status,
tags, body). If multiple types share the slug, the tool errors with
"Specify type" — re-prompt with the right `type` argument.

### C.3 — `fbrain_list`

> Use fbrain to list all designs, newest 5 first.

Expected: Claude calls `fbrain_list` with `{type: "design", limit: 5}`
and prints `type · slug · status · title` lines.

### C.4 — `fbrain_put` (write)

> Use fbrain to put a new concept with slug `mcp-smoketest` and body
> "hello world from MCP".

Expected: Claude calls `fbrain_put` with `{type: "concept", slug:
"mcp-smoketest", body: "hello world from MCP"}` and surfaces
`created concept mcp-smoketest`. Verify with `fbrain get mcp-smoketest`
from the terminal — the record should be there with the body the
agent passed.

If the agent passes `status` alongside (e.g. `status: "archived"`),
the put is followed by a `fbrain status` mutation. The tool returns
both lines: `created concept mcp-smoketest` and
`concept mcp-smoketest: active → archived`.

### C.5 — `fbrain_delete` (write)

> Use fbrain to delete the concept `mcp-smoketest`.

Expected: Claude calls `fbrain_delete` with `{slug: "mcp-smoketest",
type: "concept"}` and surfaces
`deleted concept mcp-smoketest (soft — fold_db is append-only; …)`.
Verify with `fbrain get mcp-smoketest` — should return
`No record with slug "mcp-smoketest"`. The slug is reusable
immediately afterward.

If you omit `type`, the wrapper probes every type and errors with
`ambiguous_slug` when the slug exists in more than one. That mirrors
the CLI's `fbrain delete` behavior.

### C.6 — `fbrain_link` (write)

> Use fbrain to link task `mcp-smoketest-task` to design
> `mcp-smoketest-design`.

Expected: Claude calls `fbrain_link` with `{from_type: "task",
from_slug: "mcp-smoketest-task", to_type: "design", to_slug:
"mcp-smoketest-design"}` and surfaces
`linked task mcp-smoketest-task → design mcp-smoketest-design`.
Verify with `fbrain get mcp-smoketest-task` — the `design_slug:` line
should show `mcp-smoketest-design`.

v0 supports `task → design` only. Any other pair errors with
`unsupported_link_pair` before any HTTP traffic.

## D. Inspector fallback (no Claude Code needed)

If you don't have Claude Code installed but want to verify the server,
the official MCP inspector ships a CLI:

```bash
bunx @modelcontextprotocol/inspector bun src/mcp/main.ts
```

The inspector opens a local web UI. Use the "List Tools" button — you
should see six tools registered. Click each tool, fill in the args
panel (e.g. `query: "replacement"` for search), hit "Call Tool".

## E. Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `error: Config not found at ~/.fbrain/config.json` | `fbrain init` not run | Run `fbrain init` |
| `error: node not reachable at http://127.0.0.1:9001` | homebrew `fold_db_node` daemon not running | Start the daemon; `fbrain doctor` |
| Tools appear in the client but every call returns `isError: true` with a `schema collision` message | Config's schema hashes are stale | Re-run `fbrain init` |
| Server starts but Claude Code reports "no tools" | Process crashed before connecting | Check Claude Code logs for the stderr line; usually `bun` not on PATH or `src/mcp/main.ts` wrong absolute path in the `claude mcp add` invocation |
| `unknown command: mcp` from `fbrain mcp` | This branch not installed via `bun link`/`bun install` | Re-link from this checkout; `which fbrain` should resolve to the project's `src/cli.ts` |
