/**
 * App API: `POST /v1/read`, `POST /v1/write`, and `POST /v1/x/changes`.
 * A non-200 reply throws {@link AppApiError}. A failed read in a list is a result.
 * Request and reply types live in `appApi.generated.ts`.
 */
import type * as Api from './appApi.generated.js';
import type { ClientContext } from './databases.js';
export { AppApiError } from './appApiError.js';
/** Reply from `POST /api/apps/session`. `app` is the app id. There is no expiry. */
export interface AppRegistration {
    app: string;
}
export declare function executeAppRead(ctx: ClientContext, reads: readonly Api.ReadItem[]): Promise<Api.ReadResult[]>;
export declare function executeAppWrite(ctx: ClientContext, mutations: readonly Api.WriteItem[]): Promise<Api.WriteResult>;
export declare function executeAppChanges(ctx: ClientContext, options: Api.ChangesRequest): Promise<Api.ChangesReply>;
//# sourceMappingURL=appApi.d.ts.map