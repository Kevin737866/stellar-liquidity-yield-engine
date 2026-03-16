// Main exports for the Stellar Liquidity Yield Engine SDK

export * from './types';
export { VaultClient } from './vaultClient';
export { RebalancerClient } from './rebalancer';
export { YieldCalculator } from './yieldCalculator';

// Re-export commonly used types and classes for convenience
export {
  VaultClient as Vault
} from './vaultClient';

export {
  RebalancerClient as Rebalancer
} from './rebalancer';

// Network configurations
export const TESTNET_CONFIG = {
  network: 'testnet' as const,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  contracts: {
    yieldEngine: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    rewardDistributor: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    rebalanceEngine: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    strategyRegistry: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'
  }
};

export const MAINNET_CONFIG = {
  network: 'mainnet' as const,
  horizonUrl: 'https://horizon.stellar.org',
  sorobanRpcUrl: 'https://soroban.stellar.org',
  contracts: {
    yieldEngine: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    rewardDistributor: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    rebalanceEngine: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    strategyRegistry: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q'
  }
};

// Utility functions
export function createVaultClient(vaultAddress: string, network: 'testnet' | 'mainnet' = 'testnet') {
  const config = network === 'testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
  return new VaultClient(vaultAddress, config);
}

export function createRebalancerClient(network: 'testnet' | 'mainnet' = 'testnet') {
  const config = network === 'testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
  return new RebalancerClient(config);
}

// Version
export const VERSION = '0.1.0';
