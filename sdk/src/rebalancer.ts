import { 
  Address, 
  Contract, 
  SorobanRpc, 
  TransactionBuilder, 
  Networks,
  BASE_FEE,
  xdr
} from 'stellar-sdk';
import {
  RebalanceStrategy,
  RebalanceProposal,
  RebalanceHistory,
  PoolAllocation,
  TransactionOptions,
  TransactionResult,
  RebalanceError,
  NetworkConfig
} from './types';

export class RebalancerClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkConfig: NetworkConfig;

  constructor(networkConfig: NetworkConfig) {
    this.contract = new Contract(networkConfig.contracts.rebalanceEngine);
    this.server = new SorobanRpc.Server(networkConfig.sorobanRpcUrl);
    this.networkConfig = networkConfig;
  }

  /**
   * Create a new rebalance strategy
   */
  async createStrategy(
    adminKeyPair: any,
    name: string,
    riskLevel: number,
    minApyThreshold: number,
    maxIlRisk: number,
    rebalanceFrequency: number,
    allocations: PoolAllocation[],
    options?: TransactionOptions
  ): Promise<TransactionResult & { strategyId: number }> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(
          this.contract.call(
            'create_strategy',
            name,
            riskLevel.toString(),
            minApyThreshold.toString(),
            maxIlRisk.toString(),
            rebalanceFrequency.toString(),
            this.formatAllocations(allocations)
          )
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);
      
      if (result.status === 'SUCCESS') {
        const txResult = await this.server.getTransaction(result.hash);
        const strategyId = Number(txResult.result!.returnValue);
        
        return {
          hash: result.hash,
          success: true,
          gasUsed: 0,
          strategyId
        };
      } else {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult,
          strategyId: 0
        };
      }
    } catch (error: any) {
      throw new RebalanceError(`Create strategy failed: ${error.message}`, 'CREATE_STRATEGY_ERROR');
    }
  }

  /**
   * Update an existing strategy
   */
  async updateStrategy(
    adminKeyPair: any,
    strategyId: number,
    name: string,
    riskLevel: number,
    minApyThreshold: number,
    maxIlRisk: number,
    rebalanceFrequency: number,
    allocations: PoolAllocation[],
    options?: TransactionOptions
  ): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(
          this.contract.call(
            'update_strategy',
            strategyId.toString(),
            name,
            riskLevel.toString(),
            minApyThreshold.toString(),
            maxIlRisk.toString(),
            rebalanceFrequency.toString(),
            this.formatAllocations(allocations)
          )
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0,
        error: result.status === 'ERROR' ? result.errorResult : undefined
      };
    } catch (error: any) {
      throw new RebalanceError(`Update strategy failed: ${error.message}`, 'UPDATE_STRATEGY_ERROR');
    }
  }

  /**
   * Analyze rebalance opportunities for a strategy
   */
  async analyzeRebalanceOpportunities(
    strategyId: number
  ): Promise<RebalanceProposal[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('analyze_rebalance_opportunities', strategyId.toString()))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to analyze rebalance opportunities');
      }

      return this.parseRebalanceProposals(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(`Analysis failed: ${error.message}`, 'ANALYSIS_ERROR');
    }
  }

  /**
   * Execute a rebalance proposal
   */
  async executeRebalance(
    userKeyPair: any,
    proposal: RebalanceProposal,
    options?: TransactionOptions
  ): Promise<TransactionResult & { success: boolean }> {
    try {
      const account = await this.server.getAccount(userKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(
          this.contract.call(
            'execute_rebalance',
            userKeyPair.publicKey(),
            this.formatRebalanceProposal(proposal)
          )
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = userKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);
      
      if (result.status === 'SUCCESS') {
        const txResult = await this.server.getTransaction(result.hash);
        const success = Boolean(txResult.result!.returnValue);
        
        return {
          hash: result.hash,
          success: true,
          gasUsed: 0,
          success: success
        };
      } else {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult,
          success: false
        };
      }
    } catch (error: any) {
      throw new RebalanceError(`Execute rebalance failed: ${error.message}`, 'EXECUTE_ERROR');
    }
  }

  /**
   * Get all strategies
   */
  async getStrategies(): Promise<RebalanceStrategy[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_strategies'))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get strategies');
      }

      return this.parseStrategies(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(`Failed to get strategies: ${error.message}`, 'GET_STRATEGIES_ERROR');
    }
  }

  /**
   * Get specific strategy
   */
  async getStrategy(strategyId: number): Promise<RebalanceStrategy> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_strategy', strategyId.toString()))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get strategy');
      }

      return this.parseStrategy(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(`Failed to get strategy: ${error.message}`, 'GET_STRATEGY_ERROR');
    }
  }

  /**
   * Get rebalance history
   */
  async getHistory(limit: number = 100): Promise<RebalanceHistory[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_history', limit.toString()))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get history');
      }

      return this.parseHistory(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(`Failed to get history: ${error.message}`, 'GET_HISTORY_ERROR');
    }
  }

  /**
   * Get current allocations for a strategy
   */
  async getCurrentAllocations(strategyId: number): Promise<PoolAllocation[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_current_allocations', strategyId.toString()))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get current allocations');
      }

      return this.parseAllocations(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(`Failed to get allocations: ${error.message}`, 'GET_ALLOCATIONS_ERROR');
    }
  }

  /**
   * Calculate impermanent loss for a pool
   */
  async calculateImpermanentLoss(
    poolId: Address,
    priceRatio: number,
    initialPriceRatio: number
  ): Promise<number> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(
            this.contract.call(
              'calculate_impermanent_loss',
              poolId,
              priceRatio.toString(),
              initialPriceRatio.toString()
            )
          )
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to calculate impermanent loss');
      }

      return Number(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(`IL calculation failed: ${error.message}`, 'IL_CALCULATION_ERROR');
    }
  }

  /**
   * Simulate rebalance before execution
   */
  async simulateRebalance(
    strategyId: number,
    currentAllocations: PoolAllocation[],
    marketConditions: any
  ): Promise<{
    proposals: RebalanceProposal[];
    expectedApyImprovement: number;
    estimatedGasCost: bigint;
    riskAssessment: number;
  }> {
    try {
      const proposals = await this.analyzeRebalanceOpportunities(strategyId);
      
      // Calculate expected APY improvement
      let totalApyImprovement = 0;
      for (const proposal of proposals) {
        totalApyImprovement += proposal.expectedApyImprovement;
      }
      
      // Estimate total gas cost
      let totalGasCost = 0n;
      for (const proposal of proposals) {
        totalGasCost += proposal.estimatedGasCost;
      }
      
      // Assess risk based on IL and market volatility
      const riskAssessment = this.calculateRiskAssessment(proposals, marketConditions);
      
      return {
        proposals,
        expectedApyImprovement: totalApyImprovement / Math.max(proposals.length, 1),
        estimatedGasCost: totalGasCost,
        riskAssessment
      };
    } catch (error: any) {
      throw new RebalanceError(`Simulation failed: ${error.message}`, 'SIMULATION_ERROR');
    }
  }

  /**
   * Pause rebalance engine (admin only)
   */
  async pause(adminKeyPair: any, options?: TransactionOptions): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(this.contract.call('pause', adminKeyPair.publicKey()))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0,
        error: result.status === 'ERROR' ? result.errorResult : undefined
      };
    } catch (error: any) {
      throw new RebalanceError(`Pause failed: ${error.message}`, 'PAUSE_ERROR');
    }
  }

  /**
   * Unpause rebalance engine (admin only)
   */
  async unpause(adminKeyPair: any, options?: TransactionOptions): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(this.contract.call('unpause', adminKeyPair.publicKey()))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0,
        error: result.status === 'ERROR' ? result.errorResult : undefined
      };
    } catch (error: any) {
      throw new RebalanceError(`Unpause failed: ${error.message}`, 'UNPAUSE_ERROR');
    }
  }

  // Helper methods
  private getNetworkPassphrase(): string {
    switch (this.networkConfig.network) {
      case 'mainnet':
        return Networks.PUBLIC;
      case 'testnet':
        return Networks.TESTNET;
      case 'futurenet':
        return Networks.FUTURENET;
      default:
        throw new RebalanceError('Invalid network configuration', 'INVALID_NETWORK');
    }
  }

  private formatAllocations(allocations: PoolAllocation[]): any {
    return allocations.map(alloc => ({
      pool_id: alloc.poolId.toString(),
      token_a: alloc.tokenA.toString(),
      token_b: alloc.tokenB.toString(),
      allocation_percent: alloc.allocationPercent.toString(),
      target_apy: alloc.targetApy.toString(),
      current_apy: alloc.currentApy.toString(),
      impermanent_loss_risk: alloc.impermanentLossRisk.toString()
    }));
  }

  private formatRebalanceProposal(proposal: RebalanceProposal): any {
    return {
      from_pool: proposal.fromPool.toString(),
      to_pool: proposal.toPool.toString(),
      amount_a: proposal.amountA.toString(),
      amount_b: proposal.amountB.toString(),
      expected_apy_improvement: proposal.expectedApyImprovement.toString(),
      estimated_gas_cost: proposal.estimatedGasCost.toString(),
      timestamp: proposal.timestamp.toString()
    };
  }

  private parseRebalanceProposals(returnValue: xdr.ScVal): RebalanceProposal[] {
    // Parse the ScVal array into RebalanceProposal array
    const proposals: RebalanceProposal[] = [];
    const data = returnValue.array()?.val || [];
    
    for (const item of data) {
      const proposalData = item.object()?.val || [];
      proposals.push({
        fromPool: new Address(proposalData[0]?.toString() || ''),
        toPool: new Address(proposalData[1]?.toString() || ''),
        amountA: BigInt(proposalData[2]?.toString() || '0'),
        amountB: BigInt(proposalData[3]?.toString() || '0'),
        expectedApyImprovement: Number(proposalData[4] || 0),
        estimatedGasCost: BigInt(proposalData[5]?.toString() || '0'),
        timestamp: Number(proposalData[6] || 0)
      });
    }
    
    return proposals;
  }

  private parseStrategies(returnValue: xdr.ScVal): RebalanceStrategy[] {
    // Parse the ScVal array into RebalanceStrategy array
    const strategies: RebalanceStrategy[] = [];
    const data = returnValue.array()?.val || [];
    
    for (const item of data) {
      const strategyData = item.object()?.val || [];
      strategies.push({
        strategyId: Number(strategyData[0] || 0),
        name: strategyData[1]?.toString() || '',
        riskLevel: Number(strategyData[2] || 0),
        minApyThreshold: Number(strategyData[3] || 0),
        maxIlRisk: Number(strategyData[4] || 0),
        rebalanceFrequency: Number(strategyData[5] || 0),
        allocations: this.parseAllocations(item)
      });
    }
    
    return strategies;
  }

  private parseStrategy(returnValue: xdr.ScVal): RebalanceStrategy {
    // Parse the ScVal into RebalanceStrategy structure
    const data = returnValue.object()?.val || [];
    return {
      strategyId: Number(data[0] || 0),
      name: data[1]?.toString() || '',
      riskLevel: Number(data[2] || 0),
      minApyThreshold: Number(data[3] || 0),
      maxIlRisk: Number(data[4] || 0),
      rebalanceFrequency: Number(data[5] || 0),
      allocations: this.parseAllocations(returnValue)
    };
  }

  private parseAllocations(returnValue: xdr.ScVal): PoolAllocation[] {
    // Parse the ScVal array into PoolAllocation array
    const allocations: PoolAllocation[] = [];
    const data = returnValue.array()?.val || [];
    
    for (const item of data) {
      const allocData = item.object()?.val || [];
      allocations.push({
        poolId: new Address(allocData[0]?.toString() || ''),
        tokenA: new Address(allocData[1]?.toString() || ''),
        tokenB: new Address(allocData[2]?.toString() || ''),
        allocationPercent: Number(allocData[3] || 0),
        targetApy: Number(allocData[4] || 0),
        currentApy: Number(allocData[5] || 0),
        impermanentLossRisk: Number(allocData[6] || 0)
      });
    }
    
    return allocations;
  }

  private parseHistory(returnValue: xdr.ScVal): RebalanceHistory[] {
    // Parse the ScVal array into RebalanceHistory array
    const history: RebalanceHistory[] = [];
    const data = returnValue.array()?.val || [];
    
    for (const item of data) {
      const historyData = item.object()?.val || [];
      history.push({
        timestamp: Number(historyData[0] || 0),
        fromPool: new Address(historyData[1]?.toString() || ''),
        toPool: new Address(historyData[2]?.toString() || ''),
        amountMoved: BigInt(historyData[3]?.toString() || '0'),
        apyBefore: Number(historyData[4] || 0),
        apyAfter: Number(historyData[5] || 0),
        success: Boolean(historyData[6] || false)
      });
    }
    
    return history;
  }

  private calculateRiskAssessment(proposals: RebalanceProposal[], marketConditions: any): number {
    // Simple risk assessment based on IL risk and market volatility
    let totalRisk = 0;
    for (const proposal of proposals) {
      // Risk increases with expected APY improvement (higher reward = higher risk)
      totalRisk += proposal.expectedApyImprovement / 100;
    }
    
    // Factor in market volatility
    const volatilityFactor = marketConditions.volatility || 1;
    totalRisk *= volatilityFactor;
    
    // Normalize to 0-100 scale
    return Math.min(Math.max(totalRisk, 0), 100);
  }
}
