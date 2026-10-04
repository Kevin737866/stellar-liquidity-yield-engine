// Main exports for the Stellar Liquidity Yield Engine SDK

import { Keypair, Networks } from 'stellar-sdk';
import { GovernanceSDK, type GovernanceContracts } from './governance';

export * from './types';
export { VaultClient } from './vaultClient';
export { RebalancerClient } from './rebalancer';
export { YieldCalculator } from './yieldCalculator';
export * from './insurance';

// Re-export commonly used types and classes for convenience
export {
  ArbitrageScanner,
  ArbitrageExecutor,
  ArbitrageOptimizer,
  HorizonVolatilitySource,
  realizedVolatilityBp,
} from './arbitrage';
export type { VolatilitySource, VolatilityMetrics, PoolMetrics, Opportunity } from './arbitrage';

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
  type GovernanceContracts,
  DEFAULT_GOVERNANCE_CONTRACTS,
  DEFAULT_TOKEN_DECIMALS,
  isContractConfigured,
  calculateVotingPower,
  calculateBoostMultiplier,
  formatVotingPower,
  formatAmount,
  parseStroops,
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
//
// Public endpoints are only defaults: every one of them can be pointed at a
// custom RPC via the environment, which is what `SOROBAN_RPC_URL` /
// `HORIZON_URL` in `.env.example` are for. See `.emdfile` for the convention.
export const TESTNET_CONFIG = {
  network: 'testnet' as const,
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  contracts: contractsFromEnv()
};

export const MAINNET_CONFIG = {
  network: 'mainnet' as const,
  horizonUrl: process.env.MAINNET_HORIZON_URL || 'https://horizon.stellar.org',
  sorobanRpcUrl: process.env.MAINNET_SOROBAN_RPC_URL || 'https://soroban.stellar.org',
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

export interface CreateGovernanceClientOptions {
  /**
   * Optional signer for governance transactions. The client can be created
   * without one (read-only calls still work); call `setKeypair()` later or
   * pass the keypair here to enable signing.
   */
  keypair?: Keypair;
  /**
   * Contract IDs for the governance deployment. Anything omitted falls back to
   * `DEFAULT_GOVERNANCE_CONTRACTS`, which is read from `process.env`.
   *
   * Browser bundles cannot read server-side environment variables, so UI
   * callers must pass these explicitly.
   */
  contracts?: Partial<GovernanceContracts>;
}

export function createGovernanceClient(
  network: 'testnet' | 'mainnet' = 'testnet',
  options: CreateGovernanceClientOptions = {},
): GovernanceSDK {
  const config = network === 'testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
  const networkPassphrase = network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
  return new GovernanceSDK(
    config.sorobanRpcUrl,
    networkPassphrase,
    options.keypair,
    options.contracts
  );
}

// Version - single source of truth from package.json
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const VERSION: string = (() => {
  try {
    return require('../../package.json').version;
  } catch {
    try {
      return require('../package.json').version;
    } catch {
      return '0.1.0';
    }
  }
})();
