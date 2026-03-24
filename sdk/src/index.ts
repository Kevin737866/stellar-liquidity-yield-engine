// sdk/src/index.ts

import { Address } from 'stellar-sdk';
import { VaultClient } from './vaultClient';
import { RebalancerClient } from './rebalancer';
import { NetworkConfig } from './types'; // Assuming NetworkConfig is defined in types.ts

// Main exports for the Stellar Liquidity Yield Engine SDK
export * from './types';
export { VaultClient } from './vaultClient';
export { RebalancerClient } from './rebalancer';
export { YieldCalculator } from './yieldCalculator';
export { ArbitrageScanner, ArbitrageExecutor, ArbitrageOptimizer } from './arbitrage';
export { AutoRebalancer, runScheduledRebalancer } from './bots/autoRebalancer';
export { ApyHistoryTracker } from './apyHistory';
export type { ApyDataPoint, ApyHistoryData } from './apyHistory';

// Re-export commonly used types and classes for convenience
export {
  VaultClient as Vault
} from './vaultClient';

export {
  RebalancerClient as Rebalancer
} from './rebalancer';

// Network configurations
export const TESTNET_CONFIG: NetworkConfig = {
  network: 'testnet' as const,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  contracts: {
    yieldEngine: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'),
    rewardDistributor: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'),
    rebalanceEngine: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'),
    strategyRegistry: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q')
  }
};

export const MAINNET_CONFIG: NetworkConfig = {
  network: 'mainnet' as const,
  horizonUrl: 'https://horizon.stellar.org',
  sorobanRpcUrl: 'https://soroban.stellar.org',
  contracts: {
    yieldEngine: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'),
    rewardDistributor: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'),
    rebalanceEngine: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'),
    strategyRegistry: new Address('CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q')
  }
};

// Utility functions
export function createVaultClient(vaultAddress: string, network: 'testnet' | 'mainnet' = 'testnet') {
  const config = network === 'testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
  return new VaultClient(new Address(vaultAddress), config);
}

export function createRebalancerClient(network: 'testnet' | 'mainnet' = 'testnet') {
  const config = network === 'testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
  return new RebalancerClient(config);
}

// Version
export const VERSION = '0.1.0';