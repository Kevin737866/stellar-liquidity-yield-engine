/**
 * NetworkSwitchPrompt — Issue #458
 *
 * Accessible confirmation shown before a transaction that targets Stellar
 * Mainnet. It never signs or submits anything itself: the caller keeps the
 * pending action and only runs it after `onConfirm`, which makes "cancel"
 * an explicit, safe boundary.
 */

import React, { useCallback, useEffect, useId, useRef } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getNetworkPassphrase } from '@/config/network';

export interface NetworkSwitchPromptProps {
  /** True while the prompt is visible. */
  open: boolean;
  /** Human-readable action being attempted, e.g. "deposit". */
  actionLabel: string;
  /** Called when the user declines the switch. */
  onCancel: () => void;
  /** Called when the user accepts the switch. May be async. */
  onConfirm: () => void | Promise<void>;
  /** Disables confirmation while a network switch is in progress. */
  switching?: boolean;
  /** Error from a failed network switch, if any. */
  error?: string | null;
}

export function NetworkSwitchPrompt({
  open,
  actionLabel,
  onCancel,
  onConfirm,
  switching = false,
  error = null,
}: NetworkSwitchPromptProps): React.ReactElement | null {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleCancel = useCallback(() => {
    if (!switching) onCancel();
  }, [onCancel, switching]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
        return;
      }

      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, handleCancel]);

  if (!open) return null;

  const passphrase = getNetworkPassphrase('mainnet');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
      data-testid="network-switch-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="flex-1">
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              Switch to Mainnet to continue
            </h2>
            <p id={descriptionId} className="mt-2 text-sm text-slate-600">
              You are about to {actionLabel} on <strong>Stellar Mainnet</strong>. Mainnet
              transactions use real assets and cannot be undone. Confirm your wallet is set to
              Mainnet before signing.
            </p>
            <p className="mt-2 break-words font-mono text-xs text-slate-500" data-testid="mainnet-passphrase">
              {passphrase}
            </p>
            {error && (
              <p id={errorId} role="alert" className="mt-3 text-sm font-medium text-red-700">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelRef} type="button" variant="outline" onClick={handleCancel} disabled={switching}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onConfirm()}
            disabled={switching}
            data-testid="confirm-network-switch"
          >
            {switching ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Switching…
              </>
            ) : (
              'Switch to Mainnet & Continue'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
