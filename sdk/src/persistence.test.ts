/**
 * Unit tests for the durable keeper state (checkpointing).
 *
 * Covered:
 * - Checkpoint construction and validation
 * - Migration / normalisation of stored payloads
 * - The in-memory store contract
 * - The file store: round-trip, atomic writes, missing file, corrupt file
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CHECKPOINT_VERSION,
  CheckpointError,
  FileCheckpointStore,
  MemoryCheckpointStore,
  createCheckpoint,
  createStateCheckpoint,
  isKeeperCheckpoint,
  normalizeCheckpoint,
} from './persistence';

describe('createCheckpoint', () => {
  it('derives the resume point and the last processed ledger from each other', () => {
    const checkpoint = createCheckpoint(120, 1_000);

    expect(checkpoint.version).toBe(CHECKPOINT_VERSION);
    expect(checkpoint.nextLedger).toBe(120);
    expect(checkpoint.lastProcessedLedger).toBe(119);
    expect(checkpoint.updatedAt).toBe(1_000);
  });

  it('keeps the metadata that was handed in', () => {
    const checkpoint = createCheckpoint(1, 0, { events: 12, label: 'keeper-a' });

    expect(checkpoint.metadata).toEqual({ events: 12, label: 'keeper-a' });
  });

  it('omits the metadata bag entirely when nothing was supplied', () => {
    expect(createCheckpoint(1, 0).metadata).toBeUndefined();
  });

  it('rejects a negative resume point', () => {
    expect(() => createCheckpoint(-1, 0)).toThrow(/non-negative/);
  });

  it('rejects a non-integer resume point', () => {
    expect(() => createCheckpoint(1.5, 0)).toThrow(/non-negative/);
  });

  it('rejects a non-finite timestamp', () => {
    expect(() => createCheckpoint(1, Number.NaN)).toThrow(/finite/);
  });
});

describe('createStateCheckpoint', () => {
  it('stores component state without claiming a ledger position', () => {
    const checkpoint = createStateCheckpoint(42, { lastExecutionTimeMs: 7 });

    expect(checkpoint.nextLedger).toBe(0);
    expect(checkpoint.lastProcessedLedger).toBe(-1);
    expect(checkpoint.metadata).toEqual({ lastExecutionTimeMs: 7 });
  });
});

describe('isKeeperCheckpoint', () => {
  it('accepts a well-formed checkpoint', () => {
    expect(isKeeperCheckpoint(createCheckpoint(10, 5))).toBe(true);
  });

  it('rejects non-objects and malformed payloads', () => {
    expect(isKeeperCheckpoint(null)).toBe(false);
    expect(isKeeperCheckpoint(undefined)).toBe(false);
    expect(isKeeperCheckpoint('nope')).toBe(false);
    expect(isKeeperCheckpoint({ version: 1 })).toBe(false);
    expect(isKeeperCheckpoint({ version: 1, nextLedger: -1, updatedAt: 0 })).toBe(false);
  });
});

describe('normalizeCheckpoint', () => {
  it('keeps a valid checkpoint and derives the last processed ledger', () => {
    const normalized = normalizeCheckpoint({
      version: CHECKPOINT_VERSION,
      nextLedger: 50,
      lastProcessedLedger: -999, // inconsistent on purpose
      updatedAt: 1234,
    });

    expect(normalized.nextLedger).toBe(50);
    expect(normalized.lastProcessedLedger).toBe(49);
    expect(normalized.updatedAt).toBe(1234);
  });

  it('migrates an older version forward', () => {
    const normalized = normalizeCheckpoint({
      version: 0,
      nextLedger: 7,
      lastProcessedLedger: 6,
      updatedAt: 1,
    });

    expect(normalized.version).toBe(CHECKPOINT_VERSION);
    expect(normalized.nextLedger).toBe(7);
  });

  it('refuses a checkpoint written by a newer version', () => {
    expect(() =>
      normalizeCheckpoint({
        version: CHECKPOINT_VERSION + 1,
        nextLedger: 7,
        lastProcessedLedger: 6,
        updatedAt: 1,
      }),
    ).toThrow(/newer than the supported version/);
  });

  it('refuses a malformed payload', () => {
    expect(() => normalizeCheckpoint({ version: 1 })).toThrow(CheckpointError);
    expect(() => normalizeCheckpoint({ version: 1, nextLedger: 5 })).toThrow(/malformed/);
  });

  it('drops a metadata bag that is not an object', () => {
    const normalized = normalizeCheckpoint({
      version: CHECKPOINT_VERSION,
      nextLedger: 5,
      lastProcessedLedger: 4,
      updatedAt: 1,
      metadata: 'oops',
    });

    expect(normalized.metadata).toBeUndefined();
  });
});

describe('MemoryCheckpointStore', () => {
  it('returns null before anything was stored', async () => {
    const store = new MemoryCheckpointStore();
    expect(await store.load()).toBeNull();
  });

  it('round-trips a checkpoint', async () => {
    const store = new MemoryCheckpointStore();
    await store.save(createCheckpoint(42, 99));

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.nextLedger).toBe(42);
    expect(loaded!.lastProcessedLedger).toBe(41);
    expect(loaded!.updatedAt).toBe(99);
  });

  it('counts loads and saves', async () => {
    const store = new MemoryCheckpointStore();
    await store.load();
    await store.save(createCheckpoint(1, 1));

    expect(store.loads).toBe(1);
    expect(store.saves).toBe(1);
  });

  it('clears the stored checkpoint', async () => {
    const store = new MemoryCheckpointStore();
    await store.save(createCheckpoint(42, 99));
    await store.clear();

    expect(await store.load()).toBeNull();
    expect(store.peek()).toBeNull();
  });

  it('does not hand out a mutable reference to its state', async () => {
    const store = new MemoryCheckpointStore();
    await store.save(createCheckpoint(42, 99));

    const loaded = (await store.load())!;
    loaded.nextLedger = 1;

    expect((await store.load())!.nextLedger).toBe(42);
  });
});

describe('FileCheckpointStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keeper-checkpoint-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null when the checkpoint does not exist yet', async () => {
    const store = new FileCheckpointStore(path.join(dir, 'missing.json'));
    expect(await store.load()).toBeNull();
  });

  it('round-trips a checkpoint through the file system', async () => {
    const file = path.join(dir, 'keeper.json');
    const store = new FileCheckpointStore(file);

    await store.save(createCheckpoint(512, 1_700_000_000_000));

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.nextLedger).toBe(512);
    expect(loaded!.lastProcessedLedger).toBe(511);
    expect(loaded!.updatedAt).toBe(1_700_000_000_000);
  });

  it('survives a simulated crash: a new store reads what the old one wrote', async () => {
    const file = path.join(dir, 'keeper.json');

    const before = new FileCheckpointStore(file);
    await before.save(createCheckpoint(10, 1));

    // The process "restarts": a brand new store instance reads the file.
    const after = new FileCheckpointStore(file);
    expect((await after.load())!.nextLedger).toBe(10);
  });

  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'nested', 'deep', 'keeper.json');
    const store = new FileCheckpointStore(file);

    await store.save(createCheckpoint(3, 1));

    expect((await store.load())!.nextLedger).toBe(3);
  });

  it('leaves no temporary file behind after a successful save', async () => {
    const file = path.join(dir, 'keeper.json');
    const store = new FileCheckpointStore(file);

    await store.save(createCheckpoint(3, 1));

    await expect(fs.access(`${file}.tmp`)).rejects.toBeDefined();
  });

  it('overwrites the previous checkpoint atomically', async () => {
    const file = path.join(dir, 'keeper.json');
    const store = new FileCheckpointStore(file);

    await store.save(createCheckpoint(10, 1));
    await store.save(createCheckpoint(20, 2));

    const loaded = await store.load();
    expect(loaded!.nextLedger).toBe(20);
    expect(loaded!.updatedAt).toBe(2);
  });

  it('reports a corrupt checkpoint instead of silently ignoring it', async () => {
    const file = path.join(dir, 'keeper.json');
    await fs.writeFile(file, '{ this is not json', 'utf8');

    const store = new FileCheckpointStore(file);
    await expect(store.load()).rejects.toThrow(/not valid JSON/);
  });

  it('reports a checkpoint that is structurally invalid', async () => {
    const file = path.join(dir, 'keeper.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, nextLedger: 'nope' }), 'utf8');

    const store = new FileCheckpointStore(file);
    await expect(store.load()).rejects.toThrow(/malformed/);
  });

  it('treats an empty file as "nothing stored yet"', async () => {
    const file = path.join(dir, 'keeper.json');
    await fs.writeFile(file, '', 'utf8');

    const store = new FileCheckpointStore(file);
    expect(await store.load()).toBeNull();
  });

  it('clears the checkpoint and tolerates clearing a missing one', async () => {
    const file = path.join(dir, 'keeper.json');
    const store = new FileCheckpointStore(file);

    await store.save(createCheckpoint(10, 1));
    await store.clear();
    expect(await store.load()).toBeNull();

    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('refuses to persist a malformed checkpoint', async () => {
    const store = new FileCheckpointStore(path.join(dir, 'keeper.json'));
    await expect(
      store.save({ version: 1, nextLedger: -3, lastProcessedLedger: -4, updatedAt: 0 }),
    ).rejects.toThrow(/malformed/);
  });

  it('rejects an empty file path', () => {
    expect(() => new FileCheckpointStore('  ')).toThrow(/non-empty/);
  });
});
