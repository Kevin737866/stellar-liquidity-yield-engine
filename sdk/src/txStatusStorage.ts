export type TxStatus = 'idle' | 'submitting' | 'pending' | 'confirmed' | 'failed';

export interface PersistedTxState {
  status: TxStatus;
  hash: string | null;
  error: string | null;
  updatedAt: number;
}

export const PENDING_TX_STORAGE_KEY = 'stellar-liquidity-yield:pending-tx';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const TX_STATUSES: TxStatus[] = ['idle', 'submitting', 'pending', 'confirmed', 'failed'];

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage;
}

export function readPersistedTx(storage?: StorageLike): PersistedTxState | null {
  const target = resolveStorage(storage);
  if (!target) {
    return null;
  }

  try {
    const raw = target.getItem(PENDING_TX_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !TX_STATUSES.includes(parsed.status)) {
      return null;
    }

    const hash = typeof parsed.hash === 'string' ? parsed.hash : null;
    const error = typeof parsed.error === 'string' ? parsed.error : null;
    const status: TxStatus =
      parsed.status === 'submitting' ? (hash ? 'pending' : 'idle') : parsed.status;

    return {
      status,
      hash,
      error,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writePersistedTx(state: PersistedTxState, storage?: StorageLike): void {
  const target = resolveStorage(storage);
  if (!target) {
    return;
  }

  try {
    target.setItem(PENDING_TX_STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}
