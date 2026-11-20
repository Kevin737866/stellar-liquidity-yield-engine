import { createNetworkConfig, getMissingContractRoles } from './networkConfig';
import { Networks } from 'stellar-sdk';

describe('network configuration', () => {
  it('uses public testnet defaults', () => {
    const config = createNetworkConfig('testnet', {});
    expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(config.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('uses public mainnet defaults and passphrase', () => {
    const config = createNetworkConfig('mainnet', {});
    expect(config.horizonUrl).toBe('https://horizon.stellar.org');
    expect(config.sorobanRpcUrl).toBe('https://soroban.stellar.org');
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it('accepts canonical and legacy contract variable names', () => {
    const config = createNetworkConfig('testnet', {
      YIELD_ENGINE_CONTRACT_ID: 'CYIELD',
      REWARD_DISTRIBUTOR_ADDRESS: 'CREWARD',
      REBALANCE_ENGINE_CONTRACT_ID: 'CREBALANCE',
      STRATEGY_REGISTRY_ADDRESS: 'CSTRATEGY',
    });
    expect(config.contracts).toEqual({
      yieldEngine: 'CYIELD',
      rewardDistributor: 'CREWARD',
      rebalanceEngine: 'CREBALANCE',
      strategyRegistry: 'CSTRATEGY',
    });
  });

  it('prefers canonical contract variables and trims boundaries', () => {
    const config = createNetworkConfig('testnet', {
      YIELD_ENGINE_CONTRACT_ID: '  CCANONICAL  ',
      YIELD_ENGINE_ADDRESS: 'CLEgacy',
      SOROBAN_RPC_URL: '  https://rpc.example  ',
      HORIZON_URL: '   ',
    });
    expect(config.contracts.yieldEngine).toBe('CCANONICAL');
    expect(config.sorobanRpcUrl).toBe('https://rpc.example');
    expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
  });

  it('reports every missing contract role explicitly', () => {
    const config = createNetworkConfig('testnet', {});
    expect(getMissingContractRoles(config)).toEqual([
      'yieldEngine', 'rewardDistributor', 'rebalanceEngine', 'strategyRegistry',
    ]);
  });
});
