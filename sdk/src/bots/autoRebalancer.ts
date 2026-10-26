import {
  ArbitrageScanner,
  ArbitrageExecutor,
  ArbitrageOptimizer,
  Opportunity,
  RoundTripCostEstimator,
} from '../arbitrage';
import { LedgerHeadSource, RpcLagMonitor, RpcLagOptions, RpcLagReport } from '../rpcSync';
import {
  createStateCheckpoint,
  type CheckpointStore,
  type KeeperCheckpoint,
} from '../persistence';
import { SorobanRpc } from 'stellar-sdk';
import axios from 'axios';

/** Metadata key holding the wall-clock time of the last successful rebalance. */
export const STATE_KEY_LAST_EXECUTION_TIME = 'lastExecutionTimeMs';

/** Metadata key holding the last cron minute that was consumed. */
export const STATE_KEY_LAST_CONSUMED_MINUTE = 'lastConsumedMinute';

export interface RebalancerConfig {
  vaultAddress: string;
  currentPoolId: string;
  currentVaultApy: number;
  minApyDelta: number; // Basis months
  maxIlTolerance: number; // Basis months
  cooldownHours: number;
  cronExpression?: string;
  telegramWebhookUrl?: string;
  discordWebhookUrl?: string;
  riskTolerance: number; // 1-10
  maxPositionSize: bigint;
  /** Asset represented by maxPositionSize and the cost estimator's amounts. */
  investmentAsset?: string;
  /** Required to produce arbitrage recommendations; unknown fees fail closed. */
  roundTripCostEstimator?: RoundTripCostEstimator;
  /**
   * RPC ledger-head source. When set, the keeper checks the node's head against
   * the last ledger it processed and warns before acting on stale data.
   */
  rpcHeadSource?: LedgerHeadSource;
  /** Thresholds for the RPC lag warning. */
  lagOptions?: RpcLagOptions;
  /**
   * Durable store for the keeper's own state (last execution time and the
   * last consumed cron minute).
   *
   * Without it a restart forgets that a rebalance already happened, and the
   * keeper would happily execute a second one as soon as it comes back up.
   * With it the keeper resumes exactly where it left off.
   */
  stateStore?: CheckpointStore;
}

/** The keeper state that has to survive a restart. */
export interface RebalancerState {
  /** Wall-clock time of the last successful rebalance (0 when none). */
  lastExecutionTime: number;
  /** The last cron minute that was consumed (-1 when none). */
  lastConsumedMinute: number;
}

export interface RebalanceResult {
  timestamp: number;
  success: boolean;
  opportunity?: Opportunity;
  profit?: bigint;
  message: string;
  /** RPC lag observed for this run, when a head source is configured. */
  lag?: RpcLagReport;
}

export interface AutoRebalancerOptions {
  /** Override the opportunity scanner (defaults to a real Horizon-backed one). */
  scanner?: ArbitrageScanner;
  /** Override the executor, e.g. to configure its write pacing. */
  executor?: ArbitrageExecutor;
}

/**
 * Structured log emitted whenever the keeper decides not to submit a
 * contract call (skipped or aborted action). These records are the main
 * debugging surface for decisions that never reached the chain.
 */
export interface SkippedActionLog {
  /** Event name, always 'keeper.action.skipped'. */
  event: 'keeper.action.skipped';
  /** Stable machine-readable reason code. */
  reason:
    | 'rpc_lag'
    | 'cooldown'
    | 'no_opportunities'
    | 'no_eligible_opportunities'
    | 'not_profitable'
    | 'no_cost_estimate'
    | 'simulation_negative'
    | 'simulation_no_cost_estimate'
    | 'execution_failed'
    | 'error';
  /** Human-readable detail for the skip. */
  message: string;
  /** Wallet/vault the keeper would have acted on behalf of. */
  vaultAddress: string;
  /** Pool the keeper currently holds. */
  currentPoolId: string;
  /** Pool the keeper would have moved into, when known. */
  targetPoolId?: string;
  /** Position size the attempt would have used, in strops. */
  amount: string;
  /** Investment asset for the attempt. */
  investmentAsset?: string;
  /** Net profit (strops) when a cost estimate was available. */
  netProfit?: string;
  /** APY delta of the candidate opportunity, in basis months. */
  apyDelta?: number;
  /** IL risk of the candidate opportunity, in basis months. */
  ilRisk?: number;
  /** RPC lag report at the time of the skip, when available. */
  lag?: RpcLagReport;
  /** Wall-clock timestamp of the skip decision. */
  timestamp: number;
}

export class AutoRebalancer {
  private config: RebalancerConfig;
  private scanner: ArbitrageScanner;
  private executor: ArbitrageExecutor;
  private executionHistory: RebalanceResult[] = [];
  private lastExecutionTime: number = 0;
  private lastConsumedMinute: number = -1;
  private lagMonitor?: RpcLagMonitor;
  private lastLag?: RpcLagReport;
  private skippedActions: SkippedActionLog[] = [];

  constructor(config: RebalancerConfig, options: AutoRebalancerOptions = {}) {
    this.config = config;
    this.scanner = new ArbitrageScanner('https://horizon.stellar.org', {
      roundTripCostEstimator: config.roundTripCostEstimator,
    });
    this.executor = new ArbitrageExecutor();
    if (config.rpcHeadSource) {
      this.lagMonitor = new RpcLagMonitor(config.rpcHeadSource, config.lagOptions);
    }
  }

  /** Write-pacing counters for the executor this keeper writes through. */
  getWriteLimiterStats() {
    return this.executor.getWriteLimiterStats();
  }

  /**
   * The keeper state that has to survive a restart.
   */
  getState(): RebalancerState {
    return {
      lastExecutionTime: this.lastExecutionTime,
      lastConsumedMinute: this.lastConsumedMinute,
    };
  }

  /**
   * Restore the keeper's state from the configured store.
   *
   * Called automatically at the start of the first {@link run}. Returns `true`
   * when a checkpoint was applied.
   *
   * @throws When the stored checkpoint cannot be read. The keeper fails closed
   *   in that case: without knowing when it last executed it must not execute
   *   again.
   */
  async restoreState(): Promise<boolean> {
    const store = this.config.stateStore;
    if (!store) {
      this.stateRestored = true;
      return false;
    }

    // Load first: if this throws, the keeper stays un-restored so the next
    // run retries (and fails closed again) instead of proceeding on defaults.
    const checkpoint = await store.load();
    this.stateRestored = true;
    if (!checkpoint) return false;

    const metadata = checkpoint.metadata ?? {};
    const lastExecutionTime = metadata[STATE_KEY_LAST_EXECUTION_TIME];
    if (typeof lastExecutionTime === 'number' && Number.isFinite(lastExecutionTime)) {
      this.lastExecutionTime = lastExecutionTime;
    }

    const lastConsumedMinute = metadata[STATE_KEY_LAST_CONSUMED_MINUTE];
    if (typeof lastConsumedMinute === 'number' && Number.isInteger(lastConsumedMinute)) {
      this.lastConsumedMinute = lastConsumedMinute;
    }

    return true;
  }

  /**
   * Write the keeper's current state to the configured store.
   *
   * @returns The checkpoint that was written, or `null` when no store is
   *   configured.
   */
  async persistState(): Promise<KeeperCheckpoint | null> {
    const store = this.config.stateStore;
    if (!store) return null;

    const checkpoint = createStateCheckpoint(Date.now(), {
      [STATE_KEY_LAST_EXECUTION_TIME]: this.lastExecutionTime,
      [STATE_KEY_LAST_CONSUMED_MINUTE]: this.lastConsumedMinute,
    });
    await store.save(checkpoint);
    return checkpoint;
  }

  /**
   * Check the RPC node's ledger head against the last ledger this keeper has
   * processed, warning when the node is noticeably behind. Returns `undefined`
   * when no head source is configured.
   */
  async checkRpcLag(): Promise<RpcLagReport | undefined> {
    if (!this.lagMonitor) {
      return undefined;
    }
    const report = await this.lagMonitor.check();
    this.lastLag = report;
    return report;
  }

  /** The most recent lag report, if a check has run. */
  getLastLagReport(): RpcLagReport | undefined {
    return this.lastLag;
  }

  /** Structured logs for actions that were attempted but never submitted. */
  getSkippedActions(): SkippedActionLog[] {
    return [...this.skippedActions];
  }

  /**
   * Record and log a skipped/aborted action. The structured record is
   * retained in-memory and emitted as a single-line JSON object so it can be
   * grepped/parsed by log pipelines.
   */
  private logSkipped(
    reason: SkippedActionLog['reason'],
    message: string,
    extra: Partial<Omit<SkippedActionLog, 'event' | 'reason' | 'message' | 'vaultAddress' | 'currentPoolId' | 'amount' | 'timestamp'>> = {},
  ): SkippedActionLog {
    const record: SkippedActionLog = {
      event: 'keeper.action.skipped',
      reason,
      message,
      vaultAddress: this.config.vaultAddress,
      currentPoolId: this.config.currentPoolId,
      amount: this.config.maxPositionSize.toString(),
      investmentAsset: this.config.investmentAsset,
      timestamp: Date.now(),
      ...extra,
    };
    this.skippedActions.push(record);
    console.warn(JSON.stringify(record));
    return record;
  }

  /**
   * Run the auto-rebalancer (15-minute interval compatible)
   * Call this every 15 minutes via cron job or timer
   */
  async run(): Promise<RebalanceResult[]> {
    const results: RebalanceResult[] = [];

    try {
      // Recover the keeper's state from the last run before acting. A keeper
      // that comes back from an outage must not repeat the rebalance it
      // already executed, so an unreadable checkpoint fails the run closed
      // instead of silently forgetting the cooldown.
      if (!this.stateRestored) {
        await this.restoreState();
      }

      // Warn before acting if the RPC node's head has fallen noticeably behind
      // the last ledger this keeper processed.
      const lag = await this.checkRpcLag();
      if (lag && lag.severity !== 'pk') {
        this.logSkipped('rpc_lag', `RPC lag detected: ${lag.message}`, { lag });
        results.push({
          timestamp: Date.now(),
          success: false,
          message: `RPC lag detected: ${lag.message}`,
          lag,
        });
      }

      // Check cooldown
      if (!this.isReadyForRebalance()) {
        this.logSkipped(
          'cooldown',
          `Cooldown active. Last execution: ${new Date(this.lastExecutionTime).toISOString()}`,
          { lag },
        );
        results.push({
          timestamp: Date.now(),
          success: false,
          message: `Cooldown active. Last execution: ${new Date(this.lastExecutionTime).toISOString()}`,
          lag,
        });
        return results;
      }

      // The scheduled slot has been consumed — record it before doing any
      // work, so a restart in the middle of this run does not open the same
      // slot a second time.
      await this.persistState();

      // Scan for opportunities
      const opportunities = await this.scanner.findOpportunities(
        this.config.currentVaultApy,
        this.config.minApyDelta,
        this.config.maxIlTolerance,
        {
          investmentAmount: this.config.maxPositionSize,
          investmentAsset: this.config.investmentAsset ?? '',
          sourcePoolId: this.config.currentPoolId,
        },
      );

      if (opportunities.length === 0) {
        this.logSkipped('no_opportunities', 'No profitable opportunities found', { lag });
        results.push({
          timestamp: Date.now(),
          success: false,
          message: 'No profitable opportunities found',
          lag,
        });
        return results;
      }

      // Rank opportunities by risk-adjusted return
      const rankedOpps = ArbitrageOptimizer.rankOpportunities(
        opportunities.filter((opportunity) => opportunity.recommended),
        this.config.riskTolerance,
      );

      if (rankedOpps.length === 0) {
        this.logSkipped(
          'no_eligible_opportunities',
          'No opportunities remain eligible after net-profitability and risk checks',
          { lag },
        );
        results.push({
          timestamp: Date.now(),
          success: false,
          message: 'No opportunities remain eligible after net-profitability and risk checks',
          lag,
        });
        return results;
      }

      // Execute best opportunity if profitable
      const bestOpportunity = rankedOpps[0];
      const profitability = ArbitrageOptimizer.calculateProfitability(
        bestOpportunity,
        this.config.maxPositionSize,
      );

      if (!profitability.costEstimateAvailable || profitability.netProfit <= BigInt(0)) {
        const message = profitability.costEstimateAvailable
          ? `Best opportunity not profitable. Net profit: ${profitability.netProfit}`
          : 'Best opportunity has no valid round-trip cost estimate for this position';
        this.logSkipped(
          profitability.costEstimateAvailable ? 'not_profitable' : 'no_cost_estimate',
          message,
          {
            lag,
            targetPoolId: bestOpportunity.pool_id,
            netProfit: profitability.costEstimateAvailable
              ? profitability.netProfit.toString()
              : undefined,
            apyDelta: bestOpportunity.apy_delta,
            ilRisk: bestOpportunity.il_risk,
          },
        );
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message,
          lag,
        });
        return results;
      }

      // Simulate first
      const simulation = await this.executor.simulateRebalance(
        bestOpportunity,
        this.config.maxPositionSize,
      );

      if (!simulation.costEstimateAvailable || !simulation.profitable) {
        const message = simulation.costEstimateAvailable
          ? `Simulation shows negative profit: ${simulation.netProfit}`
          : 'Simulation has no valid round-trip cost estimate for this position';
        this.logSkipped(
          simulation.costEstimateAvailable
            ? 'simulation_negative'
            : 'simulation_no_cost_estimate',
          message,
          {
            lag,
            targetPoolId: bestOpportunity.pool_id,
            netProfit: simulation.costEstimateAvailable
              ? simulation.netProfit.toString()
              : undefined,
            apyDelta: bestOpportunity.apy_delta,
            ilRisk: bestOpportunity.il_risk,
          },
        );
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message,
          lag,
        });
        return results;
      }

      // Execute
      const executionResult = await this.executor.executeArbitrage(
        bestOpportunity,
        this.config.currentPoolId,
        this.config.maxPositionSize,
        process.env.STELLAR_PRIVATE_KEY || '',
      );

      if (executionResult.success) {
        this.lastExecutionTime = Date.now();
        const result: RebalanceResult = {
          timestamp: Date.now(),
          success: true,
          opportunity: bestOpportunity,
          profit: profitability.netProfit,
          message: `Rebalance executed successfully. TX: ${executionResult.transactionHash}`,
          lag,
        };
        results.push(result);
        this.executionHistory.push(result);

        // Make the new position durable before anything else can fail, so a
        // restart right after this point does not repeat the rebalance.
        await this.persistState();

        // Send notifications
        await this.notifyExecution(result);
      } else {
        const message = `Execution failed: ${executionResult.error}`;
        this.logSkipped('execution_failed', message, {
          lag,
          targetPoolId: bestOpportunity.pool_id,
          netProfit: profitability.netProfit.toString(),
          apyDelta: bestOpportunity.apy_delta,
          ilRisk: bestOpportunity.il_risk,
        });
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message,
          lag,
        });
        this.executionHistory.push(results[results.length - 1]);
      }
    } catch (error) {
      const message = `Rebalancer run failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logSkipped('error', message, { lag: this.lastLag });
      results.push({
        timestamp: Date.now(),
        success: false,
        message,
        lag: this.lastLag,
      });
    }

    return results;
  }

  /** Returns true when the cooldown window has elapsed. */
  isReadyForRebalance(): boolean {
    if (this.lastExecutionTime === 0) {
      return true;
    }
    const cooldownMs = this.config.cooldownHours * 60 * 60 * 1000;
    return Date.now() - this.lastExecutionTime >= cooldownMs;
  }

  /** Send configured webhook notifications for a successful execution. */
  private async notifyExecution(result: RebalanceResult): Promise<void> {
    const text = `[${result.success ? 'SUCCESS' : 'FAIL'}] ${result.message}`;
    const tasks: Promise<unknown>[] = [];
    if (this.config.telegramWebhookUrl) {
      tasks.push(
        axios.post(this.config.telegramWebhookUrl, { text }).catch(() => undefined),
      );
    }
    if (this.config.discordWebhookUrl) {
      tasks.push(
        axios.post(this.config.discordWebhookUrl, { content: text }).catch(() => undefined),
      );
    }
    await Promise.all(tasks);
  }
}
