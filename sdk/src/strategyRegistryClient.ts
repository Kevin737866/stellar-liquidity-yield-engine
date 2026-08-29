/**
 * StrategyRegistryClient — Issue #130
 *
 * Fetches active `YieldStrategy` records from the strategy registry contract.
 *
 * Because a real registry contract is not yet deployed we first attempt the
 * contract call and, on failure, gracefully fall back to a set of built-in
 * default strategies so the UI always has data to display. The default
 * strategies mirror the previous hard-coded mock values in StrategySelector
 * but are now produced dynamically on each call (respecting the `limit`
 * argument) and are the single authoritative source — the UI mock has been
 * removed.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  scValToNative,
} from 'stellar-sdk';
import { NetworkConfig, YieldStrategy, StrategyError } from './types';

export class StrategyRegistryClient {
  private server: SorobanRpc.Server;
  private networkConfig: NetworkConfig;

  constructor(networkConfig: NetworkConfig) {
    this.server = new SorobanRpc.Server(networkConfig.sorobanRpcUrl);
    this.networkConfig = networkConfig;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch active strategies from the registry.
   *
   * Tries the contract's `get_active_strategies` entry-point first; on any
   * failure (contract not deployed, RPC error, etc.) returns the built-in
   * default strategies so callers always receive a usable result.
   *
   * @param limit Maximum strategies to return (default 50)
   */
  async fetchActiveStrategies(limit: number = 50): Promise<YieldStrategy[]> {
    try {
      const registryAddress = this.networkConfig.contracts.strategyRegistry;
      if (!registryAddress) {
        return this.defaultStrategies(limit);
      }

      const contract = new Contract(registryAddress as string);

      const simResult = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
          ),
          {
            fee: BASE_FEE,
            networkPassphrase: this.getNetworkPassphrase(),
          }
        )
          .addOperation(contract.call('get_active_strategies'))
          .build()
      );

      if (
        simResult.result &&
        (simResult.result as any).status === 'SUCCESS' &&
        (simResult.result as any).returnValue
      ) {
        const raw = scValToNative(
          (simResult.result as any).returnValue
        ) as any[];

        const strategies: YieldStrategy[] = raw
          .slice(0, limit)
          .map((item: any) => ({
            strategyId: Number(item.strategy_id ?? item.strategyId),
            name: String(item.name),
            description: String(item.description ?? ''),
            creator: item.creator,
            riskLevel: Number(item.risk_level ?? item.riskLevel ?? 1),
            minInvestment: BigInt(item.min_investment ?? item.minInvestment ?? 0),
            maxInvestment: BigInt(
              item.max_investment ?? item.maxInvestment ?? 0
            ),
            feeStructure: {
              managementFee: Number(
                item.fee_structure?.management_fee ??
                  item.feeStructure?.managementFee ??
                  0
              ),
              performanceFee: Number(
                item.fee_structure?.performance_fee ??
                  item.feeStructure?.performanceFee ??
                  0
              ),
              depositFee: Number(
                item.fee_structure?.deposit_fee ??
                  item.feeStructure?.depositFee ??
                  0
              ),
              withdrawalFee: Number(
                item.fee_structure?.withdrawal_fee ??
                  item.feeStructure?.withdrawalFee ??
                  0
              ),
            },
            performanceHistory: [],
            isActive: Boolean(item.is_active ?? item.isActive ?? true),
            createdAt: Number(item.created_at ?? item.createdAt ?? 0),
            updatedAt: Number(item.updated_at ?? item.updatedAt ?? 0),
          }))
          .filter((s) => s.isActive);

        if (strategies.length > 0) {
          return strategies;
        }
      }
    } catch {
      // Contract not available — fall through to defaults.
    }

    return this.defaultStrategies(limit);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getNetworkPassphrase(): string {
    switch (this.networkConfig.network) {
      case 'mainnet':
        return Networks.PUBLIC;
      case 'testnet':
        return Networks.TESTNET;
      case 'futurenet':
        return Networks.FUTURENET;
      default:
        throw new StrategyError(
          'Invalid network configuration',
          'INVALID_NETWORK'
        );
    }
  }

  /**
   * Built-in default strategies. These mirror the three canonical risk tiers
   * and serve as the fallback when the registry contract is not yet deployed.
   */
  private defaultStrategies(limit: number): YieldStrategy[] {
    const now = Date.now();

    const defaults: YieldStrategy[] = [
      {
        strategyId: 1,
        name: 'Conservative Growth',
        description:
          'Low-risk strategy focusing on stable pairs with minimal impermanent loss',
        creator: 'GADMIN123456789',
        riskLevel: 1,
        minInvestment: 1_000_000n, // 1 000 USD (6 dp)
        maxInvestment: 100_000_000n, // 100 000 USD
        feeStructure: {
          managementFee: 500,
          performanceFee: 1000,
          depositFee: 50,
          withdrawalFee: 100,
        },
        performanceHistory: [
          {
            timestamp: now - 86_400_000,
            totalValue: 1_050_000n,
            netApy: 800,
            volatility: 500,
            sharpeRatio: 12_000,
          },
          {
            timestamp: now - 172_800_000,
            totalValue: 1_040_000n,
            netApy: 750,
            volatility: 450,
            sharpeRatio: 11_000,
          },
          {
            timestamp: now - 259_200_000,
            totalValue: 1_030_000n,
            netApy: 700,
            volatility: 400,
            sharpeRatio: 10_000,
          },
        ],
        isActive: true,
        createdAt: now - 259_200_000,
        updatedAt: now - 86_400_000,
      },
      {
        strategyId: 2,
        name: 'Balanced Portfolio',
        description:
          'Medium-risk strategy with diversified exposure across multiple pools',
        creator: 'GADMIN123456789',
        riskLevel: 2,
        minInvestment: 500_000n,
        maxInvestment: 500_000_000n,
        feeStructure: {
          managementFee: 800,
          performanceFee: 1500,
          depositFee: 75,
          withdrawalFee: 150,
        },
        performanceHistory: [
          {
            timestamp: now - 86_400_000,
            totalValue: 1_120_000n,
            netApy: 1500,
            volatility: 1200,
            sharpeRatio: 8_000,
          },
          {
            timestamp: now - 172_800_000,
            totalValue: 1_100_000n,
            netApy: 1400,
            volatility: 1100,
            sharpeRatio: 7_500,
          },
          {
            timestamp: now - 259_200_000,
            totalValue: 1_080_000n,
            netApy: 1300,
            volatility: 1000,
            sharpeRatio: 7_000,
          },
        ],
        isActive: true,
        createdAt: now - 259_200_000,
        updatedAt: now - 86_400_000,
      },
      {
        strategyId: 3,
        name: 'Aggressive Yield',
        description:
          'High-risk strategy targeting maximum yields through volatile asset pairs',
        creator: 'GADMIN123456789',
        riskLevel: 3,
        minInvestment: 100_000n,
        maxInvestment: 1_000_000_000n,
        feeStructure: {
          managementFee: 1200,
          performanceFee: 2000,
          depositFee: 100,
          withdrawalFee: 200,
        },
        performanceHistory: [
          {
            timestamp: now - 86_400_000,
            totalValue: 1_250_000n,
            netApy: 2500,
            volatility: 2500,
            sharpeRatio: 6_000,
          },
          {
            timestamp: now - 172_800_000,
            totalValue: 1_200_000n,
            netApy: 2200,
            volatility: 2300,
            sharpeRatio: 5_500,
          },
          {
            timestamp: now - 259_200_000,
            totalValue: 1_150_000n,
            netApy: 2000,
            volatility: 2000,
            sharpeRatio: 5_000,
          },
        ],
        isActive: true,
        createdAt: now - 259_200_000,
        updatedAt: now - 86_400_000,
      },
    ];

    return defaults.slice(0, limit);
  }
}
