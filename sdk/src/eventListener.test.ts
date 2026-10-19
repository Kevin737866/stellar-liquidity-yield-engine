import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EventListener,
  FileCursorStore,
  ListenerEvent,
  MemoryCursorStore,
} from './eventListener';

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
