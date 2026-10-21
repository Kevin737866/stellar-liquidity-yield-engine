/**
 * Retry utility for transient RPC errors.
 *
 * Transient errors (network timeouts, rate limits, temporary server errors)
 * should be retried with exponential backoff to reduce spurious failures.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts. Defaults to 3. */
  maxRetries?: number;
  /** Initial delay between retries in milliseconds. Defaults to 100ms. */
  initialDelayMs?: number;
  /** Multiplier for exponential backoff. Defaults to 2. */
  backoffMultiplier?: number;
  /** Maximum delay between retries in milliseconds. Defaults to 5000ms. */
  maxDelayMs?: number;
  /** Whether to add jitter to retry delays. Defaults to true. */
  jitter?: boolean;
  /** Optional callback for logging retry attempts. */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface RetryResult<T> {
  /** The successful result, or throws if all retries failed. */
  result: T;
  /** Number of attempts made (1 = first attempt, no retries). */
  attempts: number;
}

/**
 * Default retry configuration for RPC calls.
 */
export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 100,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
  jitter: true,
  onRetry: () => {},
};

/**
 * Error codes that indicate transient failures and should trigger retries.
 */
const TRANSIENT_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
];

/**
 * HTTP status codes that indicate transient failures.
 */
const TRANSIENT_HTTP_STATUS_CODES = [
  408, // Request Timeout
  429, // Too Many Requests (rate limit)
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
];

/**
 * Error messages that indicate transient failures.
 */
const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /timeout/i,
  /temporar/i,
  /unavailable/i,
  /rate limit/i,
  /too many requests/i,
  /connection/i,
];

/**
 * Determine if an error is transient and should trigger a retry.
 */
function isTransientError(error: Error): boolean {
  // Check error code
  if ('code' in error && TRANSIENT_ERROR_CODES.includes((error as any).code)) {
    return true;
  }

  // Check HTTP status code
  if ('status' in error && typeof (error as any).status === 'number') {
    return TRANSIENT_HTTP_STATUS_CODES.includes((error as any).status);
  }

  // Check error message
  const message = error.message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Calculate delay with exponential backoff and optional jitter.
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  backoffMultiplier: number,
  maxDelayMs: number,
  jitter: boolean
): number {
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  if (!jitter) {
    return cappedDelay;
  }

  // Add random jitter: ±25% of the delay
  const jitterFactor = 0.75 + Math.random() * 0.5; // 0.75 to 1.25
  return Math.floor(cappedDelay * jitterFactor);
}

/**
 * Retry an async operation with exponential backoff for transient errors.
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the successful operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error as Error;

      // Don't retry on the last attempt or non-transient errors
      if (attempt > opts.maxRetries || !isTransientError(lastError)) {
        throw lastError;
      }

      const delayMs = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.backoffMultiplier,
        opts.maxDelayMs,
        opts.jitter
      );

      opts.onRetry(attempt, lastError, delayMs);

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError!;
}

/**
 * Create a retry wrapper with pre-configured options.
 */
export function createRetryWrapper(options: RetryOptions) {
  return <T>(fn: () => Promise<T>) => withRetry(fn, options);
}
