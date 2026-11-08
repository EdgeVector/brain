# Brain multi-key schemas

Each Brain schema owns its record values. Canonical fields still reuse their definitions.
`brain init` requires LastDB API 29 or later (`package.json` `lastdb.minApiVersion`). That node owns the values of every schema that an app declares.
Named keys belong to the source record schema. A mutation updates the record and its keys in one native request.

The compact list locator keeps its external digest key and sole page field. Its schema key stays empty and it has no alternate keys.
Owned setup declares this shape like the other schemas. It needs no conversion capability, because a fresh home holds no shared locator.
The app does not invent a stored hash field or reconstruct API keys.

Each record kind uses recent and status keys. Task also uses a design key. Ranges contain the reverse UTC timestamp and the slug. Tags, links, graph edges, counts, and body files remain separate records that own their values. A list cursor belongs to one filter.

A config must set `storageModel` to `multi-key-v1`. Any other value is `config_invalid`.

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
