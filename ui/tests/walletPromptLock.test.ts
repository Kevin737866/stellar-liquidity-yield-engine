import {
  WalletPromptBusyError,
  WALLET_PROMPT_BUSY_MESSAGE,
  getActiveWalletPrompts,
  isWalletPromptActive,
  runWithWalletPrompt,
  subscribeToWalletPrompt,
} from '@/lib/walletPromptLock';

describe('wallet prompt lock', () => {
  it('allows one prompt at a time and releases it on success', async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const listener = jest.fn();
    const unsubscribe = subscribeToWalletPrompt(listener);

    const first = runWithWalletPrompt('sign', () => pending);

    expect(isWalletPromptActive()).toBe(true);
    expect(isWalletPromptActive('sign')).toBe(true);
    expect(getActiveWalletPrompts()).toEqual(['sign']);
    expect(listener).toHaveBeenLastCalledWith(['sign']);

    await expect(runWithWalletPrompt('connect', async () => 'second')).rejects.toBeInstanceOf(
      WalletPromptBusyError
    );

    release('first');
    await expect(first).resolves.toBe('first');

    expect(isWalletPromptActive()).toBe(false);
    expect(getActiveWalletPrompts()).toEqual([]);
    expect(listener).toHaveBeenLastCalledWith([]);

    await expect(runWithWalletPrompt('connect', async () => 'third')).resolves.toBe('third');
    unsubscribe();
  });

  it('releases the lock when a prompt is rejected', async () => {
    await expect(
      runWithWalletPrompt('connect', async () => {
        throw new Error('User rejected the request');
      })
    ).rejects.toThrow('User rejected the request');

    expect(isWalletPromptActive()).toBe(false);
  });

  it('exposes an actionable message for duplicate prompts', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runWithWalletPrompt('connect', () => pending);

    await expect(runWithWalletPrompt('connect', async () => undefined)).rejects.toThrow(
      WALLET_PROMPT_BUSY_MESSAGE
    );

    release();
    await first;
  });
});
