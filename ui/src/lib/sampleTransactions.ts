import type { TransactionRecord } from '@/lib/transactionFilters';

export const sampleTransactions: TransactionRecord[] = [
  {
    id: 'tx-1',
    status: 'confirmed',
    operation: 'deposit',
    amount: '5,000.00',
    asset: 'USDC',
    timestamp: '2026-11-21 14:32',
    hash: '0x8f3a…c21d',
  },
  {
    id: 'tx-2',
    status: 'pending',
    operation: 'rebalance',
    amount: '12,400.00',
    asset: 'XLM',
    timestamp: '2026-11-21 11:05',
    hash: '0x2b71…9e4a',
  },
  {
    id: 'tx-3',
    status: 'failed',
    operation: 'withdraw',
    amount: '2,150.00',
    asset: 'USDC',
    timestamp: '2026-11-20 18:47',
    hash: '0x71c9…4f0b',
  },
  {
    id: 'tx-4',
    status: 'confirmed',
    operation: 'harvest',
    amount: '318.42',
    asset: 'AQUA',
    timestamp: '2026-11-20 09:15',
    hash: '0x9d02…77ae',
  },
  {
    id: 'tx-5',
    status: 'confirmed',
    operation: 'claim',
    amount: '84.10',
    asset: 'USDC',
    timestamp: '2026-11-19 16:08',
    hash: '0x4e88…1c3d',
  },
];
