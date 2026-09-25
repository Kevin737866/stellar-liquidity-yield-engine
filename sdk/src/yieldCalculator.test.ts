import { YieldCalculator } from './yieldCalculator';
import { PoolInfo } from './types';

describe('YieldCalculator.calculateImpermanentLoss', () => {
  it('returns zero IL when the price ratio has not changed', () => {
    const result = YieldCalculator.calculateImpermanentLoss(1, 1, 30);
    expect(result.ilPercent).toBeCloseTo(0, 10);
    expect(result.currentPriceRatio).toBe(1);
    expect(result.initialPriceRatio).toBe(1);
    expect(result.timeElapsed).toBe(30);
  });

  it('matches the known IL value for a 4x price increase', () => {
    // IL = 2*sqrt(4)/(1+4) - 1 = 4/5 - 1 = -20%
    const result = YieldCalculator.calculateImpermanentLoss(1, 4, 7);
    expect(result.ilPercent).toBeCloseTo(-20, 6);
  });

  it('matches the known (symmetric) IL value for a 4x price decrease', () => {
    // k = 0.25 => 2*0.5/1.25 - 1 = -20%
    const result = YieldCalculator.calculateImpermanentLoss(1, 0.25, 7);
    expect(result.ilPercent).toBeCloseTo(-20, 6);
  });

  it('is symmetric: a factor-k move in either direction yields the same IL', () => {
    // k = 2 (2x up) and k = 1/2 (2x down) both give the same IL.
    const up = YieldCalculator.calculateImpermanentLoss(1, 2, 1);
    const down = YieldCalculator.calculateImpermanentLoss(2, 1, 1);
    const upFlipped = YieldCalculator.calculateImpermanentLoss(1, 0.5, 1);
    expect(up.ilPercent).toBeCloseTo(down.ilPercent, 10);
    expect(up.ilPercent).toBeCloseTo(upFlipped.ilPercent, 10);
    // 2*sqrt(2)/3 - 1 = -5.7190958%
    expect(up.ilPercent).toBeCloseTo(-5.7190958418, 6);
  });

  it('handles a non-positive baseline without NaN/Infinity', () => {
    const zeroBase = YieldCalculator.calculateImpermanentLoss(0, 1, 1);
    expect(zeroBase.ilPercent).toBe(0);

    const negativeBase = YieldCalculator.calculateImpermanentLoss(-1, 1, 1);
    expect(negativeBase.ilPercent).toBe(0);

    const nonPositiveCurrent = YieldCalculator.calculateImpermanentLoss(1, 0, 1);
    expect(nonPositiveCurrent.ilPercent).toBe(0);
  });

  it('preserves supplied metadata in the result', () => {
    const result = YieldCalculator.calculateImpermanentLoss(1.2, 0.9, 60);
    expect(result.initialPriceRatio).toBe(1.2);
    expect(result.currentPriceRatio).toBe(0.9);
    expect(result.timeElapsed).toBe(60);
  });
});

describe('YieldCalculator.projectApy', () => {
  const neutralMarket = { volatility: 20, trend: 'neutral' as const, volume: 500000 };

  it('returns flat zeros for an empty history', () => {
    const result = YieldCalculator.projectApy([], neutralMarket, 30);
    expect(result.projectedApy).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.timeHorizon).toBe(30);
  });

  it('projects the historical average for a neutral market', () => {
    const result = YieldCalculator.projectApy([1000, 1500, 1250], neutralMarket, 30);
    expect(result.projectedApy).toBeCloseTo(1250, 6);
    // vol of [1000,1500,1250] ~ 204 bp => high-vol penalty drops base 85 to 65
    expect(result.confidence).toBe(65);
  });

  it('boosts confidence when historical volatility is low', () => {
    const result = YieldCalculator.projectApy([1250, 1250, 1250], neutralMarket, 30);
    expect(result.projectedApy).toBeCloseTo(1250, 6);
    expect(result.confidence).toBe(95); // 85 base + 10 low-vol
  });

  it('applies the 20% bullish boost', () => {
    const result = YieldCalculator.projectApy(
      [1000],
      { volatility: 20, trend: 'bullish', volume: 500000 },
      30
    );
    expect(result.projectedApy).toBeCloseTo(1200, 6);
    expect(result.confidence).toBe(100); // 85 + 10 bullish + 10 low-vol, clamped
  });

  it('applies the 20% bearish reduction and lowers confidence', () => {
    const result = YieldCalculator.projectApy(
      [1000],
      { volatility: 20, trend: 'bearish', volume: 500000 },
      30
    );
    expect(result.projectedApy).toBeCloseTo(800, 6);
    expect(result.confidence).toBe(80); // 85 - 15 bearish + 10 low-vol
  });

  it('boosts projection for high volume', () => {
    const result = YieldCalculator.projectApy([1000], { volatility: 20, trend: 'neutral', volume: 2000000 }, 30);
    expect(result.projectedApy).toBeCloseTo(1100, 6);
  });

  it('reduces projection for low volume', () => {
    const result = YieldCalculator.projectApy([1000], { volatility: 20, trend: 'neutral', volume: 50000 }, 30);
    expect(result.projectedApy).toBeCloseTo(900, 6);
  });

  it('handles negative and zero historical APYs', () => {
    const result = YieldCalculator.projectApy([-500, 0, 500], neutralMarket, 30);
    expect(result.projectedApy).toBeCloseTo(0, 6); // avg is 0
    expect(Number.isNaN(result.projectedApy)).toBe(false);
  });

  it('keeps confidence within 0-100 bounds under extreme conditions', () => {
    const result = YieldCalculator.projectApy(
      [1000],
      { volatility: 90, trend: 'bearish', volume: 50000 },
      30
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('lists a sensible human-readable factors array', () => {
    const result = YieldCalculator.projectApy([1000], neutralMarket, 30);
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.factors[0]).toContain('Historical APY');
  });
});

describe('YieldCalculator.calculateSharpeRatio', () => {
  it('returns 0 for an empty returns array', () => {
    expect(YieldCalculator.calculateSharpeRatio([], 100)).toBe(0);
  });

  it('returns 0 when volatility is zero (all identical returns)', () => {
    expect(YieldCalculator.calculateSharpeRatio([500, 500, 500], 100)).toBe(0);
  });

  it('returns the ratio of excess return to volatility', () => {
    // returns average 200 bp, riskFree 100 bp, stddev 100 bp => 1
    const sharpe = YieldCalculator.calculateSharpeRatio([100, 300], 100);
    expect(sharpe).toBeCloseTo(1, 6);
  });

  it('can be negative when risk-free rate exceeds average return', () => {
    const sharpe = YieldCalculator.calculateSharpeRatio([0, 0], 500);
    expect(Number.isNaN(sharpe)).toBe(false);
  });

  it('handles zero and negative returns without crashing', () => {
    const sharpe = YieldCalculator.calculateSharpeRatio([-100, 0, -50], 0);
    expect(Number.isNaN(sharpe)).toBe(false);
    expect(sharpe).toBeLessThan(0);
  });
});

describe('YieldCalculator.calculateMaxDrawdown', () => {
  it('returns zero drawdown for an empty series', () => {
    const result = YieldCalculator.calculateMaxDrawdown([]);
    expect(result.maxDrawdown).toBe(0);
    expect(result.maxDrawdownPeriod).toEqual({ start: 0, end: 0 });
  });

  it('returns zero drawdown for a monotonically increasing series', () => {
    const result = YieldCalculator.calculateMaxDrawdown([100, 105, 110, 120]);
    expect(result.maxDrawdown).toBe(0);
  });

  it('computes a known drawdown (peak 100 to trough 70 => 30%)', () => {
    const result = YieldCalculator.calculateMaxDrawdown([100, 80, 90, 70]);
    expect(result.maxDrawdown).toBeCloseTo(30, 6);
    expect(result.maxDrawdownPeriod.start).toBe(2);
    expect(result.maxDrawdownPeriod.end).toBe(3);
  });

  it('computes a known monotonic-decline drawdown (100 to 20 => 80%)', () => {
    const result = YieldCalculator.calculateMaxDrawdown([100, 50, 20]);
    expect(result.maxDrawdown).toBeCloseTo(80, 6);
  });

  it('handles a single-element series (zero drawdown)', () => {
    const result = YieldCalculator.calculateMaxDrawdown([42]);
    expect(result.maxDrawdown).toBe(0);
  });

  it('handles negative values and deep drawdowns', () => {
    const result = YieldCalculator.calculateMaxDrawdown([10, -20]);
    // peak 10, trough -20 => (10 - (-20)) / 10 = 3 => 300%
    expect(result.maxDrawdown).toBeCloseTo(300, 6);
  });
});

describe('YieldCalculator.calculateCompoundInterest', () => {
  it('computes a known compounding result', () => {
    // 1000 principal, 10% APY (1000 bp), compounded once annually for 1 year
    const result = YieldCalculator.calculateCompoundInterest(1000n, 1000, 1, 1);
    expect(result.finalAmount).toBe(1100n);
    expect(result.totalInterest).toBe(100n);
    expect(result.effectiveApy).toBeCloseTo(1000, 3);
  });

  it('returns principal and zero interest for a zero horizon', () => {
    const result = YieldCalculator.calculateCompoundInterest(1000n, 1000, 1, 0);
    expect(result.finalAmount).toBe(1000n);
    expect(result.totalInterest).toBe(0n);
    expect(result.effectiveApy).toBe(0);
    expect(Number.isNaN(result.effectiveApy)).toBe(false);
  });

  it('handles zero principal', () => {
    const result = YieldCalculator.calculateCompoundInterest(0n, 1000, 4, 1);
    expect(result.finalAmount).toBe(0n);
    expect(result.totalInterest).toBe(0n);
  });

  it('handles a zero interest rate', () => {
    const result = YieldCalculator.calculateCompoundInterest(1000n, 0, 12, 5);
    expect(result.finalAmount).toBe(1000n);
    expect(result.totalInterest).toBe(0n);
  });

  it('handles negative principal without crashing', () => {
    const result = YieldCalculator.calculateCompoundInterest(-1000n, 1000, 1, 1);
    expect(result.finalAmount).toBe(-1100n);
    expect(result.totalInterest).toBe(-100n);
  });
});

describe('YieldCalculator.calculateOptimalDeposit', () => {
  const basePool: PoolInfo = {
    id: {} as any,
    tokenA: {} as any,
    tokenB: {} as any,
    reserveA: 1000n,
    reserveB: 1000n,
    totalLiquidity: 2000n,
    feeRate: 30,
    apy: 1500,
    volume24h: 500000n
  };

  it('splits a balanced pool 50/50 at the target value', () => {
    const result = YieldCalculator.calculateOptimalDeposit(basePool, 100n, 50);
    expect(result.amountA).toBe(100n);
    expect(result.amountB).toBe(100n);
    expect(result.expectedLpTokens).toBeGreaterThan(0n);
  });

  it('allocates more of the cheaper token when reserves are skewed', () => {
    const skewed: PoolInfo = {
      ...basePool,
      reserveA: 2000n,
      reserveB: 1000n
    };
    const result = YieldCalculator.calculateOptimalDeposit(skewed, 100n, 50);
    // ratio = 2 => amountA = 100*10000/20000 = 50, amountB = 100
    expect(result.amountA).toBe(50n);
    expect(result.amountB).toBe(100n);
  });

  it('handles zero target value', () => {
    const result = YieldCalculator.calculateOptimalDeposit(basePool, 0n, 50);
    expect(result.amountA).toBe(0n);
    expect(result.amountB).toBe(0n);
  });
});

describe('YieldCalculator.calculateLiquidityDepthImpact', () => {
  const pool: PoolInfo = {
    id: {} as any,
    tokenA: {} as any,
    tokenB: {} as any,
    reserveA: 1000n,
    reserveB: 1000n,
    totalLiquidity: 2000n,
    feeRate: 30,
    apy: 1500,
    volume24h: 500000n
  };

  it('returns zero impact for a zero-size trade', () => {
    const result = YieldCalculator.calculateLiquidityDepthImpact(pool, 0n);
    expect(result.priceImpact).toBeCloseTo(0, 10);
  });

  it('small trades produce small positive price impact', () => {
    const result = YieldCalculator.calculateLiquidityDepthImpact(pool, 10n);
    expect(result.priceImpact).toBeGreaterThan(0);
    expect(result.effectivePrice).toBeGreaterThan(0);
  });
});

describe('YieldCalculator.simulateImpermanentLoss', () => {
  it('runs a simulation and produces bounded statistics', () => {
    const result = YieldCalculator.simulateImpermanentLoss(1, 10, 5, 50);
    expect(result.ilDistribution).toHaveLength(50);
    expect(Number.isNaN(result.averageIl)).toBe(false);
    expect(result.bestCaseIl).toBeGreaterThanOrEqual(result.worstCaseIl);
  });

  it('produces all non-positive IL values (IL is always a loss)', () => {
    const result = YieldCalculator.simulateImpermanentLoss(1, 10, 5, 30);
    for (const il of result.ilDistribution) {
      expect(il).toBeLessThanOrEqual(0);
    }
  });
});

describe('YieldCalculator.computeHistoricalImpermanentLoss', () => {
  it('maps each price point to a timestamped IL percent', () => {
    const history = [
      { timestamp: 1000, priceRatio: 1 },
      { timestamp: 2000, priceRatio: 2 },
      { timestamp: 3000, priceRatio: 0.5 }
    ];
    const result = YieldCalculator.computeHistoricalImpermanentLoss(1, history);
    expect(result).toHaveLength(3);
    expect(result[0].timestamp).toBe(1000);
    expect(result[0].ilPercent).toBeCloseTo(0, 10);
    expect(result[1].ilPercent).toBeLessThan(0); // moved away from initial
  });

  it('returns an empty array for an empty history', () => {
    const result = YieldCalculator.computeHistoricalImpermanentLoss(1, []);
    expect(result).toEqual([]);
  });
});

describe('YieldCalculator.estimateFeeRevenue', () => {
  const oneYear = { start: 0, end: 365 * 24 * 60 * 60 * 1000 };

  it('computes zero fees for a zero TVL', () => {
    const result = YieldCalculator.estimateFeeRevenue(0n, 100, 100, 100, 1000, 1500, oneYear);
    expect(result.totalFees).toBe(0n);
    expect(result.harvestFees).toBe(0n);
    expect(result.withdrawalFees).toBe(0n);
    expect(result.managementFees).toBe(0n);
    expect(result.performanceFees).toBe(0n);
  });

  it('yields no yield-based fees for a zero-length period (withdrawal fee still applies)', () => {
    // Yield/management/performance fees scale with the period (and are 0 for a
    // zero-length period). The withdrawal fee uses a fixed "10% of TVL is
    // withdrawn" assumption and therefore still accrues.
    const result = YieldCalculator.estimateFeeRevenue(1000n, 100, 100, 100, 1000, 1500, {
      start: 1000,
      end: 1000
    });
    expect(result.harvestFees).toBe(0n);
    expect(result.managementFees).toBe(0n);
    expect(result.performanceFees).toBe(0n);
    expect(result.totalFees).toBe(result.withdrawalFees);
    expect(result.withdrawalFees).toBe(1n); // 10% of 1000 * 100 bp
  });

  it('produces a positive breakdown for a normal period', () => {
    const result = YieldCalculator.estimateFeeRevenue(1_000_000n, 100, 50, 200, 1000, 1500, oneYear);
    expect(result.totalFees).toBeGreaterThan(0n);
    expect(result.totalFees).toBe(
      result.harvestFees + result.withdrawalFees + result.managementFees + result.performanceFees
    );
  });
});