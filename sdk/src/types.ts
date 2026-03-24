import { Address } from 'stellar-sdk';

// Vault Types
export interface VaultInfo {
  name: string;
  tokenA: Address;
  tokenB: Address;
  poolId: Address;
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

export interface TransactionResult {
  hash: string;
  success: boolean;
  gasUsed: number;
  error?: string;
  events?: any[];
}

// Configuration Types
export interface NetworkConfig {
  network: 'testnet' | 'mainnet' | 'futurenet';
  horizonUrl: string;
  sorobanRpcUrl: string;
  contracts: {
    yieldEngine: Address;
    rewardDistributor: Address;
    rebalanceEngine: Address;
    strategyRegistry: Address;
  };
}

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
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export class RebalanceError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'RebalanceError';
  }
}

export class RewardError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'RewardError';
  }
}

export class StrategyError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'StrategyError';
  }
}

// Utility Types
export type RiskLevel = 'conservative' | 'balanced' | 'aggressive';
export type ApprovalType = 'initial' | 'update' | 'removal';

export interface TimeInterval {
  start: number;
  end: number;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

// Event Types
export interface VaultEvent {
  type: 'deposit' | 'withdraw' | 'harvest' | 'pause' | 'unpause';
  vault: Address;
  user?: Address;
  amount?: bigint;
  timestamp: number;
  data?: any;
}

export interface RebalanceEvent {
  type: 'proposal' | 'execution' | 'failure';
  strategy: number;
  fromPool?: Address;
  toPool?: Address;
  amount?: bigint;
  timestamp: number;
  data?: any;
}

export interface RewardEvent {
  type: 'distribution' | 'claim' | 'expiry';
  vault: Address;
  user?: Address;
  amount?: bigint;
  timestamp: number;
  data?: any;
}
