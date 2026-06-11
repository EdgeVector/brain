// Lowercase-hex SHA-256, matching the Rust `app_identity_crypto` helpers
// (`compute_payload_hash` = lowercase-hex sha256 of the JCS bytes).
//
// The implementation now comes from @folddb/app-sdk (`sha256Hex` in
// `capabilityToken.ts`), which is synchronous (node:crypto). The previous
// fbrain implementation was async (WebCrypto); call sites that `await` a
// plain string keep working unchanged, so this re-export is drop-in.

export { sha256Hex } from "@folddb/app-sdk";
