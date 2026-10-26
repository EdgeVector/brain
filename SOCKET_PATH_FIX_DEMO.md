# Socket Path Persistence Fix - Demonstration

## Problem

When `brain init` connects to a lastdb node through `FBRAIN_FOLDDB_SOCKET` (or when the socket path is derived from `LASTDB_HOME`/`FOLDDB_HOME`), the config file that gets written had:
- `nodeUrl: "http://127.0.0.1"` ✓
- **NO** `nodeSocketPath` field ✗

Later commands (`brain put`, `brain get`) would fail with "node socket not reachable" when the environment variables weren't set, because they couldn't find the socket path that init actually used.

## Root Cause

The `buildConfig()` function only checked `process.env.FBRAIN_FOLDDB_SOCKET` and persisted it if present. But the **actual socket path used** during init was resolved by `defaultFolddbSocketPath()`, which has a precedence chain:
1. `FBRAIN_FOLDDB_SOCKET` env var
2. Config override parameter  
3. Default path derived from `resolveNodeHome()` (which checks `LASTDB_HOME` and `FOLDDB_HOME`)

So if someone set `LASTDB_HOME` or `FOLDDB_HOME` but not `FBRAIN_FOLDDB_SOCKET`, init would connect successfully but wouldn't persist the socket path.

## Solution

The fix resolves the **actual socket path** that init will use (by calling `defaultFolddbSocketPath()` early) and passes it through to:
1. `newNodeClient()` calls (so they use the explicit path)
2. `buildConfig()` (so it gets persisted)

### Code Changes

**Before:**
```typescript
// In buildConfig()
const socketOverride = process.env.FBRAIN_FOLDDB_SOCKET;
if (socketOverride && socketOverride.length > 0) {
  config.nodeSocketPath = socketOverride;
}
```

**After:**
```typescript
// In runInit(), early resolution:
const nodeSocketPath = isLoopbackNodeUrl(nodeUrl)
  ? defaultFolddbSocketPath(existing?.nodeSocketPath)
  : undefined;

// Pass to clients:
const probeClient = newNodeClient({ 
  baseUrl: nodeUrl,
  userHash: probeUserHash,
  socketPath: nodeSocketPath,  // ← Explicit path
});

// Pass to buildConfig:
const config = buildConfig({ 
  nodeUrl, 
  schemaServiceUrl, 
  userHash, 
  schemaHashes,
  nodeSocketPath,  // ← Gets persisted
});
```

## Expected Behavior

### Scenario 1: Using `FBRAIN_FOLDDB_SOCKET`

```bash
# Start node with custom socket
mkdir -p /tmp/test-node/data
# (assume lastdbd running with socket at /tmp/test-node/data/folddb.sock)

# Run init with env var
FBRAIN_FOLDDB_SOCKET=/tmp/test-node/data/folddb.sock brain init

# Config now contains:
{
  "configVersion": 4,
  "nodeUrl": "http://127.0.0.1",
  "nodeSocketPath": "/tmp/test-node/data/folddb.sock",  // ← PERSISTED
  "userHash": "...",
  "schemaHashes": { ... }
}

# Later commands work WITHOUT the env var:
brain put test --body "hello world"  # ✓ Works! Uses nodeSocketPath from config
brain get test                        # ✓ Works!
```

### Scenario 2: Using `LASTDB_HOME`

```bash
# Start node with custom home
LASTDB_HOME=/tmp/custom-home lastdbd &
# Socket is at /tmp/custom-home/data/folddb.sock

# Run init with LASTDB_HOME but no FBRAIN_FOLDDB_SOCKET
LASTDB_HOME=/tmp/custom-home brain init

# Config now contains:
{
  "configVersion": 4,
  "nodeUrl": "http://127.0.0.1",
  "nodeSocketPath": "/tmp/custom-home/data/folddb.sock",  // ← PERSISTED
  "userHash": "...",
  "schemaHashes": { ... }
}

# Later commands work WITHOUT LASTDB_HOME:
brain put test --body "hello world"  # ✓ Works! Uses nodeSocketPath from config
brain get test                        # ✓ Works!
```

### Scenario 3: Default socket path

```bash
# Node running at default location (~/.lastdb/data/folddb.sock)
lastdbd &

# Run init without any env vars
brain init

# Config contains:
{
  "configVersion": 4,
  "nodeUrl": "http://127.0.0.1",
  "nodeSocketPath": "/home/user/.lastdb/data/folddb.sock",  // ← PERSISTED
  "userHash": "...",
  "schemaHashes": { ... }
}

# Later commands work:
brain put test --body "hello world"  # ✓ Works!
```

## Runtime Commands Honor Config

The fix ensures that `newReadClientFromCfg()` and `newWriteClientFromCfg()` already pass `cfg.nodeSocketPath` to the underlying client, so runtime commands will use the persisted socket path:

```typescript
// In client.ts (already present):
export function newReadClientFromCfg(cfg: Config, verbose?: Verbose): NodeClient {
  const opts: Parameters<typeof newNodeClient>[0] = {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
  };
  if (verbose !== undefined) opts.verbose = verbose;
  if (cfg.nodeSocketPath !== undefined) opts.socketPath = cfg.nodeSocketPath;  // ✓
  return newNodeClient(opts);
}
```

## Precedence Order (Runtime Commands)

When a command like `brain get` runs, the socket path resolution follows this precedence:

1. **`FBRAIN_FOLDDB_SOCKET` env var** (ad-hoc override)
2. **`cfg.nodeSocketPath`** (persisted from init) ← **THIS IS NEW**
3. **Default path** (derived from `LASTDB_HOME`/`FOLDDB_HOME` or standard default)

This means:
- If you need a different socket temporarily, set `FBRAIN_FOLDDB_SOCKET`
- Otherwise, commands use the socket path from your config (persisted during init)
- If config has no `nodeSocketPath`, fall back to the default derivation

## Testing

To verify this fix works, you need a running lastdb node. Here's how to test:

```bash
# 1. Create a test directory with a custom socket location
mkdir -p /tmp/test-lastdb-node/data
export TEST_SOCKET=/tmp/test-lastdb-node/data/folddb.sock

# 2. Start lastdbd with custom home
LASTDB_HOME=/tmp/test-lastdb-node lastdbd &
# Wait for node to start and create the socket

# 3. Run brain init with the socket env var
rm -rf ~/.brain  # Clear any existing config
FBRAIN_FOLDDB_SOCKET=$TEST_SOCKET brain init

# 4. Verify the config has nodeSocketPath
cat ~/.brain/config.json | jq -r '.nodeSocketPath'
# Should output: /tmp/test-lastdb-node/data/folddb.sock

# 5. Unset the env var and run commands
unset FBRAIN_FOLDDB_SOCKET
brain put test-record --body "Testing socket path persistence"
brain get test-record
# Both should work! ✓

# 6. Clean up
pkill lastdbd
rm -rf /tmp/test-lastdb-node
```

## Evidence

This fix addresses the issue reported in:
https://github.com/EdgeVector/lastdb/actions/runs/40387095189 (lastdb PR #445)

Where `brain init` connected successfully but later commands failed because the socket path wasn't persisted.
