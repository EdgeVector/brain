/**
 * Conditional single-record and batch mutation operations (`POST /api/mutation`
 * and `POST /api/mutations/batch`).
 */
import { type ClientContext } from './databases.js';
import type { MutationBatchItem, MutationBatchOptions, MutationBatchResult, MutationOp, MutationOptions, MutationResult, ShareSubmissionResult, ShareSubmissionStatus } from './types.js';
/** Look up this receiver's proposal by the UUID used for submission. */
export declare function executeShareSubmissionStatus(ctx: ClientContext, mutationId: string): Promise<ShareSubmissionStatus>;
/** Serialize one {@link MutationOp} into the daemon's `Operation::Mutation` wire object. */
export declare function buildMutationOperation(schemaName: string, op: MutationOp, definitionIds: ReadonlyMap<string, string>): Record<string, unknown>;
/** Parse a `200` commit receipt from `POST /api/mutation` or `POST /api/db/delete-blob`. */
export declare function parseCommittedMutation(rawBody: unknown): MutationResult;
/** `POST /api/mutation` — write one complete conditional record into `schemaName`. */
export declare function executeMutate(ctx: ClientContext, schemaName: string, op: MutationOp, options?: MutationOptions): Promise<MutationResult | ShareSubmissionResult>;
/** `POST /api/mutations/batch` — commit an atomic batch of conditional record mutations. */
export declare function executeMutateBatch(ctx: ClientContext, items: readonly MutationBatchItem[], options?: MutationBatchOptions): Promise<MutationBatchResult>;
//# sourceMappingURL=mutationOps.d.ts.map