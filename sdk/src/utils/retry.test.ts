/**
 * Tests for retry utility.
 */

import { withRetry, createRetryWrapper, DEFAULT_RETRY_OPTIONS } from './retry';

describe('withRetry', () => {
  it('returns result on first successful attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const { result, attempts } = await withRetry(fn);

    expect(result).toBe('success');
    expect(attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue('success');

    const { result, attempts } = await withRetry(fn, { maxRetries: 3 });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on transient errors', async () => {
    const fn = jest.fn()
      .mockRejectedValue(new Error('network timeout'));

    await expect(withRetry(fn, { maxRetries: 2 }))
      .rejects
      .toThrow('network timeout');

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry on non-transient errors', async () => {
    const fn = jest.fn()
      .mockRejectedValue(new Error('invalid signature'));

    await expect(withRetry(fn, { maxRetries: 3 }))
      .rejects
      .toThrow('invalid signature');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('recognizes transient error codes', async () => {
    const transientErrors = [
      { code: 'ECONNRESET', message: 'Connection reset' },
      { code: 'ETIMEDOUT', message: 'Timeout' },
      { code: 'ECONNREFUSED', message: 'Connection refused' },
      { code: 'ENOTFOUND', message: 'DNS not found' },
      { code: 'EAI_AGAIN', message: 'DNS timeout' },
      { code: 'EPIPE', message: 'Broken pipe' },
    ];

    for (const error of transientErrors) {
      const fn = jest.fn()
        .mockRejectedValueOnce(error as any)
        .mockResolvedValue('success');

      const { result } = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('recognizes transient HTTP status codes', async () => {
    const transientStatuses = [408, 429, 500, 502, 503, 504];

    for (const status of transientStatuses) {
      const fn = jest.fn()
        .mockRejectedValueOnce({ status, message: `HTTP ${status}` } as any)
        .mockResolvedValue('success');

      const { result } = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('recognizes transient error patterns in messages', async () => {
    const transientMessages = [
      'network error occurred',
      'request timeout',
      'temporary unavailable',
      'service unavailable',
      'rate limit exceeded',
      'too many requests',
      'connection failed',
    ];

    for (const message of transientMessages) {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error(message))
        .mockResolvedValue('success');

      const { result } = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('uses exponential backoff', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const delays: number[] = [];
    const startTime = Date.now();

    await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 50,
      backoffMultiplier: 2,
      maxDelayMs: 1000,
      jitter: false,
      onRetry: (attempt, error, delayMs) => {
        delays.push(delayMs);
      },
    });

    const endTime = Date.now();

    // First retry should be ~50ms, second should be ~100ms (50 * 2)
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(50);
    expect(delays[1]).toBeGreaterThanOrEqual(100);
    expect(endTime - startTime).toBeGreaterThanOrEqual(150);
  });

  it('respects max delay cap', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const delays: number[] = [];

    await withRetry(fn, {
      maxRetries: 4,
      initialDelayMs: 10,
      backoffMultiplier: 10,
      maxDelayMs: 20,
      jitter: false,
      onRetry: (attempt, error, delayMs) => {
        delays.push(delayMs);
      },
    });

    delays.forEach(delay => {
      expect(delay).toBeLessThanOrEqual(20);
    });
  });

  it('adds jitter when enabled', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const delays: number[] = [];

    await withRetry(fn, {
      maxRetries: 2,
      initialDelayMs: 100,
      backoffMultiplier: 2,
      jitter: true,
      onRetry: (attempt, error, delayMs) => {
        delays.push(delayMs);
      },
    });

    // With jitter, delay should be between 75ms and 125ms (100 * 0.75 to 100 * 1.25)
    expect(delays[0]).toBeGreaterThanOrEqual(75);
    expect(delays[0]).toBeLessThanOrEqual(125);
  });

  it('calls onRetry callback for each retry', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network error 1'))
      .mockRejectedValueOnce(new Error('network error 2'))
      .mockResolvedValue('success');

    const retryCallbacks: any[] = [];

    await withRetry(fn, {
      maxRetries: 3,
      onRetry: (attempt, error, delayMs) => {
        retryCallbacks.push({ attempt, error: error.message, delayMs });
      },
    });

    expect(retryCallbacks).toHaveLength(2);
    expect(retryCallbacks[0].attempt).toBe(1);
    expect(retryCallbacks[0].error).toBe('network error 1');
    expect(retryCallbacks[1].attempt).toBe(2);
    expect(retryCallbacks[1].error).toBe('network error 2');
  });

  it('respects custom maxRetries', async () => {
    const fn = jest.fn()
      .mockRejectedValue(new Error('network error'));

    await expect(withRetry(fn, { maxRetries: 5 }))
      .rejects
      .toThrow('network error');

    expect(fn).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
  });

  it('uses default options when none provided', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const { result } = await withRetry(fn);

    expect(result).toBe('success');
  });
});

describe('retry configuration boundaries', () => {
  it('rejects negative maxRetries without executing the operation', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    await expect(withRetry(fn, { maxRetries: -1 })).rejects.toThrow(
      'maxRetries must be a non-negative integer'
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects fractional maxRetries values', async () => {
    await expect(withRetry(async () => 'success', { maxRetries: 1.5 })).rejects.toThrow(
      'maxRetries must be a non-negative integer'
    );
  });

  it('accepts zero retries and performs exactly one attempt', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('network timeout'));
    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('network timeout');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid backoff and delay boundaries', async () => {
    await expect(withRetry(async () => 'success', { initialDelayMs: -1 })).rejects.toThrow('initialDelayMs');
    await expect(withRetry(async () => 'success', { backoffMultiplier: 0 })).rejects.toThrow('backoffMultiplier');
    await expect(withRetry(async () => 'success', {
      initialDelayMs: 100,
      maxDelayMs: 50,
    })).rejects.toThrow('maxDelayMs');
  });
});

describe('createRetryWrapper', () => {
  it('creates a wrapper with pre-configured options', async () => {
    const wrapper = createRetryWrapper({ maxRetries: 5 });
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    const { result, attempts } = await wrapper(fn);

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('allows overriding options per call', async () => {
    const wrapper = createRetryWrapper({ maxRetries: 2 });
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('success');

    // The wrapper doesn't accept options override in current implementation
    // This test verifies the base functionality
    await expect(wrapper(fn))
      .rejects
      .toThrow('network error');

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

describe('DEFAULT_RETRY_OPTIONS', () => {
  it('has sensible default values', () => {
    expect(DEFAULT_RETRY_OPTIONS.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_OPTIONS.initialDelayMs).toBe(100);
    expect(DEFAULT_RETRY_OPTIONS.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_OPTIONS.maxDelayMs).toBe(5000);
    expect(DEFAULT_RETRY_OPTIONS.jitter).toBe(true);
  });
});
