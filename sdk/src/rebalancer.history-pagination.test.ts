import { Account, nativeToScVal, scValToNative } from 'stellar-sdk';
import { RebalancerClient } from './rebalancer';

describe('RebalancerClient history pagination', () => {
  const config = {
    network: 'testnet' as const,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    contracts: {
      yieldEngine: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      rewardDistributor: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      rebalanceEngine: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      strategyRegistry: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    },
  };

  function createClient() {
    const client = new RebalancerClient(config);
    const server = {
      getAccount: jest.fn().mockResolvedValue(
        new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1'),
      ),
      simulateTransaction: jest.fn(),
    };
    (client as any).server = server;
    return { client, server };
  }

  it('calls the paginated contract method and parses its page', async () => {
    const { client, server } = createClient();
    const page: any[] = [];
    jest.spyOn(client as any, 'parseHistory').mockReturnValue(page);
    server.simulateTransaction.mockResolvedValue({
      result: { status: 'SUCCESS', returnValue: {} },
    });

    await expect(client.getHistoryPage(25, 50)).resolves.toBe(page);

    const operation = server.simulateTransaction.mock.calls[0][0].operations[0].func;
    expect(operation.invokeContract().functionName().toString()).toBe('get_history_paginated');
    expect(operation.invokeContract().args().map((arg: any) => Number(scValToNative(arg))))
      .toEqual([25, 50]);
  });

  it('rejects invalid limits and offsets before making an RPC request', async () => {
    const { client, server } = createClient();

    await expect(client.getHistoryPage(0, 0)).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    await expect(client.getHistoryPage(1001, 0)).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    await expect(client.getHistoryPage(10, -1)).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it('exposes the total history count for pagination controls', async () => {
    const { client, server } = createClient();
    server.simulateTransaction.mockResolvedValue({
      result: { status: 'SUCCESS', returnValue: nativeToScVal(123, { type: 'u32' }) },
    });

    await expect(client.getHistoryCount()).resolves.toBe(123);

    const operation = server.simulateTransaction.mock.calls[0][0].operations[0].func;
    expect(operation.invokeContract().functionName().toString()).toBe('get_history_count');
  });
});
