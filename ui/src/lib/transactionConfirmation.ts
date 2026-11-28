import type { TransactionRecord } from '@/lib/transactionFilters';

/** Displayed when a transaction has no usable vault or pool value. */
export const CONFIRMATION_NOT_RECORDED = 'Not recorded';

export interface TransactionConfirmation {
  vault: string;
  pool: string;
}

function formatTarget(value: unknown): string {
  if (typeof value !== 'string') {
    return CONFIRMATION_NOT_RECORDED;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : CONFIRMATION_NOT_RECORDED;
}

/**
 * Resolve the vault and pool recorded on a transaction for display in its
 * confirmation details. Missing, blank, and non-string values are reported
 * explicitly instead of being rendered as an empty label.
 */
export function getTransactionConfirmation(
  record: Partial<TransactionRecord> | null | undefined,
): TransactionConfirmation {
  return {
    vault: formatTarget(record?.vault),
    pool: formatTarget(record?.pool),
  };
}
