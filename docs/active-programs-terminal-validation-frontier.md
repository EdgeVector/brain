# Active Programs Terminal Validation Frontier

`active-programs` is a durable Brain project record, not a checked-in source
file in this repository. When the record references terminal proof cards, keep
the prose explicit:

- `Kind: validation` terminal proof cards are proof work, not pickup-ready
  implementation slices.
- `program-driver` may point at terminal proof as the next proof to run, but it
  must not label those cards as `Kind: pr` frontiers.
- If terminal proof fails, file exactly one concrete `Kind: pr` child for the
  observed gap, then let pickup claim that child through normal board gates.

Verification for this invariant is live-data based:

```bash
brain get active-programs --type project
fkanban pickup claim --dry-run --json --worker dry-run
```
