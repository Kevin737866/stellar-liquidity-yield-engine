/**
 * Durable exponential backoff for keeper loops.
 *
 * After repeated consecutive failures a keeper skips its ticks until `nextAttemptAt`, so a
 * flapping keeper stops hammering the RPC during an outage. The state is persisted through a
 * store, so a restart during the outage does not reset the delay.
 *
 * Staged rollout support: a keeper running a new strategy version can be placed in a rollout
 * stage (e.g. canary -> partial -> full) that gates which keepers are allowed to execute the
 * new version, and can be promoted or rolled back deterministically. Keepers outside the
 * current stage keep running the previous version. Stage membership is derived from a stable
 * hash of the keeper id, so the same keeper always lands in the same bucket for a given rollout.
 *
 * Key rotation note: backoff state is independent of signing keys. Rotating a keeper signing
 * key does not require clearing backoff state; a keeper that is mid-backoff should simply
 * continue to honor `nextAttemptAt` after the new key is loaded, and the first successful
 * tick with the new key resets the counters via `recordSuccess()`.
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

/* ------------------------------------------------------------------------------------------ */
/* Staged rollout                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Named rollout stages, in increasing exposure order. */
export type RolloutStage = 'disabled' | 'canary' | 'partial' | 'full';

/** Percentage of keepers (0-100) that run the new version in each stage. */
export const ROLLOUT_STAGE_PERCENT: Record<RolloutStage, number> = {
  disabled: 0,
  canary: 5,
  partial: 50,
  full: 100,
};

const STAGE_ORDER: readonly RolloutStage[] = ['disabled', 'canary', 'partial', 'full'];

export interface RolloutPlan {
  /** Identifier of the strategy version being rolled out, e.g. "v2". */
  version: string;
  /** Current stage. */
  stage: RolloutStage;
  /** Epoch ms of the last stage change (0 = never changed). */
  updatedAt: number;
}

export interface RolloutStateStore {
  load(): Promise<RolloutPlan | null>;
  save(plan: RolloutPlan): Promise<void>;
}

export class InMemoryRolloutStore implements RolloutStateStore {
  private plan: RolloutPlan | null = null;
  async load() {
    return this.plan ? { ...this.plan } : null;
  }
  async save(plan: RolloutPlan) {
    this.plan = { ...plan };
  }
}

/**
 * Stable bucket in [0, 100) for a keeper id, using FNV-1a. Deterministic across processes so a
 * keeper's rollout membership does not change on restart.
 */
export function rolloutBucket(keeperId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < keeperId.length; i++) {
    hash ^= keeperId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/** Returns true if the given keeper should run the rollout version at the given stage. */
export function isInRolloutStage(keeperId: string, stage: RolloutStage): boolean {
  if (!keeperId) throw new Error('keeperId is required for rollout selection');
  return rolloutBucket(keeperId) < ROLLOUT_STAGE_PERCENT[stage];
}

/** Validates a version string and stage value. */
export function validateRolloutPlan(plan: RolloutPlan): RolloutPlan {
  if (typeof plan.version !== 'string' || plan.version.trim() === '') {
    throw new Error('Invalid rollout plan: version must be a non-empty string');
  }
  if (!STAGE_ORDER.includes(plan.stage)) {
    throw new Error(`Invalid rollout plan: unknown stage "${String(plan.stage)}"`);
  }
  return plan;
}

export interface RolloutOptions {
  store?: RolloutStateStore;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  onStageChange?: (info: { version: string; from: RolloutStage; to: RolloutStage }) => void;
}

/**
 * Drives a staged rollout of a new strategy version. Promotion moves one stage forward at a time;
 * rollback returns straight to `disabled`, so the previous version is always the safe default.
 */
export class StagedRollout {
  private readonly store: RolloutStateStore;
  private readonly now: () => number;
  private readonly opts: RolloutOptions;
  private plan: RolloutPlan;
  private loaded = false;

  constructor(version: string, opts: RolloutOptions = {}) {
    this.opts = opts;
    this.store = opts.store ?? new InMemoryRolloutStore();
    this.now = opts.now ?? Date.now;
    this.plan = validateRolloutPlan({ version, stage: 'disabled', updatedAt: 0 });
  }

  /**
   * Restores persisted plan. An unreadable store, or a stored plan for a different version,
   * falls back to the default `disabled` plan so the keeper stays on the previous version.
   */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let stored: RolloutPlan | null = null;
    try {
      stored = await this.store.load();
    } catch {
      stored = null;
    }
    if (!stored) return;
    try {
      const valid = validateRolloutPlan(stored);
      if (valid.version !== this.plan.version) return;
      this.plan = {
        version: valid.version,
        stage: valid.stage,
        updatedAt: Number.isFinite(valid.updatedAt) ? valid.updatedAt : 0,
      };
    } catch {
      // corrupt persisted plan: keep the safe default
    }
  }

  getPlan(): RolloutPlan {
    return { ...this.plan };
  }

  /** Whether the given keeper should run the new version right now. */
  shouldUseNewVersion(keeperId: string): boolean {
    return isInRolloutStage(keeperId, this.plan.stage);
  }

  /** Advances exactly one stage. Throws if already at `full`. */
  async promote(): Promise<RolloutPlan> {
    await this.init();
    const idx = STAGE_ORDER.indexOf(this.plan.stage);
    if (idx === STAGE_ORDER.length - 1) {
      throw new Error('Cannot promote: rollout is already at the full stage');
    }
    return this.setStage(STAGE_ORDER[idx + 1]);
  }

  /** Immediately returns all keepers to the previous version. */
  async rollback(): Promise<RolloutPlan> {
    await this.init();
    if (this.plan.stage === 'disabled') return this.getPlan();
    return this.setStage('disabled');
  }

  private async setStage(to: RolloutStage): Promise<RolloutPlan> {
    const from = this.plan.stage;
    this.plan = { version: this.plan.version, stage: to, updatedAt: this.now() };
    await this.persist();
    this.opts.onStageChange?.({ version: this.plan.version, from, to });
    return this.getPlan();
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.plan);
    } catch {
      // Losing durability must not crash the keeper; in-memory plan still applies.
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Backoff                                                                                     */
/* ------------------------------------------------------------------------------------------ */

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
    const failures = this.state.consecutiveFailures + 1;
    const message = error instanceof Error ? error.message : String(error);
    const delayMs = backoffDelayMs(failures, this.policy, this.random);
    const now = this.now();
    const nextAttemptAt = delayMs > 0 ? now + delayMs : 0;
    this.state = { consecutiveFailures: failures, nextAttemptAt, lastError: message, updatedAt: now };
    await this.persist();
    if (delayMs > 0) this.opts.onBackoff?.({ failures, delayMs, nextAttemptAt, error: message });
    return delayMs;
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.state);
    } catch {
      // Losing durability must not crash the keeper; in-memory state still applies.
    }
  }
}