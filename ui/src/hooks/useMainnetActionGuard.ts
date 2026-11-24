/**
 * useMainnetActionGuard — Issue #458
 *
 * Wraps a transaction action so Mainnet writes always pass through an explicit
 * network-switch prompt. Testnet actions run unchanged, which keeps existing
 * integrations backward-compatible.
 *
 * Normal:   requestAction → (testnet) run immediately
 *           requestAction → (mainnet) prompt → confirm → run
 * Boundary: cancel, Escape/backdrop dismissal, repeated requests while the
 *           prompt is open, and in-flight switches never submit a transaction.
 * Failure:  a rejecting `onNetworkChange` keeps the prompt open, reports the
 *           error, and never runs the guarded action.
 */

import { useCallback, useRef, useState } from 'react';
import { getNetwork, type UiNetwork } from '@/config/network';

export type MainnetActionHandler = () => void | Promise<void>;

export type NetworkChangeHandler = (network: UiNetwork) => void | Promise<void>;

export interface MainnetActionRequest {
  /** Human-readable action name used in the prompt, e.g. "withdraw". */
  label: string;
  /** Work to run once the user confirms (or immediately on testnet). */
  run: MainnetActionHandler;
  /** Settles the caller's promise when the action finishes or is cancelled. */
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

export interface UseMainnetActionGuardOptions {
  /** Effective network; falls back to the configured network. */
  network?: UiNetwork;
  /**
   * Optional host callback that applies the network switch (for example, a
   * wallet or React context update). When omitted the prompt is a pure
   * confirmation and the already-configured network is used.
   */
  onNetworkChange?: NetworkChangeHandler;
}

export interface UseMainnetActionGuardReturn {
  /** The action waiting for confirmation, if any. */
  pendingAction: MainnetActionRequest | null;
  isPromptOpen: boolean;
  isSwitching: boolean;
  switchError: string | null;
  /**
   * Guard `run` behind a Mainnet prompt when appropriate. The returned promise
   * settles when `run` settles, or immediately when the user cancels / another
   * request supersedes this one.
   */
  requestAction: (label: string, run: MainnetActionHandler) => Promise<void>;
  /** Decline the switch; the pending action is discarded. */
  cancel: () => void;
  /** Apply the network switch and run the pending action. */
  confirm: () => Promise<void>;
  /** Clear a switch error without changing the pending action. */
  clearError: () => void;
}

function switchFailureMessage(error: unknown): string {
  const detail = error instanceof Error && error.message.trim() ? error.message : 'Unknown error';
  return `Could not switch to Mainnet (${detail}). No transaction was submitted.`;
}

export function useMainnetActionGuard({
  network,
  onNetworkChange,
}: UseMainnetActionGuardOptions = {}): UseMainnetActionGuardReturn {
  const activeNetwork: UiNetwork = network ?? getNetwork();
  const [pendingAction, setPendingAction] = useState<MainnetActionRequest | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchingRef = useRef(false);
  // Refs are the synchronous source of truth for duplicate-request protection;
  // React state alone would still expose a stale action to a second click.
  const pendingRef = useRef<MainnetActionRequest | null>(null);

  const cancel = useCallback(() => {
    if (switchingRef.current) return;
    pendingRef.current?.resolve();
    pendingRef.current = null;
    setPendingAction(null);
    setSwitchError(null);
  }, []);

  const clearError = useCallback(() => {
    setSwitchError(null);
  }, []);

  const requestAction = useCallback(
    (label: string, run: MainnetActionHandler): Promise<void> => {
      // Never stack prompts: the first decision still owns the transaction.
      if (pendingRef.current || switchingRef.current) return Promise.resolve();
      setSwitchError(null);

      if (activeNetwork !== 'mainnet') {
        try {
          return Promise.resolve(run());
        } catch (error) {
          return Promise.reject(error);
        }
      }

      return new Promise<void>((resolve, reject) => {
        const request = { label, run, resolve, reject };
        pendingRef.current = request;
        setPendingAction(request);
      });
    },
    [activeNetwork]
  );

  const confirm = useCallback(async () => {
    const action = pendingRef.current;
    if (!action || switchingRef.current) return;

    switchingRef.current = true;
    setIsSwitching(true);
    setSwitchError(null);

    try {
      if (onNetworkChange) {
        await onNetworkChange('mainnet');
      }
    } catch (error) {
      setSwitchError(switchFailureMessage(error));
      return;
    } finally {
      switchingRef.current = false;
      setIsSwitching(false);
    }

    // Drop the action before awaiting it so a double-confirm cannot resubmit.
    pendingRef.current = null;
    setPendingAction(null);
    try {
      await action.run();
      action.resolve();
    } catch (error) {
      // Reject the caller's `await requestAction(...)` without creating an
      // unhandled rejection from the dialog's `void confirm()` call.
      action.reject(error);
    }
  }, [onNetworkChange]);

  return {
    pendingAction,
    isPromptOpen: pendingAction !== null,
    isSwitching,
    switchError,
    requestAction,
    cancel,
    confirm,
    clearError,
  };
}
