# Brain v2 storage spike

The branch `spike/brain-v2-molecules-20261027` contains an opt-in storage adapter for the existing Brain client.
Normal initialization does not activate the adapter.
The adapter uses one record schema and three narrow native lookup schemas.
Proteins share their field atoms. A separate schema holds tag memberships.

The CI workflow compares the current Brain write plan with the adapter on the same pinned LastDB release.
Each layout receives 1,024 generated records, 4,096 body bytes per record, two tags, and two record types.
The workload sends 256 updates to the sixteen most recent records and deletes eight recent records.
It measures an older-record update separately because the current layout can refuse that operation after page overflow.
Three paired repeats alternate the layout order on one CI worker.
Every repeat uses a fresh generated home.

The result includes:

- The disk size after a flush, with logical bytes and allocated bytes.
- Separate sizes for the database, the Search delivery queue, and other files.
- The daemon memory size and the client memory size, with samples every 50 ms.
- The median, 95th percentile, and 99th percentile for durable create and update calls.
- The request count per record operation.
- Keyed read results for every generated record after updates, deletes, and a daemon restart.
- Native list continuation, typed status lists, tag lists, duplicate slugs, concurrent edits, and recreation.
- The actual protein membership for the shared identity field across all four layouts.

Write latency includes the addressed read, the write plan, and the durable mutation result.
It excludes command startup, frontmatter parsing, and the optional cross-type hint reads.
The adapter writes changed fields only. The node retains the other field values and uses stored scalar fields for key moves.

The workflow verifies the release archive checksum and the daemon source revision.
The CI summary contains the comparison. Raw output stays in a CI artifact for 14 days.
No local benchmark, primary access, primary copy, or test suite is required.

## Scope limits

This is a storage spike, not a complete app upgrade.
The current path also maintains counts and bounded keyword fallback pages.
The adapter does not yet implement those features, so their costs remain part of the current-path result.
LastSeek search, body files, attachments, graph relationships, and conversion remain outside this comparison.
The adapter refuses a body above 48 KiB.

CI seeds local system schemas to isolate storage cost from shared schema-service calls.
Production registration and declaration-issued field identities need a separate rollout.
The spike must show actual native lookup behavior before any cost result supports the redesign.
An improvement in one metric does not establish an improvement in the other metrics.

Keep the spike branch after the CI result.
Do not activate it on an existing Brain home or upgrade the primary through this work.

## Bulk read follow-up

The read workflow compares the retained spike revision with the new read code.
It uses 1,000 and 10,000 generated records on the same pinned LastDB release.
Each comparison has three paired repeats, one call after a daemon restart, and five later calls per operation.
The OS file cache remains in place after a daemon restart.

The operations are get, first page, all summaries, all records, snapshot counts, bulk selection, and migration source reads.
Current Brain also measures the keyword fallback with LastSeek absent.
V2 has no search adapter or snapshot command.
Its count operation reads all identities and types; it does not maintain a count schema.

The setup writes equal generated corpora through native mutation batches.
It writes the current page format and count records directly, outside the measured read time.
This method measures read cost; it does not measure corpus creation cost or production enrollment.
Each complete result must match the generated membership and field values.
The workflow records a baseline resource-limit error as a failure, with the elapsed time to failure.
A failed request does not count as a successful latency.
Any candidate failure stops the job.

Current Brain reads one hash of page atoms together, then follows only its linked pages.
Normal list calls still read one exact page.
Batch reads use at most 100 keys per request and four requests at once.
Migration reads use these batches for each page of storage keys.
Snapshot counts use one batch of maintained counters.
Bulk selection reads the summary fields it needs and checks current status and tags.
It does not fetch record bodies.
V2 has an explicit bulk page iterator with a maximum of 500 identities per page.
The caller can process each page without a full corpus in memory.

The CI summary contains before and after latencies and request counts.
Raw artifacts contain response bytes, memory samples, source revisions, and failures.
The operation clock excludes module imports and process startup.
The operation clock also excludes the final membership and field checks.
Bulk record reads request the public record fields in both versions.
V2 counts omit titles, tags, and record bodies through the new field selection.
The artifact also records the full workload process time.
Small sample counts limit conclusions about p95 and p99.
