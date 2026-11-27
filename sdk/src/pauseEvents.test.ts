import { VaultClient, RebalancerClient } from './index';
import { Address } from 'stellar-sdk';
import type { PauseReason } from './types';

describe('Pause Event Emission', () => {
  describe('VaultClient pause events', () => {
    let vaultClient: VaultClient;
    let mockNetworkConfig: any;
    let mockVaultAddress: Address;

    beforeEach(() => {
      mockVaultAddress = new Address('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
      mockNetworkConfig = {
        network: 'testnet' as const,
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        contracts: {
          yieldEngine: '',
          rewardDistributor: '',
          rebalanceEngine: '',
          strategyRegistry: ''
        }
      };
      vaultClient = new VaultClient(mockVaultAddress, mockNetworkConfig);
    });

    it('should emit pause event with security reason', (done) => {
      const reason = 'security' as PauseReason;
      const reasonDetails = 'Suspicious activity detected';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        expect(event.vault).toBe(mockVaultAddress.toString());
        expect(event.timestamp).toBeGreaterThan(0);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with circuit_breaker reason', (done) => {
      const reason = 'circuit_breaker' as PauseReason;
      const reasonDetails = 'High volatility detected';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with slippage_protection reason', (done) => {
      const reason = 'slippage_protection' as PauseReason;
      const reasonDetails = 'Price deviation exceeded 5% threshold';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with maintenance reason', (done) => {
      const reason = 'maintenance' as PauseReason;
      const reasonDetails = 'Scheduled system upgrade';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with governance reason', (done) => {
      const reason = 'governance' as PauseReason;
      const reasonDetails = 'Protocol vote passed to pause';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with liquidity_issue reason', (done) => {
      const reason = 'liquidity_issue' as PauseReason;
      const reasonDetails = 'Insufficient liquidity in pool';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with emergency reason', (done) => {
      const reason = 'emergency' as PauseReason;
      const reasonDetails = 'Critical system failure detected';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with manual reason', (done) => {
      const reason = 'manual' as PauseReason;
      const reasonDetails = 'Admin initiated manual pause';

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event without reasonDetails', (done) => {
      const reason = 'manual' as PauseReason;

      vaultClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBeUndefined();
        done();
      });

      (vaultClient as any).emitPauseEvent(reason);
    });

    it('should emit unpause event', (done) => {
      vaultClient.on('unpause', (event: any) => {
        expect(event.type).toBe('unpause');
        expect(event.vault).toBe(mockVaultAddress.toString());
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.reason).toBeUndefined();
        done();
      });

      (vaultClient as any).emitUnpauseEvent();
    });

    it('should emit vaultEvent for pause', (done) => {
      const reason = 'security' as PauseReason;

      vaultClient.on('vaultEvent', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason);
    });

    it('should emit vaultEvent for unpause', (done) => {
      vaultClient.on('vaultEvent', (event: any) => {
        expect(event.type).toBe('unpause');
        done();
      });

      (vaultClient as any).emitUnpauseEvent();
    });
  });

  describe('RebalancerClient pause events', () => {
    let rebalancerClient: RebalancerClient;
    let mockNetworkConfig: any;

    beforeEach(() => {
      mockNetworkConfig = {
        network: 'testnet' as const,
        horizonUrl: 'https://horizon-testnet.stellar.org',
        sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
        contracts: {
          yieldEngine: '',
          rewardDistributor: '',
          rebalanceEngine: 'CBALANCE',
          strategyRegistry: ''
        }
      };
      rebalancerClient = new RebalancerClient(mockNetworkConfig);
    });

    it('should emit pause event with security reason', (done) => {
      const reason = 'security' as PauseReason;
      const reasonDetails = 'Arbitrage risk detected';

      rebalancerClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        expect(event.strategy).toBe(0);
        expect(event.timestamp).toBeGreaterThan(0);
        done();
      });

      (rebalancerClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with circuit_breaker reason', (done) => {
      const reason = 'circuit_breaker' as PauseReason;
      const reasonDetails = 'Volatility threshold exceeded';

      rebalancerClient.on('pause', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (rebalancerClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with all reason types', (done) => {
      const reasons: PauseReason[] = [
        'security',
        'circuit_breaker',
        'slippage_protection',
        'maintenance',
        'governance',
        'liquidity_issue',
        'emergency',
        'manual'
      ] as PauseReason[];

      let receivedCount = 0;
      rebalancerClient.on('pause', (event: any) => {
        expect(reasons).toContain(event.reason);
        receivedCount++;
        if (receivedCount === reasons.length) {
          done();
        }
      });

      reasons.forEach((reason) => {
        (rebalancerClient as any).emitPauseEvent(reason, `Test ${reason}`);
      });
    });

    it('should emit unpause event', (done) => {
      rebalancerClient.on('unpause', (event: any) => {
        expect(event.type).toBe('unpause');
        expect(event.strategy).toBe(0);
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.reason).toBeUndefined();
        done();
      });

      (rebalancerClient as any).emitUnpauseEvent();
    });

    it('should emit rebalanceEvent for pause', (done) => {
      const reason = 'maintenance' as PauseReason;

      rebalancerClient.on('rebalanceEvent', (event: any) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        done();
      });

      (rebalancerClient as any).emitPauseEvent(reason);
    });

    it('should emit rebalanceEvent for unpause', (done) => {
      rebalancerClient.on('rebalanceEvent', (event: any) => {
        expect(event.type).toBe('unpause');
        done();
      });

      (rebalancerClient as any).emitUnpauseEvent();
    });
  });

  describe('PauseReason type validation', () => {
    it('should accept all valid pause reasons', () => {
      const validReasons: PauseReason[] = [
        'security',
        'circuit_breaker',
        'slippage_protection',
        'maintenance',
        'governance',
        'liquidity_issue',
        'emergency',
        'manual'
      ] as PauseReason[];

      validReasons.forEach((reason) => {
        expect(reason).toBeDefined();
      });
    });

    it('should distinguish common pause causes', () => {
      const securityReason = 'security' as PauseReason;
      const circuitBreakerReason = 'circuit_breaker' as PauseReason;
      const slippageReason = 'slippage_protection' as PauseReason;
      const maintenanceReason = 'maintenance' as PauseReason;

      expect(securityReason).not.toBe(circuitBreakerReason);
      expect(circuitBreakerReason).not.toBe(slippageReason);
      expect(slippageReason).not.toBe(maintenanceReason);
    });
  });
});
