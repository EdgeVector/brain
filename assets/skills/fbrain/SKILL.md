---
name: fbrain
description: |
  Install and use fbrain — a personal knowledge base ("brain") stored in your
  fold_db node. Capture and recall notes across eight record types (designs,
  tasks, concepts, preferences, references, agents, projects, spikes) with
  semantic search, and serve them to an agent over MCP. Use when the user says
  "set up fbrain", "install fbrain", "remember this in fbrain", "save a note /
  design / concept to fbrain", "what do I have in fbrain about X", "search my
  brain", or "fbrain isn't working".
---

# fbrain — your personal brain over fold_db

fbrain is a Bun/TypeScript CLI (and MCP server) that uses [fold_db](https://folddb.com)
as the storage engine for a personal knowledge base. Your data lives on **your
own fold_db node** — there's no account to sign up for and nothing leaves your
machine. Eight record types: **design, task, concept, preference, reference,
agent, project, spike**, each with semantic search.

## Setup (one-time)

**Prerequisites:** a running fold_db node + Bun (≥ 1.3.10).

```bash
# 1. install + start the node (prebuilt binary, no Rust)
brew install edgevector/folddb/folddb
brew services start folddb
curl -s http://127.0.0.1:9001/api/health        # expect {"ok":true,...}

# 2. install fbrain
git clone https://github.com/EdgeVector/fbrain && cd fbrain
bun install
bun link                                          # exposes a global `fbrain`

# 3. bootstrap
fbrain init                                       # resolves schemas; one-time consent
fbrain doctor                                     # verify config + node + schemas
```

`init` resolves fbrain's published schemas from the public schema service (a
read-only lookup — **no account or key needed**) and ends with a one-time
consent prompt so fbrain may read/write its own namespace on your node; press
**y**. For a scripted / non-interactive install, pass `fbrain init
--grant-consent`. `init` is idempotent — safe to re-run.

Config lives at `~/.fbrain/config.json` (override with `$FBRAIN_CONFIG`). If you
didn't `bun link`, run commands as `bun src/cli.ts <command>` from the checkout.

## Daily use

```bash
# capture
fbrain design new "Auth rework" --body "OAuth + passkeys; drop sessions"
fbrain put concept caching --title "Cache layer" --body "..."     # any of the 8 types
fbrain task new "Wire up retries" --body "..."

# recall
fbrain list                                  # recent records
fbrain get <slug>                            # one record
fbrain search "how did we handle auth"       # semantic search
fbrain ask "what did I note about caching?"  # natural-language answer over your notes

# organize / maintain
fbrain link <slug> <other-slug>              # relate two records
fbrain delete <slug>                         # soft-delete
fbrain doctor                                # health-check
```

Re-`put`ting the same slug **updates** the record (upsert). Run `fbrain --help`
for the full command set.

## Use it from an agent (MCP)

Register the MCP server so an agent can read/write your brain as tools:

```bash
cd fbrain
claude mcp add fbrain bun "$PWD/src/mcp/main.ts"     # or: fbrain mcp
```

It reads the same `~/.fbrain/config.json`.

## Notes

- **No account / no cloud by default.** The brain is single-user and lives on
  your local node; using fbrain needs no invite, key, or sign-up.
- **`ask` needs an LLM key.** Set `ANTHROPIC_API_KEY` for natural-language
  answers; without it, `ask` falls back to keyword + vector search.
- **Don't reset/wipe the node to "start clean."** `init` and `put` are additive
  and idempotent, and the node is the only copy of your data.
- If `doctor` reports the node unreachable, start it with
  `brew services start folddb` — don't kill a node you didn't start.
