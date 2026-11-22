import {
  PENDING_TX_STORAGE_KEY,
  readPersistedTx,
  writePersistedTx,
} from './txStatusStorage';

describe('persisted transaction status', () => {
  const createStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: jest.fn((key: string) => values.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    };
  };

  it('returns null when nothing has been persisted', () => {
    expect(readPersistedTx(createStorage())).toBeNull();
  });

  it('restores a confirmed transaction with its hash', () => {
    const storage = createStorage();
    storage.setItem(
      PENDING_TX_STORAGE_KEY,
      JSON.stringify({
        status: 'confirmed',
        hash: '0xabc',
        error: null,
        updatedAt: 123,
      }),
    );

    expect(readPersistedTx(storage)).toEqual({
      status: 'confirmed',
      hash: '0xabc',
      error: null,
      updatedAt: 123,
    });
  });

  it('normalizes a stale submitting state with a hash to pending', () => {
    const storage = createStorage();
    storage.setItem(
      PENDING_TX_STORAGE_KEY,
      JSON.stringify({ status: 'submitting', hash: '0xabc', error: null }),
    );

    expect(readPersistedTx(storage)).toMatchObject({
      status: 'pending',
      hash: '0xabc',
    });
  });

  it('normalizes a stale submitting state without a hash to idle', () => {
    const storage = createStorage();
    storage.setItem(
      PENDING_TX_STORAGE_KEY,
      JSON.stringify({ status: 'submitting', hash: null, error: null }),
    );

    expect(readPersistedTx(storage)).toMatchObject({
      status: 'idle',
      hash: null,
    });
  });

  it('ignores malformed payloads', () => {
    const storage = createStorage();
    storage.setItem(PENDING_TX_STORAGE_KEY, '{not json');
    expect(readPersistedTx(storage)).toBeNull();

    storage.setItem(PENDING_TX_STORAGE_KEY, JSON.stringify({ status: 'unknown' }));
    expect(readPersistedTx(storage)).toBeNull();
  });

  it('persists state under the shared key', () => {
    const storage = createStorage();
    const state = {
      status: 'failed' as const,
      hash: null,
      error: 'reverted',
      updatedAt: 456,
    };

    writePersistedTx(state, storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      PENDING_TX_STORAGE_KEY,
      JSON.stringify(state),
    );
    expect(readPersistedTx(storage)).toEqual(state);
  });
});
