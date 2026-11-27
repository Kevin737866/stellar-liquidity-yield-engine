import { SorobanRpc } from 'stellar-sdk';

export interface RpcHealthCheckOptions {
  /** Maximum time (ms) to wait for the endpoint health response. Defaults to 5s. */
  timeoutMs?: number;
}

export interface RpcHealthCheckReport {
  endpoint: string;
  status: 'healthy';
  latencyMs: number;
  checkedAt: number;
}

export class RpcHealthCheckError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'RpcHealthCheckError';
  }
}

/**
 * Check the configured Soroban RPC endpoint before submitting a transaction.
 * The check is opt-in at transaction call sites so existing integrations do
 * not incur an extra RPC request unless they configure it.
 */
export async function checkRpcHealth(
  server: Pick<SorobanRpc.Server, 'getHealth' | 'serverURL'>,
  options: RpcHealthCheckOptions = {},
): Promise<RpcHealthCheckReport> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('RPC health check timeoutMs must be a positive finite number');
  }

  const endpoint = server.serverURL.toString();
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const health = await Promise.race([
      server.getHealth(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`health check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

    if (health.status !== 'healthy') {
      throw new RpcHealthCheckError(
        `RPC health check failed for ${endpoint}: endpoint reported status "${health.status}"`,
        endpoint,
      );
    }

    const checkedAt = Date.now();
    return {
      endpoint,
      status: health.status,
      latencyMs: checkedAt - startedAt,
      checkedAt,
    };
  } catch (error) {
    if (error instanceof RpcHealthCheckError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RpcHealthCheckError(
      `RPC health check failed for ${endpoint}: ${detail}`,
      endpoint,
    );
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

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
  server: SorobanRpc.Server,
  hash: string,
  options: WaitForTransactionOptions = {},
): Promise<SorobanRpc.Api.GetTransactionResponse> {
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
