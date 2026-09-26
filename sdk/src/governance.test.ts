import { Keypair } from 'stellar-sdk';
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
});

describe('GovernanceSDK contract address configuration', () => {
  const RPC_URL = 'https://127.0.0.1:8080';
  const PASSPHRASE = 'Test SDF Network ; September 2015';
  const VALID_CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
  const OTHER_CONTRACT_ID = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3';

  const CONTRACT_ENV_VARS = [
    'GOVERNANCE_CONTRACT',
    'VOTING_ESCROW_CONTRACT',
    'STAKING_CONTRACT',
    'FEE_DISTRIBUTOR_CONTRACT',
  ];

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const name of CONTRACT_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    // Several read paths log before rethrowing; keep expected failures quiet.
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of CONTRACT_ENV_VARS) {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name] as string;
      }
    }
    jest.restoreAllMocks();
  });

  const newClient = (contracts?: Record<string, string>) =>
    new GovernanceSDK(RPC_URL, PASSPHRASE, undefined, contracts);

  /** Records the address a call would hit without touching the network. */
  const captureSimulatedAddress = (sdk: GovernanceSDK) => {
    const seen: string[] = [];
    jest
      .spyOn(sdk as any, 'simulateCall')
      .mockImplementation(async (...args: unknown[]) => {
        seen.push(args[0] as string);
        return 0n;
      });
    return seen;
  };

  it('rejects the placeholder strings that used to be the defaults', () => {
    // These are the literals the module used to fall back to. None of them is
    // a deployable Stellar ID, so they must never be accepted.
    const placeholders = [
      'GOV_TOKEN_CONTRACT_ADDRESS',
      'VE_TOKEN_CONTRACT_ADDRESS',
      'STAKING_CONTRACT_ADDRESS',
      'FEE_DISTRIBUTOR_ADDRESS',
    ];

    for (const placeholder of placeholders) {
      process.env.GOVERNANCE_CONTRACT = placeholder;
      expect(() => newClient()).toThrow(/is not a valid Stellar/);
      expect(() => newClient()).toThrow(new RegExp(`GOVERNANCE_CONTRACT \\("${placeholder}"\\)`));
    }
  });

  it('rejects a placeholder passed through the constructor', () => {
    expect(() => newClient({ governance: 'GOV_TOKEN_CONTRACT_ADDRESS' })).toThrow(
      /contracts\.governance/
    );
  });

  it('rejects a truncated or otherwise malformed address', () => {
    expect(() => newClient({ governance: 'CADQOBYHA4DQ' })).toThrow(/is not a valid Stellar/);
    expect(() => newClient({ staking: '0x1234' })).toThrow(/is not a valid Stellar/);
    // Lowercase is not valid base32 for a Stellar ID.
    expect(() => newClient({ votingEscrow: VALID_CONTRACT_ID.toLowerCase() })).toThrow(
      /is not a valid Stellar/
    );
    // Wrong length but a plausible alphabet.
    expect(() => newClient({ feeDistributor: `${VALID_CONTRACT_ID}AA` })).toThrow(
      /is not a valid Stellar/
    );
  });

  it('rejects an address that is set but empty', () => {
    process.env.STAKING_CONTRACT = '   ';
    expect(() => newClient()).toThrow(/STAKING_CONTRACT is set but empty/);
  });

  it('names the environment variable to set when a role is unconfigured', async () => {
    const sdk = newClient();

    await expect(sdk.getTotalSupply()).rejects.toThrow(/GOVERNANCE_CONTRACT/);
    await expect(sdk.getTokenBalance('GABC')).rejects.toThrow(/GOVERNANCE_CONTRACT/);
  });

  it('does not require unrelated contracts to be configured', async () => {
    process.env.GOVERNANCE_CONTRACT = VALID_CONTRACT_ID;
    const sdk = newClient();

    const seen = captureSimulatedAddress(sdk);
    await sdk.getTotalSupply();

    expect(seen).toEqual([VALID_CONTRACT_ID]);
  });

  it('uses the address for the role each call actually needs', async () => {
    process.env.GOVERNANCE_CONTRACT = VALID_CONTRACT_ID;
    process.env.VOTING_ESCROW_CONTRACT = OTHER_CONTRACT_ID;
    const sdk = newClient();

    const seen = captureSimulatedAddress(sdk);
    await sdk.getTotalSupply();
    await sdk.getVotingPower('GABC');

    expect(seen).toEqual([VALID_CONTRACT_ID, OTHER_CONTRACT_ID]);
  });

  it('still reports a role that was not configured', async () => {
    process.env.GOVERNANCE_CONTRACT = VALID_CONTRACT_ID;
    const sdk = newClient();

    await expect(sdk.getStakeBalance('GABC')).rejects.toThrow(/STAKING_CONTRACT/);
  });

  it('prefers an explicit constructor address over the environment', async () => {
    process.env.GOVERNANCE_CONTRACT = OTHER_CONTRACT_ID;
    const sdk = newClient({ governance: VALID_CONTRACT_ID });

    const seen = captureSimulatedAddress(sdk);
    await sdk.getTotalSupply();

    expect(seen).toEqual([VALID_CONTRACT_ID]);
  });

  it('trims surrounding whitespace from a configured address', async () => {
    process.env.GOVERNANCE_CONTRACT = `  ${VALID_CONTRACT_ID}  `;
    const sdk = newClient();

    const seen = captureSimulatedAddress(sdk);
    await sdk.getTotalSupply();

    expect(seen).toEqual([VALID_CONTRACT_ID]);
  });

  it('accepts a valid account address as well as a contract address', () => {
    const accountId = Keypair.random().publicKey();
    expect(() => newClient({ governance: accountId })).not.toThrow();
  });
});
