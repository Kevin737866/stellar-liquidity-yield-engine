/**
 * Governance SDK Module
 * 
 * Provides JavaScript/TypeScript interface for the Stellar Yield Governance system.
 * Handles proposal creation, voting, fee claiming, and token delegation.
 */

import { simulationReturnValue } from './utils/soroban';
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
 * Deployed contract IDs used by {@link GovernanceSDK}.
 *
 * Every field is optional; an unconfigured deployment simply leaves the
 * corresponding calls unusable, which is surfaced as an explicit error rather
 * than a fabricated placeholder address.
 */
export interface GovernanceContracts {
  /** Governance token + proposal registry. */
  governance: string;
  /** Voting escrow (lock) contract. */
  votingEscrow: string;
  /** Staking / rewards contract. */
  staking: string;
  /** Fee distributor contract. */
  feeDistributor: string;
}

/**
 * Placeholder IDs reported when a contract has not been configured. These are
 * deliberately not valid addresses so a misconfigured deployment fails loudly
 * instead of silently targeting some other contract.
 */
const UNCONFIGURED_CONTRACT = 'UNCONFIGURED';

/**
 * Contract IDs read from the environment, used only as a fallback for callers
 * that do not inject their own (e.g. Node scripts and the examples).
 *
 * Browser bundles cannot read server-side environment variables, so UI callers
 * must pass `contracts` to the {@link GovernanceSDK} constructor instead.
 */
export const DEFAULT_GOVERNANCE_CONTRACTS: GovernanceContracts = {
  governance: process.env.GOVERNANCE_CONTRACT || UNCONFIGURED_CONTRACT,
  votingEscrow: process.env.VOTING_ESCROW_CONTRACT || UNCONFIGURED_CONTRACT,
  staking: process.env.STAKING_CONTRACT || UNCONFIGURED_CONTRACT,
  feeDistributor: process.env.FEE_DISTRIBUTOR_CONTRACT || UNCONFIGURED_CONTRACT,
};

/** True when `contractId` is a usable, explicitly configured contract ID. */
export function isContractConfigured(contractId: string | undefined | null): boolean {
  return typeof contractId === 'string' && contractId.length > 0 && contractId !== UNCONFIGURED_CONTRACT;
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

/** Default number of proposals returned per history page. */
export const GOVERNANCE_PAGE_SIZE = 25;

/** Largest page size accepted by {@link paginateProposals}. */
export const GOVERNANCE_MAX_PAGE_SIZE = 100;

/**
 * One bounded slice of the governance proposal history.
 *
 * Pages are 1-based. `totalPages` is 0 for an empty history and out-of-range
 * pages are clamped to the last page so callers never render a blank page.
 */
export interface ProposalPage {
  items: GovernanceProposal[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

function assertProposalPagination(page: number, pageSize: number): void {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError('Proposal page must be an integer greater than or equal to 1');
  }
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > GOVERNANCE_MAX_PAGE_SIZE
  ) {
    throw new RangeError(
      `Proposal page size must be an integer between 1 and ${GOVERNANCE_MAX_PAGE_SIZE}`
    );
  }
}

/**
 * Slice a proposal history into pages without mutating the input array.
 * Validation is exported through {@link GovernanceSDK.getProposalPage} too, so
 * UI callers get the same boundary behavior against a live deployment.
 */
export function paginateProposals(
  proposals: GovernanceProposal[],
  page: number = 1,
  pageSize: number = GOVERNANCE_PAGE_SIZE
): ProposalPage {
  assertProposalPagination(page, pageSize);

  const total = proposals.length;
  const totalPages = Math.ceil(total / pageSize);
  const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;

  return {
    items: proposals.slice(start, start + pageSize),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrevious: currentPage > 1,
  };
}

/**
 * One account's governance participation across a proposal history.
 *
 * `eligibleProposals` counts the proposals whose voting window has opened
 * (anything other than `Pending`), because a pending proposal cannot have been
 * voted on yet. `participationRate` is `proposalsVoted / eligibleProposals` as
 * a percentage with one decimal, and is 0 when there is nothing eligible.
 */
export interface GovernanceParticipationSummary {
  account: string;
  /** Proposals examined. */
  totalProposals: number;
  /** Proposals that reached a voting window. */
  eligibleProposals: number;
  /** Distinct proposals this account voted on, for or against. */
  proposalsVoted: number;
  /** Proposals this account cast a for-vote on. */
  votesFor: number;
  /** Proposals this account cast an against-vote on. */
  votesAgainst: number;
  /** Sum of the voting power committed across every vote. */
  votingPowerUsed: bigint;
  /** Participation percentage (0-100) over `eligibleProposals`. */
  participationRate: number;
  /** Proposals this account authored. */
  proposalsCreated: number;
  /** IDs of the proposals this account voted on, ascending by history order. */
  votedProposalIds: number[];
}

/**
 * `scValToNative` surfaces voter maps as either a JS `Map` or a plain object
 * depending on the SDK version, so both shapes are accepted here.
 */
type VoterWeights = Record<string, bigint> | Map<string, bigint> | null | undefined;

/**
 * Normalize a raw voter weight. Values that do not look like an integer
 * amount are treated as a zero-weight vote rather than throwing, because a
 * single malformed entry must not take down a whole participation report.
 */
function toVotingWeight(raw: unknown): bigint {
  if (typeof raw === 'bigint') {
    return raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return BigInt(Math.trunc(raw));
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return BigInt(raw.trim());
  }
  return 0n;
}

/**
 * Read one account's weight out of a proposal's voter map. Returns `undefined`
 * when the account is absent, which is what distinguishes "did not vote" from
 * "voted with zero weight".
 */
function readVoterWeight(voters: VoterWeights, account: string): bigint | undefined {
  if (voters === null || voters === undefined) {
    return undefined;
  }
  if (voters instanceof Map) {
    return voters.has(account) ? toVotingWeight(voters.get(account)) : undefined;
  }
  if (typeof voters === 'object') {
    const record = voters as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, account)) {
      return undefined;
    }
    return toVotingWeight(record[account]);
  }
  return undefined;
}

/**
 * Summarize one account's participation over a proposal history.
 *
 * This is pure so callers can reuse a proposal list they already hold (the UI
 * does) without another RPC sweep. An account that appears in both voter maps
 * of a proposal - which a re-vote can produce - is counted once toward
 * `proposalsVoted` but its weight is counted on both sides.
 *
 * @throws TypeError when `account` is empty or `proposals` is not an array.
 */
export function summarizeGovernanceParticipation(
  account: string,
  proposals: readonly GovernanceProposal[]
): GovernanceParticipationSummary {
  if (typeof account !== 'string' || account.trim().length === 0) {
    throw new TypeError(
      'Governance participation summary requires a non-empty account address'
    );
  }
  if (!Array.isArray(proposals)) {
    throw new TypeError('Governance participation summary requires an array of proposals');
  }

  const address = account.trim();
  let eligibleProposals = 0;
  let proposalsVoted = 0;
  let votesFor = 0;
  let votesAgainst = 0;
  let proposalsCreated = 0;
  let votingPowerUsed = 0n;
  const votedProposalIds: number[] = [];

  for (const proposal of proposals) {
    if (proposal.state !== ProposalState.Pending) {
      eligibleProposals += 1;
    }
    if (proposal.proposer === address) {
      proposalsCreated += 1;
    }

    const forWeight = readVoterWeight(proposal.forVoters, address);
    const againstWeight = readVoterWeight(proposal.againstVoters, address);
    if (forWeight === undefined && againstWeight === undefined) {
      continue;
    }

    proposalsVoted += 1;
    votedProposalIds.push(proposal.id);
    if (forWeight !== undefined) {
      votesFor += 1;
      votingPowerUsed += forWeight;
    }
    if (againstWeight !== undefined) {
      votesAgainst += 1;
      votingPowerUsed += againstWeight;
    }
  }

  return {
    account: address,
    totalProposals: proposals.length,
    eligibleProposals,
    proposalsVoted,
    votesFor,
    votesAgainst,
    votingPowerUsed,
    participationRate:
      eligibleProposals === 0
        ? 0
        : Math.round((proposalsVoted / eligibleProposals) * 1000) / 10,
    proposalsCreated,
    votedProposalIds,
  };
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
 * Result of submitting a signed transaction.
 */
export interface SubmittedTransaction {
  hash: string;
  success: boolean;
  /** Ledger the transaction was included in, once known. */
  ledger?: number;
  /** Why it did not succeed, when `success` is false. */
  error?: string;
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
  private governanceContractId: string;
  private votingEscrowContractId: string;
  private stakingContractId: string;
  private feeDistributorContractId: string;

  /**
   * @param sorobanRpcUrl Soroban RPC endpoint for the target network.
   * @param networkPassphrase Network passphrase used to build and sign txs.
   * @param keypair Optional signer. Read-only calls work without one.
   * @param contracts Optional contract ID overrides. Anything omitted falls
   *   back to `DEFAULT_GOVERNANCE_CONTRACTS` (environment-driven). Browser
   *   callers must pass these explicitly since they cannot read `process.env`.
   */
  constructor(
    sorobanRpcUrl: string,
    networkPassphrase: string,
    keypair?: Keypair,
    contracts: Partial<GovernanceContracts> = {}
  ) {
    this.server = new SorobanRpc.Server(sorobanRpcUrl);
    this.networkPassphrase = networkPassphrase;
    this.keypair = keypair;
    this.governanceContractId = contracts.governance || DEFAULT_GOVERNANCE_CONTRACTS.governance;
    this.votingEscrowContractId = contracts.votingEscrow || DEFAULT_GOVERNANCE_CONTRACTS.votingEscrow;
    this.stakingContractId = contracts.staking || DEFAULT_GOVERNANCE_CONTRACTS.staking;
    this.feeDistributorContractId = contracts.feeDistributor || DEFAULT_GOVERNANCE_CONTRACTS.feeDistributor;
  }

  /**
   * Contract IDs this client is pointed at. Useful for diagnostics and for
   * callers that need to confirm a deployment is fully configured.
   */
  getContracts(): GovernanceContracts {
    return {
      governance: this.governanceContractId,
      votingEscrow: this.votingEscrowContractId,
      staking: this.stakingContractId,
      feeDistributor: this.feeDistributorContractId,
    };
  }

  /**
   * Rotate a single protocol contract address at runtime (e.g. after a
   * governance-approved upgrade). Only the named role is changed; all other
   * roles keep their current values. The new ID must be a configured value.
   *
   * @throws if `contractId` is not a configured (non-placeholder) address.
   */
  rotateContract(role: keyof GovernanceContracts, contractId: string): void {
    if (!isContractConfigured(contractId)) {
      throw new Error(
        `rotateContract: refusing to set "${role}" to an unconfigured contract ID`
      );
    }
    switch (role) {
      case 'governance':
        this.governanceContractId = contractId;
        break;
      case 'votingEscrow':
        this.votingEscrowContractId = contractId;
        break;
      case 'staking':
        this.stakingContractId = contractId;
        break;
      case 'feeDistributor':
        this.feeDistributorContractId = contractId;
        break;
      default:
        throw new Error(`rotateContract: unknown contract role "${String(role)}"`);
    }
  }

  // Validating accessors. Every call site reads the contract through these so
  // an unconfigured deployment fails with an actionable message instead of
  // constructing a `Contract` from a placeholder ID.
  private get governanceContract(): string {
    return this.requireContract(this.governanceContractId, 'governance');
  }

  private get votingEscrowContract(): string {
    return this.requireContract(this.votingEscrowContractId, 'votingEscrow');
  }

  private get stakingContract(): string {
    return this.requireContract(this.stakingContractId, 'staking');
  }

  private get feeDistributorContract(): string {
    return this.requireContract(this.feeDistributorContractId, 'feeDistributor');
  }

  /**
   * Resolve a contract ID, failing with an actionable message when the
   * deployment has not been configured for it.
   */
  private requireContract(contractId: string, role: keyof GovernanceContracts): string {
    if (!isContractConfigured(contractId)) {
      throw new Error(
        `Governance contract "${role}" is not configured. ` +
          `Pass contracts.${role} to the GovernanceSDK constructor (browser) ` +
          `or set the matching environment variable (Node).`
      );
    }
    return contractId;
  }

  /**
   * Set the keypair for signing transactions
   */
  setKeypair(keypair: Keypair): void {
    this.keypair = keypair;
  }

  /**
   * Safely rotate the signer used by this client.
   *
   * Validates the new keypair before swapping it in, so a failed rotation
   * never leaves the client without a usable signer. Returns the previous
   * signer (if any) so callers can confirm or roll back the rotation.
   *
   * Failure behaviour:
   * - `null` / `undefined` new keypair: throws, current signer is kept.
   * - Keypair that cannot produce a public key: throws, current signer is kept.
   * - Rotating to the same public key as the current signer: no-op, returns
   *   the current signer unchanged.
   */
  rotateKeypair(next: Keypair): Keypair | undefined {
    if (!next) {
      throw new Error('rotateKeypair: a new keypair is required');
    }
    let nextKey: string;
    try {
      nextKey = next.publicKey();
    } catch (error) {
      throw new Error(
        `rotateKeypair: supplied keypair is unusable: ${(error as Error).message}`
      );
    }
    const previous = this.keypair;
    if (previous && previous.publicKey() === nextKey) {
      return previous;
    }
    this.keypair = next;
    return previous;
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

  // ===== Token Functions =====

  /**
   * Get governance token balance
   */
  async getTokenBalance(address: string): Promise<bigint> {
    try {
      const result = await this.simulateCall(
        this.governanceContract,
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
        this.governanceContract,
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
      this.governanceContract,
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
      this.governanceContract,
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
      this.votingEscrowContract,
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
      this.votingEscrowContract,
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
      this.votingEscrowContract,
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
      this.votingEscrowContract,
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
        this.votingEscrowContract,
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
        this.votingEscrowContract,
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
        this.votingEscrowContract,
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
        this.votingEscrowContract,
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
      this.votingEscrowContract,
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
      this.stakingContract,
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
      this.stakingContract,
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
      this.stakingContract,
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
        this.stakingContract,
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
        this.stakingContract,
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
      this.feeDistributorContract,
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
        this.feeDistributorContract,
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
        this.feeDistributorContract,
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
      this.governanceContract,
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
      this.governanceContract,
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
      this.governanceContract,
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
      this.governanceContract,
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
      this.governanceContract,
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
        this.governanceContract,
        'get_proposal',
        { proposal_id: proposalId }
      );

      const stateRaw = await this.simulateCall(
        this.governanceContract,
        'get_proposal_state',
        { proposal_id: proposalId }
      );

      const hasQuorum = await this.simulateCall(
        this.governanceContract,
        'has_quorum',
        { proposal_id: proposalId }
      );

      const hasPassed = await this.simulateCall(
        this.governanceContract,
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
   *
   * @param maxProposals Highest proposal ID to probe. Defaults to 1000, which
   *   is the SDK's historical scan ceiling. Each probe is a separate
   *   `simulateTransaction`, so UI callers should pass a bound close to the
   *   real proposal count rather than paying for a 1000-ID sweep.
   */
  async getAllProposals(maxProposals: number = 1000): Promise<GovernanceProposal[]> {
    const proposals: GovernanceProposal[] = [];
    const MAX_PROPOSALS = maxProposals;
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
   * Get one page of governance proposal history.
   *
   * The page is sliced from the IDs returned by {@link getAllProposals}, so it
   * works against deployments that do not expose a paginated contract
   * entrypoint. `page` is 1-based; invalid bounds fail before any RPC call.
   */
  async getProposalPage(
    page: number = 1,
    pageSize: number = GOVERNANCE_PAGE_SIZE,
    maxProposals: number = 1000
  ): Promise<ProposalPage> {
    assertProposalPagination(page, pageSize);
    if (!Number.isSafeInteger(maxProposals) || maxProposals < 1) {
      throw new RangeError('maxProposals must be a positive integer');
    }

    const proposals = await this.getAllProposals(maxProposals);
    return paginateProposals(proposals, page, pageSize);
  }

  /**
   * Summarize one account's governance participation.
   *
   * Pass `options.proposals` to reuse a history the caller already fetched
   * (the UI does, to avoid a second RPC sweep); otherwise the history is read
   * through {@link getAllProposals}, bounded by `options.maxProposals`.
   * Invalid input fails before any RPC request.
   */
  async getParticipationSummary(
    account: string,
    options: { proposals?: GovernanceProposal[]; maxProposals?: number } = {}
  ): Promise<GovernanceParticipationSummary> {
    if (typeof account !== 'string' || account.trim().length === 0) {
      throw new TypeError(
        'Governance participation summary requires a non-empty account address'
      );
    }

    if (options.proposals !== undefined) {
      return summarizeGovernanceParticipation(account, options.proposals);
    }

    const maxProposals = options.maxProposals ?? 1000;
    if (!Number.isSafeInteger(maxProposals) || maxProposals < 1) {
      throw new RangeError('maxProposals must be a positive integer');
    }

    const proposals = await this.getAllProposals(maxProposals);
    return summarizeGovernanceParticipation(account, proposals);
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
        this.simulateCall(this.governanceContract, 'get_performance_fee', {}),
        this.simulateCall(this.governanceContract, 'get_withdrawal_fee', {}),
        this.simulateCall(this.governanceContract, 'get_rebalance_threshold', {}),
        this.simulateCall(this.governanceContract, 'get_insurance_reserve_target', {})
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
      contractAddress: this.governanceContract,
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

    if (!SorobanRpc.Api.isSimulationError(simResult)) {
      return scValToNative(simulationReturnValue(simResult));
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

  /**
   * Submit a signed transaction and wait for it to be included on chain.
   *
   * The build-and-sign helpers in this class return a signed `Transaction`
   * without sending it, so a caller that only uses those can appear to succeed
   * while nothing ever reaches the ledger. This is the missing half: it sends
   * the transaction and polls until the RPC confirms success or failure.
   *
   * @param transaction Signed transaction from one of this class's methods.
   * @param options.timeoutMs How long to wait for inclusion (default 60s).
   * @param options.pollIntervalMs Delay between polls (default 1s).
   */
  async submitTransaction(
    transaction: Transaction,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<SubmittedTransaction> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;

    const sendResult = await this.server.sendTransaction(transaction);
    const hash = sendResult.hash;

    if (sendResult.status === 'ERROR') {
      return {
        hash,
        success: false,
        error: 'The RPC rejected this transaction (status ERROR).',
      };
    }

    if (sendResult.status === 'TRY_AGAIN_LATER') {
      return {
        hash,
        success: false,
        error: 'The RPC asked us to retry later (status TRY_AGAIN_LATER).',
      };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const poll = await this.server.getTransaction(hash);

      if (poll.status === 'SUCCESS') {
        return { hash, success: true, ledger: poll.ledger };
      }
      if (poll.status === 'FAILED') {
        return {
          hash,
          success: false,
          ledger: poll.ledger,
          error: 'The transaction was included but failed on chain.',
        };
      }

      // NOT_FOUND: still waiting for the next ledger close.
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return {
      hash,
      success: false,
      error: `Timed out after ${timeoutMs}ms waiting for the transaction to be included.`,
    };
  }
}

// ===== Standalone Functions =====

/**
 * Decimals used by Stellar Asset Contract (SAC) tokens, which includes the
 * governance token. Vault LP tokens may use a different value, so callers
 * handling those must pass `decimals` explicitly.
 */
export const DEFAULT_TOKEN_DECIMALS = 7;

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
export function formatVotingPower(
  votingPower: bigint,
  decimals: number = DEFAULT_TOKEN_DECIMALS
): string {
  const divisor = BigInt(10 ** decimals);
  const whole = votingPower / divisor;
  const fractional = votingPower % divisor;
  return `${whole}.${fractional.toString().padStart(decimals, '0')}`;
}

/**
 * Format a base-unit amount for display, trimming trailing fractional zeros.
 *
 * Stellar governance tokens use 7 decimals, but vault LP tokens may use 18, so
 * every display site must be told which token it is rendering rather than
 * assuming 7. This is the display counterpart to {@link parseStroops}.
 *
 * @param amount Amount in the token's smallest unit.
 * @param decimals Token decimals (7 for governance tokens, 18 for some LP tokens).
 */
export function formatAmount(amount: bigint, decimals: number = DEFAULT_TOKEN_DECIMALS): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fractional = (magnitude % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fractional.length > 0 ? `${sign}${whole}.${fractional}` : `${sign}${whole}`;
}

/**
 * Parse a human-readable decimal string into a base-unit `bigint`.
 *
 * This is the missing inverse of {@link formatVotingPower} /
 * {@link formatAmount}. Amounts must never round-trip through
 * `parseFloat`/`Number`, because IEEE-754 doubles cannot represent 7-decimal
 * token amounts exactly: `BigInt(Math.floor(parseFloat('1.1') * 1e7))` yields
 * `10999999999` instead of `11000000`, and large balances silently lose
 * precision once they exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Parsing is done on the decimal string directly:
 * - thousands separators (`,`) and surrounding whitespace are ignored;
 * - `''`, `'.'` and `undefined`/`null` parse to `0n` (an empty amount input);
 * - digits beyond `decimals` are truncated, never rounded up, so a user can
 *   never be charged more than they typed;
 * - negative values and non-numeric input throw, since a negative token
 *   amount is never a valid user input.
 *
 * @param value Decimal amount as typed by a human, e.g. `'12.3456789'`.
 * @param decimals Token decimals (7 for governance tokens, 18 for some LP tokens).
 */
export function parseStroops(
  value: string | number | null | undefined,
  decimals: number = DEFAULT_TOKEN_DECIMALS
): bigint {
  if (value === null || value === undefined) return 0n;

  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot parse "${value}" as a token amount`);
    }
    text = numberToPlainDecimalString(value);
  } else {
    text = value.trim().replace(/,/g, '');
  }

  if (text === '' || text === '.') return 0n;

  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    throw new Error(
      `Cannot parse "${value}" as a token amount: expected a non-negative decimal number`
    );
  }

  const whole = match[1];
  let fraction = match[2] ?? '';

  // Truncate, never round, so the parsed amount is never larger than typed.
  if (fraction.length > decimals) {
    fraction = fraction.slice(0, decimals);
  }
  fraction = fraction.padEnd(decimals, '0');

  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(fraction === '' ? '0' : fraction);
}

/**
 * Expand a JS number's exponential notation (`1e-7`) into a plain decimal
 * string so `parseStroops` can process it without float arithmetic.
 */
function numberToPlainDecimalString(value: number): string {
  const text = String(value);

  const exponential = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!exponential) return text;

  const [, sign, intPart, fracPart = '', rawExponent] = exponential;
  const exponent = Number(rawExponent);
  const digits = intPart + fracPart;
  const pointIndex = intPart.length + exponent;

  if (pointIndex <= 0) {
    return `${sign}0.${'0'.repeat(-pointIndex)}${digits}`;
  }
  if (pointIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(pointIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
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
