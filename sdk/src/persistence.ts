/**
 * Durable keeper state.
 *
 * An off-chain keeper is a long-running process that follows the chain: it
 * polls the RPC, decides what to do, and does it.  The only thing that makes
 * it "the same keeper" across a restart is *where it was*.  Without durable
 * state a restart means either replaying history (re-running side effects
 * that already happened) or losing the position entirely (skipping work that
 * still has to happen).
 *
 * This module provides the small amount of machinery needed to make a keeper
 * restartable:
 *
 * - {@link KeeperCheckpoint} — the snapshot of "where the keeper is".
 * - {@link CheckpointStore} — the persistence contract (load / save / clear).
 * - {@link FileCheckpointStore} — a durable, crash-safe JSON file store.
 * - {@link MemoryCheckpointStore} — an in-memory store for tests and for
 *   deployments that deliberately run ephemerally.
 *
 * The checkpoint records the **ledger the keeper resumes from**.  That resume
 * point is an *exclusive* lower bound, so a keeper that restarts picks up
 * exactly one ledger after the last one it consumed: no gap, no replay.
 *
 * ## Usage
 *
 * ```ts
 * const store = new FileCheckpointStore('./state/keeper.json');
 *
 * const listener = new ContractEventListener(server, {
 *   startLedger: 0,          // ignored when a checkpoint exists
 *   store,                   // ← durable state
 * });
 *
 * listener.start(5_000);     // restores from the checkpoint, then resumes
 * ```
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Version of the checkpoint format written by this module.
 *
 * A checkpoint written by a *newer* version is refused rather than
 * misinterpreted; older versions are migrated forward by
 * {@link normalizeCheckpoint}.
 */
export const CHECKPOINT_VERSION = 1;

/**
 * A snapshot of the state a keeper needs to resume exactly where it stopped.
 */
export interface KeeperCheckpoint {
  /** Format version of this checkpoint. */
  version: number;
  /**
   * The ledger the keeper resumes from — an *exclusive* lower bound, i.e. the
   * first ledger that has **not** been processed yet.
   */
  nextLedger: number;
  /**
   * The highest ledger the keeper has fully consumed, i.e. `nextLedger - 1`.
   * `-1` means "nothing processed yet".
   */
  lastProcessedLedger: number;
  /** Wall-clock time (ms since the epoch) the checkpoint was written. */
  updatedAt: number;
  /** Optional component-specific counters kept alongside the position. */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Persistence contract for keeper checkpoints.
 *
 * Implementations must make {@link save} durable before it resolves: a keeper
 * that crashes right after `save()` returned must come back with the state
 * that was written, not the state before it.
 */
export interface CheckpointStore {
  /** Read the stored checkpoint, or `null` when nothing was stored yet. */
  load(): Promise<KeeperCheckpoint | null>;
  /** Durably store a checkpoint, replacing any previous one. */
  save(checkpoint: KeeperCheckpoint): Promise<void>;
  /** Remove the stored checkpoint. Clearing a missing checkpoint is a no-op. */
  clear(): Promise<void>;
}

/** Raised when a checkpoint cannot be read, written, or understood. */
export class CheckpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'CheckpointError';
    if (options && 'cause' in options) {
      // `cause` is not in the ES2020 lib this package targets.
      (this as unknown as { cause?: unknown }).cause = options.cause;
    }
  }
}

function isLedgerSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Type guard for a structurally valid checkpoint.
 *
 * Only the fields the keeper relies on are checked; unknown extra fields are
 * tolerated so a newer writer can add information without breaking an older
 * reader.
 */
export function isKeeperCheckpoint(value: unknown): value is KeeperCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<KeeperCheckpoint>;
  return (
    isLedgerSequence(candidate.version) &&
    isLedgerSequence(candidate.nextLedger) &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt)
  );
}

/**
 * Validate and migrate a raw checkpoint read from storage.
 *
 * `lastProcessedLedger` is always derived from `nextLedger` so the two can
 * never disagree — a keeper that trusts them blindly cannot end up with an
 * inconsistent position.
 *
 * @throws {CheckpointError} when the payload is unusable. Callers that want a
 *   best-effort restart should catch the error and fall back to a known-good
 *   start ledger rather than crashing.
 */
export function normalizeCheckpoint(raw: unknown): KeeperCheckpoint {
  if (!isKeeperCheckpoint(raw)) {
    throw new CheckpointError('checkpoint payload is malformed');
  }

  if (raw.version > CHECKPOINT_VERSION) {
    throw new CheckpointError(
      `checkpoint version ${raw.version} is newer than the supported version ${CHECKPOINT_VERSION}`,
    );
  }

  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined;

  return {
    version: CHECKPOINT_VERSION,
    nextLedger: raw.nextLedger,
    lastProcessedLedger: raw.nextLedger - 1,
    updatedAt: raw.updatedAt,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Build a checkpoint for a given resume point.
 *
 * @param nextLedger The ledger the keeper should resume from (exclusive lower
 *   bound). `0` means "start at the very beginning".
 * @param updatedAt Wall-clock time the checkpoint was written.
 * @param metadata Optional component-specific counters.
 */
export function createCheckpoint(
  nextLedger: number,
  updatedAt: number,
  metadata?: Record<string, string | number | boolean>,
): KeeperCheckpoint {
  if (!isLedgerSequence(nextLedger)) {
    throw new CheckpointError('nextLedger must be a non-negative integer');
  }
  if (!Number.isFinite(updatedAt)) {
    throw new CheckpointError('updatedAt must be a finite timestamp');
  }
  return {
    version: CHECKPOINT_VERSION,
    nextLedger,
    lastProcessedLedger: nextLedger - 1,
    updatedAt,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Build a checkpoint that carries component state only.
 *
 * Some keepers are not ledger-driven — an auto-rebalancer, for example, is
 * driven by wall-clock time (its cooldown) rather than by a ledger position.
 * Such keepers still need their state to survive a restart, so they store it
 * in the checkpoint's `metadata` bag and leave the ledger position empty.
 *
 * @param updatedAt Wall-clock time the checkpoint was written.
 * @param metadata Component state to persist.
 */
export function createStateCheckpoint(
  updatedAt: number,
  metadata: Record<string, string | number | boolean>,
): KeeperCheckpoint {
  return createCheckpoint(0, updatedAt, metadata);
}

/**
 * An in-memory checkpoint store.
 *
 * Useful in tests and for keepers that are intentionally stateless between
 * runs.  It implements the same contract as {@link FileCheckpointStore},
 * including the "save is durable before it resolves" guarantee.
 */
export class MemoryCheckpointStore implements CheckpointStore {
  private checkpoint: KeeperCheckpoint | null = null;

  /** Number of times {@link save} was called — handy in assertions. */
  saves = 0;

  /** Number of times {@link load} was called — handy in assertions. */
  loads = 0;

  async load(): Promise<KeeperCheckpoint | null> {
    this.loads += 1;
    return this.checkpoint ? { ...this.checkpoint } : null;
  }

  async save(checkpoint: KeeperCheckpoint): Promise<void> {
    this.saves += 1;
    this.checkpoint = { ...checkpoint };
  }

  async clear(): Promise<void> {
    this.checkpoint = null;
  }

  /** The stored checkpoint, or `null`. Handy for assertions. */
  peek(): KeeperCheckpoint | null {
    return this.checkpoint ? { ...this.checkpoint } : null;
  }
}

/**
 * A checkpoint store backed by a JSON file on disk.
 *
 * Writes are atomic: the payload is written to a sibling temporary file and
 * then renamed over the target.  A crash (or a `kill -9`) in the middle of a
 * write therefore leaves the previous checkpoint intact instead of a
 * half-written file, which is what makes a restart after an outage safe.
 *
 * ```ts
 * const store = new FileCheckpointStore('./state/keeper.json');
 * await store.save(createCheckpoint(1234, Date.now()));
 * ```
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly filePath: string;
  private readonly tempPath: string;

  /**
   * @param filePath Where the checkpoint is stored. Missing parent
   *   directories are created on save.
   */
  constructor(filePath: string) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new CheckpointError('checkpoint file path must be a non-empty string');
    }
    this.filePath = path.resolve(filePath);
    this.tempPath = `${this.filePath}.tmp`;
  }

  /** Absolute path of the checkpoint file. */
  get path(): string {
    return this.filePath;
  }

  async load(): Promise<KeeperCheckpoint | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new CheckpointError(`unable to read checkpoint at ${this.filePath}`, { cause: err });
    }

    // A zero-length file is treated as "nothing stored yet" — some ops
    // scripts create the file up front with `touch`.
    if (raw.trim().length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CheckpointError(`checkpoint at ${this.filePath} is not valid JSON`, { cause: err });
    }

    return normalizeCheckpoint(parsed);
  }

  async save(checkpoint: KeeperCheckpoint): Promise<void> {
    if (!isKeeperCheckpoint(checkpoint)) {
      throw new CheckpointError('refusing to persist a malformed checkpoint');
    }

    const payload = `${JSON.stringify(
      { ...normalizeCheckpoint(checkpoint), version: CHECKPOINT_VERSION },
      null,
      2,
    )}\n`;
    const directory = path.dirname(this.filePath);

    try {
      await fs.mkdir(directory, { recursive: true });
      // Write-then-rename: the rename is atomic on POSIX file systems, so a
      // crash never leaves a partially written checkpoint behind.
      await fs.writeFile(this.tempPath, payload, 'utf8');
      await fs.rename(this.tempPath, this.filePath);
    } catch (err) {
      // Best effort cleanup; the previous checkpoint is still intact.
      await this.removeTemp();
      throw new CheckpointError(`unable to write checkpoint at ${this.filePath}`, { cause: err });
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if (!isNotFound(err)) {
        throw new CheckpointError(`unable to clear checkpoint at ${this.filePath}`, { cause: err });
      }
    }
    await this.removeTemp();
  }

  private async removeTemp(): Promise<void> {
    try {
      await fs.unlink(this.tempPath);
    } catch {
      // The temp file may not exist — nothing to clean up.
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
