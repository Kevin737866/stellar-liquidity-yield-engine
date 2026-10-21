import {
  ArbitrageScanner,
  ArbitrageExecutor,
  ArbitrageOptimizer,
  Opportunity,
  RoundTripCostEstimator,
} from '../arbitrage';
import { LedgerHeadSource, RpcLagMonitor, RpcLagOptions, RpcLagReport } from '../rpcSync';
import { SorobanRpc } from 'stellar-sdk';
import axios from 'axios';

export interface RebalancerConfig {
  vaultAddress: string;
  currentPoolId: string;
  currentVaultApy: number;
  minApyDelta: number; // Basis points
  maxIlTolerance: number; // Basis points
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

export class AutoRebalancer {
  private config: RebalancerConfig;
  private scanner: ArbitrageScanner;
  private executor: ArbitrageExecutor;
  private executionHistory: RebalanceResult[] = [];
  private lastExecutionTime: number = 0;
  private lastConsumedMinute: number = -1;
  private lagMonitor?: RpcLagMonitor;
  private lastLag?: RpcLagReport;

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

  /**
   * Run the auto-rebalancer (15-minute interval compatible)
   * Call this every 15 minutes via cron job or timer
   */
  async run(): Promise<RebalanceResult[]> {
    const results: RebalanceResult[] = [];

    try {
      // Warn before acting if the RPC node's head has fallen noticeably behind
      // the last ledger this keeper processed.
      const lag = await this.checkRpcLag();
      if (lag && lag.severity !== 'ok') {
        results.push({
          timestamp: Date.now(),
          success: false,
          message: `RPC lag detected: ${lag.message}`,
          lag,
        });
      }

      // Check cooldown
      if (!this.isReadyForRebalance()) {
        results.push({
          timestamp: Date.now(),
          success: false,
          message: `Cooldown active. Last execution: ${new Date(this.lastExecutionTime).toISOString()}`,
          lag,
        });
        return results;
      }

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
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message: profitability.costEstimateAvailable
            ? `Best opportunity not profitable. Net profit: ${profitability.netProfit}`
            : 'Best opportunity has no valid round-trip cost estimate for this position',
        });
        return results;
      }

      // Simulate first
      const simulation = await this.executor.simulateRebalance(
        bestOpportunity,
        this.config.maxPositionSize,
      );

      if (!simulation.costEstimateAvailable || !simulation.profitable) {
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message: simulation.costEstimateAvailable
            ? `Simulation shows negative profit: ${simulation.netProfit}`
            : 'Simulation has no valid round-trip cost estimate for this position',
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

        // Send notifications
        await this.notifyExecution(result);
      } else {
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message: `Execution failed: ${executionResult.error}`,
          lag,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({
        timestamp: Date.now(),
        success: false,
        message: `Auto-rebalancer error: ${errorMsg}`,
      });
    }

    return results;
  }

  /**
   * Check if enough time has passed since last execution (cooldown)
   * and if the current time matches the cron expression schedule.
   * Both conditions must be satisfied when cronExpression is set;
   * cooldown must never bypass the schedule.
   * The last consumed scheduled minute is tracked to prevent
   * repeated rebalances during the same matching minute.
   */
  private isReadyForRebalance(): boolean {
    const cooldownMs = this.config.cooldownHours * 3600 * 1000;
    const cooldownReady = Date.now() - this.lastExecutionTime >= cooldownMs;
    const now = new Date();
    const currentMinute = now.getMinutes();

    if (!this.config.cronExpression) {
      return cooldownReady;
    }

    const cronMatch = this.isCronTime(currentMinute);
    if (cronMatch && cooldownReady) {
      if (currentMinute !== this.lastConsumedMinute) {
        this.lastConsumedMinute = currentMinute;
        return true;
      }
      return false; // same minute already consumed
    }

    if (cronMatch && !cooldownReady) {
      // Cron matches but cooldown not satisfied — do not consume schedule
      return false;
    }

    return false;
  }

/**
   * Check if the current time matches the cron expression.
   * Supports patterns like: every15m (every 15 minutes), minuteValue (e.g. 0).
   * @param minute The current minute value (0-59) to check against the expression.
   */
  private isCronTime(minute: number): boolean {
    if (!this.config.cronExpression) return false;

    const parts = this.config.cronExpression.trim().split(/\s+/);
    const minutePart = parts[0] || '';

    if (minutePart === '*') return true;

    if (minutePart.startsWith('*/')) {
      const interval = parseInt(minutePart.slice(2), 10);
      if (!isNaN(interval) && interval > 0) {
        return minute % interval === 0;
      }
    }

    if (minutePart.startsWith('every')) {
      const numberPart = minutePart.replace('every', '').replace('m', '').replace('M', '').trim();
      const interval = parseInt(numberPart, 10);
      if (!isNaN(interval) && interval > 0) {
        return minute % interval === 0;
      }
    }

    if (minutePart === String(minute)) {
      return true;
    }

    return false;
  }

  /**
   * Get cumulative arbitrage gains vs hold strategy
   */
  getCumulativeMetrics(): {
    totalExecutions: number;
    successfulRebalances: number;
    totalProfit: bigint;
    averageProfit: bigint;
  } {
    const successful = this.executionHistory.filter(r => r.success);
    const totalProfit = successful.reduce((sum, r) => sum + (r.profit || BigInt(0)), BigInt(0));

    return {
      totalExecutions: this.executionHistory.length,
      successfulRebalances: successful.length,
      totalProfit,
      averageProfit: successful.length > 0 ? totalProfit / BigInt(successful.length) : BigInt(0),
    };
  }

  /**
   * Send Telegram notification
   */
  private async notifyTelegram(result: RebalanceResult): Promise<void> {
    if (!this.config.telegramWebhookUrl) return;

    const message = `
🎯 **Arbitrage Rebalance Executed**
Pool: ${result.opportunity?.pool_id || 'N/A'}
Profit: ${result.profit?.toString() || 'N/A'} stroops
APY Delta: ${result.opportunity?.apy_delta || 'N/A'} bp
IL Risk: ${result.opportunity?.il_risk || 'N/A'} bp
Time: ${new Date(result.timestamp).toISOString()}
    `;

    try {
      await axios.post(this.config.telegramWebhookUrl, { text: message });
    } catch (error) {
      console.error('Telegram notification failed:', error);
    }
  }

  /**
   * Send Discord notification
   */
  private async notifyDiscord(result: RebalanceResult): Promise<void> {
    if (!this.config.discordWebhookUrl) return;

    const embed = {
      title: '🎯 Arbitrage Rebalance Executed',
      color: 0x00ff00,
      fields: [
        { name: 'Pool', value: result.opportunity?.pool_id || 'N/A', inline: true },
        { name: 'Profit', value: result.profit?.toString() || 'N/A', inline: true },
        { name: 'APY Delta', value: `${result.opportunity?.apy_delta || 'N/A'} bp`, inline: true },
        { name: 'IL Risk', value: `${result.opportunity?.il_risk || 'N/A'} bp`, inline: true },
        { name: 'Timestamp', value: new Date(result.timestamp).toISOString(), inline: false },
      ],
    };

    try {
      await axios.post(this.config.discordWebhookUrl, { embeds: [embed] });
    } catch (error) {
      console.error('Discord notification failed:', error);
    }
  }

  /**
   * Send all notifications
   */
  private async notifyExecution(result: RebalanceResult): Promise<void> {
    await Promise.all([
      this.notifyTelegram(result),
      this.notifyDiscord(result),
    ]);
  }

  /**
   * Get execution history
   */
  getExecutionHistory(limit: number = 100): RebalanceResult[] {
    return this.executionHistory.slice(-limit);
  }
}

/**
 * Cron-compatible entry point for scheduled execution
 * Usage: add a crontab entry that runs `node dist/bots/autoRebalancer.js`
 * every 15 minutes, e.g. "/15 * * * *".
 *
 * Cron scheduling mode: set CRON_EXPRESSION env var (e.g. every15m)
 * to enable cron-based cadence alongside the existing cooldown-based mode.
 */
async function runScheduledRebalancer() {
  const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
  const config: RebalancerConfig = {
    vaultAddress: process.env.VAULT_ADDRESS || '',
    currentPoolId: process.env.CURRENT_POOL_ID || '',
    currentVaultApy: parseInt(process.env.CURRENT_VAULT_APY || '1500'),
    minApyDelta: parseInt(process.env.MIN_APY_DELTA || '200'),
    maxIlTolerance: parseInt(process.env.MAX_IL_TOLERANCE || '100'),
    cooldownHours: parseInt(process.env.COOLDOWN_HOURS || '24'),
    cronExpression: process.env.CRON_EXPRESSION,
    telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    riskTolerance: parseInt(process.env.RISK_TOLERANCE || '5'),
    maxPositionSize: BigInt(process.env.MAX_POSITION_SIZE || '1000000000'),
    // Watch the RPC node's ledger head so a lagging node is reported before
    // the keeper acts on stale state.
    rpcHeadSource: new SorobanRpc.Server(rpcUrl),
  };

  const rebalancer = new AutoRebalancer(config);
  const results = await rebalancer.run();

  console.log(`[${new Date().toISOString()}] Rebalancer execution:`, results);
  console.log('Cumulative metrics:', rebalancer.getCumulativeMetrics());

  if (config.cronExpression) {
    console.log(`Cron schedule active: ${config.cronExpression}`);
  } else {
    console.log(`Cooldown mode active: ${config.cooldownHours}h intervals`);
  }
}

// Execute if run directly
if (require.main === module) {
  runScheduledRebalancer().catch(console.error);
}

export { runScheduledRebalancer };
