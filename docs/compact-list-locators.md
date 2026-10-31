# Compact list locators

A list locator answers one exact question: which page contains this card in
this list? It does not need an ordered range.

`BrainCompactListLocator_v1` uses one hash key and one stored field,
`bcl_page`. The key is the SHA-256 digest of the complete list-hash and card
identity tuple, with a versioned domain prefix. Its API form is 43 characters.
The schema declares no hash-value field, so Mini does not create a second
field solely to repeat the request coordinate.

The older locator uses three stored fields and puts `type#slug` in its range.
The current Mini range codec expands each input byte to eight characters.
The new hash key avoids that range and the two redundant key-value fields.
For each converted locator, the current field count falls from three to one.

## Compatibility and conversion

`brain init` resolves the new support schema under the separate
`__braincompactlocator__` config key. The old support schema stays registered.
A config without the new key continues to use the old layout. No write path
registers a schema or changes a primary program.

The reader batches both exact addresses while the old schema remains in the
config. A compact value takes precedence. The legacy address remains a
fallback, and the reader also names old copies for retirement.

A later write replaces a known old locator with its compact value and removes
the old record in the same record batch. A delete removes both known copies,
so a fallback cannot restore an old locator. Page validation still proves
membership before the write. The conversion batch cap is 128 operations;
it includes the extra old-locator erasures.

Named-slug backfill uses the same reader and writer. It verifies the named
pages before a replacement. A locator already covered by its page remains
unchanged until a later record write. Backfill does not walk the primary without keys.
Cards moved from a full head can acquire a compact locator before their old
locator is read. A later named write or backfill reads both copies and removes
the old copy.

Stop older Brain writers before a home copy. An older app does not
read the new support schema. Existing deletion markers and old file bytes can
remain until the supported storage maintenance or a later format transfer.
This change does not promise an immediate physical disk reduction.

## Empty helper records

A missing edge set, frontmatter edge set, or token set means an empty set.
Normal writes do not create records solely to store `[]`. A write that clears
an existing set removes its record after the corresponding membership change.
Product record bodies and nonempty sets remain in place.

No primary upgrade, schema initialization, or live backfill accompanies this
source change. The installed Brain app remains on its existing release.
