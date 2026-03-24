import { ArbitrageScanner, ArbitrageExecutor, ArbitrageOptimizer, Opportunity } from '../sdk/src/arbitrage';

/**
 * Arbitrage Strategy Backtest Simulation
 * Simulates 2024 mainnet conditions to validate strategy profitability
 */

// Mock historical pool data for 2024
const HISTORICAL_POOLS_2024 = [
  { date: '2024-01-15', apy: 850, liquidity: BigInt(50000000000), volatility: 1200 },
  { date: '2024-02-20', apy: 1200, liquidity: BigInt(75000000000), volatility: 1500 },
  { date: '2024-03-10', apy: 950, liquidity: BigInt(60000000000), volatility: 1100 },
  { date: '2024-04-05', apy: 2100, liquidity: BigInt(120000000000), volatility: 2000 },
  { date: '2024-05-12', apy: 1850, liquidity: BigInt(95000000000), volatility: 1700 },
  { date: '2024-06-18', apy: 1450, liquidity: BigInt(80000000000), volatility: 1400 },
  { date: '2024-07-25', apy: 1650, liquidity: BigInt(90000000000), volatility: 1600 },
  { date: '2024-08-30', apy: 2400, liquidity: BigInt(140000000000), volatility: 2200 },
  { date: '2024-09-22', apy: 1950, liquidity: BigInt(100000000000), volatility: 1800 },
  { date: '2024-10-15', apy: 1750, liquidity: BigInt(88000000000), volatility: 1500 },
  { date: '2024-11-30', apy: 2200, liquidity: BigInt(130000000000), volatility: 2100 },
  { date: '2024-12-20', apy: 1800, liquidity: BigInt(92000000000), volatility: 1600 },
];

interface BacktestConfig {
  initialPosition: bigint;
  currentVaultApy: number;
  minApyDelta: number;
  maxIlTolerance: number;
  cooldownDays: number;
  riskTolerance: number;
}

interface BacktestResult {
  date: string;
  action: 'HOLD' | 'REBALANCE';
  poolApy: number;
  holdProfit: bigint;
  arbitrageProfit: bigint;
  cumulativeArbitrage: bigint;
  roi: number; // Percentage
}

class ArbitrageBacktester {
  private config: BacktestConfig;
  private results: BacktestResult[] = [];

  constructor(config: BacktestConfig) {
    this.config = config;
  }

  /**
   * Simulate 2024 mainnet trading year
   */
  async runBacktest(): Promise<BacktestResult[]> {
    let cumulativeArbitrage = BigInt(0);
    let lastRebalanceDate = '2024-01-01';

    for (const pool of HISTORICAL_POOLS_2024) {
      // Check if cooldown has passed
      const daysSinceRebalance = this.daysBetween(lastRebalanceDate, pool.date);
      const canRebalance = daysSinceRebalance >= this.config.cooldownDays;

      // Calculate hold profit
      const holdProfit = this.calculateYieldProfit(
        this.config.initialPosition,
        this.config.currentVaultApy,
      );

      let action: 'HOLD' | 'REBALANCE' = 'HOLD';
      let arbitrageProfit = BigInt(0);

      // Check if rebalancing is beneficial
      if (canRebalance) {
        const opportunity = this.createOpportunity(pool);
        const profitability = ArbitrageOptimizer.calculateProfitability(
          opportunity,
          this.config.initialPosition,
          BigInt(100),
        );

        if (profitability.netProfit > BigInt(0)) {
          action = 'REBALANCE';
          arbitrageProfit = profitability.netProfit;
          cumulativeArbitrage += arbitrageProfit;
          lastRebalanceDate = pool.date;
        }
      }

      const roi = Number((cumulativeArbitrage * BigInt(10000)) / this.config.initialPosition) / 100;

      this.results.push({
        date: pool.date,
        action,
        poolApy: pool.apy,
        holdProfit,
        arbitrageProfit,
        cumulativeArbitrage,
        roi,
      });
    }

    return this.results;
  }

  /**
   * Print formatted backtest report
   */
  printReport(): void {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('       2024 MAINNET ARBITRAGE STRATEGY BACKTEST REPORT');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('Configuration:');
    console.log(`  Initial Position: ${this.config.initialPosition.toString()} stroops`);
    console.log(`  Vault APY: ${this.config.currentVaultApy} bp (${(this.config.currentVaultApy / 100).toFixed(2)}%)`);
    console.log(`  Min APY Delta: ${this.config.minApyDelta} bp (${(this.config.minApyDelta / 100).toFixed(2)}%)`);
    console.log(`  Cooldown: ${this.config.cooldownDays} days`);
    console.log(`  Risk Tolerance: ${this.config.riskTolerance}/10\n`);

    console.log('Date          | Pool APY | Action      | Arbitrage Profit | Cumulative Profit | ROI');
    console.log('─────────────────────────────────────────────────────────────────────────────────────');

    for (const result of this.results) {
      const apyStr = (result.poolApy / 100).toFixed(2).padEnd(7);
      const actionStr = result.action.padEnd(10);
      const profitStr = result.arbitrageProfit.toString().padEnd(16);
      const cumulStr = result.cumulativeArbitrage.toString().padEnd(18);
      const roiStr = result.roi.toFixed(2) + '%';

      console.log(
        `${result.date} | ${apyStr}% | ${actionStr} | ${profitStr} | ${cumulStr} | ${roiStr}`,
      );
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('Summary Metrics:');
    console.log('─────────────────────────────────────────────────────────────────');

    const rebalances = this.results.filter(r => r.action === 'REBALANCE').length;
    const lastResult = this.results[this.results.length - 1];
    const totalProfit = lastResult.cumulativeArbitrage;
    const finalRoi = lastResult.roi;

    console.log(`Total Rebalances: ${rebalances}`);
    console.log(`Total Profit: ${totalProfit.toString()} stroops`);
    console.log(`Final ROI: ${finalRoi.toFixed(2)}%`);
    console.log(
      `Annualized Return: ${(finalRoi / 1).toFixed(2)}% (based on single year)`,
    );

    // Profit comparison
    const holdAnnually = (this.config.currentVaultApy / 100) * (this.config.initialPosition / BigInt(100)) / BigInt(100);
    const holdYearly = holdAnnually * BigInt(1000000);
    const outperformance = totalProfit - holdYearly;

    console.log(`\nHold Strategy Annual Return: ~${holdYearly.toString()} stroops`);
    console.log(`Arbitrage Outperformance: ${outperformance > BigInt(0) ? '+' : ''}${outperformance.toString()} stroops`);
    console.log(`Outperformance %: ${(finalRoi - (this.config.currentVaultApy / 100)).toFixed(2)}%\n`);

    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  /**
   * Calculate yield profit for a period
   */
  private calculateYieldProfit(amount: bigint, apy: number): bigint {
    // Simplified: profit = amount * APY / 10000 / 12 (monthly)
    return (amount * BigInt(apy)) / BigInt(10000) / BigInt(12);
  }

  /**
   * Create mock opportunity from pool data
   */
  private createOpportunity(pool: any): Opportunity {
    const apyDelta = Math.max(0, pool.apy - this.config.currentVaultApy);
    const ilRisk = pool.volatility;

    return {
      pool_id: `pool_${pool.date.replace(/-/g, '_')}`,
      current_apy: this.config.currentVaultApy,
      projected_apy: pool.apy,
      il_risk: ilRisk,
      net_profit: BigInt(0), // Calculated separately
      apy_delta: apyDelta,
      recommended: apyDelta >= this.config.minApyDelta && ilRisk <= this.config.maxIlTolerance,
    };
  }

  /**
   * Calculate days between two date strings
   */
  private daysBetween(date1: string, date2: string): number {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const diffTime = Math.abs(d2.getTime() - d1.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }
}

/**
 * Run backtest with multiple scenarios
 */
async function runMultiScenarioBacktest(): Promise<void> {
  const scenarios = [
    {
      name: 'Conservative (Low Risk)',
      config: {
        initialPosition: BigInt(10000000000), // 100 XLM
        currentVaultApy: 1200,
        minApyDelta: 400, // 4%
        maxIlTolerance: 50,
        cooldownDays: 30,
        riskTolerance: 3,
      },
    },
    {
      name: 'Balanced (Medium Risk)',
      config: {
        initialPosition: BigInt(10000000000),
        currentVaultApy: 1200,
        minApyDelta: 200, // 2%
        maxIlTolerance: 100,
        cooldownDays: 15,
        riskTolerance: 5,
      },
    },
    {
      name: 'Aggressive (High Risk)',
      config: {
        initialPosition: BigInt(10000000000),
        currentVaultApy: 1200,
        minApyDelta: 50, // 0.5%
        maxIlTolerance: 200,
        cooldownDays: 7,
        riskTolerance: 8,
      },
    },
  ];

  for (const scenario of scenarios) {
    console.log(`\n\n${'█'.repeat(65)}`);
    console.log(`SCENARIO: ${scenario.name}`);
    console.log('█'.repeat(65));

    const backtester = new ArbitrageBacktester(scenario.config);
    await backtester.runBacktest();
    backtester.printReport();
  }
}

// Main execution
async function main(): Promise<void> {
  console.log('Starting 2024 Mainnet Arbitrage Backtest Simulation...\n');
  await runMultiScenarioBacktest();
  console.log('\nBacktest complete. Review results above to validate strategy parameters.');
}

// Execute if run as main module
if (require.main === module) {
  main().catch(console.error);
}

export { ArbitrageBacktester, runMultiScenarioBacktest };
