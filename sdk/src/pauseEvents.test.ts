import { VaultClient, RebalancerClient } from './index';
import { Keypair, Address } from 'stellar-sdk';
import { PauseReason, VaultEvent, RebalanceEvent } from './types';

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
      const reason: PauseReason = 'security';
      const reasonDetails = 'Suspicious activity detected';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        expect(event.vault).toBe(mockVaultAddress.toString());
        expect(event.timestamp).toBeGreaterThan(0);
        done();
      });

      // Simulate pause event emission (in real scenario, this would be called after successful pause)
      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with circuit_breaker reason', (done) => {
      const reason: PauseReason = 'circuit_breaker';
      const reasonDetails = 'High volatility detected';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with slippage_protection reason', (done) => {
      const reason: PauseReason = 'slippage_protection';
      const reasonDetails = 'Price deviation exceeded 5% threshold';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with maintenance reason', (done) => {
      const reason: PauseReason = 'maintenance';
      const reasonDetails = 'Scheduled system upgrade';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with governance reason', (done) => {
      const reason: PauseReason = 'governance';
      const reasonDetails = 'Protocol vote passed to pause';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with liquidity_issue reason', (done) => {
      const reason: PauseReason = 'liquidity_issue';
      const reasonDetails = 'Insufficient liquidity in pool';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with emergency reason', (done) => {
      const reason: PauseReason = 'emergency';
      const reasonDetails = 'Critical system failure detected';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event with manual reason', (done) => {
      const reason: PauseReason = 'manual';
      const reasonDetails = 'Admin initiated manual pause';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBe(reasonDetails);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason, reasonDetails);
    });

    it('should emit pause event without reasonDetails', (done) => {
      const reason: PauseReason = 'manual';

      vaultClient.on('pause', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        expect(event.reasonDetails).toBeUndefined();
        done();
      });

      (vaultClient as any).emitPauseEvent(reason);
    });

    it('should emit unpause event', (done) => {
      vaultClient.on('unpause', (event: VaultEvent) => {
        expect(event.type).toBe('unpause');
        expect(event.vault).toBe(mockVaultAddress.toString());
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.reason).toBeUndefined();
        done();
      });

      (vaultClient as any).emitUnpauseEvent();
    });

    it('should emit vaultEvent for pause', (done) => {
      const reason: PauseReason = 'security';

      vaultClient.on('vaultEvent', (event: VaultEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        done();
      });

      (vaultClient as any).emitPauseEvent(reason);
    });

    it('should emit vaultEvent for unpause', (done) => {
      vaultClient.on('vaultEvent', (event: VaultEvent) => {
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
      const reason: PauseReason = 'security';
      const reasonDetails = 'Arbitrage risk detected';

      rebalancerClient.on('pause', (event: RebalanceEvent) => {
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
      const reason: PauseReason = 'circuit_breaker';
      const reasonDetails = 'Volatility threshold exceeded';

      rebalancerClient.on('pause', (event: RebalanceEvent) => {
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
      ];

      let receivedCount = 0;
      rebalancerClient.on('pause', (event: RebalanceEvent) => {
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
      rebalancerClient.on('unpause', (event: RebalanceEvent) => {
        expect(event.type).toBe('unpause');
        expect(event.strategy).toBe(0);
        expect(event.timestamp).toBeGreaterThan(0);
        expect(event.reason).toBeUndefined();
        done();
      });

      (rebalancerClient as any).emitUnpauseEvent();
    });

    it('should emit rebalanceEvent for pause', (done) => {
      const reason: PauseReason = 'maintenance';

      rebalancerClient.on('rebalanceEvent', (event: RebalanceEvent) => {
        expect(event.type).toBe('pause');
        expect(event.reason).toBe(reason);
        done();
      });

      (rebalancerClient as any).emitPauseEvent(reason);
    });

    it('should emit rebalanceEvent for unpause', (done) => {
      rebalancerClient.on('rebalanceEvent', (event: RebalanceEvent) => {
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
      ];

      validReasons.forEach((reason) => {
        expect(reason).toBeDefined();
      });
    });

    it('should distinguish common pause causes', () => {
      const securityReason: PauseReason = 'security';
      const circuitBreakerReason: PauseReason = 'circuit_breaker';
      const slippageReason: PauseReason = 'slippage_protection';
      const maintenanceReason: PauseReason = 'maintenance';

      expect(securityReason).not.toBe(circuitBreakerReason);
      expect(circuitBreakerReason).not.toBe(slippageReason);
      expect(slippageReason).not.toBe(maintenanceReason);
    });
  });
});
