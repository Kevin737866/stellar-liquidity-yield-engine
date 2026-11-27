import { Networks } from 'stellar-sdk';
import { NetworkConfig } from './types';

export type SupportedNetwork = NetworkConfig['network'];

export type NetworkConfigErrorCode =
  | 'INVALID_NETWORK'
  | 'INVALID_ENDPOINT_URL'
  | 'MISSING_CONTRACT_ID';

export class NetworkConfigError extends Error {
  constructor(
    message: string,
    public readonly code: NetworkConfigErrorCode,
  ) {
    super(message);
    this.name = 'NetworkConfigError';
  }
}

export interface NetworkEndpointDefaults {
  readonly horizonUrl: string;
  readonly sorobanRpcUrl: string;
  readonly networkPassphrase: string;
}

export const DEFAULT_NETWORK: SupportedNetwork = 'testnet';

export const DEFAULT_NETWORK_ENDPOINTS: Readonly<
  Record<SupportedNetwork, NetworkEndpointDefaults>
> = Object.freeze({
  testnet: Object.freeze({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  }),
  mainnet: Object.freeze({
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  }),
  futurenet: Object.freeze({
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    sorobanRpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: Networks.FUTURENET,
  }),
});

export interface OptionalNetworkConfig {
  network?: SupportedNetwork;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  contracts?: Partial<NetworkConfig['contracts']>;
}

/**
 * Result of a keeper readiness check for RPC endpoint and signer configuration.
 * `ready` is true only when `issues` is empty.
 */
export interface KeeperReadinessReport {
  ready: boolean;
  network: SupportedNetwork | null;
  horizonUrl: string | null;
  sorobanRpcUrl: string | null;
  issues: KeeperReadinessIssue[];
}

export type KeeperReadinessIssueCode =
  | 'INVALID_NETWORK'
  | 'INVALID_ENDPOINT_URL'
  | 'MISSING_SIGNER_SECRET'
  | 'INVALID_SIGNER_SECRET'
  | 'MISSING_CONTRACT_ID';

export interface KeeperReadinessIssue {
  code: KeeperReadinessIssueCode;
  field: string;
  message: string;
}

type EnvRecord = Readonly<Record<string, string | undefined>>;

const ENDPOINT_ENV_KEYS: Readonly<
  Record<SupportedNetwork, { horizon: string; sorobanRpc: string }>
> = {
  testnet: { horizon: 'HORIZON_URL', sorobanRpc: 'SOROBAN_RPC_URL' },
  mainnet: { horizon: 'MAINNET_HORIZON_URL', sorobanRpc: 'MAINNET_SOROBAN_RPC_URL' },
  futurenet: { horizon: 'FUTURENET_HORIZON_URL', sorobanRpc: 'FUTURENET_SOROBAN_RPC_URL' },
};

function readRuntimeEnv(env?: EnvRecord): EnvRecord {
  if (env) return env;
  if (typeof process !== 'undefined' && process.env) {
    return process.env;
  }
  return {};
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertSupportedNetwork(network: unknown): asserts network is SupportedNetwork {
  if (
    typeof network !== 'string' ||
    !Object.prototype.hasOwnProperty.call(DEFAULT_NETWORK_ENDPOINTS, network)
  ) {
    throw new NetworkConfigError(
      `Unsupported Stellar network "${String(network)}". Expected one of: testnet, mainnet, futurenet.`,
      'INVALID_NETWORK',
    );
  }
}

function assertValidEndpointUrl(field: 'horizonUrl' | 'sorobanRpcUrl', url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetworkConfigError(
      `Invalid ${field} "${url}": expected a valid http(s) URL.`,
      'INVALID_ENDPOINT_URL',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkConfigError(
      `Invalid ${field} "${url}": protocol must be http or https.`,
      'INVALID_ENDPOINT_URL',
    );
  }

  return url;
}

function envEndpointOrDefault(envName: string, fallback: string, env?: EnvRecord): string {
  return normalizeOptionalString(readRuntimeEnv(env)[envName]) ?? fallback;
}

/**
 * Resolve the Stellar network passphrase for `network`, defaulting to testnet
 * when omitted. Throws {@link NetworkConfigError} for unsupported networks.
 */
export function getNetworkPassphrase(network: SupportedNetwork = DEFAULT_NETWORK): string {
  assertSupportedNetwork(network);
  return DEFAULT_NETWORK_ENDPOINTS[network].networkPassphrase;
}

/**
 * Read a required contract ID from an environment map, rejecting missing or
 * whitespace-only values with an actionable {@link NetworkConfigError}.
 */
export function requiredEnvContract(name: string, env?: EnvRecord): string {
  const value = normalizeOptionalString(readRuntimeEnv(env)[name]);
  if (!value) {
    throw new NetworkConfigError(
      `Missing required environment variable ${name}: set it to a real deployed contract ID before using this network config.`,
      'MISSING_CONTRACT_ID',
    );
  }
  return value;
}

/**
 * Lazy contract-ID accessor object backed by environment variables.
 * Reading an unset or whitespace-only variable throws {@link NetworkConfigError}.
 */
export function contractsFromEnv(env?: EnvRecord) {
  return {
    get yieldEngine() { return requiredEnvContract('YIELD_ENGINE_CONTRACT_ID', env); },
    get rewardDistributor() { return requiredEnvContract('REWARD_DISTRIBUTOR_CONTRACT_ID', env); },
    get rebalanceEngine() { return requiredEnvContract('REBALANCE_ENGINE_CONTRACT_ID', env); },
    get strategyRegistry() { return requiredEnvContract('STRATEGY_REGISTRY_CONTRACT_ID', env); },
    get governanceToken() { return requiredEnvContract('GOVERNANCE_TOKEN_CONTRACT_ID', env); },
    get votingEscrow() { return requiredEnvContract('VOTING_ESCROW_CONTRACT_ID', env); },
    get stakingContract() { return requiredEnvContract('STAKING_CONTRACT_ID', env); },
    get feeDistributor() { return requiredEnvContract('FEE_DISTRIBUTOR_CONTRACT_ID', env); },
  };
}

export const TESTNET_CONFIG = {
  network: 'testnet' as const,
  horizonUrl: envEndpointOrDefault('HORIZON_URL', DEFAULT_NETWORK_ENDPOINTS.testnet.horizonUrl),
  sorobanRpcUrl: envEndpointOrDefault('SOROBAN_RPC_URL', DEFAULT_NETWORK_ENDPOINTS.testnet.sorobanRpcUrl),
  contracts: contractsFromEnv(),
};

export const MAINNET_CONFIG = {
  network: 'mainnet' as const,
  horizonUrl: envEndpointOrDefault('MAINNET_HORIZON_URL', DEFAULT_NETWORK_ENDPOINTS.mainnet.horizonUrl),
  sorobanRpcUrl: envEndpointOrDefault('MAINNET_SOROBAN_RPC_URL', DEFAULT_NETWORK_ENDPOINTS.mainnet.sorobanRpcUrl),
  contracts: contractsFromEnv(),
};

/**
 * Resolve an optional or partial network configuration into a complete
 * {@link NetworkConfig}.
 *
 * Precedence for optional endpoint fields:
 * 1. Explicit non-blank value in `config`
 * 2. Matching non-blank environment variable for the resolved network
 * 3. Public default endpoint in {@link DEFAULT_NETWORK_ENDPOINTS}
 *
 * Omitted contract IDs default to `''` (matching {@link NetworkConfig}'s
 * "not configured" convention) so callers can inspect or instantiate
 * read-only / fallback clients without setting every contract address upfront.
 */
export function resolveNetworkConfig(
  config?: OptionalNetworkConfig,
  env?: EnvRecord,
): NetworkConfig {
  const resolvedNetwork = config?.network === undefined ? DEFAULT_NETWORK : config.network;
  assertSupportedNetwork(resolvedNetwork);

  const runtimeEnv = readRuntimeEnv(env);
  const envKeys = ENDPOINT_ENV_KEYS[resolvedNetwork];
  const defaults = DEFAULT_NETWORK_ENDPOINTS[resolvedNetwork];

  const rawHorizon =
    normalizeOptionalString(config?.horizonUrl) ??
    normalizeOptionalString(runtimeEnv[envKeys.horizon]) ??
    defaults.horizonUrl;

  const rawSorobanRpc =
    normalizeOptionalString(config?.sorobanRpcUrl) ??
    normalizeOptionalString(runtimeEnv[envKeys.sorobanRpc]) ??
    defaults.sorobanRpcUrl;

  const horizonUrl = assertValidEndpointUrl('horizonUrl', rawHorizon);
  const sorobanRpcUrl = assertValidEndpointUrl('sorobanRpcUrl', rawSorobanRpc);

  const contracts = config?.contracts;
  return {
    network: resolvedNetwork,
    horizonUrl,
    sorobanRpcUrl,
    contracts: {
      yieldEngine: normalizeOptionalString(contracts?.yieldEngine) ?? '',
      rewardDistributor: normalizeOptionalString(contracts?.rewardDistributor) ?? '',
      rebalanceEngine: normalizeOptionalString(contracts?.rebalanceEngine) ?? '',
      strategyRegistry: normalizeOptionalString(contracts?.strategyRegistry) ?? '',
    },
  };
}

/**
 * Resolve either a preset network name or a partial {@link OptionalNetworkConfig}.
 * Defaults to {@link TESTNET_CONFIG} when omitted and throws
 * {@link NetworkConfigError} for unsupported network names.
 */
export function selectNetworkConfig(
  networkOrConfig: SupportedNetwork | OptionalNetworkConfig = DEFAULT_NETWORK,
): NetworkConfig {
  if (typeof networkOrConfig === 'object' && networkOrConfig !== null) {
    return resolveNetworkConfig(networkOrConfig);
  }
  getNetworkPassphrase(networkOrConfig);
  if (networkOrConfig === 'testnet') return TESTNET_CONFIG;
  if (networkOrConfig === 'mainnet') return MAINNET_CONFIG;
  return resolveNetworkConfig({ network: networkOrConfig });
}

/**
 * Check whether RPC endpoint and keeper signer configuration is usable.
 *
 * Never throws: every problem is reported as a structured issue so operators
 * can see all readiness gaps at once. The signer secret is validated for
 * presence and Stellar secret-key format only; it is never echoed back.
 *
 * Reads `KEEPER_SIGNER_SECRET` (a Stellar `S...` secret key) from `env`.
 */
export function checkKeeperReadiness(
  config?: OptionalNetworkConfig,
  env?: EnvRecord,
): KeeperReadinessReport {
  const runtimeEnv = readRuntimeEnv(env);
  const issues: KeeperReadinessIssue[] = [];

  let network: SupportedNetwork | null = null;
  let horizonUrl: string | null = null;
  let sorobanRpcUrl: string | null = null;

  try {
    const resolved = resolveNetworkConfig(config, runtimeEnv);
    network = resolved.network;
    horizonUrl = resolved.horizonUrl;
    sorobanRpcUrl = resolved.sorobanRpcUrl;
  } catch (error) {
    if (error instanceof NetworkConfigError) {
      const code: KeeperReadinessIssueCode =
        error.code === 'INVALID_NETWORK'
          ? 'INVALID_NETWORK'
          : error.code === 'INVALID_ENDPOINT_URL'
            ? 'INVALID_ENDPOINT_URL'
            : 'MISSING_CONTRACT_ID';
      const field =
        error.code === 'INVALID_NETWORK'
          ? 'network'
          : error.code === 'INVALID_ENDPOINT_URL'
            ? (error.message.includes('sorobanRpcUrl') ? 'sorobanRpcUrl' : 'horizonUrl')
            : 'contracts';
      issues.push({ code, field, message: error.message });
    } else {
      throw error;
    }
  }

  const secret = normalizeOptionalString(runtimeEnv.KEEPER_SIGNER_SECRET);
  if (!secret) {
    issues.push({
      code: 'MISSING_SIGNER_SECRET',
      field: 'KEEPER_SIGNER_SECRET',
      message:
        'Missing KEEPER_SIGNER_SECRET: set it to the keeper Stellar secret key (starts with "S").',
    });
  } else if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    issues.push({
      code: 'INVALID_SIGNER_SECRET',
      field: 'KEEPER_SIGNER_SECRET',
      message:
        'Invalid KEEPER_SIGNER_SECRET: expected a Stellar secret key (56 characters, starts with "S"). Value not shown.',
    });
  }

  return {
    ready: issues.length === 0,
    network,
    horizonUrl,
    sorobanRpcUrl,
    issues,
  };
}
