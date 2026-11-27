import {
  GOVERNANCE_MAX_PAGE_SIZE,
  GOVERNANCE_PAGE_SIZE,
  GovernanceProposal,
  GovernanceSDK,
  ProposalState,
  paginateProposals,
} from './governance';

const makeProposal = (id: number): GovernanceProposal => ({
  id,
  proposer: `G${id}`,
  description: `proposal ${id}`,
  callData: [],
  votesFor: BigInt(id),
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
});

describe('governance proposal history pagination', () => {
  const proposals = Array.from({ length: 7 }, (_, index) => makeProposal(index + 1));

  it('exposes bounded defaults for keepers and UI callers', () => {
    expect(GOVERNANCE_PAGE_SIZE).toBe(25);
    expect(GOVERNANCE_MAX_PAGE_SIZE).toBe(100);
  });

  it('returns ordered first, middle and final partial pages', () => {
    const first = paginateProposals(proposals, 1, 3);
    expect(first.items.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(first).toMatchObject({
      page: 1,
      pageSize: 3,
      total: 7,
      totalPages: 3,
      hasNext: true,
      hasPrevious: false,
    });

    const middle = paginateProposals(proposals, 2, 3);
    expect(middle.items.map((p) => p.id)).toEqual([4, 5, 6]);
    expect(middle).toMatchObject({ hasNext: true, hasPrevious: true });

    const last = paginateProposals(proposals, 3, 3);
    expect(last.items.map((p) => p.id)).toEqual([7]);
    expect(last).toMatchObject({ hasNext: false, hasPrevious: true });
  });

  it('handles empty history and clamps out-of-range pages', () => {
    const empty = paginateProposals([], 1, 3);
    expect(empty).toMatchObject({
      items: [],
      total: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    });

    const beyond = paginateProposals(proposals, 99, 3);
    expect(beyond.items.map((p) => p.id)).toEqual([7]);
    expect(beyond.page).toBe(3);
  });

  it('rejects invalid bounds before making an RPC request', async () => {
    const sdk = new GovernanceSDK(
      'https://127.0.0.1:8080',
      'Test SDF Network ; September 2015'
    );
    const getAll = jest.spyOn(sdk, 'getAllProposals').mockResolvedValue(proposals);

    await expect(sdk.getProposalPage(0, 3)).rejects.toThrow(RangeError);
    await expect(sdk.getProposalPage(1, 0)).rejects.toThrow(RangeError);
    await expect(sdk.getProposalPage(1, GOVERNANCE_MAX_PAGE_SIZE + 1)).rejects.toThrow(
      RangeError
    );
    await expect(sdk.getProposalPage(1, 3, 0)).rejects.toThrow(RangeError);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('wraps the legacy history reader without changing its result', async () => {
    const sdk = new GovernanceSDK(
      'https://127.0.0.1:8080',
      'Test SDF Network ; September 2015'
    );
    jest.spyOn(sdk, 'getAllProposals').mockResolvedValue(proposals);

    const page = await sdk.getProposalPage(2, 3);
    expect(page.items.map((p) => p.id)).toEqual([4, 5, 6]);
    expect(page.total).toBe(proposals.length);
  });
});
