import { act, renderHook } from '@testing-library/react';
import { useTxStatus } from '@/hooks/useTxStatus';

describe('useTxStatus duplicate submissions', () => {
  it('runs only the first transaction when called twice before re-render', async () => {
    const { result } = renderHook(() => useTxStatus());
    let release!: (value: { hash: string; success: boolean }) => void;
    const pending = new Promise<{ hash: string; success: boolean }>((resolve) => {
      release = resolve;
    });
    const action = jest.fn(() => pending);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = result.current.runTx(action);
      second = result.current.runTx(action);
    });

    expect(action).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(false);

    await act(async () => {
      release({ hash: 'HASH', success: true });
      await first;
    });

    await expect(first).resolves.toBe(true);
    expect(result.current.txStatus).toBe('confirmed');
    expect(result.current.isTxInFlight).toBe(false);
  });

  it('releases the lock after a failed transaction', async () => {
    const { result } = renderHook(() => useTxStatus());
    const action = jest.fn(async () => {
      throw new Error('sign failed');
    });

    await act(async () => {
      await result.current.runTx(action);
    });

    expect(result.current.txStatus).toBe('failed');
    expect(result.current.txError).toBe('sign failed');

    await act(async () => {
      await result.current.runTx(async () => ({ hash: 'HASH2', success: true }));
    });

    expect(result.current.txStatus).toBe('confirmed');
  });
});
