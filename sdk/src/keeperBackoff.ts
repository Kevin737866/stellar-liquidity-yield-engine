/**
 * Durable exponential backoff for keeper loops.
 *
 * After repeated consecutive failures a keeper skips its ticks until `nextAttemptAt`, so a
 * flapping keeper stops hammering the RPC during an outage. The state is persisted through a
 * store, so a restart during the outage does not reset the delay.
 *
 * Key rotation note: backoff state is independent of signing keys. Rotating a keeper signing
 * key does not require clearing backoff state; a keeper that is mid-backoff should simply
 * continue to honor `nextAttemptAt` after the new key is loaded, and the first successful
 * tick with the new key resets the counters via `recordSuccess()`.
 *
 * Pause reason catalog: operators may supply a catalog of named pause reasons (for example
 * `rpc-outage`, `maintenance`) through `BackoffOptions.pauseReasons` or `setPauseReasonCatalog()`.
 * A keeper can then be paused with a reason code that must exist in the catalog. Unknown codes
 * are rejected rather than silently accepted, so typos in operator tooling fail loudly.
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

/** Pattern for pause reason codes: lowercase letters, digits, and hyphens, 1-64 chars. */
const PAUSE_REASON_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Catalog code identifying why a keeper is paused, e.g. `rpc-outage`. */
export type PauseReason = string;

export interface PauseReasonEntry {
  /** Stable machine-readable code, e.g. `rpc-outage`. */
  code: string;
  /** Human-readable description shown to operators. */
  description: string;
}

export interface PauseState {
  /** Catalog code of the active pause. */
  reason: string;
  /** Epoch ms when the pause was applied. */
  pausedAt: number;
}

export interface BackoffState {
  consecutiveFailures: number;
  /** Epoch ms before which the keeper must not call the RPC again (0 = no wait). */
  nextAttemptAt: number;
  lastError?: string;
  updatedAt: number;
  /** Active operator pause, if any. Persisted so pauses survive restarts. */
  pause?: PauseState;
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
  /** Operator-configurable pause reason catalog. Empty or omitted means no reasons are valid. */
  pauseReasons?: PauseReasonEntry[];
  onBackoff?: (info: { failures: number; delayMs: number; nextAttemptAt: number; error: string }) => void;
  onRecover?: (info: { afterFailures: number }) => void;
  onPause?: (info: { reason: string; pausedAt: number }) => void;
  onResume?: (info: { reason: string }) => void;
}

export type TickResult<T> =
  | { ran: true; ok: true; value: T }
  | { ran: true; ok: false; error: unknown; delayMs: number }
  | { ran: false; waitMs: number }
  | { ran: false; paused: true; reason: string };

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

/**
 * Validates a pause reason catalog. Codes must match the allowed pattern and be unique;
 * descriptions must be non-empty. Returns a frozen, normalized copy.
 */
export function validatePauseReasonCatalog(entries: PauseReasonEntry[]): ReadonlyArray<PauseReasonEntry> {
  const seen = new Set<string>();
  const out: PauseReasonEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.code !== 'string' || !PAUSE_REASON_CODE.test(entry.code)) {
      throw new Error(`Invalid pause reason code: ${String(entry?.code)}`);
    }
    if (seen.has(entry.code)) {
      throw new Error(`Duplicate pause reason code: ${entry.code}`);
    }
    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      throw new Error(`Pause reason ${entry.code} needs a non-empty description`);
    }
    seen.add(entry.code);
    out.push({ code: entry.code, description: entry.description.trim() });
  }
  return Object.freeze(out);
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
  private catalog: ReadonlyArray<PauseReasonEntry>;
  private state: BackoffState = { ...EMPTY };
  private loaded = false;

  constructor(opts: BackoffOptions = {}) {
    this.opts = opts;
    this.policy = validatePolicy({ ...DEFAULT_BACKOFF_POLICY, ...opts.policy });
    this.store = opts.store ?? new InMemoryBackoffStore();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.catalog = validatePauseReasonCatalog(opts.pauseReasons ?? []);
  }

  /** Returns the currently configured pause reason catalog. */
  getPauseReasonCatalog(): ReadonlyArray<PauseReasonEntry> {
    return this.catalog;
  }

  /**
   * Replaces the pause reason catalog at runtime (e.g. after an operator edits config).
   * If the active pause refers to a code no longer in the catalog, the pause is kept so the
   * keeper stays halted, but `getState().pause` still reports the stale code for visibility.
   */
  setPauseReasonCatalog(entries: PauseReasonEntry[]): void {
    this.catalog = validatePauseReasonCatalog(entries);
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
      pause: this.sanitizePause(stored.pause),
    };
  }

  getState(): BackoffState {
    return { ...this.state, pause: this.state.pause ? { ...this.state.pause } : undefined };
  }

  /** Milliseconds the keeper must still wait (0 = may run now). */
  remainingMs(): number {
    return Math.max(0, this.state.nextAttemptAt - this.now());
  }

  /** Whether an operator pause is active. */
  isPaused(): boolean {
    return this.state.pause !== undefined;
  }

  /**
   * Pauses the keeper under a catalog reason. Rejects codes not in the catalog so that
   * operator tooling cannot persist unrecognized reasons.
   */
  async pause(reason: string): Promise<void> {
    await this.init();
    if (!this.catalog.some((e) => e.code === reason)) {
      throw new Error(`Unknown pause reason: ${reason}`);
    }
    const pausedAt = this.now();
    this.state = { ...this.state, pause: { reason, pausedAt }, updatedAt: pausedAt };
    await this.persist();
    this.opts.onPause?.({ reason, pausedAt });
  }

  /** Clears an active pause. Returns false if the keeper was not paused. */
  async resume(): Promise<boolean> {
    await this.init();
    const pause = this.state.pause;
    if (!pause) return false;
    this.state = { ...this.state, pause: undefined, updatedAt: this.now() };
    await this.persist();
    this.opts.onResume?.({ reason: pause.reason });
    return true;
  }

  async recordSuccess(): Promise<void> {
    const previous = this.state.consecutiveFailures;
    if (previous === 0 && this.state.nextAttemptAt === 0) return;
    this.state = { ...this.state, consecutiveFailures: 0, nextAttemptAt: 0, lastError: undefined, updatedAt: this.now() };
    await this.persist();
    if (previous >= this.policy.startAfterFailures) this.opts.onRecover?.({ afterFailures: previous });
  }

  async recordFailure(error: unknown): Promise<number> {
    const now = this.now();
    const failures = this.state.consecutiveFailures + 1;
    const delayMs = backoffDelayMs(failures, this.policy, this.random);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    this.state = {
      ...this.state,
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
   * One keeper tick. Skips the task entirely while paused or backing off (no RPC call, no extra
   * failure counted); otherwise runs it and records the outcome. Never throws for task errors.
   */
  async tick<T>(task: () => Promise<T>): Promise<TickResult<T>> {
    await this.init();
    if (this.state.pause) return { ran: false, paused: true, reason: this.state.pause.reason };
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
      await this.store.save(this.getState());
    } catch {
      // A failing store must not crash the keeper; state remains in memory.
    }
  }

  /**
   * Drops structurally invalid persisted pauses. A pause with a well-formed but no-longer-catalogued
   * code is kept as-is so the keeper stays halted; only malformed data is discarded.
   */
  private sanitizePause(pause: PauseState | undefined): PauseState | undefined {
    if (!pause || typeof pause !== 'object') return undefined;
    if (typeof pause.reason !== 'string' || pause.reason.trim() === '') return undefined;
    if (!Number.isFinite(pause.pausedAt)) return undefined;
    return { reason: pause.reason, pausedAt: pause.pausedAt };
  }
}
