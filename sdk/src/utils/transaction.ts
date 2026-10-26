import { SorobanRpc } from 'stellar-sdk';

export interface WaitForTransactionOptions {
  /** Maximum time (ms) to keep polling before giving up. Defaults to 30s. */
  timeoutMs?: number;
  /** Delay (ms) between `getTransaction` polls. Defaults to 1s. */
  intervalMs?: number;
}

/**
 * Structured log emitted when a contract call is attempted but not submitted
 * (e.g. skipped due to guards, aborted before send, or timed out waiting for
 * confirmation). The shape is stable so it can be filtered and alerted on.
 */
export interface SkippedContractCallLog {
  /** Discriminator for filtering in log aggregators. */
  event: 'contract_call_skipped';
  /** Machine-readable reason code for the skip/abort. */
  reason:
    | 'precondition_failed'
    | 'simulation_failed'
    | 'send_failed'
    | 'timeout'
    | 'already_submitted'
    | 'unknown';
  /** Contract method that was attempted (e.g. 'transfer'). */
  method?: string;
  /** Contract ID the call targeted. */
  contractId?: string;
  /** Additional context for debugging (args, guard results, error messages). */
  context?: Record<string, unknown>;
  /** ISO timestamp of when the skip was observed. */
  timestamp: string;
}

/**
 * Emit a structured log for a contract call that was attempted but not
 * submitted. Uses console.info so it is visible by default and can be
 * collected by log aggregators via the `contract_call_skipped` event field.
 */
export function logSkippedContractCall(
  log: Omit<SkippedContractCallLog, 'event' | 'timestamp'> &
    Partial<Pick<SkippedContractCallLog, 'event' | 'timestamp'>>,
): SkippedContractCallLog {
  const entry: SkippedContractCallLog = {
    event: 'contract_call_skipped',
    timestamp: new Date().toISOString(),
    ...log,
  };
  console.info(JSON.stringify(entry));
  return entry;
}

export async function waitForTransaction(
  server: SorobanRpc,
  hash: string,
  options: WaitForTransactionOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await server.getTransaction(hash);
      if (result) {
        return result;
      }
    } catch {
      // Transaction not yet found; keep polling until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  logSkippedContractCall({
    reason: 'timeout',
    context: { hash, timeoutMs, intervalMs },
  });
  throw new Error(`Timed out waiting for transaction ${hash}`);
}
