import { Address, Transaction } from "stellar-sdk";

// Vault Types
export interface VaultInfo {
  name: string;
  tokenA: Address | string;
  tokenB: Address | string;
  poolId: Address | string;
  strategyId: number;
  feeRate: number; // Basis points (100 = 1%)
  harvestFee: number; // Basis points
  withdrawalFee: number; // Basis points
}

export interface UserPosition {
  shares: bigint;
  lastHarvest: number;
  depositedAmountA: bigint;
  depositedAmountB: bigint;
}

export interface VaultMetrics {
  totalShares: bigint;
  totalAmountA: bigint;
  totalAmountB: bigint;
  apy: number; // Basis points
  tvl: bigint; // Total Value Locked in USD (scaled)
  lastHarvest: number;
}

/**
 * Reason a vault is paused. Used by `VaultClient` status reads.
 */
export type PauseReason = "admin" | "emergency" | "maintenance" | "unknown";

/**
 * Read-only view of a contract instance's configuration, as exposed by the
 * upgrade/deployment read APIs. Fields that a contract has not yet been
 * configured with are `null` rather than placeholder values.
 */
export interface ContractInstanceConfig {
  /** Contract ID (C-string). Empty string means the instance is not deployed. */
  contractId: string;
  /** Hash of the currently installed WASM, or null if unknown. */
  wasmHash: string | null;
  /** Version reported by the contract, or null if the contract has none. */
  version: number | null;
  /** Whether the instance is paused. */
  paused: boolean;
  /** Admin contract/account ID (C- or G-string) that controls upgrades, or null if unset. */
  admin: Address | string | null;
  /** Pending upgrade WASM hash awaiting activation, or null if none. */
  pendingUpgradeHash: string | null;
}

/**
 * Result of a read-only configuration query. Failures are reported in the
 * result instead of thrown so dashboards can render partial state.
 */
export type ContractInstanceConfigResult =
  | { ok: true; config: ContractInstanceConfig }
  | { ok: false; error: string; code: string };

export interface DepositParams {
  amountA: bigint;
  amountB: bigint;
  minShares: bigint;
}

export interface WithdrawParams {
  shares: bigint;
  minAmountA: bigint;
  minAmountB: bigint;
}

// Rebalance Engine Types
export interface PoolAllocation {
  poolId: Address;
  tokenA: Address;
  tokenB: Address;
  allocationPercent: number; // Basis points (10000 = 100%)
  targetApy: number; // Basis points
  currentApy: number; // Basis points
  impermanentLossRisk: number; // Basis points
}

export interface RebalanceStrategy {
  strategyId: number;
  name: string;
  riskLevel: number; // 1=Conservative, 2=Balanced, 3=Aggressive
  minApyThreshold: number; // Basis points
  maxIlRisk: number; // Basis points
  rebalanceFrequency: number; // Seconds
  allocations: PoolAllocation[];
}

export interface RebalanceProposal {
  fromPool: Address;
  toPool: Address;
  amountA: bigint;
  amountB: bigint;
  expectedApyImprovement: number; // Basis points
  estimatedGasCost: bigint;
  timestamp: number;
}

export interface RebalanceHistory {
  timestamp: number;
  fromPool: Address;
  toPool: Address;
  amountMoved: bigint;
  apyBefore: number;
  apyAfter: number;
  success: boolean;
}

export interface PoolApyRecord {
  apyBps: number;
  updatedAt: number;
  updatedBy: string;
}

// Reward Distributor Types
export interface RewardToken {
  tokenAddress: Address;
  symbol: string;
  decimals: number;
  weight: number; // Weight for distribution (basis points)
}

export interface RewardDistribution {
  vaultAddress: Address;
  totalRewards: Map<Address, bigint>; // token_address -> amount
  distributionTimestamp: number;
  merkleRoot: Buffer;
}

export interface UserRewardClaim {
  user: Address;
  vaultAddress: Address;
  rewards: Map<Address, bigint>; // token_address -> amount
  proof: Buffer[];
  claimed: boolean;
  claimTimestamp: number;
}

export interface RewardConfig {
  distributionFrequency: number; // Seconds between distributions
  claimDeadline: number; // Seconds after distribution when claims expire
  feeRate: number; // Fee rate for claiming rewards (basis points)
  minRewardAmount: bigint; // Minimum amount to claim
}

// Strategy Registry Types
export interface YieldStrategy {
  strategyId: number;
  name: string;
  description: string;
  creator: Address;
  riskLevel: number; // 1=Conservative, 2=Balanced, 3=Aggressive
  minInvestment: bigint;
  maxInvestment: bigint;
  feeStructure: FeeStructure;
  performanceHistory: PerformanceRecord[];
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FeeStructure {
  managementFee: number; // Annual fee in basis points
  performanceFee: number; // Performance fee in basis points
  depositFee: number; // Deposit fee in basis points
  withdrawalFee: number; // Withdrawal fee in basis points
}

export interface PerformanceRecord {
  timestamp: number;
  totalValue: bigint;
  netApy: number; // Net APY after fees
  volatility: number; // Volatility measure in basis points
  sharpeRatio: number; // Sharpe ratio scaled by 10000
}

export interface StrategyParameters {
  targetTokens: Address[];
  allocationWeights: number[]; // Corresponding weights in basis points
  rebalanceThreshold: number; // Rebalance when allocation deviates by this much
  impermanentLossLimit: number; // Maximum acceptable IL in basis points
  minApyTarget: number; // Minimum APY target in basis points
}

export interface StrategyApproval {
  strategyId: number;
  approvedBy: Address;
  approvedAt: number;
  approvalType: number; // 1=Initial, 2=Update, 3=Removal
  comments: string;
}

// Pool and Market Types
export interface PoolInfo {
  id: Address;
  tokenA: Address;
  tokenB: Address;
  reserveA: bigint;
  reserveB: bigint;
  totalLiquidity: bigint;
  feeRate: number;
  apy: number;
  volume24h: bigint;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  price: number; // USD price
}

export interface PriceData {
  tokenA: number;
  tokenB: number;
  timestamp: number;
}

// Calculation Types
export interface ImpermanentLossData {
  currentPriceRatio: number;
  initialPriceRatio: number;
  ilPercent: number;
  timeElapsed: number;
}

export interface ApyProjection {
  projectedApy: number;
  confidence: number; // 0-100
  timeHorizon: number; // Days
  factors: string[];
}

export interface FeeRevenue {
  harvestFees: bigint;
  withdrawalFees: bigint;
  managementFees: bigint;
  performanceFees: bigint;
  totalFees: bigint;
}

// Arbitrage Strategy Types
export interface ArbitrageThresholds {
  minApyDelta: number; // Minimum APY difference to trigger rebalance (basis points)
  maxIlTolerance: number; // Maximum acceptable IL (basis points)
  cooldownPeriod: number; // Seconds between rebalances per vault
  lastRebalanceTime: number; // Timestamp of last rebalance
}

export interface RiskAssessment {
  poolId: Address;
  impermanentLossRisk: number; // Basis points
  estimatedSlippage: number; // Basis points
  volatilityScore: number; // 0-100
  /** Position-size multiplier in basis points. Range: 5000–10000; 10000 = full size. */
  positionSizeMultiplierBps: number;
  circuitBreakerTriggered: boolean;
  timestamp: number;
}

export interface VolatilityMetrics {
  priceCorrelation: number; // -10000 to 10000 (percentage)
  volatility24h: number; // Basis points
  volatility7d: number; // Basis points
}

export interface ArbitrageOpportunity {
  poolId: Address;
  currentApy: number; // Basis points
  projectedApy: number; // Basis points after rebalance
  ilRisk: number; // Basis points
  netProfit: bigint; // In native token units
  apyDelta: number; // Difference in basis points
  recommended: boolean;
}

export interface RebalanceResult {
  timestamp: number;
  success: boolean;
  opportunity?: ArbitrageOpportunity;
  profit?: bigint;
  message: string;
}

// Transaction Types
export interface TransactionOptions {
  gasLimit?: number;
  gasPrice?: number;
  timeout?: number;
  skipConfirmation?: boolean;
}

// Vault Client Options
export interface VaultClientOptions {
  /**
   * Public key of the account used as the source for read-only
   * `simulateTransaction` queries (e.g. the caller's own address).
   * Defaults to a freshly generated test account.
   */
  simulationSource?: string;
}

export interface TransactionResult {
  hash: string;
  success: boolean;
  gasUsed: number;
  error?: string;
  events?: any[];
}

// Configuration Types
export interface NetworkConfig {
  network: "testnet" | "mainnet" | "futurenet";
  horizonUrl: string;
  sorobanRpcUrl: string;
  /**
   * Deployed contract IDs (C-strings) for the engine contracts.
   *
   * Clients treat an empty string as "not configured". Callers that still
   * hold `Address` instances may pass them directly via `Address.toString()`.
   */
  contracts: {
    yieldEngine: string;
    rewardDistributor: string;
    rebalanceEngine: string;
    strategyRegistry: string;
  };
}

/**
 * Async wallet signer, e.g. a Freighter-backed signer.
 *
 * Passed anywhere the SDK accepts `Keypair | TransactionSigner`. The SDK
 * detects the shape by the presence of `signTransaction`, so a `Keypair`
 * never has to implement this interface.
 */
export interface TransactionSigner {
  /** Resolve the signer's account address. */
  getPublicKey(): Promise<string>;
  /** Sign `transaction` for `networkPassphrase` and return the signed tx. */
  signTransaction(
    transaction: Transaction,
    networkPassphrase: string,
  ): Promise<Transaction>;
}

export type VaultClientConfig = Pick<
  NetworkConfig,
  "network" | "sorobanRpcUrl"
>;

export interface VaultConfig {
  vaultAddress: Address;
  tokenA: Address;
  tokenB: Address;
  slippageTolerance: number; // Basis points
  minLiquidity: bigint;
  maxSlippage: number; // Basis points
}

// Error Types
export class VaultError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export class RebalanceError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "RebalanceError";
  }
}

export class RewardError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "RewardError";
  }
}

export class StrategyError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "StrategyError";
  }
}

// Utility Types
export type RiskLevel = "conservative" | "balanced" | "aggressive";
export type ApprovalType = "initial" | "update" | "removal";

export interface TimeInterval {
  start: number;
  end: number;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

// Performance History Types (Issue #128)

/**
 * A snapshot of vault performance at a point in time, derived from harvest
 * events. Used by `VaultClient.getPerformanceHistory()`.
 */
export interface PerformanceSnapshot {
  /** Unix timestamp (seconds) when the snapshot was recorded */
  timestamp: number;
  /** APY in basis points at the time of the snapshot */
  apy: number;
  /** Total value locked at the time of the snapshot */
  tvl: bigint;
  /** Amount harvested in this event (in smallest token units) */
  harvestAmount: bigint;
}

/**
 * A single raw harvest event returned by `VaultClient.getHarvestHistory()`.
 */
export interface HarvestEvent {
  /** Unix timestamp (seconds) of the harvest */
  timestamp: number;
  /** Total rewards collected during this harvest */
  rewardsHarvested: bigint;
  /** Gas units consumed by this harvest transaction */
  gasUsed: number;
  /** Transaction hash of the harvest */
  txHash: string;
}

/**
 * An impermanent loss snapshot derived from on-chain price data.
 * Returned by `VaultClient.getILHistory()`.
 */
export interface ILSnapshot {
  /** Unix timestamp (seconds) of the snapshot */
  timestamp: number;
  /** Impermanent loss in basis points */
  ilBps: number;
}
