import { Keypair, Networks } from 'stellar-sdk';
import {
  createGovernanceClient,
  GovernanceSDK,
  VERSION,
} from './index';
import {
  DEFAULT_GOVERNANCE_CONTRACTS,
  isContractConfigured,
} from './governance';

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

  it('injects caller-supplied contract IDs', () => {
    // Browser bundles cannot read process.env, so the UI must be able to
    // supply contract IDs explicitly.
    const contracts = {
      governance: 'CGOV',
      votingEscrow: 'CVE',
      staking: 'CSTAKE',
      feeDistributor: 'CFEE',
    };
    const client = createGovernanceClient('mainnet', { contracts });

    expect(client.getContracts()).toEqual(contracts);
  });

  it('merges partial contract IDs over the environment defaults', () => {
    const client = createGovernanceClient('testnet', {
      contracts: { votingEscrow: 'CVE_ONLY' },
    });

    expect(client.getContracts().votingEscrow).toBe('CVE_ONLY');
    // The other roles keep whatever DEFAULT_GOVERNANCE_CONTRACTS resolved to.
    expect(client.getContracts().governance).toBe(
      DEFAULT_GOVERNANCE_CONTRACTS.governance
    );
  });

  it('reports unconfigured contracts instead of a placeholder address', () => {
    const client = createGovernanceClient();

    // With no env set, the SDK must not invent a usable-looking contract ID.
    for (const role of Object.keys(client.getContracts()) as Array<
      keyof ReturnType<typeof client.getContracts>
    >) {
      expect(isContractConfigured(client.getContracts()[role])).toBe(false);
    }
  });
});

describe('VERSION', () => {
  it('matches package.json version as single source of truth', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const packageJson = require('../../package.json');
    expect(VERSION).toBe(packageJson.version);
    expect(VERSION).toBe('0.1.0');
  });
});
