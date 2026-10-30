# Brain multi-key schemas

New installations declare independent record values. Canonical fields still reuse their definitions.
Named keys belong to the source record schema. A mutation updates the record and its keys in one native request.

Each record kind uses recent and status keys. Task also uses a design key. Ranges contain the reverse UTC timestamp and the slug. Tags, links, graph edges, counts, and body files remain separate records with independent values. A list cursor belongs to one filter.

## Existing installations

CAUTION: Convert an existing home on the compatible LastDB release from EdgeVector/lastdb#793. The removal release from EdgeVector/lastdb#803 does not start while any shared-value schema remains in the home.

The compatible release reports the `app_schema_conversion_v1`, `compound_alternate_keys_v1`, and `independent_hash_range_v1` capabilities. It still opens shared-value schemas.

Do these steps in this order:

1. Install this Brain release. Keep the compatible LastDB release on the node.
2. Run `brain multi-key-convert` to read the plan. The command makes no change.
3. Review the plan:
   - `schemas`: the Brain schemas that the conversion keeps. Each one gets its own values and its named keys.
   - `retire`: local aliases that map only kept schemas. They hold no values of their own.
   - `legacy`: Brain schemas that this release does not read, for example `Papercut` or the old graph edge schemas.
4. If `legacy` is empty, run `brain multi-key-convert --apply --maintenance`.
5. If `legacy` is not empty, run `brain multi-key-convert --apply --maintenance --retire-legacy`. The apply refuses a non-empty list without this flag.
6. Upgrade LastDB to the removal release only after the command reports the `complete` phase.

CAUTION: `--retire-legacy` drops each legacy schema and its values. No Brain command reads those values. Keep a backup of the home before the apply.

Init and ordinary mutations do not run the conversion.

The node freezes requests, copies the current atom references and author clocks, creates the named keys, and retires the reviewed aliases and legacy schemas.
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
The legacy code remains for an installation that does not complete the explicit cutover. That code needs the compatible release.

## CI comparison

The linked LastDB CI run compares the exact app revisions on the same daemon revision.
The workload uses generated data on owned CI homes.
It checks logical record membership, order, bodies, updates, and cursors.
Physical database size may decrease. Logical record counts must remain correct.
The primary does not participate in this check.
