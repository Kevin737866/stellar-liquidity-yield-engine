import { 
  Address, 
  Contract, 
  SorobanRpc, 
  Transaction, 
  TransactionBuilder, 
  Networks,
  BASE_FEE,
  xdr,
  scValToNative
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
import { waitForTransaction } from './utils/transaction';

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
      const account = await this.server.getAccount(await this.resolvePublicKey(userKeyPair));
      
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

      const signedTx = await this.signWith(userKeyPair, tx);
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
        gasUsed: 0,
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
      const account = await this.server.getAccount(await this.resolvePublicKey(userKeyPair));
      
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

      const signedTx = await this.signWith(userKeyPair, tx);
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
          gasUsed: 0,
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
      const account = await this.server.getAccount(await this.resolvePublicKey(userKeyPair));
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(this.contract.call('harvest'))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = await this.signWith(userKeyPair, tx);
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
        gasUsed: 0,
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

      return Number(scValToNative(result.result.returnValue));
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

      return BigInt(scValToNative(result.result.returnValue));
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

      return Boolean(scValToNative(result.result.returnValue));
    } catch (error) {
      throw new VaultError(`Failed to check pause status: ${error.message}`, 'PAUSE_CHECK_ERROR');
    }
  }

  /**
   * Pause vault (admin only)
   */
  async pause(adminKeyPair: any, options?: TransactionOptions): Promise<TransactionResult> {
    try {
      const account = await this.server.getAccount(await this.resolvePublicKey(adminKeyPair));
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(this.contract.call('pause', adminKeyPair.publicKey()))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = await this.signWith(adminKeyPair, tx);
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
        gasUsed: 0,
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
      const account = await this.server.getAccount(await this.resolvePublicKey(adminKeyPair));
      
      const tx = new TransactionBuilder(account, {
        fee: options?.gasLimit ? `${options.gasLimit}` : BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase()
      })
        .addOperation(this.contract.call('unpause', adminKeyPair.publicKey()))
        .setTimeout(options?.timeout || 30)
        .build();

      const signedTx = await this.signWith(adminKeyPair, tx);
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
        gasUsed: 0,
        error: txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED ? txResult.status : undefined
      };
    } catch (error) {
      throw new VaultError(`Unpause failed: ${error.message}`, 'UNPAUSE_ERROR');
    }
  }

  // Helper methods

  /**
   * Poll `getTransaction` until the transaction reaches a terminal state
   * (SUCCESS or FAILED). Soroban RPC's `sendTransaction` only reports that
   * a transaction was accepted (PENDING) — the final outcome requires
   * polling `getTransaction`, so treating the initial status as final is
   * incorrect.
   */
  private async confirmTransaction(
    hash: string,
    timeoutMs: number = 30_000
  ): Promise<SorobanRpc.GetTransactionResponse> {
    return waitForTransaction(this.server, hash, { timeoutMs });
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

  /**
   * Parse the `get_vault_info` return value into a typed `VaultInfo`.
   *
   * The contract returns a struct where `name` is a Symbol and token/pool
   * addresses are Addresses; `scValToNative` handles the symbol-to-string
   * and address-to-G-address conversions for us.
   */
  private parseVaultInfo(returnValue: xdr.ScVal): VaultInfo {
    const data = scValToNative(returnValue) as any;
    return {
      name: data.name,
      tokenA: new Address(data.token_a),
      tokenB: new Address(data.token_b),
      poolId: new Address(data.pool_id),
      strategyId: Number(data.strategy_id),
      feeRate: Number(data.fee_rate),
      harvestFee: Number(data.harvest_fee),
      withdrawalFee: Number(data.withdrawal_fee)
    };
  }

  private parseMetrics(returnValue: xdr.ScVal): VaultMetrics {
    const data = scValToNative(returnValue) as any;
    return {
      totalShares: BigInt(data.total_shares),
      totalAmountA: BigInt(data.total_amount_a),
      totalAmountB: BigInt(data.total_amount_b),
      apy: Number(data.apy),
      tvl: BigInt(data.tvl),
      lastHarvest: Number(data.last_harvest)
    };
  }

  private parseUserPosition(returnValue: xdr.ScVal): UserPosition {
    const data = scValToNative(returnValue) as any;
    return {
      shares: BigInt(data.shares),
      lastHarvest: Number(data.last_harvest),
      depositedAmountA: BigInt(data.deposited_amount_a),
      depositedAmountB: BigInt(data.deposited_amount_b)
    };
  }

  /**
   * Parse the `withdraw` return value into the withdrawn token amounts.
   *
   * The contract returns a tuple `(final_amount_a, final_amount_b)`, which
   * is encoded as an ScVal vector of i128s; `scValToNative` turns it into a
   * plain array of bigints.
   */
  private parseWithdrawResult(returnValue: xdr.ScVal): { amountA: bigint; amountB: bigint } {
    const [amountA, amountB] = scValToNative(returnValue) as [bigint, bigint];
    return {
      amountA: BigInt(amountA),
      amountB: BigInt(amountB)
    };
  }

  /**
   * Resolve the account public key from either a `Keypair` (synchronous
   * `publicKey()`) or an async wallet signer such as Freighter
   * (`getPublicKey(): Promise<string>`).
   */
  private async resolvePublicKey(signerOrKeypair: any): Promise<string> {
    if (typeof signerOrKeypair.getPublicKey === 'function') {
      return await signerOrKeypair.getPublicKey();
    }
    return signerOrKeypair.publicKey();
  }

  /**
   * Sign a transaction with either a `Keypair` (synchronous `sign()`) or an
   * async wallet signer (`signTransaction(tx, networkPassphrase)`). This is
   * what wires browser-wallet signing (e.g. Freighter) into every write
   * method.
   */
  private async signWith(signerOrKeypair: any, tx: Transaction): Promise<Transaction> {
    if (typeof signerOrKeypair.signTransaction === 'function') {
      return await signerOrKeypair.signTransaction(tx, this.getNetworkPassphrase());
    }
    return signerOrKeypair.sign(tx);
  }
}
