import { Account, Address, Keypair, nativeToScVal } from 'stellar-sdk';
import { VaultClient } from './vaultClient';

describe('VaultClient harvest interval configuration', () => {
  const networkConfig = {
    network: 'testnet' as const,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    contracts: {
      yieldEngine: 'CAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDQF',
      rewardDistributor: 'CABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARHO',
      rebalanceEngine: 'CABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVX',
      strategyRegistry: 'CACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4JJ',
    },
  };

  let client: VaultClient;
  let mockServer: any;

  beforeEach(() => {
    client = new VaultClient(
      new Address('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'),
      networkConfig,
    );
    mockServer = {
      simulateTransaction: jest.fn(),
      getAccount: jest.fn().mockResolvedValue(
        new Account(Keypair.random().publicKey(), '1'),
      ),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'ERROR',
        hash: 'tx-hash',
        errorResult: { toXDR: () => 'declined' },
      }),
    };
    (client as any).server = mockServer;
  });

  it('reads the configured interval from the vault', async () => {
    mockServer.simulateTransaction.mockResolvedValue({
      result: {
        status: 'SUCCESS',
        returnValue: nativeToScVal(3600, { type: 'u64' }),
      },
    });

    await expect(client.getHarvestInterval()).resolves.toBe(3600);

    const tx = mockServer.simulateTransaction.mock.calls[0][0];
    expect(tx.operations[0].body.invokeContract.functionName).toBe(
      'get_harvest_interval',
    );
  });

  it('reads the remaining cooldown and harvest availability', async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce({
        result: {
          status: 'SUCCESS',
          returnValue: nativeToScVal(1500, { type: 'u64' }),
        },
      })
      .mockResolvedValueOnce({
        result: {
          status: 'SUCCESS',
          returnValue: nativeToScVal(false),
        },
      });

    await expect(client.getSecondsUntilNextHarvest()).resolves.toBe(1500);
    await expect(client.canHarvest()).resolves.toBe(false);
  });

  it('builds a set_harvest_interval transaction for the admin', async () => {
    const admin = Keypair.random();

    const result = await client.setHarvestInterval(admin, 3600);
    expect(result.success).toBe(false);

    const tx = mockServer.sendTransaction.mock.calls[0][0];
    expect(tx.operations[0].body.invokeContract.functionName).toBe(
      'set_harvest_interval',
    );
    expect(mockServer.getAccount).toHaveBeenCalledWith(admin.publicKey());
  });
});
