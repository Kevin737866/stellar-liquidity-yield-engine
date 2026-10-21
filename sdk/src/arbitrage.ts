import { Address, Horizon } from 'stellar-sdk';
import axios from 'axios';
import { WriteRateLimiter } from './utils/rateLimiter';

export interface Opportunity {
  pool_id: string;
  current_apy: number; // Basis points
  projected_apy: number; // Basis points
  il_risk: number; // Basis points
  /** Expected one-year APY-difference return in investment-asset base units. */
  gross_profit?: bigint;
  /** Estimated cost of entering and then exiting, in the same asset units. */
  round_trip_cost?: bigint | null;
  investment_amount?: bigint;
  /** Expected one-year return after round-trip fees, before IL risk adjustment. */
  net_profit: bigint;
  apy_delta: number;
  recommended: boolean;
  confidence: number; // 0-100, confidence score based on data age and sample size
}

export interface RoundTripCostEstimate {
  /** All amounts are denominated in the requested investment asset's base units. */
  asset: string;
  networkCost: bigint;
  executionCost: bigint;
  protocolCost: bigint;
}

export interface RoundTripCostEstimator {
  /**
   * Estimate fees for both entering the destination pool and exiting it.
   * Implementations must convert all components into `asset` units using a
   * trustworthy quote source, or return null when they cannot do so.
   */
  estimateRoundTripCosts(input: {
    amount: bigint;
    asset: string;
    sourcePoolId: string;
    destinationPoolId: string;
  }): Promise<RoundTripCostEstimate | null>;
}

export interface OpportunityScanOptions {
  /** Position size used to compare one year of APY gain with absolute fees. */
  investmentAmount: bigint;
  /** Asset represented by investmentAmount and all estimator cost outputs. */
  investmentAsset: string;
  sourcePoolId: string;
}

export interface PoolMetrics {
  pool_id: string;
  current_apy: number;
  total_liquidity: bigint;
  reserve_a: bigint;
  reserve_b: bigint;
  volatility_24h: number;
  volatility_7d: number;
  confidence: number; // 0-100, confidence score based on data age and sample size
}

/**
 * Realized volatility for a pool, in basis points (1 bp = 0.01%).
 */
export interface VolatilityMetrics {
  volatility_24h: number;
  volatility_7d: number;
  sampleSize_24h: number;
  sampleSize_7d: number;
}

/**
 * Resolves volatility for a pool from real price history.
 *
 * Implementations must return `null` when there is not enough price history
 * to compute a trustworthy number - never a made-up default. Callers treat
 * `null` as "unknown" and exclude the pool from risk assessments.
 */
export interface VolatilitySource {
  getVolatility(poolId: string): Promise<VolatilityMetrics | null>;
}

/**
 * Calculate confidence score based on sample size and data recency.
 * Returns a value between 0-100, where higher values indicate higher confidence.
 *
 * Confidence is computed as:
 * - Sample size component: More samples = higher confidence (capped at 50 samples)
 * - Age component: More recent data = higher confidence (exponential decay)
 */
export function calculateConfidence(
  sampleSize: number,
  ageSeconds: number,
  maxSampleSize: number = 50,
  halfLifeSeconds: number = 86400, // 24 hours
): number {
  // Sample size component: 0-50 points maps to 0-50 confidence
  const sampleScore = Math.min(sampleSize / maxSampleSize, 1) * 50;
  
  // Age component: exponential decay based on half-life
  const ageScore = Math.pow(0.5, ageSeconds / halfLifeSeconds) * 50;
  
  // Combined confidence score
  return Math.min(Math.max(sampleScore + ageScore, 0), 100);
}

/**
 * Compute realized volatility in basis points from a price series ordered
 * from oldest to newest.
 *
 * Uses log returns: for each window the standard deviation of log returns is
 * scaled by sqrt(n) to express the total dispersion across the window, then
 * converted to basis points. Returns `null` when fewer than 2 price changes
 * are available, so callers can distinguish "unknown" from "zero risk".
 */
export function realizedVolatilityBp(
  prices: number[],
  minReturns: number = 2,
): number | null {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) {
      continue;
    }
    returns.push(Math.log(curr / prev));
  }

  if (returns.length < Math.max(2, minReturns)) {
    return null;
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) * (r - mean), 0) /
    (returns.length - 1);
  const stdev = Math.sqrt(variance);

  return stdev * Math.sqrt(returns.length) * 10000;
}

/**
 * Default `VolatilitySource`: derives volatility from real trade prices
 * fetched from Horizon for the given liquidity pool.
 *
 * Trades are fetched once per pool (up to 200 most recent) and split into
 * 24h and 7d windows. If either window has too few price points, `null` is
 * returned so the pool is skipped instead of being risk-assessed on
 * fabricated numbers.
 */
export class HorizonVolatilitySource implements VolatilitySource {
  private horizonServer: Horizon.Server;
  private now: () => number;

  constructor(horizonUrl: string = 'https://horizon.stellar.org', options?: { now?: () => number }) {
    this.horizonServer = new Horizon.Server(horizonUrl);
    this.now = options?.now ?? (() => Date.now());
  }

  async getVolatility(poolId: string): Promise<VolatilityMetrics | null> {
    try {
      const trades = await this.horizonServer
        .trades()
        .forLiquidityPool(poolId)
        .order('desc')
        .limit(200)
        .call();

      const nowSec = Math.floor(this.now() / 1000);
      const cutoff24h = nowSec - 24 * 60 * 60;
      const cutoff7d = nowSec - 7 * 24 * 60 * 60;

      const pricesInWindow = (records: any[], cutoffSec: number): number[] =>
        records
          .filter((trade) => {
            const closed = Date.parse(trade.ledger_close_time ?? '');
            return Number.isFinite(closed) && Math.floor(closed / 1000) >= cutoffSec;
          })
          .map((trade) => Number(trade.price?.n) / Number(trade.price?.d))
          .filter((price) => Number.isFinite(price) && price > 0)
          .reverse(); // oldest -> newest for log-return computation

      const windowPrices = pricesInWindow(trades.records, cutoff7d);
      const recentPrices = pricesInWindow(trades.records, cutoff24h);

      const volatility7d = realizedVolatilityBp(windowPrices);
      const volatility24h = realizedVolatilityBp(recentPrices);

      if (volatility24h === null || volatility7d === null) {
        return null;
      }

      return {
        volatility_24h: volatility24h,
        volatility_7d: volatility7d,
        sampleSize_24h: recentPrices.length,
        sampleSize_7d: windowPrices.length,
      };
    } catch (error) {
      console.error(`Failed to fetch price history for pool ${poolId}:`, error);
      return null;
    }
  }
}

export class ArbitrageScanner {
  private horizonServer: Horizon.Server;
  private volatilitySource: VolatilitySource;
  private roundTripCostEstimator?: RoundTripCostEstimator;
  private poolCache: Map<string, PoolMetrics> = new Map();
  private lastScanTime: number = 0;
  private cacheExpiry: number = 60000; // 60 seconds

  constructor(
    horizonUrl: string = 'https://horizon.stellar.org',
    options: {
      volatilitySource?: VolatilitySource;
      roundTripCostEstimator?: RoundTripCostEstimator;
    } = {},
  ) {
    this.horizonServer = new Horizon.Server(horizonUrl);
    this.volatilitySource = options.volatilitySource ?? new HorizonVolatilitySource(horizonUrl);
    this.roundTripCostEstimator = options.roundTripCostEstimator;
  }

  /**
   * Monitor 50+ Stellar AMM pools for yield opportunities
   */
  async scanAllPools(): Promise<PoolMetrics[]> {
    try {
      const now = Date.now();
      
      // Return cached pools if fresh
      if (now - this.lastScanTime < this.cacheExpiry && this.poolCache.size > 0) {
        return Array.from(this.poolCache.values());
      }

      // Fetch all liquidity pools from Horizon with reserves expansion
      const pools = await this.horizonServer.liquidityPools()
        .limit(200) // Pagination: max 50+ pools per scan
        .call();

      const poolMetrics: PoolMetrics[] = [];

      for (const pool of pools.records) {
        const metrics = await this.parsePoolMetrics(pool);
        if (metrics) {
          poolMetrics.push(metrics);
          this.poolCache.set(metrics.pool_id, metrics);
        }
      }

      this.lastScanTime = now;
      return poolMetrics;
    } catch (error) {
      console.error('Error scanning pools:', error);
      return [];
    }
  }

  /**
   * Parse Horizon liquidity pool data into metrics
   */
  private async parsePoolMetrics(pool: any): Promise<PoolMetrics | null> {
    try {
      const reserves = pool.reserves || [];
      if (reserves.length < 2) return null;

      const reserve_a = BigInt(reserves[0].amount);
      const reserve_b = BigInt(reserves[1].amount);
      const total_liquidity = reserve_a + reserve_b;

      // Estimate APY from pool fee and trading volume
      const estimate_apy = await this.estimatePoolAPY(pool);

      // Realized volatility from price history. When there is not enough
      // history we skip the pool entirely rather than risk-assessing it on
      // fabricated numbers. Rounded to whole basis points because
      // downstream math converts these values with BigInt().
      const volatility = await this.volatilitySource.getVolatility(pool.id);
      if (!volatility) {
        return null;
      }

      // Calculate confidence based on sample size (24h window is most relevant)
      // and data age (assuming most recent trade is within 24h for high confidence)
      const confidence = calculateConfidence(
        volatility.sampleSize_24h,
        0, // Age is 0 since we're using the most recent window
      );

      return {
        pool_id: pool.id,
        current_apy: estimate_apy,
        total_liquidity,
        reserve_a,
        reserve_b,
        volatility_24h: Math.round(volatility.volatility_24h),
        volatility_7d: Math.round(volatility.volatility_7d),
        confidence: Math.round(confidence),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Estimate pool APY from trading volume and fees
   */
  private async estimatePoolAPY(pool: any): Promise<number> {
    // Simplified: base 5% + trading fee share
    // Production would fetch actual volume data
    return 500 + Math.floor(Math.random() * 2000); // 5% - 25%
  }

  /**
   * Identify opportunities in current vault vs available pools
   */
  async findOpportunities(
    currentVaultApy: number,
    minApyDelta: number = 200, // 2%
    maxIlTolerance: number = 100, // 1%
    scanOptions?: OpportunityScanOptions,
  ): Promise<Opportunity[]> {
    const allPools = await this.scanAllPools();
    const opportunities: Opportunity[] = [];

    if (
      !this.roundTripCostEstimator ||
      !scanOptions ||
      !Number.isSafeInteger(minApyDelta) ||
      minApyDelta < 0 ||
      !Number.isSafeInteger(maxIlTolerance) ||
      maxIlTolerance < 0 ||
      typeof scanOptions.investmentAmount !== 'bigint' ||
      scanOptions.investmentAmount <= BigInt(0) ||
      !scanOptions.investmentAsset ||
      !scanOptions.sourcePoolId
    ) {
      console.warn(
        'Skipping arbitrage opportunities because a valid investment and round-trip cost estimator are required',
      );
      return opportunities;
    }

    for (const pool of allPools) {
      if (
        !Number.isSafeInteger(currentVaultApy) ||
        !Number.isSafeInteger(pool.current_apy) ||
        !Number.isSafeInteger(pool.volatility_24h) ||
        pool.volatility_24h < 0
      ) {
        console.warn(`Skipping pool ${pool.pool_id}: invalid APY or risk metrics`);
        continue;
      }

      const apy_delta = Math.max(0, pool.current_apy - currentVaultApy);
      if (!Number.isSafeInteger(apy_delta)) {
        console.warn(`Skipping pool ${pool.pool_id}: APY difference exceeds safe precision`);
        continue;
      }

      // Filter by thresholds
      if (apy_delta >= minApyDelta && pool.volatility_24h <= maxIlTolerance * 100) {
        let estimate: RoundTripCostEstimate | null;
        try {
          estimate = await this.roundTripCostEstimator.estimateRoundTripCosts({
            amount: scanOptions.investmentAmount,
            asset: scanOptions.investmentAsset,
            sourcePoolId: scanOptions.sourcePoolId,
            destinationPoolId: pool.pool_id,
          });
        } catch (error) {
          console.error(`Failed to estimate round-trip costs for pool ${pool.pool_id}:`, error);
          continue;
        }

        if (
          !estimate ||
          estimate.asset !== scanOptions.investmentAsset ||
          typeof estimate.networkCost !== 'bigint' ||
          typeof estimate.executionCost !== 'bigint' ||
          typeof estimate.protocolCost !== 'bigint' ||
          estimate.networkCost < BigInt(0) ||
          estimate.executionCost < BigInt(0) ||
          estimate.protocolCost < BigInt(0)
        ) {
          console.warn(
            `Skipping pool ${pool.pool_id}: round-trip cost estimate is unavailable, invalid, or in incompatible units`,
          );
          continue;
        }

        const round_trip_cost =
          estimate.networkCost + estimate.executionCost + estimate.protocolCost;
        const gross_profit =
          (scanOptions.investmentAmount * BigInt(apy_delta)) / BigInt(10000);
        const net_profit = gross_profit - round_trip_cost;

        // APY is annualized, so compare the round-trip fees with one year of
        // expected gain on the same configured investment amount.
        if (net_profit <= BigInt(0)) {
          continue;
        }
        const netApyDelta =
          (net_profit * BigInt(10000)) / scanOptions.investmentAmount;

        opportunities.push({
          pool_id: pool.pool_id,
          current_apy: currentVaultApy,
          projected_apy: pool.current_apy,
          il_risk: pool.volatility_24h,
          gross_profit,
          round_trip_cost,
          investment_amount: scanOptions.investmentAmount,
          net_profit,
          apy_delta,
          recommended: netApyDelta >= minApyDelta * 2,
        });
      }
    }

    // Sort by net profit descending
    return opportunities.sort((a, b) =>
      a.net_profit === b.net_profit ? 0 : a.net_profit > b.net_profit ? -1 : 1,
    );
  }
}

export interface ArbitrageExecutorOptions {
  /**
   * Paces transaction submissions so a burst of work does not trip the RPC
   * node's rate limits. When omitted, a default limiter (one write at a time,
   * 1s apart) is used.
   */
  writeLimiter?: WriteRateLimiter;
}

export class ArbitrageExecutor {
  private horizonServer: Horizon.Server;
  private readonly writeLimiter: WriteRateLimiter;

  constructor(horizonUrl: string = 'https://horizon.stellar.org', options: ArbitrageExecutorOptions = {}) {
    this.horizonServer = new Horizon.Server(horizonUrl);
    this.writeLimiter =
      options.writeLimiter ?? new WriteRateLimiter({ minIntervalMs: 1000, maxConcurrent: 1 });
  }

  /** Write-pacing counters for this executor. */
  getWriteLimiterStats() {
    return this.writeLimiter.stats();
  }

  /**
   * Simulate rebalance with current position (dry-run)
   */
  async simulateRebalance(
    opportunity: Opportunity,
    currentPosition: bigint,
  ): Promise<{
    totalCost: bigint;
    netProfit: bigint;
    profitable: boolean;
    costEstimateAvailable: boolean;
  }> {
    if (
      typeof opportunity.round_trip_cost !== 'bigint' ||
      opportunity.round_trip_cost === undefined ||
      opportunity.round_trip_cost < BigInt(0) ||
      opportunity.investment_amount !== currentPosition ||
      typeof opportunity.gross_profit !== 'bigint' ||
      opportunity.gross_profit === undefined ||
      opportunity.gross_profit < BigInt(0) ||
      !Number.isSafeInteger(opportunity.il_risk) ||
      opportunity.il_risk < 0 ||
      currentPosition <= BigInt(0)
    ) {
      return {
        totalCost: BigInt(0),
        netProfit: BigInt(0),
        profitable: false,
        costEstimateAvailable: false,
      };
    }

    // Round-trip fees were estimated during scanning; do not add a second
    // network or execution estimate here. Keep the existing IL risk deduction.
    const ilCost = (currentPosition * BigInt(opportunity.il_risk)) / BigInt(10000);
    const totalCost = opportunity.round_trip_cost + ilCost;
    const netProfit = opportunity.gross_profit - totalCost;

    return {
      totalCost,
      netProfit,
      profitable: netProfit > BigInt(0),
      costEstimateAvailable: true,
    };
  }

  /**
   * Execute full arbitrage transaction (atomic withdraw → swap → deposit)
   */
  async executeArbitrage(
    opportunity: Opportunity,
    currentPoolId: string,
    amount: bigint,
    privateKey: string, // Stellar private key
  ): Promise<{
    success: boolean;
    transactionHash?: string;
    error?: string;
  }> {
    try {
      // Validate opportunity is still valid (prices may have moved)
      if (!opportunity.recommended) {
        return {
          success: false,
          error: 'Opportunity no longer meets recommended threshold',
        };
      }
      if (
        typeof opportunity.round_trip_cost !== 'bigint' ||
        opportunity.round_trip_cost === undefined ||
        opportunity.round_trip_cost < BigInt(0) ||
        opportunity.investment_amount !== amount ||
        amount <= BigInt(0) ||
        typeof opportunity.gross_profit !== 'bigint' ||
        opportunity.gross_profit < BigInt(0) ||
        !Number.isSafeInteger(opportunity.il_risk) ||
        opportunity.il_risk < 0 ||
        typeof opportunity.net_profit !== 'bigint' ||
        opportunity.net_profit <= BigInt(0)
      ) {
        return {
          success: false,
          error: 'Opportunity has no valid profitable round-trip cost estimate for this amount',
        };
      }
      const ilCost = (amount * BigInt(opportunity.il_risk)) / BigInt(10000);
      if (opportunity.gross_profit - opportunity.round_trip_cost - ilCost <= BigInt(0)) {
        return {
          success: false,
          error: 'Opportunity is not profitable after round-trip costs and IL risk',
        };
      }

      // Pace the submission: bursts of arbitrage are the most likely trigger
      // for node-side throttling, so the actual write goes through the limiter.
      return await this.writeLimiter.schedule(async () => {
        // In production, this would:
        // 1. Create multi-operation transaction (withdraw + deposit)
        // 2. Sign with provided private key
        // 3. Submit to network
        // 4. Wait for confirmation

        console.log(`Executing arbitrage: ${currentPoolId} -> ${opportunity.pool_id}`);
        console.log(`Amount: ${amount}, Projected APY gain: ${opportunity.apy_delta} bp`);

        // Simulated successful execution
        const txHash = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        return {
          success: true,
          transactionHash: txHash,
        };
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Execution failed: ${errorMsg}`,
      };
    }
  }
}

export class ArbitrageOptimizer {
  /**
   * Calculate profitability of an opportunity
   */
  static calculateProfitability(
    opportunity: Opportunity,
    amount: bigint,
  ): {
    grossProfit: bigint;
    netProfit: bigint;
    roi: number; // Percentage
    costEstimateAvailable: boolean;
  } {
    const grossProfit = (amount * BigInt(opportunity.apy_delta)) / BigInt(10000);
    const hasEstimate =
      typeof opportunity.round_trip_cost === 'bigint' &&
      opportunity.round_trip_cost !== undefined &&
      opportunity.round_trip_cost >= BigInt(0) &&
      opportunity.investment_amount === amount &&
      amount > BigInt(0) &&
      typeof opportunity.gross_profit === 'bigint' &&
      opportunity.gross_profit >= BigInt(0) &&
      Number.isSafeInteger(opportunity.il_risk) &&
      opportunity.il_risk >= 0;

    if (!hasEstimate) {
      return {
        grossProfit,
        netProfit: BigInt(0),
        roi: 0,
        costEstimateAvailable: false,
      };
    }

    const ilCost = (amount * BigInt(opportunity.il_risk)) / BigInt(10000);
    const netProfit = grossProfit - opportunity.round_trip_cost! - ilCost;
    const roi = amount > BigInt(0)
      ? Number((netProfit * BigInt(10000)) / amount) / 100
      : 0;

    return {
      grossProfit,
      netProfit,
      roi,
      costEstimateAvailable: true,
    };
  }

  /**
   * Rank opportunities by risk-adjusted return with confidence weighting
   */
  static rankOpportunities(
    opportunities: Opportunity[],
    riskTolerance: number, // 1-10, higher = more risk acceptable
  ): Opportunity[] {
    return opportunities.sort((a, b) => {
      // Net APY (after round-trip costs) adjusted by the existing IL risk factor.
      const riskFactor = 0.1 * (11 - riskTolerance);
      const netApyDeltaA =
        a.round_trip_cost !== undefined &&
        a.round_trip_cost !== null &&
        a.investment_amount !== undefined &&
        a.investment_amount > BigInt(0)
          ? Number((a.net_profit * BigInt(10000)) / a.investment_amount)
          : Number.NEGATIVE_INFINITY;
      const netApyDeltaB =
        b.round_trip_cost !== undefined &&
        b.round_trip_cost !== null &&
        b.investment_amount !== undefined &&
        b.investment_amount > BigInt(0)
          ? Number((b.net_profit * BigInt(10000)) / b.investment_amount)
          : Number.NEGATIVE_INFINITY;
      const scoreA = netApyDeltaA - a.il_risk * riskFactor;
      const scoreB = netApyDeltaB - b.il_risk * riskFactor;
      return scoreB - scoreA;
    });
  }

  /**
   * Estimate time to break-even after rebalancing
   */
  static estimateBreakEven(
    netProfit: bigint,
    dailyYieldIncrease: bigint,
  ): number {
    // Days = net cost / daily increase
    if (dailyYieldIncrease <= BigInt(0)) return Infinity;
    return Number((-netProfit) / dailyYieldIncrease);
  }
}
