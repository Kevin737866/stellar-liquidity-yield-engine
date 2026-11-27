'use client';

import { useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  ALL_TRANSACTIONS,
  DEFAULT_TRANSACTION_FILTERS,
  TRANSACTION_OPERATIONS,
  TRANSACTION_STATUSES,
  filterTransactions,
  hasActiveFilters,
  isTransactionOperationFilter,
  isTransactionStatusFilter,
  type TransactionOperationFilter,
  type TransactionRecord,
  type TransactionStatus,
  type TransactionStatusFilter,
} from '@/lib/transactionFilters';

const statusVariant: Record<TransactionStatus, 'success' | 'warning' | 'danger'> = {
  confirmed: 'success',
  pending: 'warning',
  failed: 'danger',
};

const statusLabel: Record<TransactionStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  failed: 'Failed',
};

const operationLabel: Record<string, string> = {
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  rebalance: 'Rebalance',
  harvest: 'Harvest',
  claim: 'Claim',
};

interface TransactionHistoryProps {
  transactions: readonly TransactionRecord[];
}

export function TransactionHistory({ transactions }: TransactionHistoryProps) {
  const [status, setStatus] = useState<TransactionStatusFilter>(
    DEFAULT_TRANSACTION_FILTERS.status,
  );
  const [operation, setOperation] = useState<TransactionOperationFilter>(
    DEFAULT_TRANSACTION_FILTERS.operation,
  );
  const statusId = useId();
  const operationId = useId();
  const summaryId = useId();

  const filtered = useMemo(
    () => filterTransactions(transactions, { status, operation }),
    [transactions, status, operation],
  );

  const filtersActive = hasActiveFilters({ status, operation });

  return (
    <section aria-labelledby={`${statusId}-heading`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id={`${statusId}-heading`} className="text-xl font-semibold text-slate-900">
            Transaction history
          </h2>
          <p className="text-sm text-slate-600">
            Review deposits, withdrawals, rebalances, harvests, and claims.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setStatus(DEFAULT_TRANSACTION_FILTERS.status);
            setOperation(DEFAULT_TRANSACTION_FILTERS.operation);
          }}
          disabled={!filtersActive}
        >
          Clear filters
        </Button>
      </div>

      <Card className="mt-3">
        <CardContent className="p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={statusId}>Status</Label>
              <select
                id={statusId}
                value={status}
                aria-describedby={summaryId}
                onChange={(event) => {
                  if (isTransactionStatusFilter(event.target.value)) {
                    setStatus(event.target.value);
                  }
                }}
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1"
              >
                <option value={ALL_TRANSACTIONS}>All statuses</option>
                {TRANSACTION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {statusLabel[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor={operationId}>Operation</Label>
              <select
                id={operationId}
                value={operation}
                aria-describedby={summaryId}
                onChange={(event) => {
                  if (isTransactionOperationFilter(event.target.value)) {
                    setOperation(event.target.value);
                  }
                }}
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1"
              >
                <option value={ALL_TRANSACTIONS}>All operations</option>
                {TRANSACTION_OPERATIONS.map((value) => (
                  <option key={value} value={value}>
                    {operationLabel[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p id={summaryId} aria-live="polite" className="mt-4 text-sm text-slate-600">
            Showing {filtered.length} of {transactions.length} transactions.
          </p>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Filtered transaction history. Use the status and operation filters to narrow the
                list.
              </caption>
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Operation
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Transaction
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-slate-600">
                      No transactions match the selected filters.
                    </td>
                  </tr>
                ) : (
                  filtered.map((transaction) => (
                    <tr key={transaction.id}>
                      <th scope="row" className="whitespace-nowrap px-3 py-3 font-medium text-slate-900">
                        {transaction.timestamp}
                      </th>
                      <td className="px-3 py-3 text-slate-600">
                        {operationLabel[transaction.operation]}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-slate-900">
                        {transaction.amount} {transaction.asset}
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant={statusVariant[transaction.status]}>
                          {statusLabel[transaction.status]}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-500">
                        {transaction.hash ?? '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
