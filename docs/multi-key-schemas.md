# Brain multi-key schemas

Each Brain schema owns its record values. Canonical fields still reuse their definitions.
`brain init` requires LastDB API 13 or later (lastdb #803). That node owns the values of every schema that an app declares.
Named keys belong to the source record schema. A mutation updates the record and its keys in one native request.

The compact list locator keeps its external digest key and sole page field. Its schema key stays empty and it has no alternate keys.
Owned setup declares this shape like the other schemas. It needs no conversion capability, because a fresh home holds no shared locator.
The app does not invent a stored hash field or reconstruct API keys.

Each record kind uses recent and status keys. Task also uses a design key. Ranges contain the reverse UTC timestamp and the slug. Tags, links, graph edges, counts, and body files remain separate records that own their values. A list cursor belongs to one filter.

## Existing installations

This release does not convert a home in place. It has no conversion command.

CAUTION: This release needs LastDB API 13 or later. Init refuses an older node with `home_copy_required` and makes no change.

A config without `storageModel: "multi-key-v1"` uses a retired Brain storage model. This release does not read it. Config load refuses it with `home_copy_required`, so init and each other command that reads the config stop and make no change.

An existing home moves to this release only by the home copy (EdgeVector/last-stack#377):

1. The home copy reads the old home. It does not change the old home.
2. The home copy writes the records to a new home that this release initializes.
3. The new home uses the `brain` app ID, the `brain` definitions, and the named keys.
4. The old home stays unchanged as the recovery point.

Old app declarations refuse the new schemas. A ranged mutation cannot silently address an independent hash-only record.

## Migration note

Earlier releases used the app ID `fbrain`. This release uses the app ID `brain`.
The home copy maps these stored and local names:

| Earlier name | This release |
|---|---|
| App ID and schema owner `fbrain` | `brain` |
| Deletion tag `__fbrain_deleted__` | `__brain_deleted__` |
| Backlink tag prefix `__fbrain_backlink__:` | `__brain_backlink__:` |
| Capability store key `fbrain@<hash>` | `brain@<hash>` |
| Environment variables `FBRAIN_*` | `BRAIN_*` |
| Data directory fallback `~/.fbrain` | `~/.brain` only |
| MCP tools `fbrain_*` | `brain_*` |

Ten field descriptions and purpose statements in `src/schemas.ts` still name `fbrain`.
They stay unchanged because the Schema Service identity hash includes them.

## CI comparison

The CI comparison runs the earlier app and this app on one LastDB revision, so it measures the app change.
Each app initializes its own generated home. No home is converted in place.
The workload uses generated data on owned CI homes.
It checks logical record membership, order, bodies, updates, and cursors.
Logical record counts must remain correct.
The primary does not participate in this check.

Alternate-key requests, saved scopes, native receipts, and owned-layout comparisons use the exact Rust wire defaults.
This keeps key fields, part order, formats, and missing-value behavior intact. Unknown properties and invalid types stop the operation.
