/**
 * Governance SDK Module
 * 
 * Provides JavaScript/TypeScript interface for the Stellar Yield Governance system.
 * Handles proposal creation, voting, fee claiming, and token delegation.
 */

import { 
  Keypair, 
  SorobanRpc, 
  Transaction, 
  TransactionBuilder,
  BASE_FEE,
  scValToNative, 
  Contract
} from 'stellar-sdk';

// ===== Configuration =====

/**
 * Governance contract addresses are read from the environment (or passed to the
 * `GovernanceSDK` constructor) and are never defaulted to a placeholder string.
 * A placeholder is not a deployable Stellar ID, so every call made against one
 * fails during signature verification — the client would fail late and with an
 * opaque error. Requiring a real address instead surfaces the misconfiguration
 * immediately, naming the variable that has to be set.
 */
const GOVERNANCE_CONTRACTS = [
  {
    role: 'governance',
    envVar: 'GOVERNANCE_CONTRACT',
    label: 'governance contract',
  },
  {
    role: 'votingEscrow',
    envVar: 'VOTING_ESCROW_CONTRACT',
    label: 'voting escrow contract',
  },
  {
    role: 'staking',
    envVar: 'STAKING_CONTRACT',
    label: 'staking contract',
  },
  {
    role: 'feeDistributor',
    envVar: 'FEE_DISTRIBUTOR_CONTRACT',
    label: 'fee distributor contract',
  },
] as const;

export type GovernanceContractRole = (typeof GOVERNANCE_CONTRACTS)[number]['role'];

/**
 * Deployed contract IDs, keyed by role. Any role left out falls back to its
 * environment variable, and is only required by the calls that need it.
 */
export type GovernanceContracts = Partial<Record<GovernanceContractRole, string>>;

/**
 * Stellar IDs are 56 base32 characters (RFC 4648 alphabet `A-Z2-7`) with a
 * version byte: `G` for accounts, `C` for contracts.
 */
const STELLAR_ID_PATTERN = /^[GC][A-Z2-7]{55}$/;

/**
 * Resolve and validate configured contract addresses. A missing address is
 * allowed here and reported by {@link GovernanceSDK.requireContractAddress} at
 * the point of use, so a client that only touches one contract does not require
 * all four; a present-but-invalid address is rejected right away, because that
 * is always a mistake.
 */
function resolveContractAddresses(overrides: GovernanceContracts): GovernanceContracts {
  const resolved: GovernanceContracts = {};

  for (const { role, envVar, label } of GOVERNANCE_CONTRACTS) {
    const override = overrides[role];
    const fromEnv = process.env[envVar];
    const value = override !== undefined ? override : fromEnv;

    if (value === undefined) {
      continue;
    }

    const source = override !== undefined ? `contracts.${role}` : envVar;
    const address = value.trim();

    if (address === '') {
      throw new Error(`${source} is set but empty: provide the deployed ${label} ID.`);
    }
    if (!STELLAR_ID_PATTERN.test(address)) {
      throw new Error(
        `${source} ("${address}") is not a valid Stellar ${label} ID. ` +
          'Expected 56 base32 characters starting with G (account) or C (contract), ' +
          "as printed by `soroban contract deploy`."
      );
    }

    resolved[role] = address;
  }

  return resolved;
}

// ===== Type Definitions =====

/**
 * Proposal state enum
 */
export enum ProposalState {
  Pending = 'pending',
  Active = 'active',
  Canceled = 'canceled',
  Defeated = 'defeated',
  Succeeded = 'succeeded',
  Queued = 'queued',
  Expired = 'expired',
  Executed = 'executed'
}

/**
 * Governance proposal interface
 */
export interface GovernanceProposal {
  id: number;
  proposer: string;
  description: string;
  callData: CallData[];
  votesFor: bigint;
  votesAgainst: bigint;
  eta: number;
  startTime: number;
  endTime: number;
  snapshotBlock: number;
  state: ProposalState;
  forVoters: Record<string, bigint>;
  againstVoters: Record<string, bigint>;
  quorumReached: boolean;
  passed: boolean;
}

/**
 * Call data for proposal execution
 */
export interface CallData {
  contractAddress: string;
  functionName: string;
  args: any[];
}

/**
 * Lock information for voting escrow
 */
export interface LockInfo {
  amount: bigint;
  startTime: number;
  endTime: number;
  votingPower: bigint;
  boostedBalance: bigint;
  boostMultiplier: number;
}

/**
 * Fee distribution info
 */
export interface FeeDistribution {
  totalCollected: bigint;
  weeklyFees: Record<number, bigint>;
  userClaimable: bigint;
}

/**
 * Protocol parameters
 */
export interface ProtocolParameters {
  performanceFee: number;
  withdrawalFee: number;
  rebalanceThreshold: number;
  insuranceReserveTarget: number;
}

// ===== SDK Client Class =====

/**
 * Governance SDK Client
 */
export class GovernanceSDK {
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private keypair?: Keypair;
  private contractAddresses: GovernanceContracts;

  /**
   * @param contracts Deployed contract IDs, keyed by role. Anything omitted
   *   falls back to its environment variable. Roles that end up unconfigured
   *   are reported by name when a call actually needs them.
   */
  constructor(
    sorobanRpcUrl: string,
    networkPassphrase: string,
    keypair?: Keypair,
    contracts: GovernanceContracts = {}
  ) {
    this.server = new SorobanRpc.Server(sorobanRpcUrl);
    this.networkPassphrase = networkPassphrase;
    this.keypair = keypair;
    this.contractAddresses = resolveContractAddresses(contracts);
  }

  /**
   * Set the keypair for signing transactions
   */
  setKeypair(keypair: Keypair): void {
    this.keypair = keypair;
  }

  /**
   * The signer currently configured on this client, if any
   */
  getKeypair(): Keypair | undefined {
    return this.keypair;
  }

  /**
   * Network passphrase this client builds and signs transactions for
   */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /**
   * The deployed contract ID configured for `role`.
   *
   * Throws when the role is unconfigured, naming the environment variable to
   * set. There is no placeholder fallback: an unset variable has to fail here
   * rather than produce a call that can never be signed.
   */
  private requireContractAddress(role: GovernanceContractRole): string {
    const address = this.contractAddresses[role];

    if (!address) {
      const { envVar, label } = GOVERNANCE_CONTRACTS.find((c) => c.role === role)!;
      throw new Error(
        `No ${label} address configured: set ${envVar} to a real deployed Stellar ` +
          `contract ID, or pass contracts.${role} to the GovernanceSDK constructor.`
      );
    }

    return address;
  }

  // ===== Token Functions =====

  /**
   * Get governance token balance
   */
  async getTokenBalance(address: string): Promise<bigint> {
    try {
      const result = await this.simulateCall(
        this.requireContractAddress('governance'),
        'balance',
        { addr: address }
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting token balance:', error);
      throw error;
    }
  }

  /**
   * Get total supply of governance tokens
   */
  async getTotalSupply(): Promise<bigint> {
    try {
      const result = await this.simulateCall(
        this.requireContractAddress('governance'),
        'total_supply',
        {}
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting total supply:', error);
      throw error;
    }
  }

  /**
   * Transfer governance tokens
   */
  async transfer(to: string, amount: bigint): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required for transfer');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'transfer',
      {
        from: this.keypair.publicKey(),
        to: to,
        amount: amount.toString()
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Delegate voting power to another address
   */
  async delegate(to: string): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required for delegation');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'delegate',
      {
        from: this.keypair.publicKey(),
        to: to
      }
    );

    return this.signTransaction(transaction);
  }

  // ===== Voting Escrow Functions =====

  /**
   * Create a new lock in voting escrow
   * @param amount Amount of tokens to lock
   * @param duration Lock duration in seconds (1 week to 4 years)
   */
  async createLock(amount: bigint, duration: number): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required for locking');
    }

    // Validate duration
    const MIN_DURATION = 7 * 24 * 60 * 60; // 1 week
    const MAX_DURATION = 4 * 365 * 24 * 60 * 60; // 4 years

    if (duration < MIN_DURATION || duration > MAX_DURATION) {
      throw new Error('Lock duration must be between 1 week and 4 years');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('votingEscrow'),
      'create_lock',
      {
        user: this.keypair.publicKey(),
        amount: amount.toString(),
        duration: duration
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Increase lock amount
   */
  async increaseLock(amount: bigint): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('votingEscrow'),
      'increase_lock',
      {
        user: this.keypair.publicKey(),
        amount: amount.toString()
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Extend lock duration
   */
  async extendLock(newDuration: number): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('votingEscrow'),
      'extend_lock',
      {
        user: this.keypair.publicKey(),
        new_duration: newDuration
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Withdraw tokens after lock expires
   */
  async withdrawFromEscrow(): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('votingEscrow'),
      'withdraw',
      {
        user: this.keypair.publicKey()
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Get current voting power
   */
  async getVotingPower(address?: string): Promise<bigint> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('votingEscrow'),
        'get_voting_power',
        { user: addr }
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting voting power:', error);
      throw error;
    }
  }

  /**
   * Get boosted balance (for vault APY boost)
   */
  async getBoostedBalance(address?: string): Promise<bigint> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('votingEscrow'),
        'get_boosted_balance',
        { user: addr }
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting boosted balance:', error);
      throw error;
    }
  }

  /**
   * Get boost multiplier
   */
  async getBoostMultiplier(address?: string): Promise<number> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('votingEscrow'),
        'get_boost_multiplier',
        { user: addr }
      );
      return Number(result);
    } catch (error) {
      console.error('Error getting boost multiplier:', error);
      throw error;
    }
  }

  /**
   * Get lock information
   */
  async getLockInfo(address?: string): Promise<LockInfo> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('votingEscrow'),
        'get_lock_info',
        { user: addr }
      );
      
      const [amount, startTime, endTime] = result;
      const votingPower = await this.getVotingPower(addr);
      const boostedBalance = await this.getBoostedBalance(addr);
      const boostMultiplier = await this.getBoostMultiplier(addr);

      return {
        amount: BigInt(amount),
        startTime: Number(startTime),
        endTime: Number(endTime),
        votingPower,
        boostedBalance,
        boostMultiplier
      };
    } catch (error) {
      console.error('Error getting lock info:', error);
      throw error;
    }
  }

  /**
   * Delegate voting power to another address
   */
  async delegateVotes(to: string, amount: bigint): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('votingEscrow'),
      'delegate',
      {
        from: this.keypair.publicKey(),
        to: to,
        amount: amount.toString()
      }
    );

    return this.signTransaction(transaction);
  }

  // ===== Staking Functions =====

  /**
   * Stake governance tokens
   */
  async stake(amount: bigint): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('staking'),
      'stake',
      {
        user: this.keypair.publicKey(),
        amount: amount.toString()
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Unstake governance tokens
   */
  async unstake(amount: bigint): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('staking'),
      'unstake',
      {
        user: this.keypair.publicKey(),
        amount: amount.toString()
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Claim staking rewards
   */
  async claimRewards(): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('staking'),
      'claim_rewards',
      {
        user: this.keypair.publicKey()
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Get pending rewards
   */
  async getPendingRewards(address?: string): Promise<bigint> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('staking'),
        'pending_rewards',
        { user: addr }
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting pending rewards:', error);
      throw error;
    }
  }

  /**
   * Get stake balance
   */
  async getStakeBalance(address?: string): Promise<bigint> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('staking'),
        'get_stake_balance',
        { user: addr }
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting stake balance:', error);
      throw error;
    }
  }

  // ===== Fee Distribution Functions =====

  /**
   * Claim fees for a specific week
   */
  async claimFees(week: number): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('feeDistributor'),
      'claim_week',
      {
        user: this.keypair.publicKey(),
        week: week
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Claim all available fees
   */
  async claimAllFees(): Promise<Transaction[]> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const currentWeek = Math.floor(Date.now() / 1000 / 604800);
    const transactions: Transaction[] = [];

    // Claim last 52 weeks
    for (let week = currentWeek - 51; week <= currentWeek; week++) {
      try {
        const tx = await this.claimFees(week);
        transactions.push(tx);
      } catch (error) {
        // Week may have already been claimed
        console.log(`Week ${week} already claimed or not available`);
      }
    }

    return transactions;
  }

  /**
   * Get claimable fees
   */
  async getClaimableFees(address?: string): Promise<bigint> {
    const addr = address || this.keypair?.publicKey();
    if (!addr) {
      throw new Error('Address required');
    }

    try {
      const result = await this.simulateCall(
        this.requireContractAddress('feeDistributor'),
        'get_claimable_fees',
        { user: addr }
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting claimable fees:', error);
      throw error;
    }
  }

  /**
   * Get total fees collected
   */
  async getTotalFeesCollected(): Promise<bigint> {
    try {
      const result = await this.simulateCall(
        this.requireContractAddress('feeDistributor'),
        'get_total_fees_collected',
        {}
      );
      return BigInt(result);
    } catch (error) {
      console.error('Error getting total fees:', error);
      throw error;
    }
  }

  // ===== Governance Functions =====

  /**
   * Create a new governance proposal
   */
  async createProposal(
    description: string,
    callData: CallData[],
    votingDuration: number = 3 * 24 * 60 * 60 // Default 3 days
  ): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    // Validate description length
    if (description.length > 280) {
      throw new Error('Proposal description too long (max 280 chars)');
    }

    // Check voting power threshold
    const votingPower = await this.getVotingPower();
    const threshold = BigInt('100000000'); // 100 tokens with 7 decimals
    
    if (votingPower < threshold) {
      throw new Error('Insufficient voting power to create proposal (minimum 100 tokens)');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'propose',
      {
        proposer: this.keypair.publicKey(),
        description: description,
        call_data: callData,
        voting_duration: votingDuration
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Cast a vote on a proposal
   */
  async castVote(
    proposalId: number,
    support: boolean,
    amount: bigint,
    reason?: string
  ): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    // Get voting power
    const votingPower = await this.getVotingPower();
    if (votingPower < amount) {
      throw new Error('Insufficient voting power');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'vote',
      {
        voter: this.keypair.publicKey(),
        proposal_id: proposalId,
        support: support,
        amount: amount.toString(),
        reason: reason || ''
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Queue a successful proposal for execution
   */
  async queueProposal(proposalId: number): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'queue',
      {
        proposal_id: proposalId
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Execute a queued proposal
   */
  async executeProposal(proposalId: number): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'execute',
      {
        proposal_id: proposalId
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Cancel a proposal
   */
  async cancelProposal(proposalId: number): Promise<Transaction> {
    if (!this.keypair) {
      throw new Error('Keypair required');
    }

    const transaction = await this.buildTransaction(
      this.requireContractAddress('governance'),
      'cancel',
      {
        proposal_id: proposalId
      }
    );

    return this.signTransaction(transaction);
  }

  /**
   * Get a proposal by ID
   */
  async getProposal(proposalId: number): Promise<GovernanceProposal> {
    try {
      const result = await this.simulateCall(
        this.requireContractAddress('governance'),
        'get_proposal',
        { proposal_id: proposalId }
      );

      const stateRaw = await this.simulateCall(
        this.requireContractAddress('governance'),
        'get_proposal_state',
        { proposal_id: proposalId }
      );

      const hasQuorum = await this.simulateCall(
        this.requireContractAddress('governance'),
        'has_quorum',
        { proposal_id: proposalId }
      );

      const hasPassed = await this.simulateCall(
        this.requireContractAddress('governance'),
        'has_passed',
        { proposal_id: proposalId }
      );

      return {
        id: proposalId,
        proposer: result.proposer,
        description: result.description,
        callData: result.call_data,
        votesFor: BigInt(result.votes_for),
        votesAgainst: BigInt(result.votes_against),
        eta: Number(result.eta),
        startTime: Number(result.start_time),
        endTime: Number(result.end_time),
        snapshotBlock: Number(result.snapshot_block),
        state: this.mapProposalState(stateRaw),
        forVoters: result.for_voters,
        againstVoters: result.against_voters,
        quorumReached: hasQuorum,
        passed: hasPassed
      };
    } catch (error) {
      console.error('Error getting proposal:', error);
      throw error;
    }
  }

  /**
   * Get all proposals
   */
  async getAllProposals(): Promise<GovernanceProposal[]> {
    const proposals: GovernanceProposal[] = [];
    const MAX_PROPOSALS = 1000;
    let consecutiveMisses = 0;

    for (let i = 0; i < MAX_PROPOSALS; i++) {
      try {
        const proposal = await this.getProposal(i);
        proposals.push(proposal);
        consecutiveMisses = 0;
      } catch (error) {
        consecutiveMisses++;
        if (consecutiveMisses >= 10) {
          break;
        }
      }
    }

    return proposals;
  }

  /**
   * Get proposals by state
   */
  async getProposalsByState(state: ProposalState): Promise<GovernanceProposal[]> {
    const allProposals = await this.getAllProposals();
    return allProposals.filter(p => p.state === state);
  }

  /**
   * Get active proposals
   */
  async getActiveProposals(): Promise<GovernanceProposal[]> {
    return this.getProposalsByState(ProposalState.Active);
  }

  /**
   * Get pending proposals
   */
  async getPendingProposals(): Promise<GovernanceProposal[]> {
    return this.getProposalsByState(ProposalState.Pending);
  }

  /**
   * Get executed proposals
   */
  async getExecutedProposals(): Promise<GovernanceProposal[]> {
    return this.getProposalsByState(ProposalState.Executed);
  }

  // ===== Protocol Parameter Functions =====

  /**
   * Get protocol parameters
   */
  async getProtocolParameters(): Promise<ProtocolParameters> {
    try {
      const [performanceFee, withdrawalFee, rebalanceThreshold, insuranceReserve] = await Promise.all([
        this.simulateCall(this.requireContractAddress('governance'), 'get_performance_fee', {}),
        this.simulateCall(this.requireContractAddress('governance'), 'get_withdrawal_fee', {}),
        this.simulateCall(this.requireContractAddress('governance'), 'get_rebalance_threshold', {}),
        this.simulateCall(this.requireContractAddress('governance'), 'get_insurance_reserve_target', {})
      ]);

      return {
        performanceFee: Number(performanceFee),
        withdrawalFee: Number(withdrawalFee),
        rebalanceThreshold: Number(rebalanceThreshold),
        insuranceReserveTarget: Number(insuranceReserve)
      };
    } catch (error) {
      console.error('Error getting protocol parameters:', error);
      throw error;
    }
  }

  /**
   * Create proposal to change protocol parameter
   */
  async proposeParameterChange(
    parameter: 'performance_fee' | 'withdrawal_fee' | 'rebalance_threshold' | 'insurance_reserve_target',
    newValue: number
  ): Promise<Transaction> {
    const callData: CallData[] = [{
      contractAddress: this.requireContractAddress('governance'),
      functionName: `set_${parameter}`,
      args: [newValue]
    }];

    const description = `Change ${parameter} to ${newValue}`;

    return this.createProposal(description, callData);
  }

  // ===== Helper Functions =====

  /**
   * Map raw state to ProposalState enum
   */
  private mapProposalState(state: number | string): ProposalState {
    const stateMap: Record<string, ProposalState> = {
      '0': ProposalState.Pending,
      '1': ProposalState.Active,
      '2': ProposalState.Canceled,
      '3': ProposalState.Defeated,
      '4': ProposalState.Succeeded,
      '5': ProposalState.Queued,
      '6': ProposalState.Expired,
      '7': ProposalState.Executed
    };

    return stateMap[String(state)] || ProposalState.Pending;
  }

  /**
   * Simulate a contract call
   */
  private async simulateCall(
    contractAddress: string,
    functionName: string,
    args: Record<string, any>
  ): Promise<any> {
    const contract = new Contract(contractAddress);

    const simResult = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(
          'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
        ),
        {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase
        }
      )
        .addOperation(
          contract.call(
            functionName,
            ...Object.entries(args).map(([, value]) => value)
          )
        )
        .build()
    );

    if (
      simResult.result &&
      (simResult.result as any).status === 'SUCCESS' &&
      (simResult.result as any).returnValue
    ) {
      return scValToNative((simResult.result as any).returnValue);
    }
    return null;
  }

  /**
   * Build a transaction for a contract call
   */
  private async buildTransaction(
    contractAddress: string,
    functionName: string,
    args: Record<string, any>
  ): Promise<Transaction> {
    const contract = new Contract(contractAddress);
    const account = await this.server.getAccount(this.keypair!.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase
    })
      .addOperation(
        contract.call(
          functionName,
          ...Object.entries(args).map(([, value]) => value)
        )
      )
      .setTimeout(180)
      .build();

    return tx;
  }

  /**
   * Sign a transaction
   */
  private signTransaction(transaction: Transaction): Transaction {
    if (!this.keypair) {
      throw new Error('Keypair required for signing');
    }

    transaction.sign(this.keypair);
    return transaction;
  }
}

// ===== Standalone Functions =====

/**
 * Calculate voting power at a specific time
 */
export function calculateVotingPower(
  amount: bigint,
  lockEnd: number,
  currentTime: number,
  maxDuration: number = 4 * 365 * 24 * 60 * 60
): bigint {
  if (lockEnd <= currentTime) {
    return BigInt(0);
  }

  const remainingTime = lockEnd - currentTime;
  return amount * BigInt(remainingTime) / BigInt(maxDuration);
}

/**
 * Calculate boost multiplier
 */
export function calculateBoostMultiplier(
  lockDuration: number,
  maxDuration: number = 4 * 365 * 24 * 60 * 60
): number {
  const durationFactor = (lockDuration / maxDuration) * 10000;
  const boost = 10000 + (durationFactor * 1500 / 10000);
  return Math.min(boost, 2500); // Cap at 2.5x
}

/**
 * Format voting power for display
 */
export function formatVotingPower(votingPower: bigint, decimals: number = 7): string {
  const divisor = BigInt(10 ** decimals);
  const whole = votingPower / divisor;
  const fractional = votingPower % divisor;
  return `${whole}.${fractional.toString().padStart(decimals, '0')}`;
}

/**
 * Format basis points to percentage
 */
export function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

/**
 * Check if a proposal has passed
 */
export function hasProposalPassed(
  votesFor: bigint,
  votesAgainst: bigint,
  totalSupply: bigint,
  quorumPercentage: number = 400
): { passed: boolean; quorumReached: boolean } {
  const totalVotes = votesFor + votesAgainst;
  const quorumRequired = (totalSupply * BigInt(quorumPercentage)) / BigInt(10000);
  
  return {
    quorumReached: totalVotes >= quorumRequired,
    passed: totalVotes >= quorumRequired && votesFor > votesAgainst
  };
}

/**
 * Get time remaining until lock expiry
 */
export function getTimeUntilExpiry(lockEnd: number, currentTime: number = Math.floor(Date.now() / 1000)): number {
  return Math.max(0, lockEnd - currentTime);
}

/**
 * Format time duration
 */
export function formatDuration(seconds: number): string {
  const years = Math.floor(seconds / (365 * 24 * 60 * 60));
  const days = Math.floor((seconds % (365 * 24 * 60 * 60)) / (24 * 60 * 60));
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));

  if (years > 0) return `${years}y ${days}d`;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
}

// ===== Constants Export =====

export const GOVERNANCE_CONSTANTS = {
  // Token distribution
  COMMUNITY_ALLOCATION: 0.5,
  TEAM_ALLOCATION: 0.2,
  TREASURY_ALLOCATION: 0.2,
  LIQUIDITY_MINING_ALLOCATION: 0.1,

  // Governance parameters
  QUORUM_PERCENTAGE: 4, // 4%
  TIMELOCK_DELAY: 2 * 24 * 60 * 60, // 2 days in seconds
  PROPOSAL_THRESHOLD: BigInt('100000000'), // 100 tokens

  // Lock duration
  MIN_LOCK_DURATION: 7 * 24 * 60 * 60, // 1 week
  MAX_LOCK_DURATION: 4 * 365 * 24 * 60 * 60, // 4 years

  // Boost parameters
  MAX_BOOST_MULTIPLIER: 2.5, // 2.5x

  // Fee ranges
  MIN_PERFORMANCE_FEE: 5, // 5%
  MAX_PERFORMANCE_FEE: 15, // 15%
  MIN_WITHDRAWAL_FEE: 0.1, // 0.1%
  MAX_WITHDRAWAL_FEE: 1, // 1%

  // Emergency multisig
  EMERGENCY_REQUIRED_SIGNATURES: 3,
  EMERGENCY_TOTAL_SIGNERS: 5
};

// ===== Default export =====
export default GovernanceSDK;
