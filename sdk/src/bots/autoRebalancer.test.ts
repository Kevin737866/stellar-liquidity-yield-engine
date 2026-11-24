import { ArbitrageScanner, ArbitrageExecutor, Opportunity } from '../arbitrage';
import { WriteRateLimiter } from '../utils/rateLimiter';
import { MemoryCheckpointStore } from '../persistence';
import {
  AutoRebalancer,
  RebalancerConfig,
  STATE_KEY_LAST_CONSUMED_MINUTE,
  STATE_KEY_LAST_EXECUTION_TIME,
} from './autoRebalancer';

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
    expect(report!.lagLedgers).toBe(2000);
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

describe('AutoRebalancer cron scheduling', () => {
  it('isReadyForRebalance returns true when cooldown has passed (cooldown-only mode)', () => {
    const config = baseConfig({
      cooldownHours: 1,
      cronExpression: undefined,
    } as RebalancerConfig);

    const keeper = new AutoRebalancer(config);

    ;(keeper as any).lastExecutionTime = Date.now() - 2 * 3600 * 1000;

    expect(keeper['isReadyForRebalance']()).toBe(true);
  });

  it('isReadyForRebalance returns true when cron expression is set and cooldown satisfied (combined mode)', () => {
    const config = baseConfig({
      cooldownHours: 1,
      cronExpression: '*',
    } as RebalancerConfig);

    const keeper = new AutoRebalancer(config);

    ;(keeper as any).lastExecutionTime = Date.now() - 3600000;

    expect(keeper['isReadyForRebalance']()).toBe(true);
  });

  it('isReadyForRebalance returns false when cron matches but cooldown not satisfied', () => {
    const config = baseConfig({
      cooldownHours: 24,
      cronExpression: '*',
    } as RebalancerConfig);

    const keeper = new AutoRebalancer(config);

    ;(keeper as any).lastExecutionTime = Date.now();

    expect(keeper['isReadyForRebalance']()).toBe(false);
  });

  it('isReadyForRebalance returns false when cooldown satisfied outside cron schedule', () => {
    const config = baseConfig({
      cooldownHours: 1,
      cronExpression: '99', // minute 99 never matches
    } as RebalancerConfig);

    const keeper = new AutoRebalancer(config);

    ;(keeper as any).lastExecutionTime = Date.now() - 3600000;

    expect(keeper['isReadyForRebalance']()).toBe(false);
  });

  it('prevents repeated rebalances during the same matching minute', () => {
    const config = baseConfig({
      cooldownHours: 1,
      cronExpression: '*',
    } as RebalancerConfig);

    const keeper = new AutoRebalancer(config);

    ;(keeper as any).lastExecutionTime = Date.now() - 3600000;

    const firstResult = keeper['isReadyForRebalance']();
    expect(firstResult).toBe(true);

    const secondResult = keeper['isReadyForRebalance']();
    expect(secondResult).toBe(false);
  });

  it('a later matching minute is eligible again after consumption', () => {
    const config = baseConfig({
      cooldownHours: 1,
      cronExpression: '*',
    } as RebalancerConfig);

    const keeper = new AutoRebalancer(config);

    ;(keeper as any).lastExecutionTime = Date.now() - 3600000;

    // First call: cron '*' always matches, cooldown satisfied, consumes current minute
    const firstResult = keeper['isReadyForRebalance']();
    expect(firstResult).toBe(true);

    // Same minute: already consumed, returns false
    const secondResult = keeper['isReadyForRebalance']();
    expect(secondResult).toBe(false);

    // Later minute: new minute, eligible again
    ;(keeper as any).lastConsumedMinute = -1;

    const now = new Date();
    now.setMinutes((now.getMinutes() + 15) % 60);

    ;(keeper as any).lastExecutionTime = Date.now() - 3600000;

    const result = keeper['isReadyForRebalance']();
    expect(result).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// Durable keeper state
// ---------------------------------------------------------------------------

describe('AutoRebalancer durable state', () => {
  it('exposes its default state', () => {
    const keeper = new AutoRebalancer(baseConfig());
    expect(keeper.getState()).toEqual({ lastExecutionTime: 0, lastConsumedMinute: -1 });
  });

  it('does nothing when no state store is configured', async () => {
    const keeper = new AutoRebalancer(baseConfig());
    expect(await keeper.restoreState()).toBe(false);
    expect(await keeper.persistState()).toBeNull();
  });

  it('writes the last execution time and consumed minute', async () => {
    const store = new MemoryCheckpointStore();
    const keeper = new AutoRebalancer(baseConfig({ stateStore: store }));
    (keeper as any).lastExecutionTime = 1_700_000_000_000;
    (keeper as any).lastConsumedMinute = 17;

    await keeper.persistState();

    expect(store.peek()!.metadata).toEqual({
      [STATE_KEY_LAST_EXECUTION_TIME]: 1_700_000_000_000,
      [STATE_KEY_LAST_CONSUMED_MINUTE]: 17,
    });
  });

  it('restores the state written by a previous process', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 0,
      lastProcessedLedger: -1,
      updatedAt: 0,
      metadata: {
        [STATE_KEY_LAST_EXECUTION_TIME]: 1_600_000_000_000,
        [STATE_KEY_LAST_CONSUMED_MINUTE]: 42,
      },
    });

    const keeper = new AutoRebalancer(baseConfig({ stateStore: store }));
    expect(await keeper.restoreState()).toBe(true);

    expect(keeper.getState()).toEqual({
      lastExecutionTime: 1_600_000_000_000,
      lastConsumedMinute: 42,
    });
  });

  it('continues to honour the cooldown after a restart', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 0,
      lastProcessedLedger: -1,
      updatedAt: 0,
      metadata: {
        [STATE_KEY_LAST_EXECUTION_TIME]: Date.now(),
        [STATE_KEY_LAST_CONSUMED_MINUTE]: -1,
      },
    });

    const scanner = { findOpportunities: jest.fn() };
    const keeper = new AutoRebalancer(baseConfig({ cooldownHours: 24, stateStore: store }), {
      scanner: scanner as unknown as ArbitrageScanner,
    });

    const results = await keeper.run();

    // The keeper remembered that it executed just before the restart, so it
    // must not execute again.
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/Cooldown active/);
    expect(scanner.findOpportunities).not.toHaveBeenCalled();
  });

  it('fails closed when the stored state cannot be read', async () => {
    const store = {
      load: async () => {
        throw new Error('corrupt state');
      },
      save: async () => undefined,
      clear: async () => undefined,
    };

    const scanner = { findOpportunities: jest.fn() };
    const keeper = new AutoRebalancer(baseConfig({ stateStore: store }), {
      scanner: scanner as unknown as ArbitrageScanner,
    });

    const results = await keeper.run();

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/corrupt state/);
    expect(scanner.findOpportunities).not.toHaveBeenCalled();
  });
});

// Issue #484: dry-run mode for keeper strategy execution.
describe('AutoRebalancer dry-run mode', () => {
  /** An opportunity with a complete cost estimate, so it passes every gate. */
  function profitableOpportunity(): Opportunity {
    return opportunity({
      round_trip_cost: BigInt(10),
      gross_profit: BigInt(5_000),
      investment_amount: BigInt(1_000_000_000),
      net_profit: BigInt(4_990),
    });
  }

  function scannerWithOpportunity(): ArbitrageScanner {
    return {
      findOpportunities: async () => [profitableOpportunity()],
    } as unknown as ArbitrageScanner;
  }

  function executorStub() {
    const executeArbitrage = jest.fn(async () => ({
      success: true,
      transactionHash: 'deadbeef',
    }));
    const simulateRebalance = jest.fn(async () => ({
      totalCost: BigInt(10),
      netProfit: BigInt(4_990),
      profitable: true,
      costEstimateAvailable: true,
    }));
    return {
      executor: { executeArbitrage, simulateRebalance } as unknown as ArbitrageExecutor,
      executeArbitrage,
      simulateRebalance,
    };
  }

  it('evaluates the opportunity and submits nothing', async () => {
    const { executor, executeArbitrage, simulateRebalance } = executorStub();
    const keeper = new AutoRebalancer(config(), {
      scanner: scannerWithOpportunity(),
      executor,
    });

    const results = await keeper.run({ dryRun: true });

    expect(simulateRebalance).toHaveBeenCalledTimes(1);
    expect(executeArbitrage).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      dryRun: true,
      wouldExecute: true,
      success: false,
      opportunity: { pool_id: 'POOL-B' },
    });
    expect(results[0].message).toMatch(/dry run/i);
    // The preview still reports the net profit the live run would have earned.
    expect(results[0].profit).toBeGreaterThan(BigInt(0));
  });

  it('leaves the cooldown and durable state untouched so a live run still executes', async () => {
    const store = new MemoryCheckpointStore();
    const { executor, executeArbitrage } = executorStub();
    const keeper = new AutoRebalancer(
      baseConfig({ cooldownHours: 24, stateStore: store }),
      { scanner: scannerWithOpportunity(), executor },
    );

    const dryResults = await keeper.run({ dryRun: true });

    expect(dryResults[0].wouldExecute).toBe(true);
    expect(keeper.getState().lastExecutionTime).toBe(0);
    expect(await store.load()).toBeNull();

    const liveResults = await keeper.run();

    expect(executeArbitrage).toHaveBeenCalledTimes(1);
    expect(liveResults[0].success).toBe(true);
    expect(liveResults[0].dryRun).toBeUndefined();
    expect(keeper.getState().lastExecutionTime).toBeGreaterThan(0);
  });

  it('honours the keeper-level dryRun default without a per-run flag', async () => {
    const { executor, executeArbitrage } = executorStub();
    const keeper = new AutoRebalancer(baseConfig({ dryRun: true }), {
      scanner: scannerWithOpportunity(),
      executor,
    });

    const results = await keeper.run();

    expect(executeArbitrage).not.toHaveBeenCalled();
    expect(results[0].dryRun).toBe(true);
    expect(results[0].wouldExecute).toBe(true);
  });

  it('tags decision-gate results as dry runs without claiming execution', async () => {
    const { executor, executeArbitrage } = executorStub();
    const keeper = new AutoRebalancer(config(), {
      scanner: { findOpportunities: async () => [] } as unknown as ArbitrageScanner,
      executor,
    });

    const results = await keeper.run({ dryRun: true });

    expect(executeArbitrage).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].dryRun).toBe(true);
    expect(results[0].success).toBe(false);
    expect(results[0].wouldExecute).toBeUndefined();
    expect(results[0].message).toMatch(/no profitable opportunities/i);
  });
});
