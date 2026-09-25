import { Keypair, Networks } from 'stellar-sdk';
import {
  createGovernanceClient,
  GovernanceSDK,
} from './index';

describe('createGovernanceClient', () => {
  it('returns a GovernanceSDK instance, not a plain config object', () => {
    const client = createGovernanceClient();

    expect(client).toBeInstanceOf(GovernanceSDK);
    // A config object would expose these; a client must not.
    expect((client as any).contracts).toBeUndefined();
    expect((client as any).horizonUrl).toBeUndefined();
    expect((client as any).sorobanRpcUrl).toBeUndefined();
    expect(typeof (client as any).server).toBe('object');
    expect((client as any).server).not.toBeNull();
  });

  it('configures the testnet passphrase by default', () => {
    const client = createGovernanceClient();
    expect(client.getNetworkPassphrase()).toBe(Networks.TESTNET);
  });

  it('configures the mainnet passphrase for mainnet', () => {
    const client = createGovernanceClient('mainnet');
    expect(client.getNetworkPassphrase()).toBe(Networks.PUBLIC);
  });

  it('creates a client without a signer by default', () => {
    const client = createGovernanceClient();
    expect(client.getKeypair()).toBeUndefined();
  });

  it('wires an optional keypair through options', () => {
    const keypair = Keypair.random();
    const client = createGovernanceClient('testnet', { keypair });

    expect(client.getKeypair()).toBe(keypair);
    expect(client.getKeypair()!.publicKey()).toBe(keypair.publicKey());
  });

  it('still supports setKeypair for late binding', () => {
    const client = createGovernanceClient();
    const keypair = Keypair.random();

    client.setKeypair(keypair);

    expect(client.getKeypair()).toBe(keypair);
  });

  it('returns a new instance on every call', () => {
    const first = createGovernanceClient();
    const second = createGovernanceClient();

    expect(first).not.toBe(second);
  });
});
