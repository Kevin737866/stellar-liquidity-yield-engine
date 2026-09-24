import { SorobanRpc } from 'stellar-sdk';

export interface WaitForTransactionOptions {
  /** Maximum time (ms) to keep polling before giving up. Defaults to 30s. */
  timeoutMs?: number;
  /** Delay (ms) between `getTransaction` polls. Defaults to 1s. */
  intervalMs?: number;
}

/**
 * Poll `getTransaction` until the transaction reaches a terminal state
 * (SUCCESS or FAILED). Soroban RPC's `sendTransaction` only reports that a
 * transaction was accepted (PENDING) — the final outcome requires polling
 * `getTransaction`.
 *
 * Returns the last `getTransaction` response. If the configured timeout
 * elapses before the transaction settles, the not-yet-terminal response is
 * returned so callers can decide how to handle it.
 */
export async function waitForTransaction(
  server: SorobanRpc.Server,
  hash: string,
  options?: WaitForTransactionOptions
): Promise<SorobanRpc.GetTransactionResponse> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const intervalMs = options?.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  let txResult = await server.getTransaction(hash);

  while (
    (txResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND ||
      (txResult.status as string) === 'PENDING') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    txResult = await server.getTransaction(hash);
  }

  return txResult;
}
