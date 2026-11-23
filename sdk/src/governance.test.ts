import { GovernanceSDK } from './governance';

const proposalActions = [
  'queueProposal',
  'executeProposal',
  'cancelProposal',
] as const;

describe('GovernanceSDK proposal actions', () => {
  // Lifecycle audit coverage: each proposal action must reject before building a transaction when no keypair is supplied, so no partial or unsigned audit events can be emitted.
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
});
