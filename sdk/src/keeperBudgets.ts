export interface StrategyBudget {
  maxExecutions: number;
  windowMs: number;
}

export type StrategyExecutionBudgets = Record<string, StrategyBudget>;

export type ExecutionBudgetSkipReason = 'strategy_budget_exceeded';

export interface ExecutionBudgetDecision {
  allowed: boolean;
  strategyId: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  resetAt: number | null;
  reason?: ExecutionBudgetSkipReason;
}

export interface ExecutionBudgetUsage {
  windowStart: number;
  count: number;
}

export type ExecutionBudgetState = Record<string, ExecutionBudgetUsage>;

export interface ExecutionBudgetManagerOptions {
  now?: () => number;
}

export const STATE_KEY_EXECUTION_BUDGETS = 'executionBudgets';

export const STRATEGY_BUDGET_EXCEEDED_REASON: ExecutionBudgetSkipReason =
  'strategy_budget_exceeded';

const normalizeStrategyId = (strategyId: string | number): string => String(strategyId);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

export class ExecutionBudgetManager {
  private readonly budgets = new Map<string, StrategyBudget>();
  private readonly now: () => number;
  private usage: ExecutionBudgetState = {};

  constructor(
    budgets: StrategyExecutionBudgets = {},
    options: ExecutionBudgetManagerOptions = {}
  ) {
    this.now = options.now ?? Date.now;

    for (const [strategyId, budget] of Object.entries(budgets)) {
      if (!strategyId) {
        throw new Error('Strategy budget id must not be empty');
      }
      if (!budget || !isPositiveInteger(budget.maxExecutions)) {
        throw new Error(`Invalid maxExecutions for strategy ${strategyId}`);
      }
      if (!isPositiveInteger(budget.windowMs)) {
        throw new Error(`Invalid windowMs for strategy ${strategyId}`);
      }
      this.budgets.set(strategyId, { ...budget });
    }
  }

  getConfiguredStrategies(): string[] {
    return [...this.budgets.keys()];
  }

  getSnapshot(strategyId: string | number): ExecutionBudgetDecision {
    const id = normalizeStrategyId(strategyId);
    const budget = this.budgets.get(id);
    if (!budget) {
      return {
        allowed: true,
        strategyId: id,
        limit: null,
        used: 0,
        remaining: null,
        resetAt: null,
      };
    }

    const now = this.now();
    const windowStart = this.windowStart(now, budget.windowMs);
    const usage = this.usage[id];
    const used = this.usageCount(usage, windowStart, now);
    const remaining = Math.max(0, budget.maxExecutions - used);

    return {
      allowed: used < budget.maxExecutions,
      strategyId: id,
      limit: budget.maxExecutions,
      used,
      remaining,
      resetAt: windowStart + budget.windowMs,
      reason: used < budget.maxExecutions ? undefined : STRATEGY_BUDGET_EXCEEDED_REASON,
    };
  }

  tryAcquire(strategyId: string | number): ExecutionBudgetDecision {
    const decision = this.getSnapshot(strategyId);
    if (!decision.allowed || decision.limit === null || decision.resetAt === null) {
      return decision;
    }

    const windowMs = this.budgets.get(decision.strategyId)!.windowMs;
    const windowStart = decision.resetAt - windowMs;
    this.usage[decision.strategyId] = {
      windowStart,
      count: decision.used + 1,
    };

    return {
      ...decision,
      used: decision.used + 1,
      remaining: Math.max(0, decision.remaining! - 1),
      allowed: true,
      reason: undefined,
    };
  }

  getState(): ExecutionBudgetState {
    const state: ExecutionBudgetState = {};
    for (const [strategyId, usage] of Object.entries(this.usage)) {
      state[strategyId] = { ...usage };
    }
    return state;
  }

  restoreState(state: ExecutionBudgetState): void {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      throw new Error('Invalid execution budget state');
    }

    const restored: ExecutionBudgetState = {};
    for (const [strategyId, usage] of Object.entries(state)) {
      if (!this.budgets.has(strategyId)) continue;
      if (
        !usage ||
        typeof usage.windowStart !== 'number' ||
        !Number.isFinite(usage.windowStart) ||
        usage.windowStart < 0 ||
        typeof usage.count !== 'number' ||
        !Number.isInteger(usage.count) ||
        usage.count < 0
      ) {
        throw new Error(`Invalid execution budget state for strategy ${strategyId}`);
      }
      restored[strategyId] = { ...usage };
    }
    this.usage = restored;
  }

  toMetadata(): Record<string, string> {
    if (this.budgets.size === 0) return {};
    return { [STATE_KEY_EXECUTION_BUDGETS]: JSON.stringify(this.getState()) };
  }

  restoreFromMetadata(metadata: Record<string, string | number | boolean> = {}): void {
    if (this.budgets.size === 0) return;
    const raw = metadata[STATE_KEY_EXECUTION_BUDGETS];
    if (raw === undefined) return;
    if (typeof raw !== 'string') {
      throw new Error('Invalid execution budget checkpoint metadata');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid execution budget checkpoint metadata');
    }
    this.restoreState(parsed as ExecutionBudgetState);
  }

  private windowStart(now: number, windowMs: number): number {
    return Math.max(0, Math.floor(now / windowMs) * windowMs);
  }

  private usageCount(
    usage: ExecutionBudgetUsage | undefined,
    windowStart: number,
    now: number
  ): number {
    if (!usage) return 0;
    if (usage.windowStart > now) return 0;
    if (usage.windowStart !== windowStart) return 0;
    return Math.max(0, usage.count);
  }
}
