# Brain v2 storage spike

The branch `spike/brain-v2-molecules-20261027` contains an opt-in storage adapter for the existing Brain client.
Normal Brain commands and initialization keep their current behavior.
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
