/**
 * Deposit review step (issue #454).
 *
 * A vault deposit used to be submitted the moment the user pressed Deposit.
 * This panel shows exactly what is about to be signed — vault, network, signer,
 * both token amounts, the vault fee and the slippage floor — and requires an
 * explicit confirmation before the transaction is built.
 */

import React from 'react';
import { AlertTriangle, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortenAddress } from '../lib/freighter';

/** Minimum shares used by the deposit call, shown so the user sees the floor. */
export const NO_SLIPPAGE_PROTECTION = 0n;

export interface DepositReviewProps {
  vaultName: string;
  vaultAddress: string;
  network: string;
  /** Address that will sign the deposit, when known. */
  walletAddress?: string;
  /** Token addresses, when the vault exposes them. */
  tokenA?: string;
  tokenB?: string;
  /** Amounts as entered, in token base units. */
  amountA: string;
  amountB: string;
  /** Minimum shares the transaction will accept. */
  minShares: bigint;
  /** Vault fee in basis points. */
  feeRateBps: number;
  /** Whether the vault is paused (deposits will be rejected on chain). */
  paused: boolean;
  /** A transaction is already being submitted. */
  submitting: boolean;
  onConfirm: () => void;
  /** Return to the amount inputs without submitting. */
  onBack: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode; title?: string }> = ({
  label,
  children,
  title,
}) => (
  <>
    <dt className="text-sm text-gray-500">{label}</dt>
    <dd className="text-sm font-medium text-gray-900 text-right break-all" title={title}>
      {children}
    </dd>
  </>
);

export const DepositReview: React.FC<DepositReviewProps> = ({
  vaultName,
  vaultAddress,
  network,
  walletAddress,
  tokenA,
  tokenB,
  amountA,
  amountB,
  minShares,
  feeRateBps,
  paused,
  submitting,
  onConfirm,
  onBack,
}) => {
  return (
    <div
      data-testid="deposit-review"
      className="rounded-lg border border-slate-200 bg-slate-50/60 p-4 space-y-4"
      role="region"
      aria-label="Deposit review"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="h-5 w-5 text-slate-700 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <h4 className="font-semibold text-slate-900">Review deposit</h4>
          <p className="text-xs text-slate-600">
            Check the details below. Nothing is submitted until you confirm.
          </p>
        </div>
      </div>

      {paused && (
        <div
          className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2"
          role="alert"
        >
          <Lock className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            This vault is paused. A deposit submitted now would be rejected on chain.
          </span>
        </div>
      )}

      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 border-t border-slate-200 pt-3">
        <Row label="Vault">{vaultName}</Row>
        <Row label="Vault contract" title={vaultAddress}>
          <span className="font-mono">{shortenAddress(vaultAddress)}</span>
        </Row>
        <Row label="Network">{network}</Row>
        <Row label="From">{walletAddress ? shortenAddress(walletAddress) : '—'}</Row>
        <Row label="Token A amount" title={tokenA}>
          {amountA} {tokenA ? <span className="text-gray-500">({shortenAddress(tokenA)})</span> : null}
        </Row>
        <Row label="Token B amount" title={tokenB}>
          {amountB} {tokenB ? <span className="text-gray-500">({shortenAddress(tokenB)})</span> : null}
        </Row>
        <Row label="Vault fee">{(feeRateBps / 100).toFixed(2)}%</Row>
        <Row label="Minimum shares">{minShares.toString()}</Row>
      </dl>

      <p className="text-xs text-gray-600">
        Amounts are token base units. Deposits are irreversible once confirmed.
      </p>

      {minShares === NO_SLIPPAGE_PROTECTION && (
        <p className="text-xs text-amber-700 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            No minimum shares are set, so the deposit executes at whatever rate the
            vault reports when it is processed.
          </span>
        </p>
      )}

      <div className="flex gap-3">
        <Button onClick={onConfirm} disabled={paused || submitting} className="flex-1">
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
              Processing…
            </>
          ) : (
            'Confirm deposit'
          )}
        </Button>
        <Button onClick={onBack} variant="outline" className="flex-1" disabled={submitting}>
          Back
        </Button>
      </div>
    </div>
  );
};

export default DepositReview;
