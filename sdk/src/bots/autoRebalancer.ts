import { ArbitrageScanner, ArbitrageExecutor, ArbitrageOptimizer, Opportunity } from '../arbitrage';
import axios from 'axios';

export interface RebalancerConfig {
  vaultAddress: string;
  currentPoolId: string;
  currentVaultApy: number;
  minApyDelta: number; // Basis points
  maxIlTolerance: number; // Basis points
  cooldownHours: number;
  telegramWebhookUrl?: string;
  discordWebhookUrl?: string;
  riskTolerance: number; // 1-10
  maxPositionSize: bigint;
}

export interface RebalanceResult {
  timestamp: number;
  success: boolean;
  opportunity?: Opportunity;
  profit?: bigint;
  message: string;
}

export class AutoRebalancer {
  private config: RebalancerConfig;
  private scanner: ArbitrageScanner;
  private executor: ArbitrageExecutor;
  private executionHistory: RebalanceResult[] = [];
  private lastExecutionTime: number = 0;

  constructor(config: RebalancerConfig) {
    this.config = config;
    this.scanner = new ArbitrageScanner();
    this.executor = new ArbitrageExecutor();
  }

  /**
   * Run the auto-rebalancer (15-minute interval compatible)
   * Call this every 15 minutes via cron job or timer
   */
  async run(): Promise<RebalanceResult[]> {
    const results: RebalanceResult[] = [];

    try {
      // Check cooldown
      if (!this.isReadyForRebalance()) {
        results.push({
          timestamp: Date.now(),
          success: false,
          message: `Cooldown active. Last execution: ${new Date(this.lastExecutionTime).toISOString()}`,
        });
        return results;
      }

      // Scan for opportunities
      const opportunities = await this.scanner.findOpportunities(
        this.config.currentVaultApy,
        this.config.minApyDelta,
        this.config.maxIlTolerance,
      );

      if (opportunities.length === 0) {
        results.push({
          timestamp: Date.now(),
          success: false,
          message: 'No profitable opportunities found',
        });
        return results;
      }

      // Rank opportunities by risk-adjusted return
      const rankedOpps = ArbitrageOptimizer.rankOpportunities(
        opportunities,
        this.config.riskTolerance,
      );

      // Execute best opportunity if profitable
      const bestOpportunity = rankedOpps[0];
      const profitability = ArbitrageOptimizer.calculateProfitability(
        bestOpportunity,
        this.config.maxPositionSize,
      );

      if (profitability.netProfit <= BigInt(0)) {
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message: `Best opportunity not profitable. Net profit: ${profitability.netProfit}`,
        });
        return results;
      }

      // Simulate first
      const simulation = await this.executor.simulateRebalance(
        bestOpportunity,
        this.config.maxPositionSize,
      );

      if (!simulation.profitable) {
        results.push({
          timestamp: Date.now(),
          success: false,
          opportunity: bestOpportunity,
          message: `Simulation shows negative profit: ${simulation.netProfit}`,
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
   */
  private isReadyForRebalance(): boolean {
    const cooldownMs = this.config.cooldownHours * 3600 * 1000;
    return Date.now() - this.lastExecutionTime >= cooldownMs;
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
 * Usage: Add to crontab: */15 * * * * node dist/bots/autoRebalancer.js
 */
async function runScheduledRebalancer() {
  const config: RebalancerConfig = {
    vaultAddress: process.env.VAULT_ADDRESS || '',
    currentPoolId: process.env.CURRENT_POOL_ID || '',
    currentVaultApy: parseInt(process.env.CURRENT_VAULT_APY || '1500'),
    minApyDelta: parseInt(process.env.MIN_APY_DELTA || '200'),
    maxIlTolerance: parseInt(process.env.MAX_IL_TOLERANCE || '100'),
    cooldownHours: parseInt(process.env.COOLDOWN_HOURS || '24'),
    telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    riskTolerance: parseInt(process.env.RISK_TOLERANCE || '5'),
    maxPositionSize: BigInt(process.env.MAX_POSITION_SIZE || '1000000000'),
  };

  const rebalancer = new AutoRebalancer(config);
  const results = await rebalancer.run();

  console.log(`[${new Date().toISOString()}] Rebalancer execution:`, results);
  console.log('Cumulative metrics:', rebalancer.getCumulativeMetrics());
}

// Execute if run directly
if (require.main === module) {
  runScheduledRebalancer().catch(console.error);
}

export { runScheduledRebalancer };
