import { 
  VaultClient, 
  RebalancerClient, 
  TESTNET_CONFIG,
  NetworkConfig,
  VaultInfo,
  UserPosition
} from '../sdk/src';

/**
 * Example: Setting up auto-compounding for USDC/XLM LP position
 * 
 * This example demonstrates how to:
 * 1. Create a vault with auto-compounding enabled
 * 2. Deposit liquidity into the vault
 * 3. Configure automatic harvesting and reinvestment
 * 4. Monitor the auto-compounding performance
 */

// Configuration
const VAULT_ADDRESS = 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q';
const USER_KEYPAIR = {
  publicKey: 'GD...YOUR_PUBLIC_KEY',
  secret: 'S...YOUR_SECRET_KEY'
};

const USDC_ADDRESS = 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q';
const XLM_ADDRESS = 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q';

async function setupAutoCompounding() {
  console.log('🚀 Setting up auto-compounding for USDC/XLM LP position...\n');

  try {
    // Initialize vault client
    const vaultClient = new VaultClient(VAULT_ADDRESS, TESTNET_CONFIG);
    
    // 1. Get vault information
    console.log('📊 Fetching vault information...');
    const vaultInfo = await vaultClient.getVaultInfo();
    console.log('Vault Info:', {
      name: vaultInfo.name,
      tokenA: vaultInfo.tokenA,
      tokenB: vaultInfo.tokenB,
      feeRate: vaultInfo.feeRate / 100, // Convert to percentage
      harvestFee: vaultInfo.harvestFee / 100,
      withdrawalFee: vaultInfo.withdrawalFee / 100
    });

    // 2. Get current vault metrics
    console.log('\n📈 Fetching vault metrics...');
    const metrics = await vaultClient.getMetrics();
    console.log('Vault Metrics:', {
      totalShares: Number(metrics.totalShares).toLocaleString(),
      totalAmountA: Number(metrics.totalAmountA).toLocaleString(),
      totalAmountB: Number(metrics.totalAmountB).toLocaleString(),
      apy: metrics.apy / 100, // Convert to percentage
      tvl: `$${(Number(metrics.tvl) / 1000000).toFixed(2)}M`,
      lastHarvest: new Date(metrics.lastHarvest * 1000).toLocaleString()
    });

    // 3. Check user's current position
    console.log('\n👤 Checking user position...');
    const userPosition = await vaultClient.getUserPosition(USER_KEYPAIR.publicKey);
    console.log('User Position:', {
      shares: Number(userPosition.shares).toLocaleString(),
      lastHarvest: new Date(userPosition.lastHarvest * 1000).toLocaleString(),
      depositedAmountA: Number(userPosition.depositedAmountA).toLocaleString(),
      depositedAmountB: Number(userPosition.depositedAmountB).toLocaleString()
    });

    // 4. Deposit liquidity (if user doesn't have a position)
    if (userPosition.shares === 0n) {
      console.log('\n💰 Depositing liquidity into vault...');
      
      const depositParams = {
        amountA: BigInt(1000000), // 1 USDC (assuming 6 decimals)
        amountB: BigInt(5000000), // 5 XLM (assuming 7 decimals)
        minShares: BigInt(950000) // Minimum shares to accept
      };

      const depositResult = await vaultClient.deposit(USER_KEYPAIR, depositParams);
      console.log('Deposit Result:', {
        hash: depositResult.hash,
        success: depositResult.success,
        gasUsed: depositResult.gasUsed
      });

      if (depositResult.success) {
        console.log('✅ Deposit successful!');
      } else {
        console.error('❌ Deposit failed:', depositResult.error);
        return;
      }
    }

    // 5. Configure auto-compounding settings
    console.log('\n⚙️ Configuring auto-compounding settings...');
    
    // In a real implementation, this would call a configuration function
    // For now, we'll simulate the configuration
    const autoCompoundConfig = {
      enabled: true,
      harvestFrequency: 86400, // Every 24 hours
      minRewardThreshold: BigInt(1000), // Minimum rewards to trigger harvest
      reinvestRatio: 10000, // 100% reinvestment
      slippageTolerance: 100 // 1% slippage tolerance
    };

    console.log('Auto-compounding Configuration:', autoCompoundConfig);

    // 6. Trigger manual harvest to test
    console.log('\n🔄 Triggering manual harvest...');
    const harvestResult = await vaultClient.harvest(USER_KEYPAIR);
    console.log('Harvest Result:', {
      hash: harvestResult.hash,
      success: harvestResult.success,
      gasUsed: harvestResult.gasUsed
    });

    if (harvestResult.success) {
      console.log('✅ Harvest successful!');
      
      // 7. Check updated metrics after harvest
      console.log('\n📊 Updated vault metrics after harvest:');
      const updatedMetrics = await vaultClient.getMetrics();
      console.log('Updated Metrics:', {
        totalShares: Number(updatedMetrics.totalShares).toLocaleString(),
        apy: updatedMetrics.apy / 100,
        tvl: `$${(Number(updatedMetrics.tvl) / 1000000).toFixed(2)}M`,
        lastHarvest: new Date(updatedMetrics.lastHarvest * 1000).toLocaleString()
      });
    } else {
      console.error('❌ Harvest failed:', harvestResult.error);
    }

    // 8. Set up monitoring for auto-compounding
    console.log('\n👀 Setting up monitoring for auto-compounding performance...');
    
    // Monitor function that would be called periodically
    async function monitorAutoCompounding() {
      try {
        const currentMetrics = await vaultClient.getMetrics();
        const currentUserPosition = await vaultClient.getUserPosition(USER_KEYPAIR.publicKey);
        
        const timeSinceLastHarvest = Date.now() - (currentMetrics.lastHarvest * 1000);
        const hoursSinceLastHarvest = timeSinceLastHarvest / (1000 * 60 * 60);
        
        console.log(`\n📈 Auto-compounding Status (${hoursSinceLastHarvest.toFixed(1)}h since last harvest):`);
        console.log({
          currentAPY: (currentMetrics.apy / 100).toFixed(2) + '%',
          userShares: Number(currentUserPosition.shares).toLocaleString(),
          estimatedDailyYield: calculateEstimatedYield(currentUserPosition.shares, currentMetrics),
          nextHarvestIn: Math.max(0, 24 - hoursSinceLastHarvest).toFixed(1) + ' hours'
        });

        // Trigger harvest if it's been more than 24 hours
        if (hoursSinceLastHarvest >= 24) {
          console.log('⏰ Triggering scheduled harvest...');
          await vaultClient.harvest(USER_KEYPAIR);
        }
      } catch (error) {
        console.error('❌ Monitoring error:', error);
      }
    }

    // Helper function to calculate estimated yield
    function calculateEstimatedYield(shares: bigint, metrics: any): string {
      if (shares === 0n || metrics.totalShares === 0n) return '$0.00';
      
      const userSharePercentage = Number(shares) / Number(metrics.totalShares);
      const dailyYield = (Number(metrics.tvl) * (metrics.apy / 10000) / 365) * userSharePercentage;
      return `$${(dailyYield / 1000000).toFixed(2)}`;
    }

    // Start monitoring (in production, this would run on a schedule)
    console.log('\n🔄 Starting monitoring (would run on schedule)...');
    await monitorAutoCompounding();

    console.log('\n✅ Auto-compounding setup complete!');
    console.log('📝 Summary:');
    console.log('- Vault: USDC/XLM LP with auto-compounding');
    console.log('- Harvest frequency: Every 24 hours');
    console.log('- Reinvestment ratio: 100%');
    console.log('- Current APY:', (metrics.apy / 100).toFixed(2) + '%');
    console.log('- User shares:', Number(userPosition.shares).toLocaleString());

  } catch (error) {
    console.error('❌ Error setting up auto-compounding:', error);
  }
}

// Additional utility functions for auto-compounding management
export class AutoCompoundManager {
  private vaultClient: VaultClient;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(vaultAddress: string, networkConfig: NetworkConfig) {
    this.vaultClient = new VaultClient(vaultAddress, networkConfig);
  }

  /**
   * Start auto-compounding monitoring
   */
  startMonitoring(userKeyPair: any, intervalMinutes: number = 60) {
    console.log(`🚀 Starting auto-compounding monitoring (every ${intervalMinutes} minutes)`);
    
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.checkAndHarvest(userKeyPair);
      } catch (error) {
        console.error('❌ Auto-compounding monitoring error:', error);
      }
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop auto-compounding monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('⏹️ Auto-compounding monitoring stopped');
    }
  }

  /**
   * Check if harvest is needed and execute if so
   */
  private async checkAndHarvest(userKeyPair: any) {
    const metrics = await this.vaultClient.getMetrics();
    const timeSinceLastHarvest = Date.now() - (metrics.lastHarvest * 1000);
    const hoursSinceLastHarvest = timeSinceLastHarvest / (1000 * 60 * 60);

    if (hoursSinceLastHarvest >= 24) {
      console.log('⏰ Triggering scheduled auto-compound harvest...');
      const result = await this.vaultClient.harvest(userKeyPair);
      
      if (result.success) {
        console.log('✅ Auto-compound harvest successful');
      } else {
        console.error('❌ Auto-compound harvest failed:', result.error);
      }
    }
  }

  /**
   * Get auto-compounding performance statistics
   */
  async getPerformanceStats(userAddress: string) {
    const [metrics, userPosition] = await Promise.all([
      this.vaultClient.getMetrics(),
      this.vaultClient.getUserPosition(userAddress)
    ]);

    const timeSinceLastHarvest = Date.now() - (metrics.lastHarvest * 1000);
    const hoursSinceLastHarvest = timeSinceLastHarvest / (1000 * 60 * 60);

    return {
      currentAPY: metrics.apy / 100,
      userShares: Number(userPosition.shares),
      userValue: userPosition.shares > 0n && metrics.totalShares > 0n 
        ? (Number(userPosition.shares) / Number(metrics.totalShares)) * Number(metrics.tvl)
        : 0,
      hoursSinceLastHarvest,
      nextHarvestIn: Math.max(0, 24 - hoursSinceLastHarvest),
      totalTVL: Number(metrics.tvl)
    };
  }
}

// Run the example
if (require.main === module) {
  setupAutoCompounding()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Example failed:', error);
      process.exit(1);
    });
}

export default setupAutoCompounding;
