import { WriteRateLimiter } from './rateLimiter';

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

/** Resolves after `n` macrotask turns, letting queued work run. */
function flush(n = 3): Promise<void> {
  return new Promise((resolve) => {
    let remaining = n;
    const tick = () => (remaining-- > 0 ? setTimeout(tick, 0) : resolve());
    tick();
  });
}

describe('WriteRateLimiter', () => {
  it('rejects an invalid configuration', () => {
    expect(() => new WriteRateLimiter({ minIntervalMs: -1 })).toThrow(/non-negative/);
    expect(() => new WriteRateLimiter({ maxConcurrent: 0 })).toThrow(/at least 1/);
    expect(() => new WriteRateLimiter({ maxQueue: 0 })).toThrow(/at least 1/);
  });

  it('returns the task result', async () => {
    const limiter = new WriteRateLimiter();
    await expect(limiter.schedule(async () => 42)).resolves.toBe(42);
  });

  it('spaces write starts by the pacing interval', async () => {
    const clock = virtualClock();
    const starts: number[] = [];
    const limiter = new WriteRateLimiter({
      minIntervalMs: 1000,
      maxConcurrent: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await Promise.all(
      [0, 1, 2].map(() =>
        limiter.schedule(async () => {
          starts.push(clock.now());
        }),
      ),
    );

    expect(starts).toEqual([0, 1000, 2000]);
    expect(limiter.stats().throttled).toBe(2);
  });

  it('does not pace when the interval is zero', async () => {
    const clock = virtualClock();
    const starts: number[] = [];
    const limiter = new WriteRateLimiter({
      minIntervalMs: 0,
      maxConcurrent: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await Promise.all(
      [0, 1, 2].map(() =>
        limiter.schedule(async () => {
          starts.push(clock.now());
        }),
      ),
    );

    expect(starts).toEqual([0, 0, 0]);
    expect(limiter.stats().throttled).toBe(0);
  });

  it('caps how many writes run concurrently', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const write = () =>
      limiter.schedule(
        () =>
          new Promise<void>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            releases.push(() => {
              active -= 1;
              resolve();
            });
          }),
      );

    const writes = [write(), write(), write(), write()];
    await flush();

    // Only two writes may be in flight; the other two wait their turn.
    expect(limiter.stats().inFlight).toBe(2);
    expect(limiter.stats().queued).toBe(2);
    expect(peak).toBe(2);

    releases.forEach((release) => release());
    await flush();
    releases.forEach((release) => release());
    await Promise.all(writes);

    expect(peak).toBe(2);
    expect(limiter.stats().completed).toBe(4);
  });

  it('rejects submissions once the queue is full', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, maxConcurrent: 1, maxQueue: 1 });
    const never = new Promise<void>(() => undefined);

    const running = limiter.schedule(() => never);
    const queued = limiter.schedule(async () => undefined);

    await expect(limiter.schedule(async () => undefined)).rejects.toThrow(/queue is full/);
    expect(limiter.stats().rejected).toBe(1);
    expect(limiter.stats().queued).toBe(1);

    // Silence unused bindings; the two accepted writes are intentionally left pending.
    expect(running).toBeDefined();
    expect(queued).toBeDefined();
  });

  it('tracks completed and failed writes', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });

    await limiter.schedule(async () => 'ok');
    await expect(
      limiter.schedule(async () => {
        throw new Error('rpc rejected the write');
      }),
    ).rejects.toThrow(/rpc rejected the write/);

    const stats = limiter.stats();
    expect(stats.submitted).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.inFlight).toBe(0);
    expect(stats.queued).toBe(0);
  });

  it('keeps draining after a failure', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });
    const order: string[] = [];

    const first = limiter.schedule(async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = limiter.schedule(async () => {
      order.push('second');
      return 'done';
    });

    await expect(first).rejects.toThrow(/boom/);
    await expect(second).resolves.toBe('done');
    expect(order).toEqual(['first', 'second']);
  });
});
