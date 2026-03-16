import { Address } from 'stellar-sdk';
import {
  ImpermanentLossData,
  ApyProjection,
  FeeRevenue,
  PoolInfo,
  TokenInfo,
  PriceData,
  TimeInterval
} from './types';

export class YieldCalculator {
  /**
   * Calculate impermanent loss for a liquidity position
   */
  static calculateImpermanentLoss(
    initialPriceRatio: number,
    currentPriceRatio: number,
    timeElapsed: number
  ): ImpermanentLossData {
    // IL formula: 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
    const priceRatio = currentPriceRatio / initialPriceRatio;
    const sqrtRatio = Math.sqrt(priceRatio);
    const ilPercent = (2 * sqrtRatio / (1 + priceRatio) - 1) * 100;

    return {
      currentPriceRatio,
      initialPriceRatio,
      ilPercent,
      timeElapsed
    };
  }

  /**
   * Project APY based on historical data and market conditions
   */
  static projectApy(
    historicalApy: number[],
    marketConditions: {
      volatility: number;
      trend: 'bullish' | 'bearish' | 'neutral';
      volume: number;
    },
    timeHorizon: number
  ): ApyProjection {
    // Calculate average historical APY
    const avgHistoricalApy = historicalApy.reduce((sum, apy) => sum + apy, 0) / historicalApy.length;
    
    // Calculate volatility
    const variance = historicalApy.reduce((sum, apy) => {
      return sum + Math.pow(apy - avgHistoricalApy, 2);
    }, 0) / historicalApy.length;
    const volatility = Math.sqrt(variance);
    
    // Adjust based on market conditions
    let projectedApy = avgHistoricalApy;
    let confidence = 85; // Base confidence
    
    switch (marketConditions.trend) {
      case 'bullish':
        projectedApy *= 1.2; // 20% boost
        confidence += 10;
        break;
      case 'bearish':
        projectedApy *= 0.8; // 20% reduction
        confidence -= 15;
        break;
      case 'neutral':
        // No adjustment
        break;
    }
    
    // Factor in volume
    if (marketConditions.volume > 1000000) { // High volume
      projectedApy *= 1.1; // 10% boost
      confidence += 5;
    } else if (marketConditions.volume < 100000) { // Low volume
      projectedApy *= 0.9; // 10% reduction
      confidence -= 10;
    }
    
    // Factor in volatility
    if (volatility > 50) { // High volatility
      confidence -= 20;
    } else if (volatility < 10) { // Low volatility
      confidence += 10;
    }
    
    // Ensure confidence stays within bounds
    confidence = Math.max(0, Math.min(100, confidence));
    
    // Generate factors for the projection
    const factors = [
      `Historical APY: ${avgHistoricalApy.toFixed(2)}%`,
      `Market trend: ${marketConditions.trend}`,
      `Volume: $${marketConditions.volume.toLocaleString()}`,
      `Volatility: ${volatility.toFixed(2)}%`,
      `Time horizon: ${timeHorizon} days`
    ];
    
    return {
      projectedApy,
      confidence,
      timeHorizon,
      factors
    };
  }

  /**
   * Estimate fee revenue for a vault
   */
  static estimateFeeRevenue(
    totalValueLocked: bigint,
    harvestFeeRate: number, // Basis points
    withdrawalFeeRate: number, // Basis points
    managementFeeRate: number, // Annual basis points
    performanceFeeRate: number, // Basis points
    apy: number, // Basis points
    period: TimeInterval
  ): FeeRevenue {
    const periodDays = (period.end - period.start) / (24 * 60 * 60 * 1000);
    const periodYears = periodDays / 365.25;
    
    // Calculate harvest fees (based on yield generated)
    const yieldGenerated = (totalValueLocked * BigInt(apy) / 10000n) * BigInt(Math.floor(periodYears * 10000)) / 10000n;
    const harvestFees = yieldGenerated * BigInt(harvestFeeRate) / 10000n;
    
    // Estimate withdrawal fees (assume 10% of TVL is withdrawn per period)
    const estimatedWithdrawals = totalValueLocked * 10n / 100n;
    const withdrawalFees = estimatedWithdrawals * BigInt(withdrawalFeeRate) / 10000n;
    
    // Calculate management fees
    const managementFees = totalValueLocked * BigInt(managementFeeRate) * BigInt(Math.floor(periodYears * 10000)) / 10000n / 10000n;
    
    // Calculate performance fees (if APY exceeds threshold, assume 20%)
    const performanceThreshold = 1000; // 10% APY threshold
    let performanceFees = 0n;
    if (apy > performanceThreshold) {
      const excessApy = apy - performanceThreshold;
      const excessYield = (totalValueLocked * BigInt(excessApy) / 10000n) * BigInt(Math.floor(periodYears * 10000)) / 10000n;
      performanceFees = excessYield * BigInt(performanceFeeRate) / 10000n;
    }
    
    const totalFees = harvestFees + withdrawalFees + managementFees + performanceFees;
    
    return {
      harvestFees,
      withdrawalFees,
      managementFees,
      performanceFees,
      totalFees
    };
  }

  /**
   * Calculate optimal deposit amounts for balanced liquidity
   */
  static calculateOptimalDeposit(
    poolInfo: PoolInfo,
    targetValue: bigint,
    slippageTolerance: number // Basis points
  ): { amountA: bigint; amountB: bigint; expectedLpTokens: bigint } {
    // Calculate the current ratio
    const currentRatio = Number(poolInfo.reserveA) / Number(poolInfo.reserveB);
    
    // Calculate optimal amounts based on current pool ratio
    let amountA: bigint;
    let amountB: bigint;
    
    if (currentRatio > 1) {
      // Token A is more valuable, need less of it
      amountA = targetValue * 10000n / BigInt(Math.floor(currentRatio * 10000));
      amountB = targetValue;
    } else {
      // Token B is more valuable, need less of it
      amountA = targetValue;
      amountB = targetValue * BigInt(Math.floor(currentRatio * 10000)) / 10000n;
    }
    
    // Calculate expected LP tokens (simplified)
    const totalLiquidity = poolInfo.totalLiquidity;
    const expectedLpTokens = (amountA + amountB) * 10000n / (totalLiquidity + 10000n);
    
    return {
      amountA,
      amountB,
      expectedLpTokens
    };
  }

  /**
   * Calculate compound interest with auto-compounding
   */
  static calculateCompoundInterest(
    principal: bigint,
    apy: number, // Basis points
    compoundingFrequency: number, // Times per year
    timeYears: number
  ): { finalAmount: bigint; totalInterest: bigint; effectiveApy: number } {
    const rate = apy / 10000 / 100; // Convert to decimal
    const n = compoundingFrequency;
    const t = timeYears;
    
    // Compound interest formula: A = P(1 + r/n)^(nt)
    const compoundFactor = Math.pow(1 + rate / n, n * t);
    const finalAmount = principal * BigInt(Math.floor(compoundFactor * 1000000)) / 1000000n;
    const totalInterest = finalAmount - principal;
    
    // Calculate effective APY
    const effectiveApy = (Math.pow(compoundFactor, 1 / t) - 1) * 10000;
    
    return {
      finalAmount,
      totalInterest,
      effectiveApy
    };
  }

  /**
   * Calculate risk-adjusted returns (Sharpe ratio)
   */
  static calculateSharpeRatio(
    returns: number[],
    riskFreeRate: number // Annual risk-free rate in basis points
  ): number {
    if (returns.length === 0) return 0;
    
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);
    
    if (volatility === 0) return 0;
    
    // Sharpe ratio = (avg_return - risk_free_rate) / volatility
    const excessReturn = avgReturn - riskFreeRate;
    return excessReturn / volatility;
  }

  /**
   * Calculate maximum drawdown
   */
  static calculateMaxDrawdown(values: number[]): { maxDrawdown: number; maxDrawdownPeriod: TimeInterval } {
    if (values.length === 0) return { maxDrawdown: 0, maxDrawdownPeriod: { start: 0, end: 0 } };
    
    let maxDrawdown = 0;
    let peak = values[0];
    let trough = values[0];
    let maxDrawdownStart = 0;
    let maxDrawdownEnd = 0;
    
    for (let i = 1; i < values.length; i++) {
      if (values[i] > peak) {
        peak = values[i];
        trough = values[i];
      } else if (values[i] < trough) {
        trough = values[i];
        const drawdown = (peak - trough) / peak;
        
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
          maxDrawdownStart = i - 1; // Approximate
          maxDrawdownEnd = i;
        }
      }
    }
    
    return {
      maxDrawdown: maxDrawdown * 100, // Convert to percentage
      maxDrawdownPeriod: {
        start: maxDrawdownStart,
        end: maxDrawdownEnd
      }
    };
  }

  /**
   * Calculate liquidity depth impact
   */
  static calculateLiquidityDepthImpact(
    poolInfo: PoolInfo,
    tradeAmount: bigint
  ): { priceImpact: number; effectivePrice: number } {
    // Simplified constant product formula impact calculation
    const reserveA = Number(poolInfo.reserveA);
    const reserveB = Number(poolInfo.reserveB);
    const tradeAmountNum = Number(tradeAmount);
    
    // Calculate price impact using x*y=k formula
    const newReserveA = reserveA + tradeAmountNum;
    const newReserveB = (reserveA * reserveB) / newReserveA;
    
    const priceImpact = (reserveB - newReserveB) / reserveB;
    const effectivePrice = newReserveB / newReserveA;
    
    return {
      priceImpact: priceImpact * 100, // Convert to percentage
      effectivePrice
    };
  }

  /**
   * Calculate yield farming metrics
   */
  static calculateYieldFarmingMetrics(
    poolInfo: PoolInfo,
    userLiquidity: bigint,
    rewardTokens: TokenInfo[],
    rewardRates: Map<Address, bigint>,
    period: TimeInterval
  ): {
    baseApy: number;
    rewardApy: number;
    totalApy: number;
    dailyRewards: Map<Address, bigint>;
  } {
    const periodDays = (period.end - period.start) / (24 * 60 * 60 * 1000);
    
    // Calculate base APY from trading fees
    const dailyVolume = Number(poolInfo.volume24h);
    const dailyFees = dailyVolume * poolInfo.feeRate / 10000;
    const yearlyFees = dailyFees * 365;
    const totalLiquidity = Number(poolInfo.totalLiquidity);
    const baseApy = (yearlyFees / totalLiquidity) * 10000; // Basis points
    
    // Calculate reward APY
    let totalRewardValue = 0;
    const dailyRewards = new Map<Address, bigint>();
    
    for (const [tokenAddress, rate] of rewardRates.entries()) {
      const tokenInfo = rewardTokens.find(t => t.address === tokenAddress);
      if (tokenInfo) {
        const dailyReward = rate * BigInt(86400) / 1000000n; // Convert to daily
        dailyRewards.set(tokenAddress, dailyReward);
        
        const yearlyReward = Number(dailyReward) * 365 * tokenInfo.price;
        totalRewardValue += yearlyReward;
      }
    }
    
    const rewardApy = (totalRewardValue / totalLiquidity) * 10000; // Basis points
    const totalApy = baseApy + rewardApy;
    
    return {
      baseApy,
      rewardApy,
      totalApy,
      dailyRewards
    };
  }

  /**
   * Simulate impermanent loss over time
   */
  static simulateImpermanentLoss(
    initialPriceRatio: number,
    volatility: number,
    timePeriod: number, // Days
    simulations: number = 1000
  ): {
    averageIl: number;
    worstCaseIl: number;
    bestCaseIl: number;
    ilDistribution: number[];
  } {
    const ilResults: number[] = [];
    
    for (let i = 0; i < simulations; i++) {
      // Simulate random walk for price ratio
      let currentRatio = initialPriceRatio;
      
      for (let day = 0; day < timePeriod; day++) {
        const randomShock = (Math.random() - 0.5) * 2 * volatility / 100;
        currentRatio *= (1 + randomShock);
      }
      
      // Calculate IL for this simulation
      const il = this.calculateImpermanentLoss(initialPriceRatio, currentRatio, timePeriod);
      ilResults.push(il.ilPercent);
    }
    
    // Calculate statistics
    ilResults.sort((a, b) => a - b);
    const averageIl = ilResults.reduce((sum, il) => sum + il, 0) / ilResults.length;
    const worstCaseIl = ilResults[0];
    const bestCaseIl = ilResults[ilResults.length - 1];
    
    return {
      averageIl,
      worstCaseIl,
      bestCaseIl,
      ilDistribution: ilResults
    };
  }
}
