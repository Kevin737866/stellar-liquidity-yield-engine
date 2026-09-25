import {
  ArbitrageScanner,
  HorizonVolatilitySource,
  realizedVolatilityBp,
  VolatilityMetrics,
  VolatilitySource,
} from './arbitrage';

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

  const buildScanner = (source: VolatilitySource) =>
    new ArbitrageScanner('https://horizon.test', { volatilitySource: source });

  it('uses real volatility from the source and rounds to whole basis points', async () => {
    const scanner = buildScanner(
      sourceReturning({ volatility_24h: 123.4, volatility_7d: 567.6 }),
    );

    const metrics = await (scanner as any).parsePoolMetrics(poolRecord);

    expect(metrics).not.toBeNull();
    expect(metrics.volatility_24h).toBe(123);
    expect(metrics.volatility_7d).toBe(568);
  });

  it('skips pools when price history is unavailable instead of fabricating values', async () => {
    const scanner = buildScanner(sourceReturning(null));

    const metrics = await (scanner as any).parsePoolMetrics(poolRecord);

    expect(metrics).toBeNull();
  });

  it('filters opportunities using the fetched volatility', async () => {
    const scanner = buildScanner(sourceReturning({ volatility_24h: 500, volatility_7d: 600 }));
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
        },
        {
          pool_id: 'high-vol-pool',
          current_apy: 5000,
          total_liquidity: BigInt(3000),
          reserve_a: BigInt(1000),
          reserve_b: BigInt(2000),
          volatility_24h: 20000,
          volatility_7d: 30000,
        },
      ]);

    const opportunities = await scanner.findOpportunities(1000);

    expect(opportunities.map((opportunity) => opportunity.pool_id)).toEqual([
      'low-vol-pool',
    ]);
    expect(opportunities[0].il_risk).toBe(500);
    expect(typeof opportunities[0].net_profit).toBe('bigint');
  });
});
