# Brain Admin Deliver Slice

`fbrain admin-snapshot` dogfoods the Mini → Exemem → admin path used by kanban
and routines. It publishes a privacy-safe rollup into the internal
`BrainAdminSnapshot` schema, then stages/approve-sends a `delivery_slice` to
the **existing admin kanban-consumer** (no second enroll).

The snapshot intentionally contains only:

- live record counts by fbrain type (`type_counts_json`)
- open-decisions **live** ledger lines — slug + short title only
- the head of the `active-programs` rollup
- recent heartbeats as `{slug, ts, ok}`
- `captured_at` / `source_app` / `schema_version`

It does **not** include full brain bodies, secret values, raw logs, or live
socket access to the primary brain.

## Publish

```bash
fbrain admin-snapshot publish --json
fbrain admin-snapshot publish --dry-run --json
```

The JSON output includes:

- `schema_hash`: use as the deliver `schema_name`
- `record_key`: normally `admin-brain-snapshot`
- `delivery_stage.legs[0].fields`: fields to deliver
- `delivery_stage.legs[0].hash_keys`: the single snapshot record key

## Deliver (preferred)

Recipient keys are operational inputs — pass flags or env vars; do not commit
them. Reuse the public fields from the enrolled kanban-consumer bundle
(`exemem-infra/scripts/enroll-kanban-consumer.mjs` / Secrets Manager
`ExememKanbanConsumer-{dev,prod}`).

```bash
export FBRAIN_ADMIN_RECIPIENT_PUBKEY=...          # ed25519 public
export FBRAIN_ADMIN_MESSAGING_PUBLIC_KEY=...      # x25519 public
export FBRAIN_ADMIN_MESSAGING_PSEUDONYM=...

fbrain admin-snapshot deliver --dry-run --json
fbrain admin-snapshot deliver --max-records 5
fbrain admin-snapshot deliver --approve --max-records 5
```

`ROUTINES_ADMIN_*` aliases are also accepted (same keys as
`routines deliver-status`). Without `--approve`, the command stages only and
prints the pending `delivery_id`. With `--approve`, Mini seals and sends a
`delivery_slice`. Non-secret evidence: `delivery_id`, shared count, message
type, schema hash, record count.

Mailbox poll + `openDelivery` stay on the admin SPA / consumer tooling.

## Manual raw path (optional)

If you need to stage by hand:

```bash
fbrain raw POST /api/sharing/deliver "$(cat /tmp/brain-admin-deliver.json)"
fbrain raw GET /api/sharing/deliveries
fbrain raw POST /api/sharing/deliveries/<delivery_id>/approve
```

Stage body shape:

```json
{
  "recipient_pubkey": "<admin consumer Ed25519 public key>",
  "recipient_display_name": "admin-dashboard brain consumer",
  "messaging_public_key": "<admin consumer X25519 public key>",
  "messaging_pseudonym": "<admin consumer messaging UUID>",
  "mode": "snapshot",
  "max_records": 5,
  "legs": [
    {
      "schema_name": "<schema_hash from fbrain admin-snapshot publish --json>",
      "fields": [
        "slug",
        "source_app",
        "schema_version",
        "captured_at",
        "type_counts_json",
        "open_decisions_json",
        "active_programs_head_json",
        "recent_heartbeats_json"
      ],
      "hash_keys": ["admin-brain-snapshot"]
    }
  ]
}
```
