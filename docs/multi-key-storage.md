# Brain record storage

Each record type owns its values in one schema.
Canonical fields supply field names, types, descriptions, and classifications.
Canonical field reuse does not share a record value between schemas.
Equal slugs in different record types remain distinct records.

Each record schema supports a primary key and named alternate keys:

- The primary key uses the record slug.
- The `recent` key orders records by reverse update time and slug under `all`.
- The `by_status` key uses the status and the same order.
- The Task `by_design` key uses the design slug and the same order.

The node updates these keys with the source record.
Readers retain the primary identity in each named-key result.
A mutation uses the primary identity.
A cursor retains its scope and the last complete order key.

Tags, links, keyword pages, and exact counts remain separate app records.
They describe relationships or derived state that an alternate key does not replace.
A source write and its required app records use the app mutation plan.
The app requires a durable receipt before it reports a durable write.

## Existing app data

CAUTION: Existing app data requires explicit conversion before the new reader starts.

The steps, the flags, and the required LastDB release are in `docs/multi-key-schemas.md`.

The converter uses the type directory and exact counts as the membership source.
It checks each expected key and the count guard.
It retains record values, stored bodies, and canonical field definitions.
It changes the local schema ownership and adds the named keys.
Normal initialization creates the new layout directly.
Source changes do not authorize a change to the primary database or its archive.

## CI measurements

The Brain read workflow compares exact app and daemon revisions.
The earlier app creates equal generated homes on the compatible daemon.
The candidate explicitly converts its home before the native daemon starts.
A separate operational arm uses normal initialization on a new generated home.

Read measurements retain 1,000 and 10,000 records, three paired repeats,
one restart call per operation, and five subsequent warm calls.
The bodies retain the original complete generated text, approximately 4.6 KB each.
The workflow measures these real app operations:

- Read one full record by key.
- Read the first ordered page.
- Read all summaries.
- Read all full records.
- Read the admin snapshot counts.
- Preview a bulk delete selection.
- Read the source records for a migration.
- Use the keyword fallback with LastSeek absent.

Operational measurements retain the 128-record pass and three 1,024-record passes.
Each body contains 4,096 bytes.
The app creates each record with one commit, as `brain put` does.
Update, delete, and title-only mutation samples each change one record.
The checks verify exact membership, values, counts, body atoms, and restart recovery.
Creation, update, delete, and title-only samples use distinct operations.

The workflow requires the exact definitions in the DEV Schema Service before it builds a daemon.
`ENVIRONMENT: dev` selects that service for the check and for both daemons.
It does not replace missing definitions with system schemas or local names.
The required `benchmark-complete` check retains all operation and upload gates.
CI summaries and verified artifacts retain the measurements.
No primary data or local benchmark participates.
