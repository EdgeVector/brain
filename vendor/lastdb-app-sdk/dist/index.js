/**
 * @lastdb/app-sdk — the runtime SDK for LastDB apps.
 *
 * Wraps a node's Unix-socket data plane: the `/api/*` methods and the app API
 * (`read`, `write`, `changes`).
 */
export { connect, LastDbClient, ownerClient } from './client.js';
export { AppApiError } from './appApi.js';
export { APP_API_CHANGES_KEPT, APP_API_CHANGES_PAGE_CAP, APP_API_CHANGES_PAGE_DEFAULT, APP_API_ERROR_CODES, APP_API_ERROR_REASONS, APP_API_MANIFEST_ACCESS_ENTRIES, APP_API_MAX_BODY_BYTES, APP_API_READ_PAGE_CAP, APP_API_READ_PAGE_DEFAULT, APP_API_READS_PER_REQUEST, } from './appApi.generated.js';
export { parseQueryResponse } from './responseParsers.js';
export { LASTDB_API_ROUTES } from './databases.js';
export { LASTDB_MIN_SUPPORTED_API_VERSION, LASTDB_SDK_API_VERSION, } from './apiVersion.generated.js';
export { REQUEST_ID_HEADER, udsTransport, } from './transport.js';
export { AuthenticationRequiredError, CasConflictError, classifyPermissionReason, LastDbError, NodeTooOldError, nodeTooOldMessage, PermissionDeniedError, QueryPaginationError, RequestRejectedError, ShareSubmissionUncertainError, TransportError, UnexpectedResponseError, } from './errors.js';
//# sourceMappingURL=index.js.map