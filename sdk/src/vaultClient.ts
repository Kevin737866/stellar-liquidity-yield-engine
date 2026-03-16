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
  VaultInfo,
  UserPosition,
  VaultMetrics,
  DepositParams,
  WithdrawParams,
  TransactionOptions,
  TransactionResult,
  VaultError,
  NetworkConfig
} from './types';

export class VaultClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkConfig: NetworkConfig;

  constructor(
    vaultAddress: Address,
    networkConfig: NetworkConfig
  ) {
    this.contract = new Contract(vaultAddress);
    this.server = new SorobanRpc.Server(networkConfig.sorobanRpcUrl);
    this.networkConfig = networkConfig;
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
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0, // Soroban doesn't provide gas usage in the same way
        error: result.status === 'ERROR' ? result.errorResult : undefined
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
      
      if (result.status === 'SUCCESS') {
        const txResult = await this.server.getTransaction(result.hash);
        const returnValue = this.parseWithdrawResult(txResult.result!.returnValue);
        
        return {
          hash: result.hash,
          success: true,
          gasUsed: 0,
          amountA: returnValue.amountA,
          amountB: returnValue.amountB
        };
      } else {
        return {
          hash: result.hash,
          success: false,
          gasUsed: 0,
          error: result.errorResult,
          amountA: 0n,
          amountB: 0n
        };
      }
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
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0,
        error: result.status === 'ERROR' ? result.errorResult : undefined
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
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
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
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
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
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
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
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
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
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
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
          await this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
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
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0,
        error: result.status === 'ERROR' ? result.errorResult : undefined
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
      
      return {
        hash: result.hash,
        success: result.status === 'SUCCESS',
        gasUsed: 0,
        error: result.status === 'ERROR' ? result.errorResult : undefined
      };
    } catch (error) {
      throw new VaultError(`Unpause failed: ${error.message}`, 'UNPAUSE_ERROR');
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
    // Parse the ScVal into VaultInfo structure
    // This is a simplified implementation
    const data = returnValue.object()?.val || [];
    return {
      name: data[0]?.toString() || '',
      tokenA: new Address(data[1]?.toString() || ''),
      tokenB: new Address(data[2]?.toString() || ''),
      poolId: new Address(data[3]?.toString() || ''),
      strategyId: Number(data[4] || 0),
      feeRate: Number(data[5] || 0),
      harvestFee: Number(data[6] || 0),
      withdrawalFee: Number(data[7] || 0)
    };
  }

  private parseMetrics(returnValue: xdr.ScVal): VaultMetrics {
    // Parse the ScVal into VaultMetrics structure
    const data = returnValue.object()?.val || [];
    return {
      totalShares: BigInt(data[0]?.toString() || '0'),
      totalAmountA: BigInt(data[1]?.toString() || '0'),
      totalAmountB: BigInt(data[2]?.toString() || '0'),
      apy: Number(data[3] || 0),
      tvl: BigInt(data[4]?.toString() || '0'),
      lastHarvest: Number(data[5] || 0)
    };
  }

  private parseUserPosition(returnValue: xdr.ScVal): UserPosition {
    // Parse the ScVal into UserPosition structure
    const data = returnValue.object()?.val || [];
    return {
      shares: BigInt(data[0]?.toString() || '0'),
      lastHarvest: Number(data[1] || 0),
      depositedAmountA: BigInt(data[2]?.toString() || '0'),
      depositedAmountB: BigInt(data[3]?.toString() || '0')
    };
  }

  private parseWithdrawResult(returnValue: xdr.ScVal): { amountA: bigint; amountB: bigint } {
    // Parse the tuple return value
    const data = returnValue.object()?.val || [];
    return {
      amountA: BigInt(data[0]?.toString() || '0'),
      amountB: BigInt(data[1]?.toString() || '0')
    };
  }
}
