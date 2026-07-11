/**
 * @lastdb/app-sdk — the runtime SDK for LastDB apps.
 *
 * Wraps a node's production `/api/*` surface: connect → request consent →
 * await grant → query/mutate with the granted capability. See the README for
 * a 10-line quickstart.
 */
export { connect, LastDbClient, 
// `FoldDbClient` is a `@deprecated` alias of `LastDbClient`, kept exported so
// mid-port consumers keep compiling; removed at the adoption capstone.
FoldDbClient, parseQueryResponse, parseSearchResponse, } from './client.js';
export { capabilityStoreKey, defaultCapabilityStore, DEFAULT_KEYCHAIN_SERVICE, FileCapabilityStore, KeychainUnavailableError, KeychainWithFileFallbackStore, loadCapabilityOrThrow, MacKeychainStore, } from './capabilityStore.js';
export { canonicalize, canonicalizeBytes, JcsError } from './jcs.js';
export { CAPABILITY_GRANT_PURPOSE, decodeCapabilityBlob, sha256Hex, tokenIntegrityValid, verifyCapabilityBlob, } from './capabilityToken.js';
export { discoverTransport, httpTransport, udsTransport } from './transport.js';
export { FoldDbError, TransportError, UnexpectedResponseError, UnknownAppError, AppInSandboxError, InvalidScopeError, ConsentDeniedError, CapabilityRevokedError, ConsentExpiredError, ConsentRequestNotFoundError, ConsentTimeoutError, PermissionDeniedError, CapabilityDeniedError, CapabilityVerificationError, RequestRejectedError, CapabilityNotFoundError, classifyPermissionReason, CAPABILITY_DENIAL_REASONS, isCapabilityDenialReason, capabilityDenialReaction, } from './errors.js';
//# sourceMappingURL=index.js.map