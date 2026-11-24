/**
 * useTxStatus — Issue #131
 *
 * Tracks the lifecycle of a Soroban transaction submitted through the UI:
 *
 *   idle  →  submitting  →  pending  →  confirmed
 *                       ↘              ↘ failed
 *
 * - idle:       No transaction in progress.
 * - submitting: The user clicked the action button; the SDK call is in flight
 *               (signing + `sendTransaction`).
 * - pending:    The transaction has been accepted by the RPC node (we have a
 *               `txHash`) and we are waiting for final confirmation.
 * - confirmed:  The transaction succeeded on-chain.
 * - failed:     The transaction was rejected or an error occurred.
 */

import { useState, useCallback, useRef } from 'react';

export type TxStatus = 'idle' | 'submitting' | 'pending' | 'confirmed' | 'failed';

export interface UseTxStatusReturn {
  /** Current transaction lifecycle state */
  txStatus: TxStatus;
  /** True while a transaction is submitting or awaiting confirmation. */
  isTxInFlight: boolean;
  /** Transaction hash once available (pending / confirmed / failed) */
  txHash: string | null;
  /** Error message when txStatus === 'failed' */
  txError: string | null;
  /** Manually set the status (useful for bridging to async SDK calls) */
  setTxStatus: (status: TxStatus) => void;
  /** Manually set the hash once the SDK returns it */
  setTxHash: (hash: string | null) => void;
  /** Manually set the error message */
  setTxError: (error: string | null) => void;
  /**
   * Convenience wrapper: run `action`, automatically advancing status through
   * submitting → pending (with hash) → confirmed | failed. Returns `false`
   * when a duplicate call was rejected; `true` when this call was accepted.
   *
   * `action` should return an object with at least `{ hash: string, success: boolean }`.
   */
  runTx: (
    action: () => Promise<{ hash: string; success: boolean; error?: string }>
  ) => Promise<boolean>;
  /** Reset all state back to idle */
  resetTx: () => void;
}

export function useTxStatus(): UseTxStatusReturn {
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const resetTx = useCallback(() => {
    setTxStatus('idle');
    setTxHash(null);
    setTxError(null);
  }, []);

  const runTx = useCallback(
    async (
      action: () => Promise<{ hash: string; success: boolean; error?: string }>
    ): Promise<boolean> => {
      if (inFlightRef.current) {
        return false;
      }

      inFlightRef.current = true;
      setTxStatus('submitting');
      setTxHash(null);
      setTxError(null);

      try {
        const result = await action();

        if (result.hash) {
          setTxHash(result.hash);
          setTxStatus('pending');
        }

        if (result.success) {
          setTxStatus('confirmed');
        } else {
          setTxError(result.error ?? 'Transaction failed');
          setTxStatus('failed');
        }
        return true;
      } catch (err: any) {
        setTxError(err?.message ?? 'Unknown error');
        setTxStatus('failed');
        return true;
      } finally {
        inFlightRef.current = false;
      }
    },
    []
  );

  return {
    txStatus,
    isTxInFlight: txStatus === 'submitting' || txStatus === 'pending',
    txHash,
    txError,
    setTxStatus,
    setTxHash,
    setTxError,
    runTx,
    resetTx,
  };
}
