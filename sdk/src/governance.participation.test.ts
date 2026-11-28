import {
  GovernanceProposal,
  GovernanceSDK,
  ProposalState,
  summarizeGovernanceParticipation,
} from './governance';

const ACCOUNT = 'GACCOUNT';

const makeProposal = (
  id: number,
  overrides: Partial<GovernanceProposal> = {}
): GovernanceProposal => ({
  id,
  proposer: 'GSOMEONE',
  description: `proposal ${id}`,
  callData: [],
  votesFor: 0n,
  votesAgainst: 0n,
  eta: 0,
  startTime: 0,
  endTime: 0,
  snapshotBlock: id,
  state: ProposalState.Active,
  forVoters: {},
  againstVoters: {},
  quorumReached: false,
  passed: false,
  ...overrides,
});

const votingFor = (weight: bigint) => ({ [ACCOUNT]: weight });
const votingAgainst = (weight: bigint) => ({ [ACCOUNT]: weight });

describe('summarizeGovernanceParticipation', () => {
  it('summarizes for and against votes across a mixed history', () => {
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, { forVoters: votingFor(100n) }),
      makeProposal(2, { againstVoters: votingAgainst(25n) }),
      makeProposal(3, { forVoters: votingFor(5n) }),
      makeProposal(4, { forVoters: { GOTHER: 999n } }),
    ]);

    expect(summary).toEqual({
      account: ACCOUNT,
      totalProposals: 4,
      eligibleProposals: 4,
      proposalsVoted: 3,
      votesFor: 2,
      votesAgainst: 1,
      votingPowerUsed: 130n,
      participationRate: 75,
      proposalsCreated: 0,
      votedProposalIds: [1, 2, 3],
    });
  });

  it('reads voter maps surfaced as a JS Map as well as a plain object', () => {
    const asMap = new Map<string, bigint>([[ACCOUNT, 7n]]);
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, { forVoters: asMap as unknown as Record<string, bigint> }),
      makeProposal(2, { againstVoters: votingAgainst(3n) }),
    ]);

    expect(summary.proposalsVoted).toBe(2);
    expect(summary.votingPowerUsed).toBe(10n);
  });

  it('counts authored proposals without counting them as votes', () => {
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, { proposer: ACCOUNT }),
      makeProposal(2, { proposer: ACCOUNT, forVoters: votingFor(1n) }),
    ]);

    expect(summary.proposalsCreated).toBe(2);
    expect(summary.proposalsVoted).toBe(1);
  });

  // ---- Boundary behavior -------------------------------------------------

  it('returns a zeroed summary for an empty history', () => {
    expect(summarizeGovernanceParticipation(ACCOUNT, [])).toEqual({
      account: ACCOUNT,
      totalProposals: 0,
      eligibleProposals: 0,
      proposalsVoted: 0,
      votesFor: 0,
      votesAgainst: 0,
      votingPowerUsed: 0n,
      participationRate: 0,
      proposalsCreated: 0,
      votedProposalIds: [],
    });
  });

  it('does not divide by zero when only pending proposals exist', () => {
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, { state: ProposalState.Pending }),
      makeProposal(2, { state: ProposalState.Pending, forVoters: votingFor(4n) }),
    ]);

    expect(summary.eligibleProposals).toBe(0);
    expect(summary.totalProposals).toBe(2);
    expect(summary.proposalsVoted).toBe(1);
    expect(summary.participationRate).toBe(0);
  });

  it('treats an account in both voter maps as one vote with both weights', () => {
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, {
        forVoters: votingFor(10n),
        againstVoters: votingAgainst(6n),
      }),
    ]);

    expect(summary.proposalsVoted).toBe(1);
    expect(summary.votesFor).toBe(1);
    expect(summary.votesAgainst).toBe(1);
    expect(summary.votingPowerUsed).toBe(16n);
  });

  it('treats a zero or malformed weight as a vote with no voting power', () => {
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, { forVoters: votingFor(0n) }),
      makeProposal(2, {
        againstVoters: { [ACCOUNT]: '12' } as unknown as Record<string, bigint>,
      }),
      makeProposal(3, {
        forVoters: { [ACCOUNT]: null } as unknown as Record<string, bigint>,
      }),
    ]);

    expect(summary.proposalsVoted).toBe(3);
    expect(summary.votingPowerUsed).toBe(12n);
  });

  it('ignores missing and null voter maps', () => {
    const summary = summarizeGovernanceParticipation(ACCOUNT, [
      makeProposal(1, {
        forVoters: null as unknown as Record<string, bigint>,
        againstVoters: undefined as unknown as Record<string, bigint>,
      }),
    ]);

    expect(summary.proposalsVoted).toBe(0);
    expect(summary.votingPowerUsed).toBe(0n);
  });

  it('trims surrounding whitespace before matching the account', () => {
    const summary = summarizeGovernanceParticipation(`  ${ACCOUNT}  `, [
      makeProposal(1, { forVoters: votingFor(1n) }),
    ]);

    expect(summary.account).toBe(ACCOUNT);
    expect(summary.proposalsVoted).toBe(1);
  });

  // ---- Failure behavior --------------------------------------------------

  it.each(['', '   '])('rejects the empty account %p', (account) => {
    expect(() => summarizeGovernanceParticipation(account, [])).toThrow(TypeError);
  });

  it('rejects a non-array proposal history', () => {
    expect(() =>
      summarizeGovernanceParticipation(ACCOUNT, null as unknown as GovernanceProposal[])
    ).toThrow(TypeError);
  });
});

describe('GovernanceSDK.getParticipationSummary', () => {
  const sdk = () =>
    new GovernanceSDK('https://127.0.0.1:8080', 'Test SDF Network ; September 2015');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuses a proposal history supplied by the caller without an RPC sweep', async () => {
    const client = sdk();
    const getAll = jest.spyOn(client, 'getAllProposals');
    const proposals = [
      makeProposal(1, { forVoters: votingFor(2n) }),
      makeProposal(2, { againstVoters: votingAgainst(3n) }),
    ];

    const summary = await client.getParticipationSummary(ACCOUNT, { proposals });

    expect(summary.proposalsVoted).toBe(2);
    expect(summary.votingPowerUsed).toBe(5n);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('reads and bounds the history when none is supplied', async () => {
    const client = sdk();
    const proposals = [makeProposal(1, { againstVoters: votingAgainst(8n) })];
    const getAll = jest.spyOn(client, 'getAllProposals').mockResolvedValue(proposals);

    const summary = await client.getParticipationSummary(ACCOUNT, { maxProposals: 42 });

    expect(getAll).toHaveBeenCalledWith(42);
    expect(summary.votesAgainst).toBe(1);
  });

  it('rejects invalid input before any RPC request', async () => {
    const client = sdk();
    const getAll = jest.spyOn(client, 'getAllProposals');

    await expect(client.getParticipationSummary('')).rejects.toThrow(TypeError);
    await expect(client.getParticipationSummary('   ')).rejects.toThrow(TypeError);
    await expect(client.getParticipationSummary(ACCOUNT, { maxProposals: 0 })).rejects.toThrow(
      RangeError
    );
    await expect(
      client.getParticipationSummary(ACCOUNT, { maxProposals: 1.5 })
    ).rejects.toThrow(RangeError);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('propagates read failures instead of reporting a fabricated summary', async () => {
    const client = sdk();
    jest.spyOn(client, 'getAllProposals').mockRejectedValue(new Error('rpc unavailable'));

    await expect(client.getParticipationSummary(ACCOUNT)).rejects.toThrow('rpc unavailable');
  });
});
