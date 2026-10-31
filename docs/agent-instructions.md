# Use brain with your AI agent

Registering the MCP server (`claude mcp add brain brain-mcp`) gives your agent
the `brain_*` tools — but installed tools sit idle unless the agent is told
*when* and *why* to reach for them. This is the one-paste fix: drop the block
below into your agent's instructions (`CLAUDE.md`, system prompt, or equivalent)
so the brain is actually used, not just connected.

The block is self-contained — it relies only on the ten MCP tools brain
registers (`brain_search`, `brain_ask`, `brain_get`, `brain_list`,
`brain_backlinks`, `brain_put`, `brain_status`, `brain_append`,
`brain_delete`, `brain_link`).
See the [`## MCP`](../README.md#mcp)
section of the README for registration, the per-tool reference, and
`brain doctor --mcp` troubleshooting.

## Copy-paste block

```markdown
## brain (persistent memory)

You have an `brain` MCP brain — a searchable store of prior decisions, learnings,
and context that survives across sessions. Use it as a loop, not a filing cabinet:

1. **Recall first.** Before answering a non-trivial question or starting a task,
   call `brain_ask` (hybrid BM25 + vector recall — the strongest retrieval) to
   pull relevant prior context. Don't answer from memory alone when the brain may
   already hold the answer. Use `brain_search` for a pure-semantic lookup,
   `brain_get`/`brain_list` when you know the slug or want to browse a type.

2. **Checkpoint as you go.** When a decision, learning, or durable fact is
   settled, write it with `brain_put` *then* — don't wait to be asked, and don't
   batch it all to the end of the session where it gets lost. A one-line note now
   beats a perfect note never. Unless the body is a short single line, stage it
   to a file and pass `body_path` (or pass `body_b64`) instead of inlining
   `body` — an inline `body` with newlines, quotes, or emoji can fail to parse
   (an opaque `could not be parsed as JSON` error) or be dropped in transit at
   ANY size, so this is not size-gated; a short path/base64 always survives. To
   UPDATE an existing record, reach for the
   right-sized tool instead of a full `brain_put`: `brain_status` changes only
   the status, and `brain_append` adds to the body without a rewrite. This
   matters because `brain_put` is a FULL REPLACE whose body defaults to empty —
   a status-only re-put wipes the body, and a get-then-re-put truncates any
   record bigger than one `brain_get` window. `brain_put` guards against that
   (it refuses a re-put that would shrink the body dramatically), so let the
   guard route you to `brain_append`/`brain_status` rather than overriding it.

3. **Pick the right type.** Every record has a type; choose the one whose purpose
   matches what you're recording (`brain_put` requires a type — there is no
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
   | `sop` | Standard operating procedure: a repeatable step-by-step process an agent follows to perform a recurring task |
   | `decision` | A call a human made — the choice, its rationale, and outcome — kept as an auditable trail |

   Link records with `brain_link`. Passing only `from_slug` and `to_slug`
   preserves the legacy task → design default; pass `from_type`/`to_type` for
   non-default explicit links. `brain_get`'s `linked_from` field lists the
   type and slug of every record that links here (one index read, cheap to
   crawl); call `brain_backlinks` when you also need each source's status
   and whether it links by explicit edge or body `[[slug]]` reference.
   Slugs are per-type, so pass `type` to `brain_get`/`brain_delete`
   whenever a slug could be ambiguous; without it, the type named by the
   slug prefix (`design-…`, `decision-…`) is tried first.

4. **It scales — call it liberally.** Point lookups (`brain_get`, a filtered
   `brain_list`) are index-backed and stay flat, well under a millisecond, from
   a thousand records to well past a hundred thousand — recalling a known slug
   never gets slower as the brain grows. `brain_ask`/`brain_search` run over
   an ANN-indexed vector store, around 4ms at 120K embedded fragments versus
   around 46ms for an exhaustive scan — fast enough to call before every
   non-trivial answer, not just the hard ones. The one call whose cost tracks
   corpus size is an unfiltered `brain_list` with no type, tag, or status — it
   returns every live record, so scope it when browsing a large brain.
```

The fenced block above is rendered from `buildAgentInstructionsBlock()` in
[`src/schemas.ts`](../src/schemas.ts) — the *same* builder that `brain mcp
instructions` prints — and a test asserts the two are byte-for-byte identical, so
the doc and the command can't drift. The **Use it for** strings come from the
single `RECORD_PURPOSES` map in that file (the same source the README's *Record
types* table and the bare `brain` help print).

> Prefer the one-step on-ramp: `brain mcp instructions >> CLAUDE.md` (or
> `| pbcopy`) appends just this block, no surrounding prose — no need to open
> this file and hand-select the fenced lines.
