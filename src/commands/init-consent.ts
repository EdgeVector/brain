// Local Mini authorizes the owner through its Unix socket. Remote nodes
// retain their capability protocol and require approval on that node.
import {
  acquireCapability,
  BRAIN_APP_ID,
  hasValidCachedCapability,
  type CapabilityStore,
  type ConsentTransport,
} from "../capability.ts";
import { BrainError, isLoopbackNodeUrl, newNodeClient, type Verbose } from "../client.ts";
import { resolvePrintSink } from "../format.ts";
import { defaultCapabilityStore } from "../keychain.ts";
import { appIdentityEnforceEnabled } from "../write-context.ts";

export type EstablishConsentOptions = {
  nodeUrl: string;
  userHash: string;
  appId?: string;
  scope?: string;
  print?: (line: string) => void;
  verbose?: Verbose;
  socketPath?: string;
  store?: CapabilityStore;
  transport?: ConsentTransport;
  isTty?: () => boolean;
  /** Retained for callers using the existing init flag. */
  nonInteractiveGrant?: boolean;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
};

export type EstablishConsentResult =
  | { state: "owner_socket" }
  | { state: "skipped"; reason: "enforce_off" | "non_tty" }
  | { state: "already_granted" }
  | { state: "granted_inline" };

export async function establishConsentInline(
  opts: EstablishConsentOptions,
): Promise<EstablishConsentResult> {
  const print = resolvePrintSink(opts);
  const node = newNodeClient({
    baseUrl: opts.nodeUrl,
    userHash: opts.userHash,
    ...(opts.verbose ? { verbose: opts.verbose } : {}),
    ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
  });
  if (isLoopbackNodeUrl(opts.nodeUrl)) {
    const identity = await node.autoIdentity();
    if (!identity.provisioned || identity.userHash !== opts.userHash) {
      throw new BrainError({
        code: "owner_identity_mismatch",
        message: "The configured owner socket did not confirm this Brain identity.",
      });
    }
    print("        owner socket confirmed access");
    return { state: "owner_socket" };
  }
  if (!appIdentityEnforceEnabled()) {
    return { state: "skipped", reason: "enforce_off" };
  }
  const appId = opts.appId ?? BRAIN_APP_ID;
  const store = opts.store ?? defaultCapabilityStore();
  if (await hasValidCachedCapability(store, opts.nodeUrl, appId)) {
    return { state: "already_granted" };
  }
  if (!(opts.isTty ?? (() => Boolean(process.stdin.isTTY)))()) {
    print("        remote access requires approval from the target node owner");
    return { state: "skipped", reason: "non_tty" };
  }
  await acquireCapability({
    ...opts,
    appId,
    store,
    transport: opts.transport ?? {
      requestConsent: (app, scope) => node.requestConsent(app, scope),
      consentStatus: (request) => node.consentStatus(request),
    },
  });
  return { state: "granted_inline" };
}
