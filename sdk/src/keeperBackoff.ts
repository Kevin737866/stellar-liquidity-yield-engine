/**
 * Durable exponential backoff for keeper loops.
 *
 * After repeated consecutive failures a keeper skips its ticks until `nextAttemptAt`, so a
 * flapping keeper stops hammering the RPC during an outage. The state is persisted through a
 * store, so a restart during the outage does not reset the delay.
 */

export interface BackoffPolicy {
  /** Delay after the first failure that triggers backoff, in ms. */
  baseMs: number;
  /** Maximum delay, in ms. */
  maxMs: number;
  /** Multiplier applied per additional failure. */
  factor: number;
  /** Consecutive failures tolerated before backoff starts (1 = back off from the first failure). */
  startAfterFailures: number;
  /** Fraction of the delay randomized (0 to 1), to avoid synchronized retries. */
  jitterRatio: number;
}

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  baseMs: 5_000,
  maxMs: 300_000,
  factor: 2,
  startAfterFailures: 2,
  jitterRatio: 0.2,
};

export interface BackoffState {
  consecutiveFailures: number;
  /** Epoch ms before which the keeper must not call the RPC again (0 = no wait). */
  nextAttemptAt: number;
  lastError?: string;
  updatedAt: number;
}

export interface BackoffStateStore {
  load(): Promise<BackoffState | null>;
  save(state: BackoffState): Promise<void>;
}

export class InMemoryBackoffStore implements BackoffStateStore {
  private state: BackoffState | null = null;
  async load() {
    return this.state ? { ...this.state } : null;
  }
  async save(state: BackoffState) {
    this.state = { ...state };
  }
}

export interface BackoffOptions {
  policy?: Partial<BackoffPolicy>;
  store?: BackoffStateStore;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Injectable randomness in [0, 1) for tests. */
  random?: () => number;
  onBackoff?: (info: { failures: number; delayMs: number; nextAttemptAt: number; error: string }) => void;
  onRecover?: (info: { afterFailures: number }) => void;
}

export type TickResult<T> =
  | { ran: true; ok: true; value: T }
  | { ran: true; ok: false; error: unknown; delayMs: number }
  | { ran: false; waitMs: number };

const EMPTY: BackoffState = { consecutiveFailures: 0, nextAttemptAt: 0, updatedAt: 0 };

function validatePolicy(p: BackoffPolicy): BackoffPolicy {
  if (!(p.baseMs > 0) || !(p.maxMs >= p.baseMs) || !(p.factor >= 1)) {
    throw new Error('Invalid backoff policy: need baseMs > 0, maxMs >= baseMs, factor >= 1');
  }
  if (!Number.isInteger(p.startAfterFailures) || p.startAfterFailures < 1) {
    throw new Error('Invalid backoff policy: startAfterFailures must be an integer >= 1');
  }
  if (p.jitterRatio < 0 || p.jitterRatio > 1) {
    throw new Error('Invalid backoff policy: jitterRatio must be between 0 and 1');
  }
  return p;
}

/** Delay in ms for the given number of consecutive failures (0 below the threshold). */
export function backoffDelayMs(failures: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  if (failures < policy.startAfterFailures) return 0;
  const exponent = failures - policy.startAfterFailures;
  const raw = Math.min(policy.maxMs, policy.baseMs * Math.pow(policy.factor, exponent));
  // Jitter only shortens the delay, so maxMs is a hard ceiling.
  const jittered = raw * (1 - policy.jitterRatio * random());
  return Math.max(1, Math.round(jittered));
}

export class KeeperBackoff {
  private readonly policy: BackoffPolicy;
  private readonly store: BackoffStateStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly opts: BackoffOptions;
  private state: BackoffState = { ...EMPTY };
  private loaded = false;

  constructor(opts: BackoffOptions = {}) {
    this.opts = opts;
    this.policy = validatePolicy({ ...DEFAULT_BACKOFF_POLICY, ...opts.policy });
    this.store = opts.store ?? new InMemoryBackoffStore();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /** Restores persisted state. Corrupt or implausible state is repaired, never trusted blindly. */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let stored: BackoffState | null = null;
    try {
      stored = await this.store.load();
    } catch {
      stored = null; // an unreadable store must not stop the keeper
    }
    if (!stored) return;

    const failures = Number.isFinite(stored.consecutiveFailures) ? Math.max(0, Math.floor(stored.consecutiveFailures)) : 0;
    const now = this.now();
    let nextAttemptAt = Number.isFinite(stored.nextAttemptAt) ? stored.nextAttemptAt : 0;
    // A clock that moved backwards (or bad data) must not park the keeper for hours.
    nextAttemptAt = Math.min(nextAttemptAt, now + this.policy.maxMs);
    this.state = {
      consecutiveFailures: failures,
      nextAttemptAt: Math.max(0, nextAttemptAt),
      lastError: typeof stored.lastError === 'string' ? stored.lastError : undefined,
      updatedAt: Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0,
    };
  }

  getState(): BackoffState {
    return { ...this.state };
  }

  /** Milliseconds the keeper must still wait (0 = may run now). */
  remainingMs(): number {
    return Math.max(0, this.state.nextAttemptAt - this.now());
  }

  async recordSuccess(): Promise<void> {
    const previous = this.state.consecutiveFailures;
    if (previous === 0 && this.state.nextAttemptAt === 0) return;
    this.state = { consecutiveFailures: 0, nextAttemptAt: 0, updatedAt: this.now() };
    await this.persist();
    if (previous >= this.policy.startAfterFailures) this.opts.onRecover?.({ afterFailures: previous });
  }

  async recordFailure(error: unknown): Promise<number> {
    const now = this.now();
    const failures = this.state.consecutiveFailures + 1;
    const delayMs = backoffDelayMs(failures, this.policy, this.random);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    this.state = {
      consecutiveFailures: failures,
      nextAttemptAt: delayMs > 0 ? now + delayMs : 0,
      lastError: message,
      updatedAt: now,
    };
    await this.persist();
    if (delayMs > 0) {
      this.opts.onBackoff?.({ failures, delayMs, nextAttemptAt: this.state.nextAttemptAt, error: message });
    }
    return delayMs;
  }

  /**
   * One keeper tick. Skips the task entirely while backing off (no RPC call, no extra failure
   * counted); otherwise runs it and records the outcome. Never throws for task errors.
   */
  async tick<T>(task: () => Promise<T>): Promise<TickResult<T>> {
    await this.init();
    const waitMs = this.remainingMs();
    if (waitMs > 0) return { ran: false, waitMs };
    try {
      const value = await task();
      await this.recordSuccess();
      return { ran: true, ok: true, value };
    } catch (error) {
      const delayMs = await this.recordFailure(error);
      return { ran: true, ok: false, error, delayMs };
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.state);
    } catch {
      // Losing durability must not crash the keeper; the in-memory state still applies.
    }
  }
}