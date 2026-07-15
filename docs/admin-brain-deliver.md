# Brain Admin Deliver Slice

`fbrain admin-snapshot publish` writes one privacy-safe record to the internal
`BrainAdminSnapshot` schema. The record is designed for the existing
LastDB Mini deliver flow, so Exemem admin can receive it as a normal
`lastdb.slice.v1` delivery.

The snapshot intentionally contains only:

- live record counts by fbrain type
- open decision slugs, titles, and statuses
- the head of the `active-programs` rollup
- recent heartbeat ids, timestamps, and outcomes
- `captured_at`

It does not include full brain bodies, secret values, raw logs, or live socket
access to the primary brain.

## Publish

```bash
fbrain admin-snapshot publish --json
```

The JSON output includes:

- `schema_hash`: use as the deliver `schema_name`
- `record_key`: normally `admin-brain-snapshot`
- `delivery_stage.legs[0].fields`: fields to deliver
- `delivery_stage.legs[0].hash_keys`: the single snapshot record key

`--dry-run --json` builds the same payload without writing the snapshot record.

## Stage And Approve Delivery

Use the existing admin kanban-consumer identity unless isolation is required.
Read its non-secret recipient metadata from the enrolled bundle path used by
`exemem-infra/scripts/enroll-kanban-consumer.mjs`; retrieve any secret material
only at point of use.

Stage body shape:

```json
{
  "recipient_pubkey": "<admin consumer Ed25519 public key>",
  "recipient_display_name": "admin-dashboard brain consumer",
  "messaging_public_key": "<admin consumer X25519 public key>",
  "messaging_pseudonym": "<admin consumer messaging UUID>",
  "mode": "snapshot",
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

Then use Mini's owner UDS delivery endpoints:

```bash
fbrain raw POST /api/sharing/deliver "$(cat /tmp/brain-admin-deliver.json)"
fbrain raw GET /api/sharing/deliveries
fbrain raw POST /api/sharing/deliveries/<delivery_id>/approve
```

After approval, the admin mailbox should contain a `delivery_slice` message
that decrypts with the same `openDelivery` path used by the Kanban tab.
