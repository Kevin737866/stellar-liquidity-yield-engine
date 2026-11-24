import { Account, Keypair, Networks, Operation, TransactionBuilder } from 'stellar-sdk';
import {
  WALLET_PROMPT_BUSY_MESSAGE,
  isWalletPromptActive,
} from '@/lib/walletPromptLock';
import { createFreighterSigner, getFreighterPublicKey } from '@/lib/freighter';

function sampleTransaction() {
  const account = new Account(Keypair.random().publicKey(), '0');
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
    .setTimeout(0)
    .build();
}

describe('Freighter prompt guards', () => {
  beforeEach(() => {
    window.freighterApi = {
      isConnected: jest.fn(async () => ({ isConnected: true })),
      getPublicKey: jest.fn(async () => Keypair.random().publicKey()),
      signTransaction: jest.fn(async (txXdr: string) => txXdr),
    };
  });

  afterEach(() => {
    delete window.freighterApi;
  });

  it('ignores a second connect click while the first wallet prompt is open', async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    window.freighterApi!.getPublicKey = jest.fn(() => pending);

    const first = getFreighterPublicKey();
    await expect(getFreighterPublicKey()).rejects.toThrow(WALLET_PROMPT_BUSY_MESSAGE);
    expect(window.freighterApi!.getPublicKey).toHaveBeenCalledTimes(1);

    release('GCONNECT');
    await expect(first).resolves.toBe('GCONNECT');
    expect(isWalletPromptActive()).toBe(false);
  });

  it('releases the wallet lock after a rejected connect prompt', async () => {
    window.freighterApi!.getPublicKey = jest.fn(async () => {
      throw new Error('User rejected the request');
    });

    await expect(getFreighterPublicKey()).rejects.toThrow('User rejected the request');
    window.freighterApi!.getPublicKey = jest.fn(async () => Keypair.random().publicKey());
    await expect(getFreighterPublicKey()).resolves.toEqual(expect.any(String));
  });

  it('blocks overlapping sign prompts from different surfaces', async () => {
    const signer = createFreighterSigner('testnet');
    const tx = sampleTransaction();
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    window.freighterApi!.signTransaction = jest.fn(() => pending);

    const first = signer.signTransaction(tx, Networks.TESTNET);
    await expect(signer.signTransaction(tx, Networks.TESTNET)).rejects.toThrow(
      WALLET_PROMPT_BUSY_MESSAGE
    );
    expect(window.freighterApi!.signTransaction).toHaveBeenCalledTimes(1);

    release(tx.toXDR());
    await expect(first).resolves.toBeDefined();
    expect(isWalletPromptActive()).toBe(false);
  });
});
