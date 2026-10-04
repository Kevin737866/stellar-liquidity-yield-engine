/**
 * Centralized network configuration for the UI.
 *
 * Issue #101: the UI previously hardcoded `soroban-testnet.stellar.org` and a
 * set of empty-string contract IDs inline in three separate components, so
 * there was no way to point the app at mainnet or a custom RPC. This module is
 * the single place that reads the environment; every other module asks it.
 *
 * Environment variables
 * ---------------------
 * Next.js only exposes variables prefixed with `NEXT_PUBLIC_` to the browser,
 * and it inlines them at build time. That has two consequences enforced here:
 *
 *  1. Every lookup must be a literal `process.env.NEXT_PUBLIC_FOO` member
 *     access. Next.js cannot inline `process.env[name]`, so a dynamic lookup
 *     silently yields `undefined` in a production bundle.
 *  2. These values are baked into the client bundle at build time and are
 *     therefore public. Never put a private key here. Signing happens through
 *     Freighter (see `src/lib/freighter.ts`), so the UI never needs one.
 *
 * See `ui/.env.example` for the full list. Unset variables fall back to the
 * public testnet endpoints, which keeps `next dev` working out of the box.
 */

/** Networks the UI can be pointed at. */
export type UiNetwork = 'testnet' | 'mainnet';

/** Contract roles the UI needs to address. */
export type ContractRole =
  | 'yieldEngine'
  | 'rewardDistributor'
  | 'rebalanceEngine'
  | 'strategyRegistry'
  | 'governance'
  | 'votingEscrow'
  | 'staking'
  | 'feeDistributor';

export type ContractAddresses = Record<ContractRole, string>;

/**
 * Public endpoints used when the matching environment variable is unset.
 * These are defaults, not hardcoding: every one is overridable below.
 */
const PUBLIC_ENDPOINT_DEFAULTS: Record<
  UiNetwork,
  { horizonUrl: string; sorobanRpcUrl: string; networkPassphrase: string }
> = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
};

/**
 * `process` is absent in some non-browser runtimes, so read through a guard
 * rather than assuming a Node or Next.js environment.
 */
function readEnv(key: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Literal member accesses so Next.js can inline them at build time. */
function readNetworkEnv(): UiNetwork {
  const raw = readEnv('NEXT_PUBLIC_STELLAR_NETWORK');
  return raw === 'mainnet' ? 'mainnet' : 'testnet';
}

function readEndpointEnv(): Record<UiNetwork, { horizonUrl: string; sorobanRpcUrl: string }> {
  return {
    testnet: {
      horizonUrl:
        readEnv('NEXT_PUBLIC_TESTNET_HORIZON_URL') ?? PUBLIC_ENDPOINT_DEFAULTS.testnet.horizonUrl,
      sorobanRpcUrl:
        readEnv('NEXT_PUBLIC_TESTNET_SOROBAN_RPC_URL') ??
        PUBLIC_ENDPOINT_DEFAULTS.testnet.sorobanRpcUrl,
    },
    mainnet: {
      horizonUrl:
        readEnv('NEXT_PUBLIC_MAINNET_HORIZON_URL') ?? PUBLIC_ENDPOINT_DEFAULTS.mainnet.horizonUrl,
      sorobanRpcUrl:
        readEnv('NEXT_PUBLIC_MAINNET_SOROBAN_RPC_URL') ??
        PUBLIC_ENDPOINT_DEFAULTS.mainnet.sorobanRpcUrl,
    },
  };
}

function readContractEnv(): ContractAddresses {
  return {
    yieldEngine: readEnv('NEXT_PUBLIC_YIELD_ENGINE_CONTRACT_ID') ?? '',
    rewardDistributor: readEnv('NEXT_PUBLIC_REWARD_DISTRIBUTOR_CONTRACT_ID') ?? '',
    rebalanceEngine: readEnv('NEXT_PUBLIC_REBALANCE_ENGINE_CONTRACT_ID') ?? '',
    strategyRegistry: readEnv('NEXT_PUBLIC_STRATEGY_REGISTRY_CONTRACT_ID') ?? '',
    governance: readEnv('NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID') ?? '',
    votingEscrow: readEnv('NEXT_PUBLIC_VOTING_ESCROW_CONTRACT_ID') ?? '',
    staking: readEnv('NEXT_PUBLIC_STAKING_CONTRACT_ID') ?? '',
    feeDistributor: readEnv('NEXT_PUBLIC_FEE_DISTRIBUTOR_CONTRACT_ID') ?? '',
  };
}

/**
 * The network the app targets. Defaults to testnet.
 *
 * A component may still accept a `network` prop to override this, which is how
 * a future network switcher would drive every consumer at once.
 */
export function getNetwork(): UiNetwork {
  return readNetworkEnv();
}

/** True when `contractId` looks like a configured contract ID. */
export function isConfigured(contractId: string | undefined | null): boolean {
  return typeof contractId === 'string' && contractId.trim().length > 0;
}

/** All configured contract IDs. Unset roles are empty strings. */
export function getContractAddresses(): ContractAddresses {
  return readContractEnv();
}

/** Roles that have no contract ID configured, for diagnostics. */
export function getMissingContractRoles(): ContractRole[] {
  const addresses = getContractAddresses();
  return (Object.keys(addresses) as ContractRole[]).filter(
    (role) => !isConfigured(addresses[role])
  );
}

/**
 * Contract IDs for `GovernanceSDK`. Unset roles stay empty so the SDK raises
 * its own actionable "contract is not configured" error rather than the UI
 * inventing a placeholder address.
 */
export function getGovernanceContracts(): Partial<ContractAddresses> {
  const addresses = getContractAddresses();
  return {
    governance: addresses.governance,
    votingEscrow: addresses.votingEscrow,
    staking: addresses.staking,
    feeDistributor: addresses.feeDistributor,
  };
}

/** Network passphrase for transaction signing. */
export function getNetworkPassphrase(network: UiNetwork = getNetwork()): string {
  const custom = readEnv(
    network === 'mainnet' ? 'NEXT_PUBLIC_MAINNET_NETWORK_PASSPHRASE' : 'NEXT_PUBLIC_TESTNET_NETWORK_PASSPHRASE'
  );
  return custom ?? PUBLIC_ENDPOINT_DEFAULTS[network].networkPassphrase;
}

/**
 * Shape accepted by the SDK clients (`VaultClient`, `RebalancerClient`,
 * `StrategyRegistryClient`).
 *
 * `contracts` is populated from the environment. Roles that are not configured
 * are empty strings, which the SDK clients already treat as "not deployed"
 * rather than as a valid address.
 */
export interface UiNetworkConfig {
  network: UiNetwork;
  horizonUrl: string;
  sorobanRpcUrl: string;
  contracts: {
    yieldEngine: string;
    rewardDistributor: string;
    rebalanceEngine: string;
    strategyRegistry: string;
  };
}

/** Build the SDK-facing network config for `network`. */
export function getNetworkConfig(network: UiNetwork = getNetwork()): UiNetworkConfig {
  const endpoints = readEndpointEnv();
  const addresses = getContractAddresses();

  return {
    network,
    horizonUrl: endpoints[network].horizonUrl,
    sorobanRpcUrl: endpoints[network].sorobanRpcUrl,
    contracts: {
      yieldEngine: addresses.yieldEngine,
      rewardDistributor: addresses.rewardDistributor,
      rebalanceEngine: addresses.rebalanceEngine,
      strategyRegistry: addresses.strategyRegistry,
    },
  };
}

/**
 * Throw a single actionable error naming every missing contract ID.
 *
 * Call this at the boundary of a flow that cannot work without a real
 * deployment, so users get one clear message instead of a
 * `Contract(some-placeholder)` failure deep inside an SDK call.
 */
export function assertContractsConfigured(roles?: ContractRole[]): void {
  const missing = (roles ?? getMissingContractRoles()).filter(
    (role) => !isConfigured(getContractAddresses()[role])
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing contract ID${missing.length > 1 ? 's' : ''} for: ${missing.join(', ')}. ` +
        'Set the matching NEXT_PUBLIC_*_CONTRACT_ID variables in ui/.env ' +
        '(see ui/.env.example).'
    );
  }
}

/**
 * One-line summary of the active configuration, for a debug/diagnostics panel.
 */
export function describeNetworkConfig(network: UiNetwork = getNetwork()): string {
  const config = getNetworkConfig(network);
  const missing = getMissingContractRoles();
  const contracts =
    missing.length === 0
      ? 'all contract IDs configured'
      : `${missing.length} contract ID(s) missing: ${missing.join(', ')}`;

  return `${network} | RPC ${config.sorobanRpcUrl} | Horizon ${config.horizonUrl} | ${contracts}`;
}
