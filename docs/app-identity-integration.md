# Brain access to LastDB

Brain declares schema ownership in its app manifest and connects to the local
LastDB owner socket. The socket authenticates the operating-system user.
The same connection serves initialization, reads, complete conditional writes
and record files.

`brain init` confirms the configured node identity after declaring its schemas.
The existing `--grant-consent` and `--yes` flags remain accepted for callers.
Local commands use owner access without acquiring a cached capability.

Remote nodes retain their capability protocol. Brain can reuse a cached
capability or request approval through the remote node. Its owner must approve
that request through the target node's supported administration flow.

| Code | Responsibility |
|---|---|
| `src/commands/init-consent.ts` | Confirm local owner access or establish remote consent. |
| `src/write-context.ts` | Select owner-socket access for local writes and search, or capability handling for remote nodes. |
| `src/capability-session.ts` | Reuse and refresh remote capabilities, and propagate owner-socket failures. |
| `src/client.ts` | Send the current record protocol through the selected transport. |
| `src/lastseek-plane.ts` | Run `lastseek search --app brain` for ranked keys. Brain then reads the records from LastDB. Exit 3 (`index_not_ready`) uses the keyword fallback. |
| `src/lastseek-schemas.ts` | The `brain/<Type>` schema names Brain passes to `lastseek index --schema` and `lastseek search --schema`. |
| `src/lastseek-index.ts` | Run `lastseek index --app brain` for that list. `brain init` does not wait. `brain index` prints LastSeek's JSON. `brain index --wait` stays for the build. |

Use `lastdb status` for node health and `lastdb admin ops` for request load.
Use `brain index` to name the schemas. Use `lastseek status --app brain` to inspect the index. Brain does not read LastSeek's files.
