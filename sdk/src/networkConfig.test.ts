import { Address, Networks } from 'stellar-sdk';
import {
  DEFAULT_NETWORK,
  DEFAULT_NETWORK_ENDPOINTS,
  MAINNET_CONFIG,
  NetworkConfigError,
  TESTNET_CONFIG,
  getNetworkPassphrase,
  requiredEnvContract,
  resolveNetworkConfig,
  selectNetworkConfig,
} from './networkConfig';
import { VaultClient } from './vaultClient';
import { RebalancerClient } from './rebalancer';
import { StrategyRegistryClient } from './strategyRegistryClient';
import { GovernanceSDK, isContractConfigured } from './governance';
import { RebalanceError } from './types';

describe('Optional network configuration behavior', () => {
  const originalEnv = process.env;
  const sampleContractAddress = Address.contract(Buffer.alloc(32, 1));
  const sampleContractId = sampleContractAddress.toString();
  const sampleContractAddressStr: string = sampleContractId;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HORIZON_URL;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.MAINNET_HORIZON_URL;
    delete process.env.MAINNET_SOROBAN_RPC_URL;
    delete process.env.FUTURENET_HORIZON_URL;
    delete process.env.FUTURENET_SOROBAN_RPC_URL;
    delete process.env.YIELD_ENGINE_CONTRACT_ID;
    delete process.env.REWARD_DISTRIBUTOR_CONTRACT_ID;
    delete process.env.REBALANCE_ENGINE_CONTRACT_ID;
    delete process.env.STRATEGY_REGISTRY_CONTRACT_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolveNetworkConfig defaults and precedence', () => {
    it('falls back to public testnet defaults when config and env are completely absent', () => {
      const config = resolveNetworkConfig(undefined, {});

      expect(config).toEqual({
        network: DEFAULT_NETWORK,
        horizonUrl: DEFAULT_NETWORK_ENDPOINTS.testnet.horizonUrl,
        sorobanRpcUrl: DEFAULT_NETWORK_ENDPOINTS.testnet.sorobanRpcUrl,
        contracts: {
          yieldEngine: '',
          rewardDistributor: '',
          rebalanceEngine: '',
          strategyRegistry: '',
        },
      });
    });

    it('falls back to public defaults for an empty config object', () => {
      const config = resolveNetworkConfig({}, {});

      expect(config.network).toBe('testnet');
      expect(config.horizonUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.testnet.horizonUrl);
      expect(config.sorobanRpcUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.testnet.sorobanRpcUrl);
    });

    it('resolves mainnet and futurenet defaults when only network is supplied', () => {
      const mainnet = resolveNetworkConfig({ network: 'mainnet' }, {});
      expect(mainnet.horizonUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.mainnet.horizonUrl);
      expect(mainnet.sorobanRpcUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.mainnet.sorobanRpcUrl);

      const futurenet = resolveNetworkConfig({ network: 'futurenet' }, {});
      expect(futurenet.horizonUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.futurenet.horizonUrl);
      expect(futurenet.sorobanRpcUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.futurenet.sorobanRpcUrl);
    });

    it('applies environment overrides when explicit config URLs are absent', () => {
      const config = resolveNetworkConfig(
        { network: 'mainnet' },
        {
          MAINNET_HORIZON_URL: 'https://custom-horizon.example.com',
          MAINNET_SOROBAN_RPC_URL: 'https://custom-rpc.example.com',
        },
      );

      expect(config.horizonUrl).toBe('https://custom-horizon.example.com');
      expect(config.sorobanRpcUrl).toBe('https://custom-rpc.example.com');
    });

    it('prefers explicit config values over env vars and trims surrounding whitespace', () => {
      const config = resolveNetworkConfig(
        {
          network: 'testnet',
          sorobanRpcUrl: '  http://localhost:8000/soroban/rpc  ',
          contracts: {
            rebalanceEngine: `  ${sampleContractId}  `,
          },
        },
        {
          HORIZON_URL: '  https://env-horizon.example.com  ',
          SOROBAN_RPC_URL: 'https://env-rpc.example.com',
        },
      );

      expect(config.horizonUrl).toBe('https://env-horizon.example.com');
      expect(config.sorobanRpcUrl).toBe('http://localhost:8000/soroban/rpc');
      expect(config.contracts).toEqual({
        yieldEngine: '',
        rewardDistributor: '',
        rebalanceEngine: sampleContractId,
        strategyRegistry: '',
      });
    });

    it('treats whitespace-only optional config and env values as absent', () => {
      const config = resolveNetworkConfig(
        {
          horizonUrl: '   ',
          sorobanRpcUrl: '\t\n',
          contracts: {
            yieldEngine: '   ',
            strategyRegistry: '\n',
          },
        },
        {
          HORIZON_URL: '   ',
          SOROBAN_RPC_URL: '',
        },
      );

      expect(config.horizonUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.testnet.horizonUrl);
      expect(config.sorobanRpcUrl).toBe(DEFAULT_NETWORK_ENDPOINTS.testnet.sorobanRpcUrl);
      expect(config.contracts.yieldEngine).toBe('');
      expect(config.contracts.strategyRegistry).toBe('');
    });
  });

  describe('boundary and failure validation', () => {
    it('rejects unsupported network names with INVALID_NETWORK', () => {
      expect(() =>
        resolveNetworkConfig({ network: 'devnet' as any }, {}),
      ).toThrow(NetworkConfigError);

      try {
        resolveNetworkConfig({ network: '' as any }, {});
        fail('Expected NetworkConfigError');
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkConfigError);
        expect((err as NetworkConfigError).code).toBe('INVALID_NETWORK');
      }
    });

    it('rejects malformed or non-http(s) endpoint URLs with INVALID_ENDPOINT_URL', () => {
      const badInputs = [
        { horizonUrl: 'not-a-url' },
        { sorobanRpcUrl: 'ftp://soroban-testnet.stellar.org' },
        { sorobanRpcUrl: 'javascript:alert(1)' },
      ];

      for (const input of badInputs) {
        try {
          resolveNetworkConfig(input, {});
          fail(`Expected NetworkConfigError for ${JSON.stringify(input)}`);
        } catch (err) {
          expect(err).toBeInstanceOf(NetworkConfigError);
          expect((err as NetworkConfigError).code).toBe('INVALID_ENDPOINT_URL');
        }
      }
    });

    it('rejects malformed endpoint URLs coming from environment variables', () => {
      expect(() =>
        resolveNetworkConfig(undefined, { SOROBAN_RPC_URL: 'ws://invalid-protocol' }),
      ).toThrow(NetworkConfigError);
    });

    it('resolves passphrases for all supported networks and rejects invalid ones', () => {
      expect(getNetworkPassphrase()).toBe(Networks.TESTNET);
      expect(getNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
      expect(getNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
      expect(getNetworkPassphrase('futurenet')).toBe(Networks.FUTURENET);
      expect(() => getNetworkPassphrase('unknown' as any)).toThrow(NetworkConfigError);
    });

    it('rejects absent or whitespace-only required contract env vars with MISSING_CONTRACT_ID', () => {
      expect(() => requiredEnvContract('YIELD_ENGINE_CONTRACT_ID', {})).toThrow(NetworkConfigError);
      expect(() =>
        requiredEnvContract('YIELD_ENGINE_CONTRACT_ID', { YIELD_ENGINE_CONTRACT_ID: '   ' }),
      ).toThrow(/YIELD_ENGINE_CONTRACT_ID/);

      expect(() => TESTNET_CONFIG.contracts.yieldEngine).toThrow(/YIELD_ENGINE_CONTRACT_ID/);
      expect(() => MAINNET_CONFIG.contracts.rebalanceEngine).toThrow(/REBALANCE_ENGINE_CONTRACT_ID/);

      process.env.YIELD_ENGINE_CONTRACT_ID = `  ${sampleContractId}  `;
      expect(TESTNET_CONFIG.contracts.yieldEngine).toBe(sampleContractId);
    });

    it('selectNetworkConfig defaults to TESTNET_CONFIG and rejects unknown presets', () => {
      expect(selectNetworkConfig()).toBe(TESTNET_CONFIG);
      expect(selectNetworkConfig('mainnet')).toBe(MAINNET_CONFIG);
      expect(selectNetworkConfig('futurenet').network).toBe('futurenet');
      expect(() => selectNetworkConfig('devnet' as any)).toThrow(NetworkConfigError);
    });
  });

  describe('SDK client behavior when optional network config is absent', () => {
    it('VaultClient works with default testnet config even when contract env vars are unset', () => {
      const client = new VaultClient(sampleContractAddressStr, selectNetworkConfig());
      expect(client).toBeInstanceOf(VaultClient);
      expect((client as any).networkConfig.network).toBe('testnet');
    });

    it('VaultClient works with a partial futurenet config resolved via selectNetworkConfig', () => {
      const config = selectNetworkConfig({
        network: 'futurenet',
        sorobanRpcUrl: 'https://custom-futurenet-rpc.example.com',
      });
      const client = new VaultClient(sampleContractAddressStr, config);
      expect(client).toBeInstanceOf(VaultClient);
      expect((client as any).networkConfig.network).toBe('futurenet');
      expect((client as any).networkConfig.sorobanRpcUrl).toBe(
        'https://custom-futurenet-rpc.example.com',
      );
    });

    it('RebalancerClient throws RebalanceError(MISSING_CONTRACT_ID) when rebalanceEngine is absent', () => {
      const emptyConfig = resolveNetworkConfig({}, {});
      try {
        new RebalancerClient(emptyConfig);
        fail('Expected RebalanceError');
      } catch (err) {
        expect(err).toBeInstanceOf(RebalanceError);
        expect((err as RebalanceError).code).toBe('MISSING_CONTRACT_ID');
      }
    });

    it('RebalancerClient throws NetworkConfigError when using TESTNET_CONFIG without env var', () => {
      expect(() => new RebalancerClient(selectNetworkConfig())).toThrow(NetworkConfigError);
      expect(() => new RebalancerClient(selectNetworkConfig())).toThrow(
        /REBALANCE_ENGINE_CONTRACT_ID/,
      );
    });

    it('RebalancerClient constructs cleanly when rebalanceEngine is explicitly supplied in partial config', () => {
      const config = selectNetworkConfig({
        contracts: { rebalanceEngine: sampleContractId },
      });
      const client = new RebalancerClient(config);
      expect(client).toBeInstanceOf(RebalancerClient);
    });

    it('GovernanceSDK defaults cleanly to read-only unconfigured state when optional args are omitted', () => {
      const config = resolveNetworkConfig({ network: 'futurenet' }, {});
      const client = new GovernanceSDK(config.sorobanRpcUrl, getNetworkPassphrase('futurenet'));

      expect(client.getNetworkPassphrase()).toBe(Networks.FUTURENET);
      expect(client.getKeypair()).toBeUndefined();
      expect(isContractConfigured(client.getContracts().governance)).toBe(false);
    });

    it('StrategyRegistryClient falls back to default strategies when strategyRegistry config is absent', async () => {
      const emptyConfig = resolveNetworkConfig({}, {});
      const registry = new StrategyRegistryClient(emptyConfig);

      const strategies = await registry.fetchActiveStrategies(2);
      expect(strategies).toHaveLength(2);
      expect(strategies[0].name).toBe('Conservative Growth');
    });
  });
});
