# Brain multi-key schemas

New installations declare independent record values. Canonical fields still reuse their definitions.
Named keys belong to the source record schema. A mutation updates the record and its keys in one native request.

Each record kind uses recent and status keys. Task also uses a design key. Ranges contain the reverse UTC timestamp and the slug. Tags, links, graph edges, counts, and body files remain separate records with independent values. A list cursor belongs to one filter.

## Existing installations

Run `brain multi-key-convert` to read the plan.
Use `--apply --maintenance` only for an explicit request pause and config cutover.
The command does not run during init or an ordinary mutation.

The node freezes requests, copies the current atom references and author clocks, creates the named keys, and retires reviewed legacy aliases.
The type directory identifies record membership. Per-kind counts guard the directory selection.
The converter refuses unique source values without a selected member. It does not infer membership from a shared key field.

The command writes the config to disk before the node resumes requests.
Repeat the same command after an interruption.
Before publication, `--apply --maintenance --abort` removes the unpublished copy and restores the old state.
After publication, resume forward. The node keeps requests blocked until completion.

The converter requires healthy counters, ordinary source schemas, no kept history, no molecule generations, no database catalog membership, and no registered logical peers.
It refuses mapped source authorities and unknown older schema shapes.
Those states require a separate reviewed conversion.

Older app declarations refuse converted schemas. A ranged mutation cannot silently address an independent hash-only record.
The legacy code remains for an installation that does not complete the explicit cutover.

## CI comparison

The linked LastDB CI run compares the exact app revisions on the same daemon revision.
The workload uses generated data on owned CI homes.
It checks logical record membership, order, bodies, updates, and cursors.
Physical database size may decrease. Logical record counts must remain correct.
The primary does not participate in this check.
