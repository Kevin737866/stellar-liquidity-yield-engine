import { Transaction, TransactionBuilder, Networks } from 'stellar-sdk';
import type { TransactionSigner } from 'stellar-liquidity-yield-engine-sdk';

/**
 * Minimal typings for the Freighter browser extension's injected API
 * (`window.freighterApi`). Keep these loose so the helper keeps working as
 * Freighter's SDK evolves.
 */
declare global {
  interface Window {
    freighterApi?: {
      isConnected: () => Promise<{ isConnected: boolean }>;
      getPublicKey: () => Promise<string>;
      signTransaction: (
        txXdr: string,
        opts?: { networkPassphrase?: string; network?: string }
      ) => Promise<string>;
    };
  }
}

export type FreighterNetwork = 'testnet' | 'mainnet';

export const isFreighterAvailable = (): boolean =>
  typeof window !== 'undefined' && !!window.freighterApi;

export const isFreighterConnected = async (): Promise<boolean> => {
  if (!isFreighterAvailable()) return false;
  try {
    const { isConnected } = await window.freighterApi!.isConnected();
    return isConnected;
  } catch {
    return false;
  }
};

export const getFreighterPublicKey = async (): Promise<string> => {
  if (!isFreighterAvailable()) {
    throw new Error('Freighter is not installed. Add the Freighter extension to your browser.');
  }
  return window.freighterApi!.getPublicKey();
};

export const getNetworkPassphrase = (network: FreighterNetwork): string =>
  network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Build a `TransactionSigner` backed by Freighter. It can be passed straight
 * into `VaultClient.deposit/withdraw/harvest` as the `userKeyPair` argument —
 * the client detects the async `getPublicKey`/`signTransaction` shape and
 * signs real transactions through the wallet.
 */
export const createFreighterSigner = (network: FreighterNetwork): TransactionSigner => ({
  async getPublicKey() {
    return getFreighterPublicKey();
  },
  async signTransaction(tx: Transaction, networkPassphrase: string) {
    if (!isFreighterAvailable()) {
      throw new Error('Freighter is not installed. Add the Freighter extension to your browser.');
    }
    const signedXdr = await window.freighterApi!.signTransaction(tx.toXDR(), {
      networkPassphrase
    });
    return TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  }
});

export const shortenAddress = (address: string, head = 6, tail = 4): string =>
  address.length > head + tail + 3
    ? `${address.slice(0, head)}…${address.slice(-tail)}`
    : address;