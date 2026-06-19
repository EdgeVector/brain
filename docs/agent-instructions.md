# Use fbrain with your AI agent

Registering the MCP server (`claude mcp add fbrain fbrain-mcp`) gives your agent
the `fbrain_*` tools — but installed tools sit idle unless the agent is told
*when* and *why* to reach for them. This is the one-paste fix: drop the block
below into your agent's instructions (`CLAUDE.md`, system prompt, or equivalent)
so the brain is actually used, not just connected.

The block is self-contained — it relies only on the seven MCP tools fbrain
registers (`fbrain_search`, `fbrain_ask`, `fbrain_get`, `fbrain_list`,
`fbrain_put`, `fbrain_delete`, `fbrain_link`). See the [`## MCP`](../README.md#mcp)
section of the README for registration, the per-tool reference, and
`fbrain doctor --mcp` troubleshooting.

## Copy-paste block

```markdown
## fbrain (persistent memory)

You have an `fbrain` MCP brain — a searchable store of prior decisions, learnings,
and context that survives across sessions. Use it as a loop, not a filing cabinet:

1. **Recall first.** Before answering a non-trivial question or starting a task,
   call `fbrain_ask` (hybrid BM25 + vector recall — the strongest retrieval) to
   pull relevant prior context. Don't answer from memory alone when the brain may
   already hold the answer. Use `fbrain_search` for a pure-semantic lookup,
   `fbrain_get`/`fbrain_list` when you know the slug or want to browse a type.

2. **Checkpoint as you go.** When a decision, learning, or durable fact is
   settled, write it with `fbrain_put` *then* — don't wait to be asked, and don't
   batch it all to the end of the session where it gets lost. A one-line note now
   beats a perfect note never. For a large body (a design, a long decision log),
   stage it to a file and pass `body_path` instead of inlining `body` — a long
   inline `body` can be silently dropped in transit in long sessions, whereas a
   short path always survives.

3. **Pick the right type.** Every record has a type; choose the one whose purpose
   matches what you're recording (`fbrain_put` requires a type — there is no
   silent default):

   | Type | Use it for |
   |---|---|
   | `design` | An architecture or plan you intend to build |
   | `task` | A unit of work; links to a parent design |
   | `concept` | Reusable framework, pattern, or protocol recorded for cross-session reuse |
   | `preference` | User-stated directive applied across future decisions |
   | `reference` | Pointer to an external resource useful for future lookup |
   | `agent` | Persistent assistant identity with role and behavior conventions |
   | `project` | Active in-flight feature work tracked over its lifecycle |
   | `spike` | Time-boxed investigation or exploration with a defined conclusion |

   Link a `task` to its parent `design` with `fbrain_link`. Slugs are per-type, so
   pass `type` to `fbrain_get`/`fbrain_delete` whenever a slug could be ambiguous.
```

The fenced block above is rendered from `buildAgentInstructionsBlock()` in
[`src/schemas.ts`](../src/schemas.ts) — the *same* builder that `fbrain mcp
instructions` prints — and a test asserts the two are byte-for-byte identical, so
the doc and the command can't drift. The **Use it for** strings come from the
single `RECORD_PURPOSES` map in that file (the same source the README's *Record
types* table and the bare `fbrain` help print).

> Prefer the one-step on-ramp: `fbrain mcp instructions >> CLAUDE.md` (or
> `| pbcopy`) appends just this block, no surrounding prose — no need to open
> this file and hand-select the fenced lines.
