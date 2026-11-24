import {
  ExecutionBudgetManager,
  STATE_KEY_EXECUTION_BUDGETS,
} from './keeperBudgets';

describe('ExecutionBudgetManager', () => {
  it('allows executions up to the configured limit and blocks the next one', () => {
    let now = 1_000;
    const manager = new ExecutionBudgetManager(
      { 'strategy-1': { maxExecutions: 2, windowMs: 1_000 } },
      { now: () => now }
    );

    expect(manager.tryAcquire('strategy-1')).toMatchObject({
      allowed: true,
      used: 1,
      remaining: 1,
      resetAt: 2_000,
    });
    expect(manager.tryAcquire('strategy-1')).toMatchObject({
      allowed: true,
      used: 2,
      remaining: 0,
    });
    expect(manager.tryAcquire('strategy-1')).toMatchObject({
      allowed: false,
      used: 2,
      remaining: 0,
      reason: 'strategy_budget_exceeded',
    });
  });

  it('refills at the window boundary and treats an exact boundary as a new window', () => {
    let now = 500;
    const manager = new ExecutionBudgetManager(
      { 7: { maxExecutions: 1, windowMs: 1_000 } },
      { now: () => now }
    );

    expect(manager.tryAcquire(7).allowed).toBe(true);
    expect(manager.tryAcquire(7).allowed).toBe(false);

    now = 999;
    expect(manager.tryAcquire(7).allowed).toBe(false);

    now = 1_000;
    expect(manager.tryAcquire(7)).toMatchObject({ allowed: true, used: 1, resetAt: 2_000 });
  });

  it('leaves unconfigured strategies unlimited', () => {
    const manager = new ExecutionBudgetManager({});

    for (let i = 0; i < 5; i += 1) {
      expect(manager.tryAcquire('unconfigured')).toMatchObject({
        allowed: true,
        limit: null,
        remaining: null,
      });
    }
  });

  it('counts failed executions because acquisition happens before the RPC write', () => {
    const manager = new ExecutionBudgetManager(
      { 'strategy-2': { maxExecutions: 1, windowMs: 60_000 } },
      { now: () => 0 }
    );

    expect(manager.tryAcquire('strategy-2').allowed).toBe(true);

    expect(manager.getSnapshot('strategy-2')).toMatchObject({ used: 1, allowed: false });
    expect(manager.tryAcquire('strategy-2').allowed).toBe(false);
  });

  it('resets counters when the clock moves backwards', () => {
    let now = 5_000;
    const manager = new ExecutionBudgetManager(
      { 'strategy-3': { maxExecutions: 1, windowMs: 1_000 } },
      { now: () => now }
    );

    expect(manager.tryAcquire('strategy-3').allowed).toBe(true);
    now = 4_000;

    expect(manager.tryAcquire('strategy-3')).toMatchObject({ allowed: true, used: 1 });
  });

  it('rejects invalid budget configuration', () => {
    expect(
      () => new ExecutionBudgetManager({ bad: { maxExecutions: 0, windowMs: 1_000 } })
    ).toThrow(/maxExecutions/);
    expect(
      () => new ExecutionBudgetManager({ bad: { maxExecutions: 1, windowMs: 0 } })
    ).toThrow(/windowMs/);
    expect(
      () => new ExecutionBudgetManager({ bad: { maxExecutions: 1.5, windowMs: 1_000 } })
    ).toThrow(/maxExecutions/);
  });

  it('round-trips usage through checkpoint metadata', () => {
    const manager = new ExecutionBudgetManager(
      { 'strategy-4': { maxExecutions: 1, windowMs: 10_000 } },
      { now: () => 1_000 }
    );
    manager.tryAcquire('strategy-4');

    const metadata = manager.toMetadata();
    expect(metadata[STATE_KEY_EXECUTION_BUDGETS]).toContain('strategy-4');

    const restored = new ExecutionBudgetManager(
      { 'strategy-4': { maxExecutions: 1, windowMs: 10_000 } },
      { now: () => 1_500 }
    );
    restored.restoreFromMetadata(metadata);

    expect(restored.getSnapshot('strategy-4')).toMatchObject({ used: 1, allowed: false });
  });

  it('fails closed on corrupt checkpoint metadata', () => {
    const manager = new ExecutionBudgetManager({
      'strategy-5': { maxExecutions: 1, windowMs: 10_000 },
    });

    expect(() => manager.restoreFromMetadata({ [STATE_KEY_EXECUTION_BUDGETS]: '{' })).toThrow(
      /Invalid execution budget checkpoint metadata/
    );
  });
});
