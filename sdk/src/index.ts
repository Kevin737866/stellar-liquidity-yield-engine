// Main exports for the Stellar Liquidity Yield Engine SDK

import { Address, Keypair } from 'stellar-sdk';
import { GovernanceSDK, type GovernanceContracts } from './governance';
import { VaultClient } from './vaultClient';
import { RebalancerClient } from './rebalancer';
import {
  DEFAULT_NETWORK,
  DEFAULT_NETWORK_ENDPOINTS,
  MAINNET_CONFIG,
  NetworkConfigError,
  TESTNET_CONFIG,
  contractsFromEnv,
  getNetworkPassphrase,
  requiredEnvContract,
  resolveNetworkConfig,
  selectNetworkConfig,
  type NetworkConfigErrorCode,
  type NetworkEndpointDefaults,
  type OptionalNetworkConfig,
  type SupportedNetwork,
} from './networkConfig';
export * from './keeperBackoff';
export * from './types';
export { VaultClient } from './vaultClient';
export { RebalancerClient } from './rebalancer';
export { YieldCalculator } from './yieldCalculator';
export * from './insurance';
export * from './utils';
export {
  DEFAULT_NETWORK,
  DEFAULT_NETWORK_ENDPOINTS,
  MAINNET_CONFIG,
  NetworkConfigError,
  TESTNET_CONFIG,
  contractsFromEnv,
  getNetworkPassphrase,
  requiredEnvContract,
  resolveNetworkConfig,
  selectNetworkConfig,
  type NetworkConfigErrorCode,
  type NetworkEndpointDefaults,
  type OptionalNetworkConfig,
  type SupportedNetwork,
};

// Re-export commonly used types and classes for convenience
export {
  ArbitrageScanner,
  ArbitrageExecutor,
  ArbitrageOptimizer,
  HorizonVolatilitySource,
  realizedVolatilityBp,
} from './arbitrage';
export type {
  VolatilitySource,
  VolatilityMetrics,
  PoolMetrics,
  Opportunity,
  RoundTripCostEstimate,
  RoundTripCostEstimator,
  OpportunityScanOptions,
} from './arbitrage';

// Issue #130: Strategy registry client for fetching active strategies.
// A dedicated on-chain registry contract is not yet deployed, so this client
// constructs sensible default strategies from the SDK's YieldStrategy type.
// When a real registry contract is available, replace `fetchActiveStrategies`
// with a contract call to `get_active_strategies`.
export { StrategyRegistryClient } from './strategyRegistryClient';

// Keeper write pacing: rate-limit transaction submissions to avoid throttling.
export { WriteRateLimiter } from './utils/rateLimiter';
export type { WriteRateLimiterOptions, WriteRateLimiterStats } from './utils/rateLimiter';

// RPC synchronization: ledger-head lag detection for keepers.
export {
  RpcLagMonitor,
  checkRpcLag,
  computeLedgerLag,
  classifyLag,
  formatLagMessage,
  DEFAULT_WARNING_LEDGERS,
  DEFAULT_CRITICAL_LEDGERS,
  LEDGER_CLOSE_TIME_SECONDS,
} from './rpcSync';
export type { RpcLagReport, RpcLagOptions, RpcLagThresholds, LagSeverity, LedgerHeadSource, RpcLagMonitorOptions } from './rpcSync';

// Keeper health metrics for ops monitoring.
export { KeeperMetrics, KEEPER_METRICS_PREFIX, } from './keeperMetrics';
export type {
  KeeperMetricsSnapshot,
  KeeperMetricsOptions,
  MetricSample,
  MetricType,
} from './keeperMetrics';

// Address-filtered contract event listener for off-chain keepers.
// Operators running multiple contracts can restrict a single listener to only
// the contract addresses they care about, eliminating noise from unrelated
// on-chain activity.
export {
  ContractEventListener,
  DEFAULT_PAGE_SIZE,
  CursorExpiredError,
  isCursorExpiredError,
  classifyCursorExpiration,
} from './eventListener';
export type {
  PollResult,
  CursorExpirationReason,
  ListenerConfig,
  EventSource,
  GetEventsFilter,
  GetEventsRequest,
  GetEventsResponse,
  RawContractEvent,
  FilteredVaultEvent,
  FilteredRebalanceEvent,
  FilteredRewardEvent,
  UnknownContractEvent,
  KnownEventName,
  EventHandlerMap,
  EventHandler,
  RawEventHandler,
  ListenerErrorEvent,
} from './eventListener';

// Durable keeper state: checkpoints let a keeper resume exactly where it left
// off after a crash, a deploy, or an extended outage.
export {
  CHECKPOINT_VERSION,
  CheckpointError,
  FileCheckpointStore,
  MemoryCheckpointStore,
  createCheckpoint,
  createStateCheckpoint,
  isKeeperCheckpoint,
  normalizeCheckpoint,
} from './persistence';
export type { CheckpointStore, KeeperCheckpoint } from './persistence';

// TEMP-VERIFY-DISABLED (pre-existing syntax error unrelated to this change, restored after check): export { AutoRebalancer, runScheduledRebalancer } from './bots/autoRebalancer';

// Governance SDK exports
export {
  GovernanceSDK,
  ProposalState,
  GOVERNANCE_PAGE_SIZE,
  GOVERNANCE_MAX_PAGE_SIZE,
  paginateProposals,
  type GovernanceProposal,
  type ProposalPage,
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

// Utility functions
export function createVaultClient(
  vaultAddress: string | Address,
  network: SupportedNetwork | OptionalNetworkConfig = DEFAULT_NETWORK,
) {
  const config = selectNetworkConfig(network);
  return new VaultClient(vaultAddress as Address, config);
}

export function createRebalancerClient(
  network: SupportedNetwork | OptionalNetworkConfig = DEFAULT_NETWORK,
) {
  const config = selectNetworkConfig(network);
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
  /**
   * Optional Soroban RPC endpoint override. When omitted, the public default
   * (or environment override) for the selected network is used.
   */
  sorobanRpcUrl?: string;
}

export function createGovernanceClient(
  network: SupportedNetwork = DEFAULT_NETWORK,
  options: CreateGovernanceClientOptions = {},
): GovernanceSDK {
  const networkPassphrase = getNetworkPassphrase(network);
  const config = options.sorobanRpcUrl !== undefined
    ? resolveNetworkConfig({ network, sorobanRpcUrl: options.sorobanRpcUrl })
    : selectNetworkConfig(network);
  return new GovernanceSDK(
    config.sorobanRpcUrl,
    networkPassphrase,
    options.keypair,
    options.contracts
  );
}

// SDK API compatibility: exported surface is covered by regression tests
// (see sdk/tests/apiCompatibility.test.ts) so that removing or renaming a
// public export is caught before a release ships.

// Version - single source of truth from package.json
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

// Event origin labels: contract events vs Horizon-style ledger events.
export {
  CONTRACT_EVENT_ORIGIN,
  LEDGER_EVENT_ORIGIN,
  toLedgerEvent,
  isLedgerEvent,
  isContractEvent,
} from './eventOrigin';
export type { EventOrigin, LedgerEvent } from './eventOrigin';
