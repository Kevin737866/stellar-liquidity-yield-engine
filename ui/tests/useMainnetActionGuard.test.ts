import { act, renderHook } from '@testing-library/react';
import { useMainnetActionGuard } from '@/hooks/useMainnetActionGuard';

describe('useMainnetActionGuard', () => {
  it('runs testnet actions immediately without opening a prompt', async () => {
    const run = jest.fn();
    const { result } = renderHook(() => useMainnetActionGuard({ network: 'testnet' }));

    await act(async () => {
      await result.current.requestAction('deposit', run);
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.isPromptOpen).toBe(false);
    expect(result.current.pendingAction).toBeNull();
  });

  it('holds a mainnet action until the switch is confirmed', async () => {
    const run = jest.fn();
    const onNetworkChange = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useMainnetActionGuard({ network: 'mainnet', onNetworkChange })
    );

    let callerPromise: Promise<void> | undefined;
    await act(async () => {
      callerPromise = result.current.requestAction('deposit', run);
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.current.pendingAction).toEqual(
      expect.objectContaining({ label: 'deposit', run })
    );

    await act(async () => {
      await result.current.confirm();
      await callerPromise;
    });

    expect(onNetworkChange).toHaveBeenCalledWith('mainnet');
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.isPromptOpen).toBe(false);
  });

  it('discards the pending action when cancelled', async () => {
    const run = jest.fn();
    let callerPromise: Promise<void> | undefined;
    const { result } = renderHook(() => useMainnetActionGuard({ network: 'mainnet' }));

    await act(async () => {
      callerPromise = result.current.requestAction('withdraw', run);
    });
    await act(async () => {
      result.current.cancel();
      await callerPromise;
    });

    expect(result.current.isPromptOpen).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a failed network switch and never submits the transaction', async () => {
    const run = jest.fn();
    const onNetworkChange = jest.fn().mockRejectedValue(new Error('wallet rejected the switch'));
    const { result } = renderHook(() =>
      useMainnetActionGuard({ network: 'mainnet', onNetworkChange })
    );

    await act(async () => {
      void result.current.requestAction('harvest rewards', run);
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.isPromptOpen).toBe(true);
    expect(result.current.isSwitching).toBe(false);
    expect(result.current.switchError).toMatch(/wallet rejected the switch/);
    expect(result.current.switchError).toMatch(/No transaction was submitted/);
    expect(run).not.toHaveBeenCalled();

    act(() => result.current.clearError());
    expect(result.current.switchError).toBeNull();
  });

  it('uses a safe message for non-Error failures', async () => {
    const run = jest.fn();
    const onNetworkChange = jest.fn().mockRejectedValue('not an error');
    const { result } = renderHook(() =>
      useMainnetActionGuard({ network: 'mainnet', onNetworkChange })
    );

    await act(async () => {
      void result.current.requestAction('vote', run);
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.switchError).toMatch(/Unknown error/);
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores a second request while a prompt is already open', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { result } = renderHook(() => useMainnetActionGuard({ network: 'mainnet' }));

    await act(async () => {
      void result.current.requestAction('deposit', first);
      void result.current.requestAction('withdraw', second);
    });

    expect(result.current.pendingAction?.label).toBe('deposit');
    await act(async () => {
      await result.current.confirm();
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not run an action twice when confirm is called again', async () => {
    const run = jest.fn();
    const { result } = renderHook(() => useMainnetActionGuard({ network: 'mainnet' }));

    await act(async () => {
      void result.current.requestAction('deposit', run);
      await Promise.all([result.current.confirm(), result.current.confirm()]);
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects the caller promise when the guarded action fails', async () => {
    const run = jest.fn().mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useMainnetActionGuard({ network: 'mainnet' }));

    let callerPromise: Promise<void> | undefined;
    await act(async () => {
      callerPromise = result.current.requestAction('deposit', run);
    });
    await expect(
      act(async () => {
        await result.current.confirm();
        await callerPromise;
      })
    ).rejects.toThrow('rpc down');
  });
});
