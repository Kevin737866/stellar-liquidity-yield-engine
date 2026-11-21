import {
  Account,
  Keypair,
  nativeToScVal,
  scValToNative,
  Transaction,
} from 'stellar-sdk';
import { CallData, GovernanceSDK, ProposalState } from './governance';

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const GOVERNANCE_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const VOTING_ESCROW_CONTRACT = GOVERNANCE_CONTRACT;
const PROPOSAL_ID = 1;
const PROPOSAL_THRESHOLD = BigInt(100_000_000);

const proposalStateValues: Record<ProposalState, number> = {
  [ProposalState.Pending]: 0,
  [ProposalState.Active]: 1,
  [ProposalState.Canceled]: 2,
  [ProposalState.Defeated]: 3,
  [ProposalState.Succeeded]: 4,
  [ProposalState.Queued]: 5,
  [ProposalState.Expired]: 6,
  [ProposalState.Executed]: 7,
};

function operationName(transaction: Transaction): string {
  return (transaction.operations[0] as any).func._value._attributes.functionName;
}

function operationArguments(transaction: Transaction): unknown[] {
  const args = (transaction.operations[0] as any).func._value._attributes.args;
  return args.map(scValToNative);
}

function rpcResult(value: unknown, type?: string) {
  return {
    result: {
      retval: nativeToScVal(value, type ? { type } : undefined),
    },
  };
}

function createGovernanceFixture(votingPower = PROPOSAL_THRESHOLD) {
  const keypair = Keypair.random();
  let sequence = 1;
  let state = ProposalState.Pending;
  let votesFor = BigInt(0);
  let votesAgainst = BigInt(0);
  let eta = 0;
  let proposalProposer = keypair.publicKey();
  let proposalDescription = '';
  let proposalCallData: CallData[] = [];
  let nextSendStatus = 'PENDING';
  let nextTransactionStatus = 'SUCCESS';

  const server: any = {
    getAccount: jest.fn(async (address: string) => new Account(address, String(sequence++))),
    simulateTransaction: jest.fn(async (transaction: Transaction) => {
      switch (operationName(transaction)) {
        case 'get_voting_power':
          return rpcResult(votingPower, 'i128');
        case 'get_proposal':
          return rpcResult({
            proposer: proposalProposer,
            description: proposalDescription,
            call_data: proposalCallData,
            votes_for: votesFor,
            votes_against: votesAgainst,
            eta,
            start_time: 100,
            end_time: 200,
            snapshot_block: 10,
            for_voters: {},
            against_voters: {},
          });
        case 'get_proposal_state':
          return rpcResult(proposalStateValues[state], 'u32');
        case 'has_quorum':
          return rpcResult(votesFor + votesAgainst >= PROPOSAL_THRESHOLD, 'bool');
        case 'has_passed':
          return rpcResult(votesFor > votesAgainst, 'bool');
        default:
          throw new Error(`Unexpected governance simulation: ${operationName(transaction)}`);
      }
    }),
    sendTransaction: jest.fn(async (transaction: Transaction) => {
      const method = operationName(transaction);
      if (nextSendStatus === 'ERROR') {
        return { hash: `hash-${method}`, status: nextSendStatus };
      }

      switch (method) {
        case 'propose':
          [proposalProposer, proposalDescription, proposalCallData] =
            operationArguments(transaction) as [string, string, CallData[]];
          state = ProposalState.Pending;
          break;
        case 'vote':
          state = ProposalState.Active;
          votesFor = BigInt(operationArguments(transaction)[3] as bigint);
          break;
        case 'queue':
          state = ProposalState.Queued;
          eta = 172_900;
          break;
        case 'execute':
          state = ProposalState.Executed;
          break;
        case 'cancel':
          state = ProposalState.Canceled;
          break;
        default:
          throw new Error(`Unexpected governance submission: ${method}`);
      }

      return { hash: `hash-${method}`, status: nextSendStatus };
    }),
    getTransaction: jest.fn(async () => ({
      status: nextTransactionStatus,
      ledger: 42,
    })),
  };

  const sdk = new GovernanceSDK(
    'https://127.0.0.1:8080',
    NETWORK_PASSPHRASE,
    keypair,
    {
      governance: GOVERNANCE_CONTRACT,
      votingEscrow: VOTING_ESCROW_CONTRACT,
    }
  );
  (sdk as any).server = server;

  return {
    sdk,
    keypair,
    server,
    advanceState(nextState: ProposalState) {
      state = nextState;
    },
    setNextSendStatus(status: string) {
      nextSendStatus = status;
    },
    setNextTransactionStatus(status: string) {
      nextTransactionStatus = status;
    },
  };
}

describe('GovernanceSDK proposal lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates, votes on, queues, and executes a proposal through the RPC lifecycle', async () => {
    const fixture = createGovernanceFixture();
    const { sdk, server, keypair } = fixture;
    const description = 'P'.repeat(280);

    const created = await sdk.createProposal(description, [
      {
        contractAddress: GOVERNANCE_CONTRACT,
        functionName: 'set_performance_fee',
        args: [1200],
      },
    ]);
    expect(operationName(created)).toBe('propose');
    expect(created.signatures).toHaveLength(1);
    expect(await sdk.submitTransaction(created)).toMatchObject({
      success: true,
      ledger: 42,
    });

    const pending = await sdk.getProposal(PROPOSAL_ID);
    expect(pending).toMatchObject({
      id: PROPOSAL_ID,
      proposer: keypair.publicKey(),
      description,
      state: ProposalState.Pending,
    });
    expect(pending.callData).toMatchObject([
      {
        contract_address: GOVERNANCE_CONTRACT,
        function_name: 'set_performance_fee',
        args: [BigInt(1200)],
      },
    ]);

    const vote = await sdk.castVote(PROPOSAL_ID, true, PROPOSAL_THRESHOLD);
    expect(operationName(vote)).toBe('vote');
    expect(operationArguments(vote)).toHaveLength(4);
    expect(vote.signatures).toHaveLength(1);
    expect((await sdk.submitTransaction(vote)).success).toBe(true);

    fixture.advanceState(ProposalState.Succeeded);
    const queue = await sdk.queueProposal(PROPOSAL_ID);
    expect(operationName(queue)).toBe('queue');
    expect((await sdk.submitTransaction(queue)).success).toBe(true);

    const queued = await sdk.getProposal(PROPOSAL_ID);
    expect(queued.state).toBe(ProposalState.Queued);

    const execute = await sdk.executeProposal(PROPOSAL_ID);
    expect(operationName(execute)).toBe('execute');
    expect((await sdk.submitTransaction(execute)).success).toBe(true);

    const executed = await sdk.getProposal(PROPOSAL_ID);
    expect(executed).toMatchObject({
      state: ProposalState.Executed,
      votesFor: PROPOSAL_THRESHOLD,
      votesAgainst: BigInt(0),
      eta: 172_900,
    });
    expect(server.sendTransaction).toHaveBeenCalledTimes(4);
    expect(server.getTransaction).toHaveBeenCalledTimes(4);
  });

  it('cancels a pending proposal and reports included and rejected transaction failures', async () => {
    const fixture = createGovernanceFixture();
    const proposal = await fixture.sdk.createProposal('Cancel this proposal', []);
    expect((await fixture.sdk.submitTransaction(proposal)).success).toBe(true);

    const cancel = await fixture.sdk.cancelProposal(PROPOSAL_ID);
    expect(operationName(cancel)).toBe('cancel');
    expect((await fixture.sdk.submitTransaction(cancel)).success).toBe(true);
    expect((await fixture.sdk.getProposal(PROPOSAL_ID)).state).toBe(ProposalState.Canceled);

    fixture.setNextTransactionStatus('FAILED');
    const failedOnChainCancel = await fixture.sdk.cancelProposal(PROPOSAL_ID);
    await expect(fixture.sdk.submitTransaction(failedOnChainCancel)).resolves.toMatchObject({
      success: false,
      ledger: 42,
      error: 'The transaction was included but failed on chain.',
    });

    const rejectedCancel = await fixture.sdk.cancelProposal(PROPOSAL_ID);
    fixture.setNextSendStatus('ERROR');
    await expect(fixture.sdk.submitTransaction(rejectedCancel)).resolves.toMatchObject({
      hash: 'hash-cancel',
      success: false,
      error: 'The RPC rejected this transaction (status ERROR).',
    });
    expect(fixture.server.getTransaction).toHaveBeenCalledTimes(3);
  });

  it('accepts the exact proposer threshold and rejects an overlong description', async () => {
    const fixture = createGovernanceFixture(PROPOSAL_THRESHOLD);
    const createProposal = jest.spyOn(fixture.sdk as any, 'buildTransaction');

    await expect(fixture.sdk.createProposal('P'.repeat(280), [])).resolves.toBeInstanceOf(
      Transaction
    );
    expect(createProposal).toHaveBeenCalledTimes(1);

    await expect(fixture.sdk.createProposal('P'.repeat(281), [])).rejects.toThrow(
      'Proposal description too long (max 280 chars)'
    );
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  it('rejects proposal creation and voting when voting power is insufficient', async () => {
    const fixture = createGovernanceFixture(PROPOSAL_THRESHOLD - BigInt(1));

    await expect(fixture.sdk.createProposal('Below threshold', [])).rejects.toThrow(
      'Insufficient voting power to create proposal (minimum 100 tokens)'
    );
    await expect(
      fixture.sdk.castVote(PROPOSAL_ID, true, PROPOSAL_THRESHOLD)
    ).rejects.toThrow('Insufficient voting power');
    expect(fixture.server.sendTransaction).not.toHaveBeenCalled();
  });

  it('surfaces Soroban simulation failures instead of treating them as zero voting power', async () => {
    const fixture = createGovernanceFixture();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fixture.server.simulateTransaction.mockResolvedValueOnce({
      error: 'Contract simulation failed',
    });

    await expect(fixture.sdk.getVotingPower()).rejects.toThrow(
      'Soroban simulation failed: Contract simulation failed'
    );
  });
});
