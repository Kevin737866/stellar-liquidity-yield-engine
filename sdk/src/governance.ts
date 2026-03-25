/**
 * Governance SDK Module
 * 
 * Provides JavaScript/TypeScript interface for the Stellar Yield Governance system.
 * Handles proposal creation, voting, fee claiming, and token delegation.
 */

import { Server, Keypair, Transaction, xdr, scValToNative, nativeToScVal } from 'stellar-sdk';
import { Contract } from './types';

// ===== Configuration =====
const GOVERNANCE_CONTRACT_ADDRESS = process.env.GOVERNANCE_CONTRACT || 'GOV_TOKEN_CONTRACT_ADDRESS';
const VOTING_ESCROW_CONTRACT_ADDRESS = process.env.VOTING_ESCROW_CONTRACT || 'VE_TOKEN_CONTRACT_ADDRESS';
const STAKING_CONTRACT_ADDRESS = process.env.STAKING_CONTRACT || 'STAKING_CONTRACT_ADDRESS';
const FEE_DISTRIBUTOR_CONTRACT_ADDRESS = process.env.FEE_DISTRIBUTOR_CONTRACT || 'FEE_DISTRIBUTOR_ADDRESS';

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
  private server: Server;
  private networkPassphrase: string;
  private keypair?: Keypair;

  constructor(
    server: Server,
    networkPassphrase: string,
    keypair?: Keypair
  ) {
    this.server = server;
    this.networkPassphrase = networkPassphrase;
    this.keypair = keypair;
  }

  /**
   * Set the keypair for signing transactions
   */
  setKeypair(keypair: Keypair): void {
    this.keypair = keypair;
  }

  // ===== Token Functions =====

  /**
   * Get governance token balance
   */
  async getTokenBalance(address: string): Promise<bigint> {
    try {
      const result = await this.simulateCall(
        GOVERNANCE_CONTRACT_ADDRESS,
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
        GOVERNANCE_CONTRACT_ADDRESS,
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
      GOVERNANCE_CONTRACT_ADDRESS,
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
      GOVERNANCE_CONTRACT_ADDRESS,
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
      VOTING_ESCROW_CONTRACT_ADDRESS,
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
      VOTING_ESCROW_CONTRACT_ADDRESS,
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
      VOTING_ESCROW_CONTRACT_ADDRESS,
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
      VOTING_ESCROW_CONTRACT_ADDRESS,
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
        VOTING_ESCROW_CONTRACT_ADDRESS,
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
        VOTING_ESCROW_CONTRACT_ADDRESS,
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
        VOTING_ESCROW_CONTRACT_ADDRESS,
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
        VOTING_ESCROW_CONTRACT_ADDRESS,
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
      VOTING_ESCROW_CONTRACT_ADDRESS,
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
      STAKING_CONTRACT_ADDRESS,
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
      STAKING_CONTRACT_ADDRESS,
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
      STAKING_CONTRACT_ADDRESS,
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
        STAKING_CONTRACT_ADDRESS,
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
        STAKING_CONTRACT_ADDRESS,
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
      FEE_DISTRIBUTOR_CONTRACT_ADDRESS,
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
        FEE_DISTRIBUTOR_CONTRACT_ADDRESS,
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
        FEE_DISTRIBUTOR_CONTRACT_ADDRESS,
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
      GOVERNANCE_CONTRACT_ADDRESS,
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
      GOVERNANCE_CONTRACT_ADDRESS,
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
    const transaction = await this.buildTransaction(
      GOVERNANCE_CONTRACT_ADDRESS,
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
    const transaction = await this.buildTransaction(
      GOVERNANCE_CONTRACT_ADDRESS,
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
    const transaction = await this.buildTransaction(
      GOVERNANCE_CONTRACT_ADDRESS,
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
        GOVERNANCE_CONTRACT_ADDRESS,
        'get_proposal',
        { proposal_id: proposalId }
      );

      const stateRaw = await this.simulateCall(
        GOVERNANCE_CONTRACT_ADDRESS,
        'get_proposal_state',
        { proposal_id: proposalId }
      );

      const hasQuorum = await this.simulateCall(
        GOVERNANCE_CONTRACT_ADDRESS,
        'has_quorum',
        { proposal_id: proposalId }
      );

      const hasPassed = await this.simulateCall(
        GOVERNANCE_CONTRACT_ADDRESS,
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
    try {
      const count = await this.simulateCall(
        GOVERNANCE_CONTRACT_ADDRESS,
        'get_proposal_count',
        {}
      );

      const proposals: GovernanceProposal[] = [];
      const proposalCount = Number(count);

      for (let i = 1; i <= proposalCount; i++) {
        try {
          const proposal = await this.getProposal(i);
          proposals.push(proposal);
        } catch (error) {
          console.error(`Error fetching proposal ${i}:`, error);
        }
      }

      return proposals;
    } catch (error) {
      console.error('Error getting all proposals:', error);
      throw error;
    }
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
        this.simulateCall(GOVERNANCE_CONTRACT_ADDRESS, 'get_performance_fee', {}),
        this.simulateCall(GOVERNANCE_CONTRACT_ADDRESS, 'get_withdrawal_fee', {}),
        this.simulateCall(GOVERNANCE_CONTRACT_ADDRESS, 'get_rebalance_threshold', {}),
        this.simulateCall(GOVERNANCE_CONTRACT_ADDRESS, 'get_insurance_reserve_target', {})
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
      contractAddress: GOVERNANCE_CONTRACT_ADDRESS,
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
    // This would use Soroban-RPC simulateTransaction in production
    // Placeholder for SDK simulation
    const account = await this.server.loadAccount(this.keypair!.publicKey());
    
    const transaction = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase
    })
      .addOperation(Operation.contractInvoke({
        contract: contractAddress,
        method: functionName,
        args: Object.entries(args).map(([key, value]) => 
          new xdr.ScVal(xdr.ScValType.scvMap([])) // Simplified
        )
      }))
      .setTimeout(30)
      .build();

    try {
      const result = await this.server.simulateTransaction(transaction);
      if (result.results && result.results.length > 0) {
        return scValToNative(result.results[0].retval);
      }
      return null;
    } catch (error) {
      console.log('Simulation call failed, returning mock data');
      return null;
    }
  }

  /**
   * Build a transaction for a contract call
   */
  private async buildTransaction(
    contractAddress: string,
    functionName: string,
    args: Record<string, any>
  ): Promise<Transaction> {
    const account = await this.server.loadAccount(this.keypair!.publicKey());

    const operation = Operation.contractInvoke({
      contract: contractAddress,
      method: functionName,
      args: Object.entries(args).map(([key, value]) => 
        nativeToScVal(value)
      )
    });

    const transaction = new TransactionBuilder(account, {
      fee: '5000', // 0.005 XLM
      networkPassphrase: this.networkPassphrase
    })
      .addOperation(operation)
      .setTimeout(180) // 3 minutes
      .build();

    return transaction;
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
