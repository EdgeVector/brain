#!/bin/bash
# Build + code-sign the standalone `fbrain-mcp` binary — Model C Phase 2.
#
# Under the Model C (attestation-scoped app) migration the fbrain app surface
# the node attests must be a single COMPILED, SIGNED binary, not `bun run
# src/cli.ts`. This script materializes that surface:
#
#   1. `bun build --compile src/mcp/main.ts` → a standalone self-contained
#      executable at dist/fbrain-mcp (the MCP stdio entrypoint, jail-free).
#   2. Code-sign it so its signature is consistent with the repo-root
#      `folddb.toml` manifest's `[code_signature].bundle_identifier`
#      (`com.edgevector.fbrain`) added in Phase 1 (fbrain #347). The node's
#      `folddb app install` verifies the binary against that block.
#
# Signing identity (macOS):
#   - Default: an AD-HOC signature (`codesign --sign -`) carrying the manifest
#     bundle identifier. Adequate for a dev-first cut — the manifest omits
#     `team_id` (absent is valid), and ad-hoc satisfies the binary's own
#     Designated Requirement so the node can attest the stamped identifier.
#   - Real Developer ID: set CODESIGN_IDENTITY to a signing identity (e.g.
#     "Developer ID Application: EdgeVector ..."). When set, that identity is
#     used instead of ad-hoc. The org-level APPLE_*/Developer-ID secrets are
#     visible to fbrain Actions if/when real signing is wired.
#
# On non-macOS (Linux CI) `codesign` is absent; the compile still runs and
# produces a runnable binary, and the signing step is skipped with a notice
# (macOS code-signature attestation is a macOS-only concern — see the design
# doc, "(C) has no macOS-Seatbelt dependency" and the cross-platform note).
#
# Usage:
#   scripts/build-mcp-binary.sh [outfile]      # default dist/fbrain-mcp
#   CODESIGN_IDENTITY="Developer ID Application: ..." scripts/build-mcp-binary.sh
set -euo pipefail

# The bundle identifier the binary's signature must carry — kept in lockstep
# with folddb.toml's [code_signature].bundle_identifier. If you change one,
# change the other.
BUNDLE_ID="com.edgevector.fbrain"

ENTRY="src/mcp/main.ts"
OUTFILE="${1:-dist/fbrain-mcp}"

# Run from the repo root regardless of the caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

mkdir -p "$(dirname "$OUTFILE")"

echo "==> compiling $ENTRY -> $OUTFILE"
bun build --compile "$ENTRY" --outfile "$OUTFILE"

if command -v codesign >/dev/null 2>&1; then
  if [ -n "${CODESIGN_IDENTITY:-}" ]; then
    echo "==> code-signing with identity: $CODESIGN_IDENTITY (id=$BUNDLE_ID)"
    codesign --force --timestamp --options runtime \
      --sign "$CODESIGN_IDENTITY" --identifier "$BUNDLE_ID" "$OUTFILE"
  else
    echo "==> code-signing ad-hoc (id=$BUNDLE_ID); set CODESIGN_IDENTITY for a real Developer ID"
    codesign --force --sign - --identifier "$BUNDLE_ID" "$OUTFILE"
  fi
  echo "==> verifying signature"
  codesign --verify --verbose "$OUTFILE"
  codesign -dv "$OUTFILE" 2>&1 | grep -E '^(Identifier|Signature|TeamIdentifier)='
else
  echo "==> codesign not found (non-macOS); skipping signing — binary is unsigned"
fi

echo "==> built $OUTFILE"
