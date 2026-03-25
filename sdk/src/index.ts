// Main exports for the Stellar Liquidity Yield Engine SDK

export * from './types';
export { VaultClient } from './vaultClient';
export { RebalancerClient } from './rebalancer';
export { YieldCalculator } from './yieldCalculator';
export { ArbitrageScanner, ArbitrageExecutor, ArbitrageOptimizer } from './arbitrage';
export { AutoRebalancer, runScheduledRebalancer } from './bots/autoRebalancer';

// Governance SDK exports
export {
  GovernanceSDK,
  ProposalState,
  type GovernanceProposal,
  type CallData,
  type LockInfo,
  type FeeDistribution,
  type ProtocolParameters,
  calculateVotingPower,
  calculateBoostMultiplier,
  formatVotingPower,
  formatBasisPoints,
  formatDuration,
  hasProposalPassed,
  getTimeUntilExpiry,
  GOVERNANCE_CONSTANTS
} from './governance';

// Network configurations
export const TESTNET_CONFIG = {
  network: 'testnet' as const,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  contracts: {
    yieldEngine: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    rewardDistributor: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    rebalanceEngine: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    strategyRegistry: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    governanceToken: 'GOV_TOKEN_CONTRACT_ADDRESS',
    votingEscrow: 'VE_TOKEN_CONTRACT_ADDRESS',
    stakingContract: 'STAKING_CONTRACT_ADDRESS',
    feeDistributor: 'FEE_DISTRIBUTOR_ADDRESS'
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
    strategyRegistry: 'CBANDN74J4LGH4TPE4XV5N6IZ4SD4J6Q4Z6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q6Q',
    governanceToken: 'GOV_TOKEN_CONTRACT_ADDRESS',
    votingEscrow: 'VE_TOKEN_CONTRACT_ADDRESS',
    stakingContract: 'STAKING_CONTRACT_ADDRESS',
    feeDistributor: 'FEE_DISTRIBUTOR_ADDRESS'
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

export function createGovernanceClient(network: 'testnet' | 'mainnet' = 'testnet') {
  const config = network === 'testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
  // Note: GovernanceSDK constructor takes server, networkPassphrase, and optional keypair
  // This is a placeholder - actual implementation would need proper initialization
  return config;
}

// Version
export const VERSION = '0.2.0';
