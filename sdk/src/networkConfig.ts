import { Networks } from 'stellar-sdk';

export type SdkNetwork = 'testnet' | 'mainnet';

export interface SdkNetworkConfig {
  network: SdkNetwork;
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  contracts: {
    yieldEngine: string;
    rewardDistributor: string;
    rebalanceEngine: string;
    strategyRegistry: string;
  };
}

const PUBLIC_ENDPOINTS: Record<SdkNetwork, { horizonUrl: string; sorobanRpcUrl: string; networkPassphrase: string }> = {
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  },
};

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function contractId(env: NodeJS.ProcessEnv, canonicalName: string, legacyName: string): string {
  return readEnv(env, canonicalName) ?? readEnv(env, legacyName) ?? '';
}

/** Build a complete SDK network configuration from an environment object. */
export function createNetworkConfig(
  network: SdkNetwork,
  env: NodeJS.ProcessEnv = process.env,
): SdkNetworkConfig {
  const defaults = PUBLIC_ENDPOINTS[network];
  return {
    network,
    horizonUrl:
      readEnv(env, network === 'testnet' ? 'HORIZON_URL' : 'MAINNET_HORIZON_URL') ??
      defaults.horizonUrl,
    sorobanRpcUrl:
      readEnv(env, network === 'testnet' ? 'SOROBAN_RPC_URL' : 'MAINNET_SOROBAN_RPC_URL') ??
      defaults.sorobanRpcUrl,
    networkPassphrase:
      readEnv(env, network === 'testnet' ? 'TESTNET_NETWORK_PASSPHRASE' : 'MAINNET_NETWORK_PASSPHRASE') ??
      defaults.networkPassphrase,
    contracts: {
      yieldEngine: contractId(env, 'YIELD_ENGINE_CONTRACT_ID', 'YIELD_ENGINE_ADDRESS'),
      rewardDistributor: contractId(env, 'REWARD_DISTRIBUTOR_CONTRACT_ID', 'REWARD_DISTRIBUTOR_ADDRESS'),
      rebalanceEngine: contractId(env, 'REBALANCE_ENGINE_CONTRACT_ID', 'REBALANCE_ENGINE_ADDRESS'),
      strategyRegistry: contractId(env, 'STRATEGY_REGISTRY_CONTRACT_ID', 'STRATEGY_REGISTRY_ADDRESS'),
    },
  };
}

/** Return operator-facing names for contract roles that are missing. */
export function getMissingContractRoles(config: SdkNetworkConfig): Array<keyof SdkNetworkConfig['contracts']> {
  return (Object.keys(config.contracts) as Array<keyof SdkNetworkConfig['contracts']>)
    .filter((role) => config.contracts[role].trim().length === 0);
}
