/**
 * Write pacing for keepers.
 *
 * A keeper that submits transactions as fast as it discovers work will trip
 * the RPC node's own rate limits during busy periods, turning a burst of work
 * into a burst of self-inflicted failures. This limiter paces the *starts* of
 * writes and caps how many may be in flight at once, so a backlog is drained
 * steadily instead of all at once.
 */

export interface WriteRateLimiterOptions {
  /** Minimum spacing between the start of two writes, in milliseconds. */
  minIntervalMs?: number;
  /** Maximum number of writes allowed to run concurrently. Default 1. */
  maxConcurrent?: number;
  /** Maximum queued writes; further submissions are rejected. Default 1000. */
  maxQueue?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep, injectable for tests. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WriteRateLimiterStats {
  /** Writes accepted into the queue. */
  submitted: number;
  /** Writes that resolved successfully. */
  completed: number;
  /** Writes that rejected. */
  failed: number;
  /** Submissions rejected because the queue was full. */
  rejected: number;
  /** Starts that had to wait for the pacing interval. */
  throttled: number;
  /** Writes currently executing. */
  inFlight: number;
  /** Writes waiting to start. */
  queued: number;
}

interface QueueEntry<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WriteRateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly queue: QueueEntry<unknown>[] = [];
  private inFlight = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private draining = false;

  private submitted = 0;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private throttled = 0;

  constructor(options: WriteRateLimiterOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.maxQueue = options.maxQueue ?? 1000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;

    if (this.minIntervalMs < 0) {
      throw new Error('minIntervalMs must be non-negative');
    }
    if (this.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be at least 1');
    }
    if (this.maxQueue < 1) {
      throw new Error('maxQueue must be at least 1');
    }
  }

  /**
   * Queue a write. Resolves with the task's result, or rejects if the task
   * throws or the queue is full.
   */
  schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.maxQueue) {
      this.rejected += 1;
      return Promise.reject(new Error(`write rate limiter queue is full (${this.maxQueue})`));
    }

    this.submitted += 1;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as QueueEntry<unknown>);
      void this.drain();
    });
  }

  /** Current counters. */
  stats(): WriteRateLimiterStats {
    return {
      submitted: this.submitted,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
      throttled: this.throttled,
      inFlight: this.inFlight,
      queued: this.queue.length,
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0 && this.inFlight < this.maxConcurrent) {
        const wait = this.minIntervalMs - (this.now() - this.lastStart);
        if (wait > 0) {
          this.throttled += 1;
          await this.sleep(wait);
        }
        const entry = this.queue.shift();
        if (!entry) {
          break;
        }
        this.lastStart = this.now();
        this.inFlight += 1;
        this.run(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  private run(entry: QueueEntry<unknown>): void {
    entry
      .task()
      .then((value) => {
        this.completed += 1;
        entry.resolve(value);
      })
      .catch((error) => {
        this.failed += 1;
        entry.reject(error);
      })
      .finally(() => {
        this.inFlight -= 1;
        void this.drain();
      });
  }
}
