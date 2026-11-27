import { GovernanceSDK } from './governance';

const proposalActions = [
  'queueProposal',
  'executeProposal',
  'cancelProposal',
] as const;

describe('GovernanceSDK proposal actions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(proposalActions)(
    '%s rejects before building a transaction without a keypair',
    async (method) => {
      const sdk = new GovernanceSDK(
        'https://127.0.0.1:8080',
        'Test SDF Network ; September 2015'
      );
      const buildTransaction = jest.spyOn(sdk as any, 'buildTransaction');

      await expect(sdk[method](7)).rejects.toThrow('Keypair required');
      expect(buildTransaction).not.toHaveBeenCalled();
    }
  );

  it('checks RPC health before transaction submission when configured', async () => {
    const sdk = new GovernanceSDK(
      'https://127.0.0.1:8080',
      'Test SDF Network ; September 2015'
    );
    const order: string[] = [];
    (sdk as any).server = {
      serverURL: { toString: () => 'https://127.0.0.1:8080' },
      getHealth: jest.fn().mockImplementation(async () => {
        order.push('health');
        return { status: 'healthy' };
      }),
      sendTransaction: jest.fn().mockImplementation(async () => {
        order.push('send');
        return { hash: 'test-hash', status: 'TRY_AGAIN_LATER' };
      }),
    };

    await sdk.submitTransaction({} as any, {
      rpcHealthCheck: { timeoutMs: 100 },
    });

    expect(order).toEqual(['health', 'send']);
  });

  it('does not submit a transaction when its configured RPC health check fails', async () => {
    const sdk = new GovernanceSDK(
      'https://127.0.0.1:8080',
      'Test SDF Network ; September 2015'
    );
    const sendTransaction = jest.fn();
    (sdk as any).server = {
      serverURL: { toString: () => 'https://127.0.0.1:8080' },
      getHealth: jest.fn().mockRejectedValue(new Error('connection refused')),
      sendTransaction,
    };

    await expect(
      sdk.submitTransaction({} as any, {
        rpcHealthCheck: { timeoutMs: 100 },
      }),
    ).rejects.toThrow('RPC health check failed');
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
