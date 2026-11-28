import {
  CONFIRMATION_NOT_RECORDED,
  getTransactionConfirmation,
} from '@/lib/transactionConfirmation';
import type { TransactionRecord } from '@/lib/transactionFilters';

describe('getTransactionConfirmation', () => {
  it('returns the vault and pool selected for a transaction', () => {
    const record: TransactionRecord = {
      id: 'tx-1',
      status: 'confirmed',
      operation: 'deposit',
      amount: '100',
      asset: 'USDC',
      timestamp: '2026-11-21 14:32',
      vault: 'Stable Growth Vault',
      pool: 'XLM / USDC',
    };

    expect(getTransactionConfirmation(record)).toEqual({
      vault: 'Stable Growth Vault',
      pool: 'XLM / USDC',
    });
  });

  it('trims surrounding whitespace from recorded values', () => {
    expect(
      getTransactionConfirmation({
        vault: '  Stable Growth Vault  ',
        pool: '\tXLM / USDC\n',
      }),
    ).toEqual({ vault: 'Stable Growth Vault', pool: 'XLM / USDC' });
  });

  it('supports legacy records that have no vault or pool fields', () => {
    expect(getTransactionConfirmation({ id: 'legacy' })).toEqual({
      vault: CONFIRMATION_NOT_RECORDED,
      pool: CONFIRMATION_NOT_RECORDED,
    });
  });

  it('reports blank, null, and non-string values as not recorded', () => {
    expect(
      getTransactionConfirmation({
        vault: '   ',
        pool: null,
      }),
    ).toEqual({ vault: CONFIRMATION_NOT_RECORDED, pool: CONFIRMATION_NOT_RECORDED });

    expect(
      getTransactionConfirmation({
        vault: 42 as unknown as string,
        pool: undefined,
      }),
    ).toEqual({ vault: CONFIRMATION_NOT_RECORDED, pool: CONFIRMATION_NOT_RECORDED });
  });

  it('handles a missing record without throwing', () => {
    expect(getTransactionConfirmation(null)).toEqual({
      vault: CONFIRMATION_NOT_RECORDED,
      pool: CONFIRMATION_NOT_RECORDED,
    });
  });
});
