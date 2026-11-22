import { Account, Address } from 'stellar-sdk';
import { RebalancerClient } from './rebalancer';
import { PoolAllocation, RebalanceError } from './types';

describe('RebalancerClient known pool validation', () => {
  const knownAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const unknownAddress = 'GAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSABOV';

  const mockNetworkConfig = {
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

  const allocation = (poolId: string): PoolAllocation =>
    ({
      poolId: new Address(poolId),
      tokenA: new Address(knownAddress),
      tokenB: new Address(knownAddress),
      allocationPercent: 10000,
      targetApy: 500,
      currentApy: 500,
      impermanentLossRisk: 50,
    }) as unknown as PoolAllocation;

  let mockServer: any;
  let admin: any;

  beforeEach(() => {
    mockServer = {
      getAccount: jest.fn().mockResolvedValue(new Account(knownAddress, '1')),
      simulateTransaction: jest.fn(),
      sendTransaction: jest
        .fn()
        .mockResolvedValue({ status: 'SUCCESS', hash: 'tx-hash' }),
    };
    admin = {
      publicKey: jest.fn().mockReturnValue(knownAddress),
      sign: jest.fn((tx: any) => tx),
    };
  });

  it('rejects an unknown pool before touching the RPC', async () => {
    const client = new RebalancerClient(mockNetworkConfig, [knownAddress]);
    (client as any).server = mockServer;

    await expect(
      client.updateStrategy(
        admin,
        1,
        'Bad',
        1,
        100,
        500,
        3600,
        [allocation(unknownAddress)],
      ),
    ).rejects.toMatchObject({
      code: 'UNKNOWN_POOL',
    });
    expect(mockServer.getAccount).not.toHaveBeenCalled();
  });

  it('accepts a known pool and submits the transaction', async () => {
    const client = new RebalancerClient(mockNetworkConfig, [knownAddress]);
    (client as any).server = mockServer;

    const result = await client.updateStrategy(
      admin,
      1,
      'Good',
      1,
      100,
      500,
      3600,
      [allocation(knownAddress)],
    );

    expect(result.success).toBe(true);
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('allows the configured pool set to be replaced', async () => {
    const client = new RebalancerClient(mockNetworkConfig, [knownAddress]);
    (client as any).server = mockServer;
    client.setKnownPoolIds([unknownAddress]);

    await expect(
      client.updateStrategy(admin, 1, 'Bad', 1, 100, 500, 3600, [
        allocation(knownAddress),
      ]),
    ).rejects.toBeInstanceOf(RebalanceError);
  });

  it('keeps legacy behaviour when no known pools are configured', async () => {
    const client = new RebalancerClient(mockNetworkConfig);
    (client as any).server = mockServer;

    const result = await client.updateStrategy(
      admin,
      1,
      'Legacy',
      1,
      100,
      500,
      3600,
      [allocation(unknownAddress)],
    );

    expect(result.success).toBe(true);
  });

  it('reads is_known_pool from the contract', async () => {
    const client = new RebalancerClient(mockNetworkConfig);
    (client as any).server = mockServer;
    mockServer.simulateTransaction.mockResolvedValue({
      result: {
        status: 'SUCCESS',
        returnValue: { value: { boolean: true } },
      },
    });

    await expect(client.isKnownPool(new Address(knownAddress))).resolves.toBe(
      true,
    );

    const tx = mockServer.simulateTransaction.mock.calls[0][0];
    expect(tx.operations[0].body.invokeContract.functionName).toBe(
      'is_known_pool',
    );
  });
});
