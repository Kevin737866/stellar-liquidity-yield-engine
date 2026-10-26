import { ArbitrageExecutor, Opportunity } from './arbitrage';
import { WriteRateLimiter } from './utils/rateLimiter';

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    pool_id: 'POOL-B',
    current_apy: 1500,
    projected_apy: 2000,
    il_risk: 50,
    net_profit: BigInt(1000),
    apy_delta: 500,
    recommended: true,
    ...overrides,
  };
}

/** A virtual clock whose time only advances when `sleep` is called. */
function virtualClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe('ArbitrageExecutor write pacing', () => {
  it('paces submissions through its write limiter', async () => {
    const clock = virtualClock();
    const limiter = new WriteRateLimiter({
      minIntervalMs: 1000,
      maxConcurrent: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    const executor = new ArbitrageExecutor('https://horizon-testnet.stellar.org', {
      writeLimiter: limiter,
    });

    const results = await Promise.all([
      executor.executeArbitrage(opportunity(), 'POOL-A', BigInt(1000), 'SKEY'),
      executor.executeArbitrage(opportunity(), 'POOL-A', BigInt(1000), 'SKEY'),
      executor.executeArbitrage(opportunity(), 'POOL-A', BigInt(1000), 'SKEY'),
    ]);

    expect(results.every((r) => r.success)).toBe(true);

    const stats = executor.getWriteLimiterStats();
    expect(stats.completed).toBe(3);
    // Two of the three writes had to wait for the pacing interval.
    expect(stats.throttled).toBe(2);
    // The virtual clock only advances through pacing sleeps, so it reaching
    // 2000ms proves two 1000ms waits were enforced between admissions.
    expect(clock.now()).toBe(2000);
  });

  it('does not pace submissions when the limiter allows immediate writes', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });
    const executor = new ArbitrageExecutor('https://horizon-testnet.stellar.org', {
      writeLimiter: limiter,
    });

    await Promise.all([
      executor.executeArbitrage(opportunity(), 'POOL-A', BigInt(1000), 'SKEY'),
      executor.executeArbitrage(opportunity(), 'POOL-A', BigInt(1000), 'SKEY'),
    ]);

    const stats = executor.getWriteLimiterStats();
    expect(stats.completed).toBe(2);
    expect(stats.throttled).toBe(0);
  });

  it('returns a failure result without submitting a write for an invalid opportunity', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0 });
    const executor = new ArbitrageExecutor('https://horizon-testnet.stellar.org', {
      writeLimiter: limiter,
    });

    const result = await executor.executeArbitrage(
      opportunity({ recommended: false }),
      'POOL-A',
      BigInt(1000),
      'SKEY',
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/recommended threshold/);
    expect(limiter.stats().submitted).toBe(0);
  });
});
