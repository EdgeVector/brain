/**
 * @lastdb/app-sdk — the runtime SDK for LastDB apps.
 *
 * Wraps a node's Unix-socket data plane: the `/api/*` methods and the app API
 * (`read`, `write`, `changes`).
 */
export { connect, LastDbClient, ownerClient } from './client.js';
export { AppApiError } from './appApi.js';
export { parseQueryResponse } from './responseParsers.js';
export { LASTDB_API_ROUTES } from './databases.js';
export { LASTDB_MIN_SUPPORTED_API_VERSION, LASTDB_SDK_API_VERSION, } from './apiVersion.generated.js';
export { REQUEST_ID_HEADER, udsTransport, } from './transport.js';
export { AuthenticationRequiredError, CasConflictError, classifyPermissionReason, LastDbError, NodeTooOldError, nodeTooOldMessage, PermissionDeniedError, QueryPaginationError, RequestRejectedError, ShareSubmissionUncertainError, TransportError, UnexpectedResponseError, } from './errors.js';
//# sourceMappingURL=index.js.map