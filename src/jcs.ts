// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// As of the @folddb/app-sdk port, the implementation lives in the SDK
// (`fold_dev_node/sdk/typescript/src/jcs.ts`) — the same canonicalizer every
// FoldDB app uses, pinned byte-for-byte against the Rust
// `app_identity_crypto::canonicalize` golden vectors
// (`fold/app_identity_crypto/tests/golden_vectors.rs`). fbrain's
// `test/unit/jcs.test.ts` keeps reproducing those vectors through this module
// so any SDK drift from the Rust canonicalizer fails fbrain's suite too —
// the envelope `payload_hash` is `sha256(JCS(payload))`, so drift here would
// break every capability-integrity check fbrain performs.
//
// This module is a re-export shim so fbrain call sites keep one import
// surface (`src/jcs.ts`) for canonicalization.

export { canonicalize, canonicalizeBytes, JcsError } from "@folddb/app-sdk";
export type { JsonValue } from "@folddb/app-sdk";
