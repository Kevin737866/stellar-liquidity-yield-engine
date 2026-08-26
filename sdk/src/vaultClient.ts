import { 
  Address, 
  Account, 
  Contract, 
  Keypair, 
  SorobanRpc, 
  TransactionBuilder, 
  Networks,
  BASE_FEE,
  xdr
} from 'stellar-sdk';
import {
  VaultInfo,
  UserPosition,
  VaultMetrics,
  DepositParams,
  WithdrawParams,
  TransactionOptions,
  TransactionResult,
  VaultError,
  NetworkConfig,
  VaultClientOptions
} from './types';

export class VaultClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkConfig: NetworkConfig;
  private simulationSource?: string;

  constructor(
    vaultAddress: Address,
    networkConfig: NetworkConfig,
    options: VaultClientOptions = {}
  ) {
    this.contract = new Contract(vaultAddress);
    this.server = new SorobanRpc.Server(networkConfig.sorobanRpcUrl);
    this.networkConfig = networkConfig;
    this.simulationSource = options.simulationSource;
  }

  /**
   * Deposit tokens into the vault
   */
  async deposit(
    userKeyPair: any,
    params: DepositParams,
    options?: TransactionOptions
  ): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(userKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(
          this.contract.call(
            'deposit',
            ...this.prepareDepositArgs(params)
          )
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = userKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      if (result.status === 'ERROR') {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult?.toXDR('base64')
        };
      }

      const txResult = await this.confirmTransaction(result.hash);
      return {
        hash: result.hash,
        success: txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        gasUsed: this.parseGasUsed(txResult),
        error: txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED ? txResult.status : undefined
      };
    } catch (error) {
      throw new VaultError(`Deposit failed: ${error.message}`, 'DEPOSIT_ERROR');
    }
  }

  /**
   * Withdraw tokens from the vault
   */
  async withdraw(
    userKeyPair: any,
    params: WithdrawParams,
    options?: TransactionOptions
  ): Promise<TransactionResult & { amountA: bigint; amountB: bigint }> {
    try {
      const account = await this.server.getAccount(userKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(
          this.contract.call(
            'withdraw',
            ...this.prepareWithdrawArgs(params)
          )
        )
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = userKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      if (result.status === 'ERROR') {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult?.toXDR('base64'),
          amountA: 0n,
          amountB: 0n
        };
      }

      const txResult = await this.confirmTransaction(result.hash);

      if (
        txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS &&
        txResult.returnValue
      ) {
        const returnValue = this.parseWithdrawResult(txResult.returnValue);

        return {
          hash: result.hash,
          success: true,
          gasUsed: this.parseGasUsed(txResult),
          amountA: returnValue.amountA,
          amountB: returnValue.amountB
        };
      }

      return {
        hash: result.hash,
        success: false,
        gasUsed: 0,
        error: txResult.status,
        amountA: 0n,
        amountB: 0n
      };
    } catch (error) {
      throw new VaultError(`Withdraw failed: ${error.message}`, 'WITHDRAW_ERROR');
    }
  }

  /**
   * Trigger harvest and auto-compounding
   */
  async harvest(
    userKeyPair: any,
    options?: TransactionOptions
  ): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(userKeyPair.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(this.contract.call('harvest'))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = userKeyPair.sign(tx);
      const result = await this.server.sendTransaction(signedTx);

      if (result.status === 'ERROR') {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult?.toXDR('base64')
        };
      }

      const txResult = await this.confirmTransaction(result.hash);
      return {
        hash: result.hash,
        success: txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        gasUsed: this.parseGasUsed(txResult),
        error: txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED ? txResult.status : undefined
      };
    } catch (error) {
      throw new VaultError(`Harvest failed: ${error.message}`, 'HARVEST_ERROR');
    }
  }

  /**
   * Get vault information
   */
  async getVaultInfo(): Promise<VaultInfo> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.getSimulationAccount(),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_vault_info'))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get vault info');
      }

      return this.parseVaultInfo(result.result.returnValue);
    } catch (error) {
      throw new VaultError(`Failed to get vault info: ${error.message}`, 'GET_INFO_ERROR');
    }
  }

  /**
   * Get vault metrics
   */
  async getMetrics(): Promise<VaultMetrics> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.getSimulationAccount(),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_metrics'))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get metrics');
      }

      return this.parseMetrics(result.result.returnValue);
    } catch (error) {
      throw new VaultError(`Failed to get metrics: ${error.message}`, 'GET_METRICS_ERROR');
    }
  }

  /**
   * Get user position
   */
  async getUserPosition(userAddress: Address): Promise<UserPosition> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.getSimulationAccount(),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_user_position', userAddress))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get user position');
      }

      return this.parseUserPosition(result.result.returnValue);
    } catch (error) {
      throw new VaultError(`Failed to get user position: ${error.message}`, 'GET_POSITION_ERROR');
    }
  }

  /**
   * Get current APY
   */
  async getAPY(): Promise<number> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.getSimulationAccount(),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_apy'))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get APY');
      }

      return Number(result.result.returnValue);
    } catch (error) {
      throw new VaultError(`Failed to get APY: ${error.message}`, 'GET_APY_ERROR');
    }
  }

  /**
   * Get Total Value Locked
   */
  async getTVL(): Promise<bigint> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.getSimulationAccount(),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('get_tvl'))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to get TVL');
      }

      return BigInt(result.result.returnValue);
    } catch (error) {
      throw new VaultError(`Failed to get TVL: ${error.message}`, 'GET_TVL_ERROR');
    }
  }

  /**
   * Check if vault is paused
   */
  async isPaused(): Promise<boolean> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.getSimulationAccount(),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase()
          }
        )
          .addOperation(this.contract.call('is_paused'))
          .build()
      );

      if (result.result?.status !== 'SUCCESS') {
        throw new Error('Failed to check pause status');
      }

      return Boolean(result.result.returnValue);
    } catch (error) {
      throw new VaultError(`Failed to check pause status: ${error.message}`, 'PAUSE_CHECK_ERROR');
    }
  }

  /**
   * Pause vault (admin only)
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

      if (result.status === 'ERROR') {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult?.toXDR('base64')
        };
      }

      const txResult = await this.confirmTransaction(result.hash);
      return {
        hash: result.hash,
        success: txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        gasUsed: this.parseGasUsed(txResult),
        error: txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED ? txResult.status : undefined
      };
    } catch (error) {
      throw new VaultError(`Pause failed: ${error.message}`, 'PAUSE_ERROR');
    }
  }

  /**
   * Unpause vault (admin only)
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

      if (result.status === 'ERROR') {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult?.toXDR('base64')
        };
      }

      const txResult = await this.confirmTransaction(result.hash);
      return {
        hash: result.hash,
        success: txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        gasUsed: this.parseGasUsed(txResult),
        error: txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED ? txResult.status : undefined
      };
    } catch (error) {
      throw new VaultError(`Unpause failed: ${error.message}`, 'UNPAUSE_ERROR');
    }
  }

  // Helper methods

  /**
   * Resolve the source account used for read-only `simulateTransaction`
   * calls. Uses the caller-provided `simulationSource` address when given;
   * otherwise falls back to a freshly generated test account so queries are
   * not tied to the hardcoded friendbot address.
   */
  private async getSimulationAccount(): Promise<Account> {
    if (this.simulationSource) {
      return this.server.getAccount(this.simulationSource);
    }
    // A locally-constructed account is sufficient for read-only simulations;
    // no network lookup or funded account is required.
    return new Account(Keypair.random().publicKey(), '0');
  }

  private getNetworkPassphrase(): string {
    switch (this.networkConfig.network) {
      case 'mainnet':
        return Networks.PUBLIC;
      case 'testnet':
        return Networks.TESTNET;
      case 'futurenet':
        return Networks.FUTURENET;
      default:
        throw new VaultError('Invalid network configuration', 'INVALID_NETWORK');
    }
  }

  private prepareDepositArgs(params: DepositParams): any[] {
    return [
      params.amountA.toString(),
      params.amountB.toString(),
      params.minShares.toString()
    ];
  }

  private prepareWithdrawArgs(params: WithdrawParams): any[] {
    return [
      params.shares.toString(),
      params.minAmountA.toString(),
      params.minAmountB.toString()
    ];
  }

  private parseVaultInfo(returnValue: xdr.ScVal): VaultInfo {
    const fields = returnValue.fields() || [];
    return {
      name: fields[0]?.toString() || '',
      tokenA: new Address(fields[1]?.toString() || ''),
      tokenB: new Address(fields[2]?.toString() || ''),
      poolId: new Address(fields[3]?.toString() || ''),
      strategyId: Number(fields[4] || 0),
      feeRate: Number(fields[5] || 0),
      harvestFee: Number(fields[6] || 0),
      withdrawalFee: Number(fields[7] || 0)
    };
  }

  private parseMetrics(returnValue: xdr.ScVal): VaultMetrics {
    const fields = returnValue.fields() || [];
    return {
      totalShares: BigInt(fields[0]?.toString() || '0'),
      totalAmountA: BigInt(fields[1]?.toString() || '0'),
      totalAmountB: BigInt(fields[2]?.toString() || '0'),
      apy: Number(fields[3] || 0),
      tvl: BigInt(fields[4]?.toString() || '0'),
      lastHarvest: Number(fields[5] || 0)
    };
  }

  private parseUserPosition(returnValue: xdr.ScVal): UserPosition {
    const fields = returnValue.fields() || [];
    return {
      shares: BigInt(fields[0]?.toString() || '0'),
      lastHarvest: Number(fields[1] || 0),
      depositedAmountA: BigInt(fields[2]?.toString() || '0'),
      depositedAmountB: BigInt(fields[3]?.toString() || '0')
    };
  }

  private parseWithdrawResult(returnValue: xdr.ScVal): { amountA: bigint; amountB: bigint } {
    const fields = returnValue.fields() || [];
    return {
      amountA: BigInt(fields[0]?.toString() || '0'),
      amountB: BigInt(fields[1]?.toString() || '0')
    };
  }
}
