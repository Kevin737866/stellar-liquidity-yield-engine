import { EventEmitter } from 'events';
import {
  Address,
  Contract,
  Keypair,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  xdr,
  nativeToScVal,
  scValToNative,
} from "stellar-sdk";
import {
  RebalanceStrategy,
  RebalanceProposal,
  RebalanceHistory,
  PoolAllocation,
  PoolApyRecord,
  TransactionOptions,
  TransactionResult,
  TransactionSigner,
  RebalanceError,
  NetworkConfig,
} from "./types";
import { waitForTransaction } from "./utils/transaction";

export class RebalancerClient extends EventEmitter {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkConfig: NetworkConfig;

  constructor(networkConfig: NetworkConfig) {
    super();
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
    options?: TransactionOptions,
  ): Promise<TransactionResult & { strategyId: number }> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(
          this.contract.call(
            "create_strategy",
            adminKeyPair.publicKey(),
            name,
            riskLevel.toString(),
            minApyThreshold.toString(),
            maxIlRisk.toString(),
            rebalanceFrequency.toString(),
            this.formatAllocations(allocations),
          ),
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      if (result.status === "SUCCESS") {
        const txResult = await waitForTransaction(this.server, result.hash);
        const strategyId = Number(txResult.result!.returnValue);

        return {
          hash: result.hash,
          success: true,
          gasUsed: 0,
          strategyId,
        };
      } else {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult,
          strategyId: 0,
        };
      }
    } catch (error: any) {
      throw new RebalanceError(
        `Create strategy failed: ${error.message}`,
        "CREATE_STRATEGY_ERROR",
      );
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
    options?: TransactionOptions,
  ): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(
          this.contract.call(
            "update_strategy",
            adminKeyPair.publicKey(),
            strategyId.toString(),
            name,
            riskLevel.toString(),
            minApyThreshold.toString(),
            maxIlRisk.toString(),
            rebalanceFrequency.toString(),
            this.formatAllocations(allocations),
          ),
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      return {
        hash: result.hash,
        success: result.status === "SUCCESS",
        gasUsed: 0,
        error: result.status === "ERROR" ? result.errorResult : undefined,
      };
    } catch (error: any) {
      throw new RebalanceError(
        `Update strategy failed: ${error.message}`,
        "UPDATE_STRATEGY_ERROR",
      );
    }
  }

  /**
   * Analyze rebalance opportunities for a strategy
   */
  async analyzeRebalanceOpportunities(
    strategyId: number,
  ): Promise<RebalanceProposal[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call(
              "analyze_rebalance_opportunities",
              strategyId.toString(),
            ),
          )
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to analyze rebalance opportunities");
      }

      return this.parseRebalanceProposals(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(
        `Analysis failed: ${error.message}`,
        "ANALYSIS_ERROR",
      );
    }
  }

  /**
   * Execute a rebalance proposal.
   *
   * Accepts either a Stellar `Keypair` or an async wallet `TransactionSigner`
   * (e.g. Freighter). Both paths build the `execute_rebalance` call, sign it
   * for the configured network, and submit it to the RPC node.
   */
  async executeRebalance(
    userKeyPair: Keypair | TransactionSigner,
    proposal: RebalanceProposal,
    options?: TransactionOptions,
  ): Promise<TransactionResult & { executed: boolean }> {
    try {
      if (!userKeyPair) {
        throw new RebalanceError(
          "A keypair or wallet signer is required to execute a rebalance",
          "SIGNER_REQUIRED",
        );
      }

      const usesWalletSigner =
        typeof (userKeyPair as TransactionSigner).signTransaction ===
        "function";

      const publicKey = usesWalletSigner
        ? await (userKeyPair as TransactionSigner).getPublicKey()
        : (userKeyPair as Keypair).publicKey();

      const account = await this.server.getAccount(publicKey);

      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(
          this.contract.call(
            "execute_rebalance",
            // Matches the string-argument style used throughout this client.
            publicKey as any,
            this.formatRebalanceProposal(proposal),
          ),
        )
        .setTimeout(options?.timeout || 30)
        .build();

      let signedTx: Transaction;
      if (usesWalletSigner) {
        signedTx = await (userKeyPair as TransactionSigner).signTransaction(
          tx,
          this.getNetworkPassphrase(),
        );
      } else {
        tx.sign(userKeyPair as Keypair);
        signedTx = tx;
      }

      const result = await this.server.sendTransaction(signedTx);

      if (result.status === "SUCCESS") {
        const txResult = await waitForTransaction(this.server, result.hash);
        const executed = Boolean(txResult.result!.returnValue);

        return {
          hash: result.hash,
          success: true,
          gasUsed: 0,
          executed,
        };
      } else {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult,
          executed: false,
        };
      }
    } catch (error: any) {
      throw new RebalanceError(
        `Execute rebalance failed: ${error.message}`,
        "EXECUTE_ERROR",
      );
    }
  }

  /**
   * Get all strategies
   */
  async getStrategies(): Promise<RebalanceStrategy[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(this.contract.call("get_strategies"))
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get strategies");
      }

      return this.parseStrategies(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get strategies: ${error.message}`,
        "GET_STRATEGIES_ERROR",
      );
    }
  }

  /**
   * Get specific strategy
   */
  async getStrategy(strategyId: number): Promise<RebalanceStrategy> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call("get_strategy", strategyId.toString()),
          )
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get strategy");
      }

      return this.parseStrategy(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get strategy: ${error.message}`,
        "GET_STRATEGY_ERROR",
      );
    }
  }

  /**
   * Get rebalance history
   */
  async getHistory(limit: number = 100): Promise<RebalanceHistory[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(this.contract.call("get_history", limit.toString()))
          .setTimeout(30)
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get history");
      }

      return this.parseHistory(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get history: ${error.message}`,
        "GET_HISTORY_ERROR",
      );
    }
  }

  /**
   * Fetch one bounded page of rebalance history in chronological order.
   * `offset` is the zero-based index of the first history entry.
   */
  async getHistoryPage(limit: number = 100, offset: number = 0): Promise<RebalanceHistory[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RebalanceError('History page limit must be an integer between 1 and 1000', 'INVALID_PAGINATION');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0xffff_ffff) {
      throw new RebalanceError('History page offset must be a u32 integer', 'INVALID_PAGINATION');
    }

    try {
      const result: any = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call(
              'get_history_paginated',
              nativeToScVal(limit, { type: 'u32' }),
              nativeToScVal(offset, { type: 'u32' }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get history page');
      }

      return this.parseHistory(result.result.returnValue);
    } catch (error: any) {
      if (error instanceof RebalanceError && error.code === 'INVALID_PAGINATION') throw error;
      throw new RebalanceError(
        `Failed to get history page: ${error.message}`,
        'GET_HISTORY_PAGE_ERROR',
      );
    }
  }

  /** Return the total number of rebalance history entries for pagination UI. */
  async getHistoryCount(): Promise<number> {
    try {
      const result: any = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(this.contract.call('get_history_count'))
          .setTimeout(30)
          .build(),
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get history count');
      }

      const count = Number(scValToNative(result.result.returnValue));
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Contract returned an invalid history count');
      }
      return count;
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get history count: ${error.message}`,
        'GET_HISTORY_COUNT_ERROR',
      );
    }
  }

  /**
   * Get current allocations for a strategy
   */
  async getCurrentAllocations(strategyId: number): Promise<PoolAllocation[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call(
              "get_current_allocations",
              strategyId.toString(),
            ),
          )
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get current allocations");
      }

      return this.parseAllocations(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get allocations: ${error.message}`,
        "GET_ALLOCATIONS_ERROR",
      );
    }
  }

  /**
   * Check if a pool's APY observation is still fresh (within the configured maximum age).
   *
   * Returns true when the pool has an observation that is still within the
   * configured maximum age, false otherwise.
   */
  async isApyFresh(poolId: Address): Promise<boolean> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('is_apy_fresh', poolId.toString()))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to check APY freshness');
      }

      return Boolean(scValToNative(result.result.returnValue));
    } catch (error: any) {
      throw new RebalanceError(`Freshness check failed: ${error.message}`, 'FRESHNESS_CHECK_ERROR');
    }
  }

  /**
   * Calculate impermanent loss for a pool
   */
  async calculateImpermanentLoss(
    poolId: Address,
    priceRatio: number,
    initialPriceRatio: number,
  ): Promise<number> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call(
              "calculate_impermanent_loss",
              poolId,
              priceRatio.toString(),
              initialPriceRatio.toString(),
            ),
          )
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to calculate impermanent loss");
      }

      return Number(result.result.returnValue);
    } catch (error: any) {
      throw new RebalanceError(
        `IL calculation failed: ${error.message}`,
        "IL_CALCULATION_ERROR",
      );
    }
  }

  /**
   * Simulate rebalance before execution
   */
  async simulateRebalance(
    strategyId: number,
    currentAllocations: PoolAllocation[],
    marketConditions: any,
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
      const riskAssessment = this.calculateRiskAssessment(
        proposals,
        marketConditions,
      );

      return {
        proposals,
        expectedApyImprovement:
          totalApyImprovement / Math.max(proposals.length, 1),
        estimatedGasCost: totalGasCost,
        riskAssessment,
      };
    } catch (error: any) {
      throw new RebalanceError(
        `Simulation failed: ${error.message}`,
        "SIMULATION_ERROR",
      );
    }
  }

  /**
   * Pause rebalance engine (admin only)
   * @param adminKeyPair - Admin keypair for signing
   * @param reason - Reason for the pause (e.g., 'security', 'circuit_breaker', 'maintenance')
   * @param reasonDetails - Additional context about the pause reason
   * @param options - Transaction options
   */
  async pause(
    adminKeyPair: any,
    options?: TransactionOptions,
  ): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(this.contract.call("pause", adminKeyPair.publicKey()))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      return {
        hash: result.hash,
        success: result.status === "SUCCESS",
        gasUsed: 0,
        error: result.status === "ERROR" ? result.errorResult : undefined,
      };

      // Emit pause event with reason if successful
      if (transactionResult.success && reason) {
        this.emitPauseEvent(reason, reasonDetails);
      }

      return transactionResult;
    } catch (error: any) {
      throw new RebalanceError(`Pause failed: ${error.message}`, "PAUSE_ERROR");
    }
  }

  /**
   * Unpause rebalance engine (admin only)
   */
  async unpause(
    adminKeyPair: any,
    options?: TransactionOptions,
  ): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(adminKeyPair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(this.contract.call("unpause", adminKeyPair.publicKey()))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = adminKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      return {
        hash: result.hash,
        success: result.status === "SUCCESS",
        gasUsed: 0,
        error: result.status === "ERROR" ? result.errorResult : undefined,
      };
    } catch (error: any) {
      throw new RebalanceError(
        `Unpause failed: ${error.message}`,
        "UNPAUSE_ERROR",
      );
    }
  }

  /** Manage dedicated APY oracle keepers. Admin-only setter; keepers may publish data without admin privileges. */
  async setApyKeepers(
    adminKeyPair: Keypair | TransactionSigner,
    keepers: string[],
    options?: TransactionOptions,
  ): Promise<TransactionResult> {
    try {
      const publicKey = await this.resolvePublicKey(adminKeyPair);
      const account = await this.server.getAccount(publicKey);
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(this.contract.call("set_apy_keepers", publicKey, keepers))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = await this.signTransaction(adminKeyPair, tx);
      const result = await this.server.sendTransaction(signedTx);

      return {
        hash: result.hash,
        success: result.status === "SUCCESS",
        gasUsed: 0,
        error: result.status === "ERROR" ? result.errorResult : undefined,
      };
    } catch (error: any) {
      throw new RebalanceError(
        `Set APY keepers failed: ${error.message}`,
        "SET_APY_KEEPERS_ERROR",
      );
    }
  }

  async getApyKeepers(): Promise<string[]> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(this.contract.call("get_apy_keepers"))
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get APY keepers");
      }

      const data = scValToNative(result.result.returnValue) as string[];
      return Array.isArray(data) ? data : [];
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get APY keepers: ${error.message}`,
        "GET_APY_KEEPERS_ERROR",
      );
    }
  }

  async updatePoolApy(
    keeperKeyPair: Keypair | TransactionSigner,
    poolId: Address | string,
    apyBps: number,
    options?: TransactionOptions,
  ): Promise<TransactionResult> {
    try {
      const publicKey = await this.resolvePublicKey(keeperKeyPair);
      const account = await this.server.getAccount(publicKey);
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(
          this.contract.call(
            "update_pool_apy",
            publicKey,
            poolId.toString(),
            apyBps.toString(),
          ),
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = await this.signTransaction(keeperKeyPair, tx);
      const result = await this.server.sendTransaction(signedTx);

      return {
        hash: result.hash,
        success: result.status === "SUCCESS",
        gasUsed: 0,
        error: result.status === "ERROR" ? result.errorResult : undefined,
      };
    } catch (error: any) {
      throw new RebalanceError(
        `Update pool APY failed: ${error.message}`,
        "UPDATE_POOL_APY_ERROR",
      );
    }
  }

  async getPoolCurrentApy(poolId: Address | string): Promise<number> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call("get_pool_current_apy", poolId.toString()),
          )
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get pool APY");
      }

      return Number(scValToNative(result.result.returnValue));
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get pool APY: ${error.message}`,
        "GET_POOL_APY_ERROR",
      );
    }
  }

  async getPoolApyRecord(
    poolId: Address | string,
  ): Promise<PoolApyRecord | null> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(
            this.contract.call("get_pool_apy_record", poolId.toString()),
          )
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get pool APY record");
      }

      const record = scValToNative(result.result.returnValue) as any;
      if (!record) {
        return null;
      }

      return {
        apyBps: Number(record.apy_bps),
        updatedAt: Number(record.updated_at),
        updatedBy: new Address(record.updated_by).toString(),
      };
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get pool APY record: ${error.message}`,
        "GET_POOL_APY_RECORD_ERROR",
      );
    }
  }

  async setMaxApyAge(
    adminKeyPair: Keypair | TransactionSigner,
    maxAge: number,
    options?: TransactionOptions,
  ): Promise<TransactionResult> {
    try {
      const publicKey = await this.resolvePublicKey(adminKeyPair);
      const account = await this.server.getAccount(publicKey);
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(
          this.contract.call("set_max_apy_age", publicKey, maxAge.toString()),
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = await this.signTransaction(adminKeyPair, tx);
      const result = await this.server.sendTransaction(signedTx);

      return {
        hash: result.hash,
        success: result.status === "SUCCESS",
        gasUsed: 0,
        error: result.status === "ERROR" ? result.errorResult : undefined,
      };

      // Emit unpause event if successful
      if (transactionResult.success) {
        this.emitUnpauseEvent();
      }

      return transactionResult;
    } catch (error: any) {
      throw new RebalanceError(
        `Set max APY age failed: ${error.message}`,
        "SET_MAX_APY_AGE_ERROR",
      );
    }
  }

  async getMaxApyAge(): Promise<number> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(this.contract.call("get_max_apy_age"))
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to get max APY age");
      }

      return Number(scValToNative(result.result.returnValue));
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to get max APY age: ${error.message}`,
        "GET_MAX_APY_AGE_ERROR",
      );
    }
  }

  async isApyFresh(poolId: Address | string): Promise<boolean> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          },
        )
          .addOperation(this.contract.call("is_apy_fresh", poolId.toString()))
          .build(),
      );

      if (result.result?.status !== "SUCCESS") {
        throw new Error("Failed to check APY freshness");
      }

      return Boolean(scValToNative(result.result.returnValue));
    } catch (error: any) {
      throw new RebalanceError(
        `Failed to check APY freshness: ${error.message}`,
        "IS_APY_FRESH_ERROR",
      );
    }
  }

  /**
   * Emit a pause event with reason for monitoring and dashboards
   */
  private emitPauseEvent(reason: PauseReason, reasonDetails?: string): void {
    const event: RebalanceEvent = {
      type: 'pause',
      strategy: 0, // Default strategy ID, can be overridden if needed
      timestamp: Math.floor(Date.now() / 1000),
      reason,
      reasonDetails
    };
    this.emit('pause', event);
    this.emit('rebalanceEvent', event);
  }

  /**
   * Emit an unpause event for monitoring and dashboards
   */
  private emitUnpauseEvent(): void {
    const event: RebalanceEvent = {
      type: 'unpause',
      strategy: 0, // Default strategy ID
      timestamp: Math.floor(Date.now() / 1000)
    };
    this.emit('unpause', event);
    this.emit('rebalanceEvent', event);
  }

  // Helper methods
  private getNetworkPassphrase(): string {
    switch (this.networkConfig.network) {
      case "mainnet":
        return Networks.PUBLIC;
      case "testnet":
        return Networks.TESTNET;
      case "futurenet":
        return Networks.FUTURENET;
      default:
        throw new RebalanceError(
          "Invalid network configuration",
          "INVALID_NETWORK",
        );
    }
  }

  private async resolvePublicKey(
    signer: Keypair | TransactionSigner,
  ): Promise<string> {
    if (typeof (signer as TransactionSigner).getPublicKey === "function") {
      return await (signer as TransactionSigner).getPublicKey();
    }
    return (signer as Keypair).publicKey();
  }

  private async signTransaction(
    signer: Keypair | TransactionSigner,
    tx: Transaction,
  ): Promise<Transaction> {
    const usesWalletSigner =
      typeof (signer as TransactionSigner).signTransaction === "function";

    if (usesWalletSigner) {
      return await (signer as TransactionSigner).signTransaction(
        tx,
        this.getNetworkPassphrase(),
      );
    }

    (signer as Keypair).sign(tx);
    return tx;
  }

  private formatAllocations(allocations: PoolAllocation[]): any {
    return allocations.map((alloc) => ({
      pool_id: alloc.poolId.toString(),
      token_a: alloc.tokenA.toString(),
      token_b: alloc.tokenB.toString(),
      allocation_percent: alloc.allocationPercent.toString(),
      target_apy: alloc.targetApy.toString(),
      current_apy: alloc.currentApy.toString(),
      impermanent_loss_risk: alloc.impermanentLossRisk.toString(),
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
      timestamp: proposal.timestamp.toString(),
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
      timestamp: Number(item.timestamp),
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
      allocations: this.parseAllocationsValue(strategy.allocations),
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
      allocations: this.parseAllocationsValue(data.allocations),
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
      impermanentLossRisk: Number(alloc.impermanent_loss_risk),
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
      success: Boolean(item.success),
    }));
  }

  private calculateRiskAssessment(
    proposals: RebalanceProposal[],
    marketConditions: any,
  ): number {
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
