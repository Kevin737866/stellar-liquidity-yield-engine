import {
  ArbitrageExecutor,
  ArbitrageOptimizer,
  ArbitrageScanner,
  calculateConfidence,
  HorizonVolatilitySource,
  realizedVolatilityBp,
  RoundTripCostEstimate,
  RoundTripCostEstimator,
  VolatilityMetrics,
  VolatilitySource,
} from './arbitrage';

describe('calculateConfidence', () => {
  it('returns 0 when sample size is 0', () => {
    expect(calculateConfidence(0, 0)).toBe(0);
  });

  it('increases with sample size', () => {
    const lowSample = calculateConfidence(5, 0);
    const highSample = calculateConfidence(50, 0);
    expect(highSample).toBeGreaterThan(lowSample);
  });

  it('caps at 50 points for sample size component', () => {
    const atCap = calculateConfidence(50, 0);
    const aboveCap = calculateConfidence(100, 0);
    expect(atCap).toBeCloseTo(aboveCap);
  });

  it('decreases with data age', () => {
    const fresh = calculateConfidence(25, 0);
    const stale = calculateConfidence(25, 86400); // 24 hours old
    expect(fresh).toBeGreaterThan(stale);
  });

  it('combines sample size and age components', () => {
    const highConfidence = calculateConfidence(50, 0);
    const lowConfidence = calculateConfidence(5, 86400 * 2);
    expect(highConfidence).toBeGreaterThan(lowConfidence);
    expect(highConfidence).toBeLessThanOrEqual(100);
    expect(lowConfidence).toBeGreaterThanOrEqual(0);
  });

  it('respects half-life parameter', () => {
    const shortHalfLife = calculateConfidence(25, 43200, 50, 43200); // 12h half-life, 12h old
    const longHalfLife = calculateConfidence(25, 43200, 50, 86400); // 24h half-life, 12h old
    expect(longHalfLife).toBeGreaterThan(shortHalfLife);
  });
});

describe('realizedVolatilityBp', () => {
  it('returns null when there is not enough price history', () => {
    expect(realizedVolatilityBp([])).toBeNull();
    expect(realizedVolatilityBp([1])).toBeNull();
    // only one price change -> dispersion over the window is unknowable
    expect(realizedVolatilityBp([1, 1.05])).toBeNull();
  });

  it('returns null when no valid price points exist', () => {
    expect(realizedVolatilityBp([0, 0, 0])).toBeNull();
    expect(realizedVolatilityBp([NaN, NaN, NaN])).toBeNull();
  });

  it('returns 0 bp for a perfectly stable price', () => {
    expect(realizedVolatilityBp([1, 1, 1, 1])).toBe(0);
  });

  it('matches the closed-form value for an alternating +/-5% series', () => {
    const prices = [1, 1.05, 1, 1.05, 1];
    const expected = Math.log(1.05) * (4 / Math.sqrt(3)) * 10000;
    expect(realizedVolatilityBp(prices)).toBeCloseTo(expected, 6);
  });

  it('scales with the magnitude of price swings', () => {
    const small = realizedVolatilityBp([1, 1.01, 1, 1.01, 1]);
    const large = realizedVolatilityBp([1, 1.1, 1, 1.1, 1]);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large!).toBeGreaterThan(small! * 5);
  });

  it('skips invalid price points instead of producing NaN', () => {
    const result = realizedVolatilityBp([1, 0, 1.05, 1, 1.05, 1]);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!)).toBe(true);
    expect(result!).toBeGreaterThanOrEqual(0);
  });
});

describe('HorizonVolatilitySource', () => {
  const NOW_MS = Date.parse('2026-09-25T12:00:00Z');
  const iso = (secondsAgo: number) =>
    new Date(NOW_MS - secondsAgo * 1000).toISOString();

  const stubHorizon = (records: any[]) => {
    const source = new HorizonVolatilitySource('https://horizon.test', {
      now: () => NOW_MS,
    });
    (source as any).horizonServer = {
      trades: () => ({
        forLiquidityPool: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({ records }),
            }),
          }),
        }),
      }),
    };
    return source;
  };

  it('computes volatility from trade price history', async () => {
    const records = [
      { ledger_close_time: iso(86400 * 6), price: { n: '100', d: '100' } },
      { ledger_close_time: iso(86400 * 5), price: { n: '110', d: '100' } },
      { ledger_close_time: iso(86400 * 4), price: { n: '100', d: '100' } },
      { ledger_close_time: iso(86400 * 3), price: { n: '110', d: '100' } },
      { ledger_close_time: iso(60 * 60), price: { n: '100', d: '100' } },
      { ledger_close_time: iso(60 * 30), price: { n: '110', d: '100' } },
      { ledger_close_time: iso(60), price: { n: '100', d: '100' } },
    ];

    const metrics = await stubHorizon(records).getVolatility('pool-id');

    expect(metrics).not.toBeNull();
    expect(Number.isFinite(metrics!.volatility_24h)).toBe(true);
    expect(Number.isFinite(metrics!.volatility_7d)).toBe(true);
    expect(metrics!.volatility_24h).toBeGreaterThanOrEqual(0);
    expect(metrics!.volatility_7d).toBeGreaterThanOrEqual(0);
  });

  it('returns null when the 24h window has too little price history', async () => {
    const records = [
      { ledger_close_time: iso(86400 * 6), price: { n: '100', d: '100' } },
      { ledger_close_time: iso(86400 * 5), price: { n: '110', d: '100' } },
      { ledger_close_time: iso(86400 * 4), price: { n: '100', d: '100' } },
      { ledger_close_time: iso(60), price: { n: '105', d: '100' } },
    ];

    expect(await stubHorizon(records).getVolatility('pool-id')).toBeNull();
  });

  it('returns null when there is no trade history at all', async () => {
    expect(await stubHorizon([]).getVolatility('pool-id')).toBeNull();
  });
});

describe('ArbitrageScanner volatility integration', () => {
  const poolRecord = {
    id: 'pool-1',
    reserves: [{ amount: '1000' }, { amount: '2000' }],
  };

  const sourceReturning = (metrics: VolatilityMetrics | null): VolatilitySource => ({
    getVolatility: async () => metrics,
  });

  const zeroCostEstimator: RoundTripCostEstimator = {
    estimateRoundTripCosts: async ({ asset }) => ({
      asset,
      networkCost: BigInt(0),
      executionCost: BigInt(0),
      protocolCost: BigInt(0),
    }),
  };

  const buildScanner = (
    source: VolatilitySource,
    roundTripCostEstimator = zeroCostEstimator,
  ) =>
    new ArbitrageScanner('https://horizon.test', {
      volatilitySource: source,
      roundTripCostEstimator,
    });

  it('uses real volatility from the source and rounds to whole basis points', async () => {
    const scanner = buildScanner(
      sourceReturning({ volatility_24h: 123.4, volatility_7d: 567.6, sampleSize_24h: 25, sampleSize_7d: 100 }),
    );

    const metrics = await (scanner as any).parsePoolMetrics(poolRecord);

    expect(metrics).not.toBeNull();
    expect(metrics.volatility_24h).toBe(123);
    expect(metrics.volatility_7d).toBe(568);
    expect(metrics.confidence).toBeGreaterThan(0);
  });

  it('skips pools when price history is unavailable instead of fabricating values', async () => {
    const scanner = buildScanner(sourceReturning(null));

    const metrics = await (scanner as any).parsePoolMetrics(poolRecord);

    expect(metrics).toBeNull();
  });

  it('filters opportunities using the fetched volatility', async () => {
    const scanner = buildScanner(sourceReturning({ volatility_24h: 500, volatility_7d: 600, sampleSize_24h: 30, sampleSize_7d: 100 }));
    jest
      .spyOn(scanner, 'scanAllPools')
      .mockResolvedValue([
        {
          pool_id: 'low-vol-pool',
          current_apy: 1200,
          total_liquidity: BigInt(3000),
          reserve_a: BigInt(1000),
          reserve_b: BigInt(2000),
          volatility_24h: 500,
          volatility_7d: 600,
          confidence: 75,
        },
        {
          pool_id: 'high-vol-pool',
          current_apy: 5000,
          total_liquidity: BigInt(3000),
          reserve_a: BigInt(1000),
          reserve_b: BigInt(2000),
          volatility_24h: 20000,
          volatility_7d: 30000,
          confidence: 75,
        },
      ]);

    const opportunities = await scanner.findOpportunities(1000, 200, 100, {
      investmentAmount: BigInt(1_000_000),
      investmentAsset: 'USDC',
      sourcePoolId: 'current-pool',
    });

    expect(opportunities.map((opportunity) => opportunity.pool_id)).toEqual([
      'low-vol-pool',
    ]);
    expect(opportunities[0].il_risk).toBe(500);
    expect(typeof opportunities[0].net_profit).toBe('bigint');
    expect(opportunities[0].confidence).toBe(75);
  });
});

describe('ArbitrageOptimizer confidence-weighted ranking', () => {
  it('ranks opportunities higher when confidence is higher', () => {
    const opportunities = [
      {
        pool_id: 'pool-a',
        current_apy: 1000,
        projected_apy: 1500,
        il_risk: 100,
        net_profit: BigInt(400000),
        apy_delta: 500,
        recommended: true,
        confidence: 50, // Lower confidence
      },
      {
        pool_id: 'pool-b',
        current_apy: 1000,
        projected_apy: 1500,
        il_risk: 100,
        net_profit: BigInt(400000),
        apy_delta: 500,
        recommended: true,
        confidence: 90, // Higher confidence
      },
    ];

    const ranked = ArbitrageOptimizer.rankOpportunities(opportunities, 5);

    expect(ranked[0].pool_id).toBe('pool-b'); // Higher confidence should rank first
    expect(ranked[1].pool_id).toBe('pool-a');
  });

  it('still considers APY delta when confidence is equal', () => {
    const opportunities = [
      {
        pool_id: 'pool-a',
        current_apy: 1000,
        projected_apy: 1400,
        il_risk: 100,
        net_profit: BigInt(300000),
        apy_delta: 400,
        recommended: true,
        confidence: 75,
      },
      {
        pool_id: 'pool-b',
        current_apy: 1000,
        projected_apy: 1600,
        il_risk: 100,
        net_profit: BigInt(500000),
        apy_delta: 600,
        recommended: true,
        confidence: 75,
      },
    ];

    const ranked = ArbitrageOptimizer.rankOpportunities(opportunities, 5);

    expect(ranked[0].pool_id).toBe('pool-b'); // Higher APY delta should rank first
    expect(ranked[1].pool_id).toBe('pool-a');
  });

  it('balances confidence and risk when ranking', () => {
    const opportunities = [
      {
        pool_id: 'pool-a',
        current_apy: 1000,
        projected_apy: 1500,
        il_risk: 50, // Lower risk
        net_profit: BigInt(450000),
        apy_delta: 500,
        recommended: true,
        confidence: 60,
      },
      {
        pool_id: 'pool-b',
        current_apy: 1000,
        projected_apy: 1500,
        il_risk: 200, // Higher risk
        net_profit: BigInt(300000),
        apy_delta: 500,
        recommended: true,
        confidence: 95,
      },
    ];

    const ranked = ArbitrageOptimizer.rankOpportunities(opportunities, 5);

    // With moderate risk tolerance (5), lower risk should win despite lower confidence
    expect(ranked[0].pool_id).toBe('pool-a');
  });
});

describe('ArbitrageScanner round-trip cost scoring', () => {
  const source: VolatilitySource = {
    getVolatility: async () => ({ volatility_24h: 100, volatility_7d: 100 }),
  };
  const amount = BigInt(10_000);
  const scanOptions = {
    investmentAmount: amount,
    investmentAsset: 'USDC',
    sourcePoolId: 'source-pool',
  };
  const makePool = (poolId: string, apy: number) => ({
    pool_id: poolId,
    current_apy: apy,
    total_liquidity: BigInt(1_000_000),
    reserve_a: BigInt(500_000),
    reserve_b: BigInt(500_000),
    volatility_24h: 100,
    volatility_7d: 100,
  });
  const buildScanner = (
    pools: ReturnType<typeof makePool>[],
    estimator?: RoundTripCostEstimator,
  ) => {
    const scanner = new ArbitrageScanner('https://horizon.test', {
      volatilitySource: source,
      roundTripCostEstimator: estimator,
    });
    jest.spyOn(scanner, 'scanAllPools').mockResolvedValue(pools);
    return scanner;
  };
  const fixedCosts = (
    costs: (poolId: string) => { networkCost: bigint; executionCost: bigint; protocolCost: bigint } | null,
    asset = 'USDC',
  ): RoundTripCostEstimator => ({
    estimateRoundTripCosts: async ({ destinationPoolId }) => {
      const estimate = costs(destinationPoolId);
      return estimate ? { ...estimate, asset } : null;
    },
  });

  it('rejects grossly attractive opportunities whose round-trip costs exceed one year of gain', async () => {
    const scanner = buildScanner(
      [makePool('expensive', 2000)],
      fixedCosts(() => ({
        networkCost: BigInt(1),
        executionCost: BigInt(900),
        protocolCost: BigInt(200),
      })),
    );

    expect(await scanner.findOpportunities(1000, 100, 100, scanOptions)).toEqual([]);
  });

  it('keeps opportunities profitable after round-trip costs and separates gross from net', async () => {
    const scanner = buildScanner(
      [makePool('profitable', 2000)],
      fixedCosts(() => ({
        networkCost: BigInt(10),
        executionCost: BigInt(50),
        protocolCost: BigInt(40),
      })),
    );

    const [opportunity] = await scanner.findOpportunities(1000, 100, 100, scanOptions);

    expect(opportunity.gross_profit).toBe(BigInt(1000));
    expect(opportunity.round_trip_cost).toBe(BigInt(100));
    expect(opportunity.net_profit).toBe(BigInt(900));
    expect(opportunity.recommended).toBe(true);

    const profitability = ArbitrageOptimizer.calculateProfitability(opportunity, amount);
    expect(profitability.costEstimateAvailable).toBe(true);
    expect(profitability.grossProfit).toBe(BigInt(1000));
    expect(profitability.netProfit).toBe(BigInt(800));

    const simulation = await new ArbitrageExecutor('https://horizon.test').simulateRebalance(
      opportunity,
      amount,
    );
    expect(simulation.costEstimateAvailable).toBe(true);
    expect(simulation.totalCost).toBe(BigInt(200)); // 100 fees + 100 bp IL risk
    expect(simulation.netProfit).toBe(BigInt(800));

    const unsafeRiskOpportunity = { ...opportunity, il_risk: 2000 };
    await expect(
      new ArbitrageExecutor('https://horizon.test').executeArbitrage(
        unsafeRiskOpportunity,
        'source-pool',
        amount,
        '',
      ),
    ).resolves.toMatchObject({
      success: false,
      error: 'Opportunity is not profitable after round-trip costs and IL risk',
    });
  });

  it('ranks competing opportunities by net return rather than gross APY', async () => {
    const scanner = buildScanner(
      [makePool('high-gross', 3000), makePool('low-cost', 2500)],
      fixedCosts((poolId) =>
        poolId === 'high-gross'
          ? { networkCost: BigInt(0), executionCost: BigInt(1800), protocolCost: BigInt(0) }
          : { networkCost: BigInt(0), executionCost: BigInt(100), protocolCost: BigInt(0) },
      ),
    );

    const opportunities = await scanner.findOpportunities(1000, 100, 100, scanOptions);

    expect(opportunities.map((opportunity) => opportunity.pool_id)).toEqual([
      'low-cost',
      'high-gross',
    ]);
    expect(opportunities[0].net_profit).toBeGreaterThan(opportunities[1].net_profit);
  });

  it('preserves gross scoring order for negligible costs while requiring positive net profit', async () => {
    const scanner = buildScanner(
      [makePool('larger-return', 2500), makePool('smaller-return', 2000)],
      fixedCosts(() => ({
        networkCost: BigInt(0),
        executionCost: BigInt(0),
        protocolCost: BigInt(0),
      })),
    );

    const opportunities = await scanner.findOpportunities(1000, 100, 100, scanOptions);

    expect(opportunities.map((opportunity) => opportunity.pool_id)).toEqual([
      'larger-return',
      'smaller-return',
    ]);
  });

  it('fails closed for missing estimators, missing estimates, negative values, and mismatched assets', async () => {
    const pool = [makePool('candidate', 2000)];
    const withoutEstimator = buildScanner(pool);
    const noEstimate = buildScanner(pool, fixedCosts(() => null));
    const negativeEstimate = buildScanner(
      pool,
      fixedCosts(() => ({
        networkCost: BigInt(-1),
        executionCost: BigInt(0),
        protocolCost: BigInt(0),
      })),
    );
    const wrongAsset = buildScanner(
      pool,
      fixedCosts(
        () => ({ networkCost: BigInt(0), executionCost: BigInt(0), protocolCost: BigInt(0) }),
        'XLM',
      ),
    );
    const failingEstimator: RoundTripCostEstimator = {
      estimateRoundTripCosts: async () => {
        throw new Error('quote unavailable');
      },
    };
    const malformedEstimator: RoundTripCostEstimator = {
      estimateRoundTripCosts: async () =>
        ({
          asset: 'USDC',
          networkCost: '0',
          executionCost: BigInt(0),
          protocolCost: BigInt(0),
        } as unknown as RoundTripCostEstimate),
    };
    const failedEstimate = buildScanner(pool, failingEstimator);
    const malformedEstimate = buildScanner(pool, malformedEstimator);

    await expect(withoutEstimator.findOpportunities(1000, 100, 100, scanOptions)).resolves.toEqual([]);
    await expect(noEstimate.findOpportunities(1000, 100, 100, scanOptions)).resolves.toEqual([]);
    await expect(negativeEstimate.findOpportunities(1000, 100, 100, scanOptions)).resolves.toEqual([]);
    await expect(wrongAsset.findOpportunities(1000, 100, 100, scanOptions)).resolves.toEqual([]);
    await expect(failedEstimate.findOpportunities(1000, 100, 100, scanOptions)).resolves.toEqual([]);
    await expect(malformedEstimate.findOpportunities(1000, 100, 100, scanOptions)).resolves.toEqual([]);
  });

  it('rejects costs equal to gains and handles zero and unusually large values exactly', async () => {
    const equalCost = buildScanner(
      [makePool('break-even', 2000)],
      fixedCosts(() => ({
        networkCost: BigInt(0),
        executionCost: BigInt(1000),
        protocolCost: BigInt(0),
      })),
    );
    expect(await equalCost.findOpportunities(1000, 0, 100, scanOptions)).toEqual([]);
    expect(await equalCost.findOpportunities(2000, 0, 100, scanOptions)).toEqual([]);

    const largeAmount = BigInt('100000000000000000000000000000000000000');
    const largeScanner = buildScanner(
      [makePool('large', 2000)],
      fixedCosts(() => ({
        networkCost: BigInt(0),
        executionCost: BigInt(1),
        protocolCost: BigInt(0),
      })),
    );
    const [largeOpportunity] = await largeScanner.findOpportunities(1000, 100, 100, {
      ...scanOptions,
      investmentAmount: largeAmount,
    });
    expect(largeOpportunity.gross_profit).toBe((largeAmount * BigInt(1000)) / BigInt(10000));
    expect(largeOpportunity.net_profit).toBe(largeOpportunity.gross_profit! - BigInt(1));
  });
});
