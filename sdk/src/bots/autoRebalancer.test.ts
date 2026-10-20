import { ArbitrageScanner, ArbitrageExecutor, Opportunity } from '../arbitrage';
import { WriteRateLimiter } from '../utils/rateLimiter';
import { AutoRebalancer, RebalancerConfig } from './autoRebalancer';
import { ArbitrageExecutor, ArbitrageScanner, Opportunity } from '../arbitrage';

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    pool_id: 'POOL-B',
    current_apy: 1500,
    projected_apy: 2000,
    il_risk: 50,
    net_profit: BigInt(1000),
    apy_delta: 500,
    recommended: true,
    ...overrides,
  };
}

function config(): RebalancerConfig {
  return {
    vaultAddress: 'VAULT',
    currentPoolId: 'POOL-A',
    currentVaultApy: 1500,
    minApyDelta: 200,
    maxIlTolerance: 100,
    cooldownHours: 0,
    riskTolerance: 5,
    maxPositionSize: BigInt(1_000_000_000),
  };
}

function baseConfig(overrides: Partial<RebalancerConfig> = {}): RebalancerConfig {
  return {
    vaultAddress: 'VAULT',
    currentPoolId: 'POOL',
    currentVaultApy: 1500,
    minApyDelta: 200,
    maxIlTolerance: 100,
    cooldownHours: 24,
    riskTolerance: 5,
    maxPositionSize: BigInt(1_000_000_000),
    ...overrides,
  };
}

/** Scanner stub that always reports a single profitable opportunity. */
function scannerStub(): ArbitrageScanner {
  return {
    findOpportunities: async () => [opportunity()],
  } as unknown as ArbitrageScanner;
}

/** A virtual clock whose time only advances when `sleep` is called. */
function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe('AutoRebalancer write pacing', () => {
  it('routes keeper writes through the executor write limiter', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0 });
    const executor = new ArbitrageExecutor('https://horizon-testnet.stellar.org', {
      writeLimiter: limiter,
    });
    const keeper = new AutoRebalancer(config(), { scanner: scannerStub(), executor });

    const results = await keeper.run();

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    // The keeper's write went through the limiter.
    expect(limiter.stats().completed).toBe(1);
    expect(keeper.getWriteLimiterStats().completed).toBe(1);
  });

  it('throttles keeper writes when the pacing interval has not elapsed', async () => {
    const clock = virtualClock();
    const limiter = new WriteRateLimiter({
      minIntervalMs: 1000,
      maxConcurrent: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const executor = new ArbitrageExecutor('https://horizon-testnet.stellar.org', {
      writeLimiter: limiter,
    });
    const keeper = new AutoRebalancer(config(), { scanner: scannerStub(), executor });

    // A prior write at t=0 consumes the pacing window.
    await limiter.schedule(async () => undefined);
    expect(clock.now()).toBe(0);

    const results = await keeper.run();

    expect(results[0].success).toBe(true);
    // The keeper's write had to wait out the 1000ms pacing interval.
    expect(clock.now()).toBe(1000);
    expect(keeper.getWriteLimiterStats().throttled).toBe(1);
  });
});

describe('AutoRebalancer RPC lag wiring', () => {
  it('reports no lag when no head source is configured', async () => {
    const keeper = new AutoRebalancer(baseConfig());

    expect(await keeper.checkRpcLag()).toBeUndefined();
    expect(keeper.getLastLagReport()).toBeUndefined();
  });

  it('detects and records a lagging node through the configured head source', async () => {
    const keeper = new AutoRebalancer(
      baseConfig({
        rpcHeadSource: { getLatestLedger: async () => ({ sequence: 2000 }) },
        lagOptions: { warningLedgers: 5, criticalLedgers: 20 },
      }),
    );

    const report = await keeper.checkRpcLag();

    expect(report).toBeDefined();
    expect(report!.lagLedgers).toBe(2000); // processed marker still 0
    expect(report!.severity).toBe('critical');
    expect(report!.message).toMatch(/critically behind/);
    expect(keeper.getLastLagReport()).toEqual(report);
  });

  it('reports ok when the node head is current', async () => {
    const keeper = new AutoRebalancer(
      baseConfig({ rpcHeadSource: { getLatestLedger: async () => ({ sequence: 0 }) } }),
    );

    const report = await keeper.checkRpcLag();

    expect(report!.severity).toBe('ok');
    expect(report!.lagLedgers).toBe(0);
  });
});

describe('AutoRebalancer quote freshness', () => {
  it('declines a stale quote without calling the executor', async () => {
    const staleOpportunity: Opportunity = {
      pool_id: 'POOL-2',
      quote_timestamp: Date.now() - 2_000,
      current_apy: 1500,
      projected_apy: 3000,
      il_risk: 50,
      net_profit: BigInt(1_000_000),
      apy_delta: 1500,
      recommended: true,
    };
    jest.spyOn(ArbitrageScanner.prototype, 'findOpportunities').mockResolvedValue([staleOpportunity]);
    const execute = jest.spyOn(ArbitrageExecutor.prototype, 'executeArbitrage');
    const keeper = new AutoRebalancer(baseConfig({ maxQuoteAgeMs: 1_000 }));

    const results = await keeper.run();

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/Quote is stale/);
    expect(execute).not.toHaveBeenCalled();
  });
});
