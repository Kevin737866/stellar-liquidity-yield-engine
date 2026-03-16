import { 
  RebalancerClient, 
  VaultClient,
  TESTNET_CONFIG,
  NetworkConfig,
  RebalanceStrategy,
  RebalanceProposal,
  PoolAllocation
} from '../sdk/src';

/**
 * Example: Cross-pool rebalancing from low-APY to high-APY pools
 * 
 * This example demonstrates how to:
 * 1. Analyze current pool performance across multiple vaults
 * 2. Identify suboptimal allocations
 * 3. Generate rebalance proposals to move liquidity
 * 4. Execute cross-pool rebalancing
 * 5. Monitor rebalancing performance
 */

// Configuration - Multiple vault addresses
const VAULT_ADDRESSES = [
  'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q', // USDC/XLM
  'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q', // USDC/USDT
  'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'  // XLM/USDT
];

const USER_KEYPAIR = {
  publicKey: 'GD...YOUR_PUBLIC_KEY',
  secret: 'S...YOUR_SECRET_KEY'
};

// Pool configurations
const POOL_CONFIGS = [
  {
    address: 'POOL1_ADDRESS',
    tokenA: 'USDC_ADDRESS',
    tokenB: 'XLM_ADDRESS',
    currentAPY: 800, // 8%
    targetAPY: 1200, // 12%
    riskLevel: 1
  },
  {
    address: 'POOL2_ADDRESS',
    tokenA: 'USDC_ADDRESS',
    tokenB: 'USDT_ADDRESS',
    currentAPY: 600, // 6%
    targetAPY: 1000, // 10%
    riskLevel: 1
  },
  {
    address: 'POOL3_ADDRESS',
    tokenA: 'XLM_ADDRESS',
    tokenB: 'USDT_ADDRESS',
    currentAPY: 1500, // 15%
    targetAPY: 1800, // 18%
    riskLevel: 2
  }
];

async function analyzeAndRebalance() {
  console.log('🔄 Starting cross-pool rebalancing analysis...\n');

  try {
    const rebalancerClient = new RebalancerClient(TESTNET_CONFIG);
    
    // 1. Create a rebalancing strategy
    console.log('📊 Creating rebalancing strategy...');
    
    const strategyName = 'Dynamic Yield Optimization';
    const riskLevel = 2; // Balanced
    const minApyThreshold = 1000; // 10%
    const maxIlRisk = 1500; // 15%
    const rebalanceFrequency = 86400; // 24 hours
    
    // Define pool allocations
    const allocations: PoolAllocation[] = POOL_CONFIGS.map((pool, index) => ({
      poolId: pool.address,
      tokenA: pool.tokenA,
      tokenB: pool.tokenB,
      allocationPercent: Math.floor((100 / POOL_CONFIGS.length) * 100), // Equal allocation
      targetApy: pool.targetAPY,
      currentApy: pool.currentAPY,
      impermanentLossRisk: pool.riskLevel * 500 // Convert risk level to basis points
    }));

    // Create strategy (simplified - would use admin keypair in production)
    console.log('Strategy Configuration:', {
      name: strategyName,
      riskLevel,
      minApyThreshold: minApyThreshold / 100,
      maxIlRisk: maxIlRisk / 100,
      rebalanceFrequency: `${rebalanceFrequency / 3600} hours`,
      poolCount: allocations.length
    });

    // 2. Analyze current vault performance
    console.log('\n📈 Analyzing current vault performance...');
    const vaultClients = VAULT_ADDRESSES.map(address => 
      new VaultClient(address, TESTNET_CONFIG)
    );

    const vaultPerformances = await Promise.all(
      vaultClients.map(async (client, index) => {
        try {
          const [info, metrics, position] = await Promise.all([
            client.getVaultInfo(),
            client.getMetrics(),
            client.getUserPosition(USER_KEYPAIR.publicKey)
          ]);

          return {
            vaultIndex: index,
            vaultAddress: VAULT_ADDRESSES[index],
            name: info.name,
            currentAPY: metrics.apy,
            tvl: metrics.tvl,
            userShares: position.shares,
            userValue: position.shares > 0n && metrics.totalShares > 0n 
              ? (Number(position.shares) / Number(metrics.totalShares)) * Number(metrics.tvl)
              : 0n,
            isUnderperforming: metrics.apy < minApyThreshold
          };
        } catch (error) {
          console.error(`Error analyzing vault ${index}:`, error);
          return null;
        }
      })
    );

    const validPerformances = vaultPerformances.filter(p => p !== null);
    
    console.log('Vault Performance Summary:');
    validPerformances.forEach(performance => {
      const status = performance!.isUnderperforming ? '⚠️' : '✅';
      console.log(`${status} Vault ${performance!.vaultIndex}: ${performance!.name}`);
      console.log(`   APY: ${(performance!.currentAPY / 100).toFixed(2)}%`);
      console.log(`   TVL: $${(Number(performance!.tvl) / 1000000).toFixed(2)}M`);
      console.log(`   User Value: $${(Number(performance!.userValue) / 1000000).toFixed(2)}`);
    });

    // 3. Identify rebalancing opportunities
    console.log('\n🎯 Identifying rebalancing opportunities...');
    
    const underperformingVaults = validPerformances.filter(p => p!.isUnderperforming);
    const outperformingVaults = validPerformances.filter(p => !p!.isUnderperforming);
    
    console.log(`Found ${underperformingVaults.length} underperforming vaults`);
    console.log(`Found ${outperformingVaults.length} outperforming vaults`);

    if (underperformingVaults.length === 0) {
      console.log('✅ All vaults are performing well. No rebalancing needed.');
      return;
    }

    // 4. Generate rebalance proposals
    console.log('\n📋 Generating rebalance proposals...');
    
    // Simulate analysis (in production, this would call the actual contract)
    const mockProposals: RebalanceProposal[] = underperformingVaults.map(fromVault => {
      const bestTarget = outperformingVaults.reduce((best, current) => 
        current!.currentAPY > best!.currentAPY ? current : best
      );

      return {
        fromPool: fromVault!.vaultAddress,
        toPool: bestTarget!.vaultAddress,
        amountA: fromVault!.userValue / 2n, // Move 50% of liquidity
        amountB: fromVault!.userValue / 2n,
        expectedApyImprovement: bestTarget!.currentAPY - fromVault!.currentAPY,
        estimatedGasCost: BigInt(50000),
        timestamp: Date.now()
      };
    });

    console.log('Generated Rebalance Proposals:');
    mockProposals.forEach((proposal, index) => {
      console.log(`\nProposal ${index + 1}:`);
      console.log(`  From: Vault ${validPerformances.findIndex(p => p?.vaultAddress === proposal.fromPool)}`);
      console.log(`  To: Vault ${validPerformances.findIndex(p => p?.vaultAddress === proposal.toPool)}`);
      console.log(`  Amount: $${(Number(proposal.amountA) / 1000000).toFixed(2)}`);
      console.log(`  Expected APY Improvement: ${(proposal.expectedApyImprovement / 100).toFixed(2)}%`);
      console.log(`  Estimated Gas Cost: ${proposal.estimatedGasCost} stroops`);
    });

    // 5. Execute rebalancing (with user confirmation)
    console.log('\n⚡ Executing rebalancing...');
    
    for (const proposal of mockProposals) {
      try {
        console.log(`\nExecuting rebalance from ${proposal.fromPool} to ${proposal.toPool}...`);
        
        // In production, this would execute the actual rebalance
        // const result = await rebalancerClient.executeRebalance(USER_KEYPAIR, proposal);
        
        // Simulate execution
        const result = {
          hash: `rebalance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          success: true,
          gasUsed: Number(proposal.estimatedGasCost)
        };

        console.log(`✅ Rebalance successful: ${result.hash}`);
        console.log(`   Gas used: ${result.gasUsed} stroops`);
        
        // Update performance data after rebalance
        const fromVaultIndex = validPerformances.findIndex(p => p?.vaultAddress === proposal.fromPool);
        const toVaultIndex = validPerformances.findIndex(p => p?.vaultAddress === proposal.toPool);
        
        if (fromVaultIndex !== -1 && toVaultIndex !== -1) {
          const fromVault = validPerformances[fromVaultIndex]!;
          const toVault = validPerformances[toVaultIndex]!;
          
          // Simulate APY changes after rebalance
          fromVault.currentAPY = Math.min(fromVault.currentAPY + 100, toVault.currentAPY);
          toVault.currentAPY = Math.max(toVault.currentAPY - 50, minApyThreshold);
        }
        
      } catch (error) {
        console.error(`❌ Rebalance failed:`, error);
      }
    }

    // 6. Monitor post-rebalance performance
    console.log('\n📊 Monitoring post-rebalance performance...');
    
    // Wait a bit for changes to propagate
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('Updated Vault Performance:');
    validPerformances.forEach(performance => {
      const status = performance!.isUnderperforming ? '⚠️' : '✅';
      console.log(`${status} Vault ${performance!.vaultIndex}: ${performance!.name}`);
      console.log(`   New APY: ${(performance!.currentAPY / 100).toFixed(2)}%`);
      console.log(`   APY Change: ${performance!.currentAPY < minApyThreshold ? 'Still underperforming' : 'Improved'}`);
    });

    // 7. Generate rebalance summary
    console.log('\n📈 Rebalance Summary:');
    const totalImprovement = mockProposals.reduce((sum, proposal) => 
      sum + proposal.expectedApyImprovement, 0
    );
    const totalGasUsed = mockProposals.reduce((sum, proposal) => 
      sum + Number(proposal.estimatedGasCost), 0
    );
    
    console.log(`Total proposals executed: ${mockProposals.length}`);
    console.log(`Total expected APY improvement: ${(totalImprovement / mockProposals.length / 100).toFixed(2)}%`);
    console.log(`Total gas used: ${totalGasUsed.toLocaleString()} stroops`);
    console.log(`Estimated annual yield increase: $${calculateAnnualYieldIncrease(validPerformances, mockProposals)}`);

  } catch (error) {
    console.error('❌ Error during cross-pool rebalancing:', error);
  }
}

// Helper function to calculate annual yield increase
function calculateAnnualYieldIncrease(performances: any[], proposals: RebalanceProposal[]): string {
  const totalUserValue = performances.reduce((sum, p) => sum + Number(p!.userValue), 0);
  const avgImprovement = proposals.reduce((sum, p) => sum + p.expectedApyImprovement, 0) / proposals.length;
  const annualIncrease = (totalUserValue * avgImprovement) / 10000;
  
  return (annualIncrease / 1000000).toFixed(2);
}

// Advanced rebalancing utilities
export class CrossPoolRebalancer {
  private rebalancerClient: RebalancerClient;
  private vaultClients: VaultClient[];

  constructor(vaultAddresses: string[], networkConfig: NetworkConfig) {
    this.rebalancerClient = new RebalancerClient(networkConfig);
    this.vaultClients = vaultAddresses.map(address => 
      new VaultClient(address, networkConfig)
    );
  }

  /**
   * Perform comprehensive cross-pool analysis
   */
  async performComprehensiveAnalysis(userAddress: string) {
    const vaultData = await Promise.all(
      this.vaultClients.map(async (client, index) => {
        const [info, metrics, position] = await Promise.all([
          client.getVaultInfo(),
          client.getMetrics(),
          client.getUserPosition(userAddress)
        ]);

        return {
          index,
          address: await client.getVaultInfo().then(v => v.poolId),
          info,
          metrics,
          position,
          performance: this.calculatePerformanceScore(metrics, position)
        };
      })
    );

    return {
      vaultData,
      totalValue: vaultData.reduce((sum, v) => sum + Number(v.position.shares), 0),
      averageAPY: vaultData.reduce((sum, v) => sum + v.metrics.apy, 0) / vaultData.length,
      recommendations: this.generateRecommendations(vaultData)
    };
  }

  /**
   * Calculate performance score for a vault
   */
  private calculatePerformanceScore(metrics: any, position: any): number {
    if (position.shares === 0n) return 0;
    
    const apyScore = metrics.apy / 100; // Convert to percentage
    const tvlScore = Math.log(Number(metrics.tvl) / 1000000) / Math.log(10); // Log scale for TVL
    const userShareRatio = Number(position.shares) / Number(metrics.totalShares);
    
    return apyScore * 0.6 + tvlScore * 0.2 + userShareRatio * 0.2;
  }

  /**
   * Generate rebalancing recommendations
   */
  private generateRecommendations(vaultData: any[]): string[] {
    const recommendations: string[] = [];
    
    const sortedVaults = vaultData.sort((a, b) => b.performance - a.performance);
    const topPerformer = sortedVaults[0];
    const worstPerformer = sortedVaults[sortedVaults.length - 1];
    
    if (topPerformer.performance - worstPerformer.performance > 20) {
      recommendations.push(
        `Consider moving liquidity from Vault ${worstPerformer.index} to Vault ${topPerformer.index}`
      );
    }
    
    const lowAPYVaults = vaultData.filter(v => v.metrics.apy < 1000);
    if (lowAPYVaults.length > 0) {
      recommendations.push(
        `${lowAPYVaults.length} vault(s) are under 10% APY - consider rebalancing`
      );
    }
    
    return recommendations;
  }

  /**
   * Execute optimized rebalancing strategy
   */
  async executeOptimizedRebalancing(userKeyPair: any, maxSlippage: number = 100) {
    const analysis = await this.performComprehensiveAnalysis(userKeyPair.publicKey);
    
    // Generate optimized rebalance proposals
    const proposals = this.generateOptimizedProposals(analysis.vaultData, maxSlippage);
    
    // Execute proposals in order of expected return
    const sortedProposals = proposals.sort((a, b) => 
      b.expectedApyImprovement - a.expectedApyImprovement
    );
    
    const results = [];
    for (const proposal of sortedProposals) {
      try {
        const result = await this.rebalancerClient.executeRebalance(userKeyPair, proposal);
        results.push({ proposal, result, success: true });
      } catch (error) {
        results.push({ proposal, error, success: false });
      }
    }
    
    return results;
  }

  /**
   * Generate optimized rebalance proposals
   */
  private generateOptimizedProposals(vaultData: any[], maxSlippage: number): RebalanceProposal[] {
    const proposals: RebalanceProposal[] = [];
    
    // Sort by performance (worst to best)
    const sortedVaults = [...vaultData].sort((a, b) => a.performance - b.performance);
    
    // Pair worst performers with best performers
    for (let i = 0; i < Math.min(3, sortedVaults.length / 2); i++) {
      const worst = sortedVaults[i];
      const best = sortedVaults[sortedVaults.length - 1 - i];
      
      if (worst.position.shares > 0n && worst.metrics.apy < best.metrics.apy - 200) {
        const rebalanceAmount = worst.position.shares / 2n; // Move 50%
        
        proposals.push({
          fromPool: worst.address,
          toPool: best.address,
          amountA: rebalanceAmount,
          amountB: rebalanceAmount,
          expectedApyImprovement: best.metrics.apy - worst.metrics.apy,
          estimatedGasCost: BigInt(50000),
          timestamp: Date.now()
        });
      }
    }
    
    return proposals;
  }
}

// Run the example
if (require.main === module) {
  analyzeAndRebalance()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Example failed:', error);
      process.exit(1);
    });
}

export default analyzeAndRebalance;
