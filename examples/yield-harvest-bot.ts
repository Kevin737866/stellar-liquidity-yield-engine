import { 
  VaultClient, 
  RewardDistributorClient,
  TESTNET_CONFIG,
  NetworkConfig,
  VaultMetrics,
  RewardDistribution
} from '../sdk/src';

/**
 * Example: Automated yield harvesting and reinvestment bot
 * 
 * This example demonstrates how to:
 * 1. Monitor multiple vaults for reward accumulation
 * 2. Automatically harvest rewards when thresholds are met
 * 3. Reinvest harvested rewards for compound growth
 * 4. Track harvesting performance and optimize timing
 * 5. Handle edge cases and error recovery
 */

// Configuration
const BOT_CONFIG = {
  // Vault addresses to monitor
  vaultAddresses: [
    'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'
  ],
  
  // Harvesting thresholds
  minRewardThreshold: BigInt(1000), // Minimum reward to trigger harvest
  maxGasPrice: 100, // Maximum gas price in stroops
  
  // Timing configuration
  checkInterval: 60000, // Check every minute (in production: 15-30 minutes)
  harvestCooldown: 3600000, // 1 hour cooldown between harvests
  
  // Performance tracking
  enablePerformanceTracking: true,
  performanceReportInterval: 3600000 // Report every hour
};

const BOT_KEYPAIR = {
  publicKey: 'GD...BOT_PUBLIC_KEY',
  secret: 'S...BOT_SECRET_KEY'
};

// Performance tracking interface
interface HarvestPerformance {
  vaultAddress: string;
  harvestCount: number;
  totalRewards: bigint;
  totalGasUsed: number;
  averageRewardSize: bigint;
  lastHarvestTime: number;
  successRate: number;
  errors: number;
}

// Bot state
interface BotState {
  isRunning: boolean;
  lastCheckTime: number;
  lastHarvestTimes: Map<string, number>;
  performance: Map<string, HarvestPerformance>;
  totalHarvests: number;
  totalRewards: bigint;
  totalGasUsed: number;
}

class YieldHarvestBot {
  private config: typeof BOT_CONFIG;
  private keypair: typeof BOT_KEYPAIR;
  private networkConfig: NetworkConfig;
  private state: BotState;
  private vaultClients: Map<string, VaultClient>;
  private rewardClients: Map<string, RewardDistributorClient>;
  private checkTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;

  constructor(
    config: typeof BOT_CONFIG,
    keypair: typeof BOT_KEYPAIR,
    networkConfig: NetworkConfig
  ) {
    this.config = config;
    this.keypair = keypair;
    this.networkConfig = networkConfig;
    
    this.state = {
      isRunning: false,
      lastCheckTime: 0,
      lastHarvestTimes: new Map(),
      performance: new Map(),
      totalHarvests: 0,
      totalRewards: 0n,
      totalGasUsed: 0
    };

    this.vaultClients = new Map();
    this.rewardClients = new Map();
    
    // Initialize clients
    this.config.vaultAddresses.forEach(address => {
      this.vaultClients.set(address, new VaultClient(address, networkConfig));
      // In production, you'd have separate reward distributor addresses
      this.rewardClients.set(address, new RewardDistributorClient(networkConfig));
    });
  }

  /**
   * Start the harvesting bot
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      throw new Error('Bot is already running');
    }

    console.log('🤖 Starting Yield Harvest Bot...');
    console.log(`📊 Monitoring ${this.config.vaultAddresses.length} vaults`);
    console.log(`⏰ Check interval: ${this.config.checkInterval / 1000} seconds`);
    console.log(`💰 Min reward threshold: ${this.config.minRewardThreshold}`);

    this.state.isRunning = true;
    this.state.lastCheckTime = Date.now();

    // Start monitoring
    this.checkTimer = setInterval(() => {
      this.performHarvestCheck().catch(error => {
        console.error('❌ Harvest check error:', error);
      });
    }, this.config.checkInterval);

    // Start performance reporting
    if (this.config.enablePerformanceTracking) {
      this.reportTimer = setInterval(() => {
        this.generatePerformanceReport();
      }, this.config.performanceReportInterval);
    }

    console.log('✅ Yield Harvest Bot started successfully!');
  }

  /**
   * Stop the harvesting bot
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning) {
      console.log('⚠️ Bot is not running');
      return;
    }

    console.log('⏹️ Stopping Yield Harvest Bot...');
    
    this.state.isRunning = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }

    // Generate final performance report
    if (this.config.enablePerformanceTracking) {
      this.generatePerformanceReport();
    }

    console.log('✅ Yield Harvest Bot stopped');
  }

  /**
   * Perform harvest check on all vaults
   */
  private async performHarvestCheck(): Promise<void> {
    if (!this.state.isRunning) return;

    const startTime = Date.now();
    console.log(`🔍 Performing harvest check... (${new Date().toISOString()})`);

    try {
      const harvestPromises = this.config.vaultAddresses.map(async (vaultAddress) => {
        return this.checkAndHarvestVault(vaultAddress);
      });

      const results = await Promise.allSettled(harvestPromises);
      
      let successfulHarvests = 0;
      let failedHarvests = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          successfulHarvests++;
        } else {
          failedHarvests++;
          console.error(`❌ Vault ${index} harvest failed:`, result.status === 'rejected' ? result.reason : 'No harvest needed');
        }
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Harvest check completed in ${duration}ms`);
      console.log(`📊 Results: ${successfulHarvests} successful, ${failedHarvests} failed`);

      this.state.lastCheckTime = Date.now();

    } catch (error) {
      console.error('❌ Harvest check failed:', error);
    }
  }

  /**
   * Check and harvest a specific vault
   */
  private async checkAndHarvestVault(vaultAddress: string): Promise<boolean> {
    try {
      const vaultClient = this.vaultClients.get(vaultAddress)!;
      
      // Check if vault is paused
      const isPaused = await vaultClient.isPaused();
      if (isPaused) {
        console.log(`⏸️ Vault ${vaultAddress} is paused, skipping`);
        return false;
      }

      // Check cooldown period
      const lastHarvestTime = this.state.lastHarvestTimes.get(vaultAddress) || 0;
      const timeSinceLastHarvest = Date.now() - lastHarvestTime;
      
      if (timeSinceLastHarvest < this.config.harvestCooldown) {
        const remainingTime = (this.config.harvestCooldown - timeSinceLastHarvest) / 1000 / 60;
        console.log(`⏰ Vault ${vaultAddress} still in cooldown (${remainingTime.toFixed(1)}m remaining)`);
        return false;
      }

      // Get vault metrics to estimate rewards
      const metrics = await vaultClient.getMetrics();
      const estimatedRewards = this.estimatePendingRewards(metrics);
      
      console.log(`📊 Vault ${vaultAddress}: Estimated rewards: ${estimatedRewards}`);

      // Check if rewards meet threshold
      if (estimatedRewards < this.config.minRewardThreshold) {
        console.log(`💰 Vault ${vaultAddress}: Rewards (${estimatedRewards}) below threshold (${this.config.minRewardThreshold})`);
        return false;
      }

      // Check gas price (simplified - in production, check current network gas prices)
      const currentGasPrice = await this.getCurrentGasPrice();
      if (currentGasPrice > this.config.maxGasPrice) {
        console.log(`⛽ Vault ${vaultAddress}: Gas price too high (${currentGasPrice} > ${this.config.maxGasPrice})`);
        return false;
      }

      // Execute harvest
      console.log(`🌾 Harvesting vault ${vaultAddress}...`);
      const harvestResult = await vaultClient.harvest(this.keypair);
      
      if (harvestResult.success) {
        console.log(`✅ Vault ${vaultAddress} harvest successful: ${harvestResult.hash}`);
        
        // Update performance tracking
        this.updatePerformance(vaultAddress, estimatedRewards, harvestResult.gasUsed || 0, true);
        this.state.lastHarvestTimes.set(vaultAddress, Date.now());
        this.state.totalHarvests++;
        this.state.totalRewards += estimatedRewards;
        this.state.totalGasUsed += harvestResult.gasUsed || 0;
        
        return true;
      } else {
        console.error(`❌ Vault ${vaultAddress} harvest failed:`, harvestResult.error);
        this.updatePerformance(vaultAddress, 0n, harvestResult.gasUsed || 0, false);
        return false;
      }

    } catch (error) {
      console.error(`❌ Vault ${vaultAddress} error:`, error);
      this.updatePerformance(vaultAddress, 0n, 0, false);
      return false;
    }
  }

  /**
   * Estimate pending rewards for a vault
   */
  private estimatePendingRewards(metrics: VaultMetrics): bigint {
    // Simplified estimation based on time since last harvest and APY
    const timeSinceLastHarvest = Date.now() - (metrics.lastHarvest * 1000);
    const hoursSinceLastHarvest = timeSinceLastHarvest / (1000 * 60 * 60);
    
    // Estimate rewards: TVL * APY * (hours / 8760)
    const estimatedRewards = (metrics.tvl * BigInt(metrics.apy) * BigInt(Math.floor(hoursSinceLastHarvest * 1000))) / (10000n * 8760000n);
    
    return estimatedRewards;
  }

  /**
   * Get current gas price (simplified)
   */
  private async getCurrentGasPrice(): Promise<number> {
    // In production, this would query the network for current gas prices
    // For now, return a simulated value
    return 50; // 50 stroops
  }

  /**
   * Update performance tracking for a vault
   */
  private updatePerformance(
    vaultAddress: string, 
    rewards: bigint, 
    gasUsed: number, 
    success: boolean
  ): void {
    if (!this.config.enablePerformanceTracking) return;

    const current = this.state.performance.get(vaultAddress) || {
      vaultAddress,
      harvestCount: 0,
      totalRewards: 0n,
      totalGasUsed: 0,
      averageRewardSize: 0n,
      lastHarvestTime: 0,
      successRate: 0,
      errors: 0
    };

    current.harvestCount++;
    current.totalRewards += rewards;
    current.totalGasUsed += gasUsed;
    current.averageRewardSize = current.totalRewards / BigInt(current.harvestCount);
    current.lastHarvestTime = Date.now();
    
    if (success) {
      current.successRate = ((current.harvestCount - current.errors) / current.harvestCount) * 100;
    } else {
      current.errors++;
      current.successRate = ((current.harvestCount - current.errors) / current.harvestCount) * 100;
    }

    this.state.performance.set(vaultAddress, current);
  }

  /**
   * Generate performance report
   */
  private generatePerformanceReport(): void {
    console.log('\n📊 === YIELD HARVEST BOT PERFORMANCE REPORT ===');
    console.log(`⏰ Report time: ${new Date().toISOString()}`);
    console.log(`🤖 Bot uptime: ${Math.floor((Date.now() - this.state.lastCheckTime) / 1000 / 60)} minutes`);
    console.log(`🌾 Total harvests: ${this.state.totalHarvests}`);
    console.log(`💰 Total rewards: ${this.state.totalRewards}`);
    console.log(`⛽ Total gas used: ${this.state.totalGasUsed.toLocaleString()} stroops`);
    
    if (this.state.performance.size > 0) {
      console.log('\n📈 Vault Performance:');
      this.state.performance.forEach((perf, address) => {
        console.log(`\nVault: ${address}`);
        console.log(`  Harvests: ${perf.harvestCount}`);
        console.log(`  Success rate: ${perf.successRate.toFixed(2)}%`);
        console.log(`  Total rewards: ${perf.totalRewards}`);
        console.log(`  Average reward: ${perf.averageRewardSize}`);
        console.log(`  Total gas: ${perf.totalGasUsed.toLocaleString()}`);
        console.log(`  Last harvest: ${new Date(perf.lastHarvestTime).toISOString()}`);
      });
    }
    
    console.log('📊 === END PERFORMANCE REPORT ===\n');
  }

  /**
   * Get bot status
   */
  getStatus(): BotState {
    return { ...this.state };
  }

  /**
   * Force harvest a specific vault
   */
  async forceHarvest(vaultAddress: string): Promise<boolean> {
    console.log(`🔧 Force harvesting vault: ${vaultAddress}`);
    
    // Override cooldown
    this.state.lastHarvestTimes.delete(vaultAddress);
    
    return this.checkAndHarvestVault(vaultAddress);
  }

  /**
   * Update bot configuration
   */
  updateConfig(newConfig: Partial<typeof BOT_CONFIG>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('⚙️ Bot configuration updated');
  }
}

// Main execution function
async function runYieldHarvestBot() {
  console.log('🚀 Initializing Yield Harvest Bot...\n');

  try {
    // Initialize bot
    const bot = new YieldHarvestBot(BOT_CONFIG, BOT_KEYPAIR, TESTNET_CONFIG);

    // Set up graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      await bot.stop();
      process.exit(0);
    });

    // Start the bot
    await bot.start();

    // Keep the process running
    console.log('🤖 Bot is running. Press Ctrl+C to stop.');
    
    // Demonstrate bot operations
    setTimeout(async () => {
      console.log('\n🔧 Demonstrating force harvest...');
      await bot.forceHarvest(BOT_CONFIG.vaultAddresses[0]);
    }, 30000); // After 30 seconds

    setTimeout(async () => {
      console.log('\n📊 Current bot status:');
      const status = bot.getStatus();
      console.log({
        isRunning: status.isRunning,
        totalHarvests: status.totalHarvests,
        totalRewards: status.totalRewards.toString(),
        vaultsMonitored: BOT_CONFIG.vaultAddresses.length
      });
    }, 60000); // After 60 seconds

  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Additional utility functions
export class HarvestOptimizer {
  /**
   * Calculate optimal harvest timing based on historical data
   */
  static calculateOptimalTiming(harvestHistory: Array<{ timestamp: number; rewards: bigint }>): {
    optimalInterval: number;
    expectedEfficiency: number;
    recommendation: string;
  } {
    if (harvestHistory.length < 2) {
      return {
        optimalInterval: 3600000, // 1 hour default
        expectedEfficiency: 0.8,
        recommendation: 'Insufficient data - using default 1-hour interval'
      };
    }

    // Analyze harvest intervals and reward sizes
    const intervals = [];
    const rewardSizes = [];
    
    for (let i = 1; i < harvestHistory.length; i++) {
      const interval = harvestHistory[i].timestamp - harvestHistory[i-1].timestamp;
      const rewardSize = Number(harvestHistory[i].rewards);
      
      intervals.push(interval);
      rewardSizes.push(rewardSize);
    }

    // Calculate correlation between interval and reward size
    const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
    const avgRewardSize = rewardSizes.reduce((sum, val) => sum + val, 0) / rewardSizes.length;
    
    // Simple optimization: find interval that maximizes reward/gas ratio
    let optimalInterval = avgInterval;
    let maxEfficiency = 0;
    
    for (const interval of intervals) {
      const efficiency = rewardSizes[intervals.indexOf(interval)] / (interval / 1000); // Rewards per second
      if (efficiency > maxEfficiency) {
        maxEfficiency = efficiency;
        optimalInterval = interval;
      }
    }

    return {
      optimalInterval,
      expectedEfficiency: maxEfficiency / avgRewardSize,
      recommendation: `Optimal harvest interval: ${Math.round(optimalInterval / 60000)} minutes`
    };
  }

  /**
   * Predict next optimal harvest time
   */
  static predictNextHarvest(
    currentRewards: bigint,
    threshold: bigint,
    accumulationRate: number // Rewards per millisecond
  ): {
    estimatedTime: number;
    confidence: number;
    recommendation: string;
  } {
    if (currentRewards >= threshold) {
      return {
        estimatedTime: 0,
        confidence: 1.0,
        recommendation: 'Harvest now - threshold already met'
      };
    }

    const rewardsNeeded = Number(threshold - currentRewards);
    const timeNeeded = rewardsNeeded / accumulationRate;
    
    // Add uncertainty factor based on network conditions
    const uncertainty = 0.2; // 20% uncertainty
    const confidence = Math.max(0.5, 1 - (timeNeeded / (24 * 60 * 60 * 1000)) * uncertainty); // Decreasing confidence over longer periods

    return {
      estimatedTime: Math.ceil(timeNeeded),
      confidence,
      recommendation: `Harvest in approximately ${Math.ceil(timeNeeded / 60000)} minutes`
    };
  }
}

// Run the example
if (require.main === module) {
  runYieldHarvestBot()
    .then(() => {
      // Keep process running
    })
    .catch((error) => {
      console.error('Bot failed:', error);
      process.exit(1);
    });
}

export default runYieldHarvestBot;
