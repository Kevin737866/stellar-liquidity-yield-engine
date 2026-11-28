import { useId } from 'react';
import type { TransactionConfirmation } from '@/lib/transactionConfirmation';

interface TransactionConfirmationDetailsProps {
  confirmation: TransactionConfirmation;
}

/** Accessible summary of the vault and pool selected for a transaction. */
export function TransactionConfirmationDetails({
  confirmation,
}: TransactionConfirmationDetailsProps) {
  const headingId = useId();

  return (
    <div
      className="rounded-md border border-slate-200 bg-slate-50 p-3"
      role="group"
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="text-sm font-semibold text-slate-900">
        Transaction confirmation details
      </h3>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Vault</dt>
          <dd className="mt-0.5 break-words font-medium text-slate-900">
            {confirmation.vault}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Pool</dt>
          <dd className="mt-0.5 break-words font-medium text-slate-900">
            {confirmation.pool}
          </dd>
        </div>
      </dl>
    </div>
  );
}
