import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EventListener,
  FileCursorStore,
  ListenerEvent,
  MemoryCursorStore,
} from './eventListener';
import { MemoryCheckpointStore } from './persistence';

const chain: ListenerEvent[] = [
  { id: 'a', ledger: 10 },
  { id: 'b', ledger: 10 },
  { id: 'c', ledger: 12 },
  { id: 'd', ledger: 15 },
];
const fetchEvents = jest.fn(async (start: number) => ({
  events: chain.filter((e) => e.ledger >= start),
  latestLedger: 20,
}));

beforeEach(() => fetchEvents.mockClear());

describe('EventListener resume', () => {
  it('processes everything on first run and persists the cursor', async () => {
    const store = new MemoryCursorStore();
    const seen: string[] = [];
    const l = new EventListener({ fetchEvents, store, startLedger: 5, handler: (e) => void seen.push(e.id) });
    expect(await l.poll()).toBe(4);
    expect(fetchEvents).toHaveBeenCalledWith(5);
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(store.load()).toBe(20);
  });

  it('does not reprocess from zero after restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-'));
    const file = path.join(dir, 'cursor.json');
    const first: string[] = [];
    await new EventListener({
      fetchEvents, store: new FileCursorStore(file), handler: (e) => void first.push(e.id),
    }).poll();

    // "Restart": new listener and new store instance over the same file.
    const second: string[] = [];
    const restarted = new EventListener({
      fetchEvents, store: new FileCursorStore(file), handler: (e) => void second.push(e.id),
    });
    expect(restarted.nextLedger).toBe(21);
    expect(await restarted.poll()).toBe(0);
    expect(second).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replays only the unfinished ledger after a mid-run crash', async () => {
    const store = new MemoryCursorStore();
    const crashing = new EventListener({
      fetchEvents,
      store,
      handler: (e) => {
        if (e.id === 'd') throw new Error('crash');
      },
    });
    await expect(crashing.poll()).rejects.toThrow('crash');
    expect(store.load()).toBe(12);

    const seen: string[] = [];
    await new EventListener({ fetchEvents, store, handler: (e) => void seen.push(e.id) }).poll();
    expect(seen).toEqual(['d']);
  });

  it('falls back to startLedger when the cursor file is missing or corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-'));
    const file = path.join(dir, 'cursor.json');
    fs.writeFileSync(file, '{not json');
    const l = new EventListener({ fetchEvents, store: new FileCursorStore(file), startLedger: 7, handler: () => {} });
    expect(l.nextLedger).toBe(7);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Durable state (checkpointing)
// ---------------------------------------------------------------------------

describe('durable state', () => {
  const VAULT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it('reports itself as non-persistent when no store is configured', () => {
    const { listener } = makeListener(undefined, []);
    expect(listener.isPersistent).toBe(false);
    expect(listener.restoredState).toBeNull();
    expect(listener.resumeLedger).toBeNull();
  });

  it('returns null / false from persist() / restore() without a store', async () => {
    const { listener } = makeListener(undefined, []);
    expect(await listener.persist()).toBeNull();
    expect(await listener.restore()).toBe(false);
  });

  it('writes a checkpoint after every successful poll', async () => {
    const store = new MemoryCheckpointStore();
    const source = stubSource([], 120);
    const listener = new ContractEventListener(source, {
      startLedger: 100,
      store,
      now: () => 42,
    });

    await listener.poll();

    const checkpoint = store.peek()!;
    expect(checkpoint.nextLedger).toBe(121);
    expect(checkpoint.lastProcessedLedger).toBe(120);
    expect(checkpoint.updatedAt).toBe(42);
  });

  it('does not write a checkpoint after a failed poll', async () => {
    const store = new MemoryCheckpointStore();
    const failing: EventSource = {
      async getEvents() {
        throw new Error('boom');
      },
    };
    const listener = new ContractEventListener(failing, { startLedger: 100, store });
    listener.onError(() => {});

    await listener.poll();

    expect(store.saves).toBe(0);
    expect(store.peek()).toBeNull();
  });

  it('restores the cursor before the first poll', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 250,
      lastProcessedLedger: 249,
      updatedAt: 0,
    });

    const source = stubSource([], 260);
    const listener = new ContractEventListener(source, { startLedger: 100, store });

    await listener.poll();

    expect(source.lastRequest!.startLedger).toBe(250);
    expect(listener.currentLedger).toBe(261);
    expect(listener.resumeLedger).toBe(250);
    expect(listener.restoredState!.nextLedger).toBe(250);
  });

  it('does not restore twice', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 250,
      lastProcessedLedger: 249,
      updatedAt: 0,
    });
    const savesBefore = store.saves;

    const listener = new ContractEventListener(stubSource([], 260), {
      startLedger: 100,
      store,
    });

    await listener.poll();
    await listener.poll();

    // One restore + one write per poll.
    expect(store.loads).toBe(1);
    expect(store.saves - savesBefore).toBe(2);
  });

  it('can skip automatic restore with autoRestore: false', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 250,
      lastProcessedLedger: 249,
      updatedAt: 0,
    });

    const source = stubSource([], 260);
    const listener = new ContractEventListener(source, {
      startLedger: 100,
      store,
      autoRestore: false,
    });

    await listener.poll();

    expect(source.lastRequest!.startLedger).toBe(100);
  });

  it('can skip persistence with persistOnPoll: false', async () => {
    const store = new MemoryCheckpointStore();
    const listener = new ContractEventListener(stubSource([], 120), {
      startLedger: 100,
      store,
      persistOnPoll: false,
    });

    await listener.poll();

    expect(store.saves).toBe(0);
  });

  it('persists the configured metadata alongside the position', async () => {
    const store = new MemoryCheckpointStore();
    const listener = new ContractEventListener(stubSource([], 120), {
      startLedger: 100,
      store,
      checkpointMetadata: { keeper: 'vault-a', events: 7 },
    });

    await listener.poll();

    expect(store.peek()!.metadata).toEqual({ keeper: 'vault-a', events: 7 });
  });

  it('reports a failed checkpoint write through the error handler', async () => {
    const store = {
      load: async () => null,
      save: async () => {
        throw new Error('disk full');
      },
      clear: async () => undefined,
    };

    const listener = new ContractEventListener(stubSource([], 120), {
      startLedger: 100,
      store,
    });
    const errors: string[] = [];
    listener.onError((e) => errors.push(e.error.message));

    await listener.poll();

    expect(errors).toEqual(['disk full']);
    // The in-memory position still advanced.
    expect(listener.currentLedger).toBe(121);
  });
});

// ---------------------------------------------------------------------------
// Page-full cursor handling (no gaps while catching up)
// ---------------------------------------------------------------------------

describe('cursor advancement with a full page', () => {
  it('only advances past the events it actually consumed when the page is full', async () => {
    const events = [
      makeRaw('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', ['deposit'], 100),
      makeRaw('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', ['deposit'], 101),
    ];
    const source = stubSource(events, 500); // head is far ahead
    const listener = new ContractEventListener(source, { startLedger: 100, pageSize: 2 });

    await listener.poll();

    // The page was full, so there may be more events waiting: the cursor must
    // stop after the highest consumed event, not jump to the node's head.
    expect(listener.currentLedger).toBe(102);
  });

  it('jumps to the head once the page is not full', async () => {
    const events = [
      makeRaw('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', ['deposit'], 100),
    ];
    const source = stubSource(events, 500);
    const listener = new ContractEventListener(source, { startLedger: 100, pageSize: 2 });

    await listener.poll();

    expect(listener.currentLedger).toBe(501);
  });
});
