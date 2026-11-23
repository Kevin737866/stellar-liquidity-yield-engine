export const TRANSACTION_STATUSES = ['confirmed', 'pending', 'failed'] as const;
export const TRANSACTION_OPERATIONS = ['deposit', 'withdraw', 'rebalance', 'harvest', 'claim'] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export type TransactionOperation = (typeof TRANSACTION_OPERATIONS)[number];

export const ALL_TRANSACTIONS = 'all' as const;

export type TransactionStatusFilter = TransactionStatus | typeof ALL_TRANSACTIONS;
export type TransactionOperationFilter = TransactionOperation | typeof ALL_TRANSACTIONS;

export interface TransactionRecord {
  id: string;
  status: TransactionStatus;
  operation: TransactionOperation;
  amount: string;
  asset: string;
  timestamp: string;
  hash?: string;
}

export interface TransactionFilters {
  status: TransactionStatusFilter;
  operation: TransactionOperationFilter;
}

export const DEFAULT_TRANSACTION_FILTERS: TransactionFilters = {
  status: ALL_TRANSACTIONS,
  operation: ALL_TRANSACTIONS,
};

export function isTransactionStatusFilter(value: string): value is TransactionStatusFilter {
  return value === ALL_TRANSACTIONS || (TRANSACTION_STATUSES as readonly string[]).includes(value);
}

export function isTransactionOperationFilter(
  value: string,
): value is TransactionOperationFilter {
  return value === ALL_TRANSACTIONS || (TRANSACTION_OPERATIONS as readonly string[]).includes(value);
}

export function filterTransactions(
  records: readonly TransactionRecord[],
  filters: TransactionFilters,
): TransactionRecord[] {
  return records.filter((record) => {
    const statusMatches =
      filters.status === ALL_TRANSACTIONS || record.status === filters.status;
    const operationMatches =
      filters.operation === ALL_TRANSACTIONS || record.operation === filters.operation;
    return statusMatches && operationMatches;
  });
}

export function hasActiveFilters(filters: TransactionFilters): boolean {
  return filters.status !== ALL_TRANSACTIONS || filters.operation !== ALL_TRANSACTIONS;
}
