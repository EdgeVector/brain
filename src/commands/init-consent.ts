// The launcher registers the app id. Brain does not request consent.
import type { CapabilityStore, ConsentTransport } from "../capability.ts";
import type { Verbose } from "../client.ts";
import { resolvePrintSink } from "../format.ts";

export type EstablishConsentOptions = {
  nodeUrl: string;
  userHash: string;
  appId?: string;
  scope?: string;
  print?: (line: string) => void;
  verbose?: Verbose;
  socketPath?: string;
  recoveredIdentity?: boolean;
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
  print("        the launcher registers the app");
  return { state: "owner_socket" };
}
