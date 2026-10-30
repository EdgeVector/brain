# Brain multi-key schemas

New installations declare independent record values. Canonical fields still reuse their definitions.
Named keys belong to the source record schema. A mutation updates the record and its keys in one native request.

Each record kind uses recent and status keys. Task also uses a design key. Ranges contain the reverse UTC timestamp and the slug. Tags, links, graph edges, counts, and body files remain separate records with independent values. A list cursor belongs to one filter.

## Existing installations

CAUTION: Convert an existing home on the compatible LastDB release from EdgeVector/lastdb#793. The removal release from EdgeVector/lastdb#803 does not start while any shared-value schema remains in the home.

The compatible release reports `app_schema_conversion_v1`, `compound_alternate_keys_v1`, and `independent_hash_range_v1`.
A conversion that retires local aliases also requires `app_schema_alias_retirement_v1`.
The node checks each alias against one kept source before the request pause. Unique old layouts stay unchanged.

Do these steps in this order:

1. Install this Brain release. Keep the compatible LastDB release on the node.
2. Run `brain multi-key-convert` to read the plan. The command makes no change.
3. Review the selected runtime schemas, definitions, type-directory membership, per-type counts, alternate keys, and local alias list.
4. Run `brain multi-key-convert --apply --maintenance`.
5. Resume the same command after an interruption. Keep the selected config and its `.conversion.json` file.
6. Run normal init after a complete conversion to declare missing empty types. Init preserves existing runtime addresses and definition identities.
7. Upgrade LastDB to the removal release only after every app conversion completes.

CAUTION: A type inside another type, such as Sop inside Concept, needs a native conversion that preserves current atoms and author metadata.
This command refuses that shape before any declaration, mutation, or request pause. It does not copy records through ordinary writes.

CAUTION: Unknown legacy schemas need a separate reviewed conversion. The retired `--retire-legacy` option refuses the request.
No option discards their unique values. Equal field definitions do not prove equal record membership.

Each distinct record type keeps its own schema. Each type selects its records through the type directory.
The per-type count guards that selection. A missing type with a non-zero count stops the plan.
A missing empty type stays absent until normal init after the conversion.

Before the request pause, the command saves the exact config hashes, full schema requests, membership, and alias list to a durable local scope.
The returned node change ID binds that scope to one job. Resume and abort require the same full scope.
The node then freezes requests, preserves current atom references and author clocks, creates the named keys, and retires only audited aliases.
The command writes the config to disk before the node resumes requests. It checks the config and scope again after awaited reads.

Before publication, `--apply --maintenance --abort` removes the unpublished copy and restores the old state.
After publication, resume forward. The node keeps requests blocked until completion.
An unrelated pending job cannot supply membership, take over this config, or authorize an abort.

The converter requires healthy counters, ordinary source schemas, no kept history, no molecule generations, no database catalog membership, and no registered logical peers.
It refuses unknown schema shapes, transforms, incomplete type membership, and mixed values without its exact pending scope.
Those states require a separate reviewed conversion.

Init refuses an active local scope. Repeat init retains the supported owner mode and existing field profiles.
Old app declarations refuse converted schemas. A ranged mutation cannot silently address an independent hash-only record.
Legacy app code needs the compatible release until the explicit conversion completes.

## CI comparison

The linked LastDB CI run compares the exact app revisions on the same daemon revision.
The workload uses generated data on owned CI homes.
It checks logical record membership, order, bodies, updates, and cursors.
Physical database size may decrease. Logical record counts must remain correct.
The primary does not participate in this check.

Alternate-key requests, saved scopes, native receipts, and owned-layout comparisons use the exact Rust wire defaults.
This keeps key fields, part order, formats, and missing-value behavior intact. Unknown properties and invalid types stop the operation.
