/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * This is the TypeScript port of the Rust `app_identity_crypto::canonicalize`
 * (which wraps the `json_canon` crate). The two MUST produce byte-identical
 * output: a capability token minted + signed by `fold_db_node` is verified
 * against bytes the node canonicalized with the Rust implementation, and the
 * envelope's `payload_hash` is `sha256(JCS(payload))`. Any drift here breaks
 * every client-side integrity check.
 *
 * The 12 golden vectors that pin cross-implementation agreement live at
 * `fold/app_identity_crypto/tests/golden_vectors.rs`; `test/jcs.test.ts`
 * reproduces them byte-for-byte against this module.
 *
 * RFC 8785 rules implemented:
 *   - Object keys sorted lexicographically by UTF-16 code unit.
 *   - No insignificant whitespace.
 *   - Strings serialized as UTF-8 with the minimal escape set (RFC 8785
 *     §3.2.2.2 / ECMAScript QuoteJSONString): `"`, `\`, the C0 control
 *     chars, and any UTF-16 code unit in the surrogate range that is NOT
 *     part of a well-formed pair are escaped. Valid surrogate pairs and
 *     all other non-ASCII chars pass through as their literal UTF-8.
 *   - Numbers in ECMAScript `Number.prototype.toString()` (shortest
 *     round-trip) form — which is exactly what `JSON.stringify` emits for a
 *     finite JS number, including normalizing `1.0e2` → `100`.
 */
import type { JsonValue } from './types.js';
/** Raised when a value cannot be canonicalized (e.g. a non-finite number). */
export declare class JcsError extends Error {
    constructor(message: string);
}
/**
 * Canonicalize a JSON value per RFC 8785. Returns the canonical UTF-8 string.
 * Use {@link canonicalizeBytes} when you need the raw bytes for hashing.
 *
 * Throws {@link JcsError} on non-finite numbers (NaN / Infinity), which JSON
 * — and therefore JCS — cannot represent.
 */
export declare function canonicalize(value: JsonValue): string;
/** Canonicalize and return the UTF-8 byte encoding (input to SHA-256 / Ed25519). */
export declare function canonicalizeBytes(value: JsonValue): Uint8Array;
//# sourceMappingURL=jcs.d.ts.map