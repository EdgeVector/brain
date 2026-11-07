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
| `src/lastseek-plane.ts` | Query LastSeek for ranked keys. Brain then reads the records from LastDB. |

Use `lastdb status` for node health and `lastdb admin ops` for request load.
Use `lastseek status` and `lastseek doctor` for the semantic index.
