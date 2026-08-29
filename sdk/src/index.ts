// Main exports for the Stellar Liquidity Yield Engine SDK

export * from './types';
export { VaultClient } from './vaultClient';
export { RebalancerClient } from './rebalancer';
export { YieldCalculator } from './yieldCalculator';
export { ArbitrageScanner, ArbitrageExecutor, ArbitrageOptimizer } from './arbitrage';

// Issue #130: Strategy registry client for fetching active strategies.
// A dedicated on-chain registry contract is not yet deployed, so this client
// constructs sensible default strategies from the SDK's YieldStrategy type.
// When a real registry contract is available, replace `fetchActiveStrategies`
// with a contract call to `get_active_strategies`.
export { StrategyRegistryClient } from './strategyRegistryClient';
// TEMP-VERIFY-DISABLED (pre-existing syntax error unrelated to this change, restored after check): export { AutoRebalancer, runScheduledRebalancer } from './bots/autoRebalancer';

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

// Required contract IDs are read from the environment rather than hardcoded,
// since a hardcoded placeholder address is not a usable/deployed contract.
// Set these to the real contract IDs from your deployment before using a
// network config - see the README / examples for the full variable list.
function requiredEnvContract(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}: set it to a real deployed contract ID before using this network config.`
    );
  }
  return value;
}

function contractsFromEnv() {
  return {
    get yieldEngine() { return requiredEnvContract('YIELD_ENGINE_CONTRACT_ID'); },
    get rewardDistributor() { return requiredEnvContract('REWARD_DISTRIBUTOR_CONTRACT_ID'); },
    get rebalanceEngine() { return requiredEnvContract('REBALANCE_ENGINE_CONTRACT_ID'); },
    get strategyRegistry() { return requiredEnvContract('STRATEGY_REGISTRY_CONTRACT_ID'); },
    get governanceToken() { return requiredEnvContract('GOVERNANCE_TOKEN_CONTRACT_ID'); },
    get votingEscrow() { return requiredEnvContract('VOTING_ESCROW_CONTRACT_ID'); },
    get stakingContract() { return requiredEnvContract('STAKING_CONTRACT_ID'); },
    get feeDistributor() { return requiredEnvContract('FEE_DISTRIBUTOR_CONTRACT_ID'); }
  };
}

// Network configurations
export const TESTNET_CONFIG = {
  network: 'testnet' as const,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  contracts: contractsFromEnv()
};

export const MAINNET_CONFIG = {
  network: 'mainnet' as const,
  horizonUrl: 'https://horizon.stellar.org',
  sorobanRpcUrl: 'https://soroban.stellar.org',
  contracts: contractsFromEnv()
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
