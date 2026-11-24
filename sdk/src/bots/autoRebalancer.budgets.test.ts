import { ArbitrageExecutor, ArbitrageScanner, Opportunity } from '../arbitrage';
import { MemoryCheckpointStore } from '../persistence';
import { STATE_KEY_EXECUTION_BUDGETS } from '../keeperBudgets';
import { AutoRebalancer, RebalancerConfig, SkippedActionLog } from './autoRebalancer';

const POSITION_SIZE = BigInt(1_000_000_000);

function opportunity(): Opportunity {
  return {
    pool_id: 'POOL-B',
    current_apy: 1500,
    projected_apy: 2000,
    il_risk: 50,
    gross_profit: BigInt(50_000_000),
    round_trip_cost: BigInt(1_000),
    investment_amount: POSITION_SIZE,
    net_profit: BigInt(49_000_000),
    apy_delta: 500,
    recommended: true,
    confidence: 100,
  };
}

function config(overrides: Partial<RebalancerConfig> = {}): RebalancerConfig {
  return {
    vaultAddress: 'VAULT',
    currentPoolId: 'POOL-A',
    currentVaultApy: 1500,
    minApyDelta: 200,
    maxIlTolerance: 100,
    cooldownHours: 0,
    riskTolerance: 5,
    maxPositionSize: POSITION_SIZE,
    strategyId: 'strategy-1',
    clock: () => 0,
    ...overrides,
  };
}

function scannerStub() {
  return { findOpportunities: jest.fn(async () => [opportunity()]) };
}

function executorStub(executeResult = { success: true, transactionHash: 'TX-HASH' }) {
  return {
    simulateRebalance: jest.fn(async () => ({
      costEstimateAvailable: true,
      profitable: true,
      netProfit: BigInt(1_000),
    })),
    executeArbitrage: jest.fn(async () => executeResult),
    getWriteLimiterStats: jest.fn(() => ({
      submitted: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      throttled: 0,
      inFlight: 0,
      queued: 0,
    })),
  };
}

function keeperWith(
  overrides: Partial<RebalancerConfig>,
  scanner: ReturnType<typeof scannerStub>,
  executor: ReturnType<typeof executorStub>
) {
  return new AutoRebalancer(config(overrides), {
    scanner: scanner as unknown as ArbitrageScanner,
    executor: executor as unknown as ArbitrageExecutor,
  });
}

describe('AutoRebalancer per-strategy execution budgets', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips the second execution when the strategy budget is exhausted', async () => {
    const scanner = scannerStub();
    const executor = executorStub();
    const keeper = keeperWith(
      {
        strategyExecutionBudgets: {
          'strategy-1': { maxExecutions: 1, windowMs: 60_000 },
        },
      },
      scanner,
      executor
    );

    const first = await keeper.run();
    const second = await keeper.run();

    expect(first[0].success).toBe(true);
    expect(first[0].budget).toMatchObject({ allowed: true, used: 1 });
    expect(second[0].success).toBe(false);
    expect(second[0].message).toMatch(/Execution budget exhausted for strategy strategy-1/);
    expect(second[0].budget).toMatchObject({ allowed: false, reason: 'strategy_budget_exceeded' });
    expect(executor.executeArbitrage).toHaveBeenCalledTimes(1);

    const skipped = keeper.getSkippedActions().find(
      (entry: SkippedActionLog) => entry.reason === 'strategy_budget_exceeded'
    );
    expect(skipped).toMatchObject({ strategyId: 'strategy-1' });
  });

  it('charges a budget to an execution attempt even when the write fails', async () => {
    const scanner = scannerStub();
    const executor = executorStub({ success: false, error: 'RPC rejected' });
    const keeper = keeperWith(
      {
        strategyExecutionBudgets: {
          'strategy-1': { maxExecutions: 1, windowMs: 60_000 },
        },
      },
      scanner,
      executor
    );

    const first = await keeper.run();
    const second = await keeper.run();

    expect(first[0].message).toMatch(/Execution failed/);
    expect(second[0].message).toMatch(/Execution budget exhausted/);
    expect(executor.executeArbitrage).toHaveBeenCalledTimes(1);
  });

  it('keeps unconfigured strategies unlimited for backwards compatibility', async () => {
    const scanner = scannerStub();
    const executor = executorStub();
    const keeper = keeperWith({}, scanner, executor);

    const first = await keeper.run();
    const second = await keeper.run();

    expect(first[0].success).toBe(true);
    expect(second[0].success).toBe(true);
    expect(executor.executeArbitrage).toHaveBeenCalledTimes(2);
    expect(keeper.getExecutionBudgetStatus()).toMatchObject({ limit: null, allowed: true });
  });

  it('restores budget usage after a restart', async () => {
    const store = new MemoryCheckpointStore();
    const budgets = {
      'strategy-1': { maxExecutions: 1, windowMs: 60_000 },
    };
    const firstKeeper = keeperWith({ stateStore: store, strategyExecutionBudgets: budgets }, scannerStub(), executorStub());

    await firstKeeper.run();
    const checkpoint = store.peek();
    expect(checkpoint!.metadata).toHaveProperty(STATE_KEY_EXECUTION_BUDGETS);

    const secondKeeper = keeperWith({ stateStore: store, strategyExecutionBudgets: budgets }, scannerStub(), executorStub());
    const second = await secondKeeper.run();

    expect(second[0].success).toBe(false);
    expect(second[0].message).toMatch(/Execution budget exhausted/);
  });

  it('fails closed when budget checkpoint metadata is corrupt', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 0,
      lastProcessedLedger: -1,
      updatedAt: 0,
      metadata: {
        [STATE_KEY_EXECUTION_BUDGETS]: 'not-json',
      },
    });

    const scanner = scannerStub();
    const keeper = keeperWith(
      {
        stateStore: store,
        strategyExecutionBudgets: {
          'strategy-1': { maxExecutions: 1, windowMs: 60_000 },
        },
      },
      scanner,
      executorStub()
    );

    const results = await keeper.run();

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/Invalid execution budget checkpoint metadata/);
    expect(scanner.findOpportunities).not.toHaveBeenCalled();
  });
});
