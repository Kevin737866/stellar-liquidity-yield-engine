import {
  ALL_TRANSACTIONS,
  DEFAULT_TRANSACTION_FILTERS,
  filterTransactions,
  hasActiveFilters,
  isTransactionOperationFilter,
  isTransactionStatusFilter,
  type TransactionRecord,
} from '@/lib/transactionFilters';

const records: TransactionRecord[] = [
  {
    id: '1',
    status: 'confirmed',
    operation: 'deposit',
    amount: '10',
    asset: 'USDC',
    timestamp: '2026-01-01',
  },
  {
    id: '2',
    status: 'pending',
    operation: 'deposit',
    amount: '20',
    asset: 'USDC',
    timestamp: '2026-01-02',
  },
  {
    id: '3',
    status: 'failed',
    operation: 'withdraw',
    amount: '30',
    asset: 'XLM',
    timestamp: '2026-01-03',
  },
];

describe('filterTransactions', () => {
  it('returns every record when no filters are active', () => {
    expect(filterTransactions(records, DEFAULT_TRANSACTION_FILTERS)).toEqual(records);
  });

  it('filters by status', () => {
    const result = filterTransactions(records, {
      status: 'confirmed',
      operation: ALL_TRANSACTIONS,
    });
    expect(result.map((record) => record.id)).toEqual(['1']);
  });

  it('filters by operation', () => {
    const result = filterTransactions(records, {
      status: ALL_TRANSACTIONS,
      operation: 'deposit',
    });
    expect(result.map((record) => record.id)).toEqual(['1', '2']);
  });

  it('combines status and operation filters', () => {
    const result = filterTransactions(records, {
      status: 'failed',
      operation: 'withdraw',
    });
    expect(result.map((record) => record.id)).toEqual(['3']);
  });

  it('returns an empty list when nothing matches', () => {
    const result = filterTransactions(records, {
      status: 'failed',
      operation: 'deposit',
    });
    expect(result).toEqual([]);
  });

  it('handles an empty transaction list', () => {
    expect(filterTransactions([], DEFAULT_TRANSACTION_FILTERS)).toEqual([]);
  });
});

describe('filter guards and state', () => {
  it('recognises valid status and operation filters', () => {
    expect(isTransactionStatusFilter('confirmed')).toBe(true);
    expect(isTransactionStatusFilter(ALL_TRANSACTIONS)).toBe(true);
    expect(isTransactionStatusFilter('unknown')).toBe(false);
    expect(isTransactionOperationFilter('withdraw')).toBe(true);
    expect(isTransactionOperationFilter(ALL_TRANSACTIONS)).toBe(true);
    expect(isTransactionOperationFilter('unknown')).toBe(false);
  });

  it('reports whether any filter is active', () => {
    expect(hasActiveFilters(DEFAULT_TRANSACTION_FILTERS)).toBe(false);
    expect(hasActiveFilters({ status: 'failed', operation: ALL_TRANSACTIONS })).toBe(true);
    expect(hasActiveFilters({ status: ALL_TRANSACTIONS, operation: 'claim' })).toBe(true);
  });
});
