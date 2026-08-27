import { 
  Address, 
  Contract, 
  SorobanRpc, 
  TransactionBuilder, 
  Networks,
  BASE_FEE,
  xdr,
  scValToNative
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
            adminKeyPair.publicKey(),
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
            adminKeyPair.publicKey(),
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

  /**
   * Parse a vector of `RebalanceProposal` structs using `scValToNative`.
   *
   * The contract encodes each proposal as a struct; `scValToNative` converts
   * the outer vector to an array and each struct to an object with snake_case
   * keys, mapping i128s to bigints and u64s/u32s to numbers.
   */
  private parseRebalanceProposals(returnValue: xdr.ScVal): RebalanceProposal[] {
    const data = scValToNative(returnValue) as any[];

    return data.map((item) => ({
      fromPool: new Address(item.from_pool),
      toPool: new Address(item.to_pool),
      amountA: BigInt(item.amount_a),
      amountB: BigInt(item.amount_b),
      expectedApyImprovement: Number(item.expected_apy_improvement),
      estimatedGasCost: BigInt(item.estimated_gas_cost),
      timestamp: Number(item.timestamp)
    }));
  }

  private parseStrategies(returnValue: xdr.ScVal): RebalanceStrategy[] {
    const data = scValToNative(returnValue) as any[];

    return data.map((strategy) => ({
      strategyId: Number(strategy.strategy_id),
      name: strategy.name,
      riskLevel: Number(strategy.risk_level),
      minApyThreshold: Number(strategy.min_apy_threshold),
      maxIlRisk: Number(strategy.max_il_risk),
      rebalanceFrequency: Number(strategy.rebalance_frequency),
      allocations: this.parseAllocationsValue(strategy.allocations)
    }));
  }

  private parseStrategy(returnValue: xdr.ScVal): RebalanceStrategy {
    const data = scValToNative(returnValue) as any;
    return {
      strategyId: Number(data.strategy_id),
      name: data.name,
      riskLevel: Number(data.risk_level),
      minApyThreshold: Number(data.min_apy_threshold),
      maxIlRisk: Number(data.max_il_risk),
      rebalanceFrequency: Number(data.rebalance_frequency),
      allocations: this.parseAllocationsValue(data.allocations)
    };
  }

  private parseAllocations(returnValue: xdr.ScVal): PoolAllocation[] {
    const data = scValToNative(returnValue) as any[];
    return this.parseAllocationsValue(data);
  }

  private parseAllocationsValue(allocations: any[]): PoolAllocation[] {
    return allocations.map((alloc) => ({
      poolId: new Address(alloc.pool_id),
      tokenA: new Address(alloc.token_a),
      tokenB: new Address(alloc.token_b),
      allocationPercent: Number(alloc.allocation_percent),
      targetApy: Number(alloc.target_apy),
      currentApy: Number(alloc.current_apy),
      impermanentLossRisk: Number(alloc.impermanent_loss_risk)
    }));
  }

  private parseHistory(returnValue: xdr.ScVal): RebalanceHistory[] {
    const data = scValToNative(returnValue) as any[];

    return data.map((item) => ({
      timestamp: Number(item.timestamp),
      fromPool: new Address(item.from_pool),
      toPool: new Address(item.to_pool),
      amountMoved: BigInt(item.amount_moved),
      apyBefore: Number(item.apy_before),
      apyAfter: Number(item.apy_after),
      success: Boolean(item.success)
    }));
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
