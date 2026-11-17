/**
 * Typed error for a non-200 app API reply.
 * Callers that read only `code` and `message` stay valid.
 */
import type { ErrorReason } from './appApi.generated.js';
import { LastDbError } from './errors.js';
export declare class AppApiError extends LastDbError {
    readonly status: number;
    readonly code: string;
    /** Zero-based position when the refusal concerns one item in the list. */
    readonly index?: number;
    /** `exists`, `absent`, or `revision` when a write condition failed. */
    readonly reason?: ErrorReason;
    constructor(status: number, code: string, message: string, index?: number, reason?: ErrorReason);
}
/** Build {@link AppApiError} from a non-200 app API body. */
export declare function appApiFailure(status: number, body: unknown): AppApiError;
//# sourceMappingURL=appApiError.d.ts.map