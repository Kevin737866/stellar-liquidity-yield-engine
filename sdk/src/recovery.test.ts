/**
 * Restart-during-outage recovery scenarios.
 *
 * The keeper is made of three pieces that all have to remember where they
 * were:
 *
 * - the event listener (which ledger it has consumed),
 * - the RPC lag monitor (which ledger it has processed), and
 * - the auto-rebalancer (when it last executed).
 *
 * These tests walk a keeper through an outage: it runs, the process dies, the
 * chain moves on, a fresh process starts up and has to pick the work up
 * exactly where the dead one left it — without repeating a single event and
 * without skipping a single one.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ContractEventListener,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type RawContractEvent,
} from './eventListener';
import { FileCheckpointStore, MemoryCheckpointStore } from './persistence';
import { RpcLagMonitor } from './rpcSync';

const VAULT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

// ---------------------------------------------------------------------------
// A tiny in-memory chain to replay against
// ---------------------------------------------------------------------------

/**
 * A deterministic chain: events are appended per ledger, and the "node"
 * serves them from `startLedger` up, capped by `limit` — the same paging
 * contract the real Soroban RPC offers.
 */
class FakeChain {
  head = 0;
  readonly events: RawContractEvent[] = [];
  readonly requests: GetEventsRequest[] = [];

  /** Append one event to the chain and move the head to its ledger. */
  append(ledger: number, topic: string, contractId = VAULT): void {
    this.events.push({
      contractId,
      ledger,
      ledgerClosedAt: new Date(ledger * 5_000).toISOString(),
      topic: [topic],
      value: { ledger },
      // Unique and ordered, like the RPC's paging tokens.
      id: `${contractId}-${ledger}-${this.events.length}`,
    });
    this.head = Math.max(this.head, ledger);
  }

  /** Append `count` events, one per ledger, starting at `fromLedger`. */
  appendRange(fromLedger: number, count: number, topic = 'deposit'): void {
    for (let i = 0; i < count; i += 1) {
      this.append(fromLedger + i, topic);
    }
  }

  /** The RPC surface the listener talks to. */
  source(): EventSource {
    return {
      getEvents: async (request: GetEventsRequest): Promise<GetEventsResponse> => {
        this.requests.push(request);
        const limit = request.limit ?? 200;
        // Like Soroban RPC: a cursor resumes strictly after that event and
        // cannot be combined with startLedger.
        if (request.cursor !== undefined && request.startLedger !== undefined) {
          throw new Error('startLedger and cursor cannot both be set');
        }
        const remaining = request.cursor !== undefined
          ? this.events.slice(this.events.findIndex((e) => e.id === request.cursor) + 1)
          : this.events.filter((e) => e.ledger >= (request.startLedger ?? 0));
        const events = remaining.slice(0, limit);
        return { events, latestLedger: this.head };
      },
    };
  }
}

/** Collect the ledgers of every event the listener delivered. */
function collect(listener: ContractEventListener): number[] {
  const seen: number[] = [];
  listener.onRaw((e) => seen.push(e.ledger));
  return seen;
}

// ---------------------------------------------------------------------------
// Scenario: the keeper restarts in the middle of an outage
// ---------------------------------------------------------------------------

describe('restart during an outage', () => {
  it('resumes at the ledger it left off and catches up on everything it missed', async () => {
    const chain = new FakeChain();
    const store = new MemoryCheckpointStore();

    // --- Run 1: the keeper starts and follows the chain. ------------------
    chain.appendRange(100, 10); // ledgers 100..109
    const first = new ContractEventListener(chain.source(), {
      startLedger: 100,
      store,
    });

    const beforeOutage = collect(first);
    await first.poll();

    expect(beforeOutage).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(first.currentLedger).toBe(110);
    expect(store.peek()!.nextLedger).toBe(110);

    // --- The outage: the process dies and the chain moves on. --------------
    chain.appendRange(110, 40); // ledgers 110..149 happen while we are down

    // --- Run 2: a brand new process picks the work up. -------------------
    const second = new ContractEventListener(chain.source(), {
      startLedger: 0, // the operator's fallback; the checkpoint wins
      store,
    });

    const afterOutage = collect(second);
    await second.poll();

    // Resumed exactly where the dead process stopped — no replay.
    expect(chain.requests[1].startLedger).toBe(110);
    expect(afterOutage).toEqual(chain.events.filter((e) => e.ledger >= 110).map((e) => e.ledger));
    expect(afterOutage[0]).toBe(110);
    expect(afterOutage).toHaveLength(40);

    // ...and the position moved on.
    expect(second.currentLedger).toBe(150);
    expect(store.peek()!.nextLedger).toBe(150);
  });

  it('never re-delivers an event that was handled before the outage', async () => {
    const chain = new FakeChain();
    const store = new MemoryCheckpointStore();

    chain.appendRange(1, 5);
    const first = new ContractEventListener(chain.source(), { startLedger: 1, store });
    const beforeOutage = collect(first);
    await first.poll();

    chain.appendRange(6, 5);
    const second = new ContractEventListener(chain.source(), { startLedger: 1, store });
    const afterOutage = collect(second);
    await second.poll();

    const delivered = [...beforeOutage, ...afterOutage];
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('catches up across many pages without dropping or repeating an event', async () => {
    const chain = new FakeChain();
    const store = new MemoryCheckpointStore();

    // The keeper goes down after consuming one full page. A full page does
    // not mean the backlog is drained, so its cursor stops after the last
    // event it actually saw.
    chain.appendRange(1, 10);
    const first = new ContractEventListener(chain.source(), {
      startLedger: 1,
      store,
      pageSize: 4,
    });
    const beforeOutage = collect(first);
    await first.poll();

    expect(beforeOutage).toEqual([1, 2, 3, 4]);
    expect(first.currentLedger).toBe(5);
    expect(store.peek()!.nextLedger).toBe(5);

    // While it is down the chain advances by 50 ledgers.
    chain.appendRange(11, 50);

    const second = new ContractEventListener(chain.source(), {
      startLedger: 1,
      store,
      pageSize: 4,
    });
    const seen = collect(second);

    // Drain the backlog page by page.
    for (let i = 0; i < 30 && second.currentLedger <= 60; i += 1) {
      await second.poll();
    }

    expect(seen).toEqual(chain.events.filter((e) => e.ledger >= 5).map((e) => e.ledger));
    expect(second.currentLedger).toBe(61);

    // Nothing was dropped and nothing was delivered twice.
    const delivered = [...beforeOutage, ...seen];
    expect(delivered).toEqual(chain.events.map((e) => e.ledger));
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it('recovers the position from a checkpoint that outlived the process', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keeper-recovery-'));
    const file = path.join(dir, 'keeper.json');

    try {
      const chain = new FakeChain();
      chain.appendRange(200, 3);

      // First process: writes its position to disk.
      const first = new ContractEventListener(chain.source(), {
        startLedger: 200,
        store: new FileCheckpointStore(file),
      });
      await first.poll();
      expect(first.currentLedger).toBe(203);

      // Second process: a brand new store instance reads the same file.
      const second = new ContractEventListener(chain.source(), {
        startLedger: 0,
        store: new FileCheckpointStore(file),
      });
      await second.restore();

      expect(second.currentLedger).toBe(203);
      expect(second.resumeLedger).toBe(203);
      expect(second.restoredState!.nextLedger).toBe(203);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('honours a start ledger that is ahead of the checkpoint', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 100,
      lastProcessedLedger: 99,
      updatedAt: 0,
    });

    const listener = new ContractEventListener(
      { getEvents: async () => ({ events: [], latestLedger: 0 }) },
      { startLedger: 500, store },
    );
    await listener.restore();

    expect(listener.currentLedger).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Scenario: the checkpoint cannot be read
// ---------------------------------------------------------------------------

describe('an unreadable checkpoint', () => {
  it('reports the problem and starts from the configured ledger', async () => {
    const chain = new FakeChain();
    chain.appendRange(1, 3);

    const failingStore = {
      load: async () => {
        throw new Error('checkpoint is corrupt');
      },
      save: async () => undefined,
      clear: async () => undefined,
    };

    const listener = new ContractEventListener(chain.source(), {
      startLedger: 1,
      store: failingStore,
    });

    const errors: string[] = [];
    listener.onError((e) => errors.push(e.error.message));

    await listener.restore().catch(() => undefined);

    expect(errors).toHaveLength(0); // restore() reports through the caller
    expect(listener.currentLedger).toBe(1);
  });

  it('keeps the listener alive when the restore fails during start()', async () => {
    const chain = new FakeChain();
    chain.appendRange(1, 3);

    const failingStore = {
      load: async () => {
        throw new Error('checkpoint is corrupt');
      },
      save: async () => undefined,
      clear: async () => undefined,
    };

    const listener = new ContractEventListener(chain.source(), {
      startLedger: 1,
      store: failingStore,
    });

    const errors: string[] = [];
    listener.onError((e) => errors.push(e.error.message));

    const seen = collect(listener);
    listener.start(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    listener.stop();

    expect(errors.join(' ')).toMatch(/checkpoint is corrupt/);
    // The keeper still came back up and processed the chain.
    expect(seen).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Scenario: the RPC lag monitor comes back with the rest of the keeper
// ---------------------------------------------------------------------------

describe('the lag monitor after an outage', () => {
  it('restores the processed ledger instead of reporting a false critical lag', async () => {
    const store = new MemoryCheckpointStore();
    const head = { sequence: 1_000 };

    const before = new RpcLagMonitor(
      { getLatestLedger: async () => head },
      { store, warningLedgers: 5, criticalLedgers: 20 },
      () => undefined,
    );
    before.recordProcessedLedger(995);
    await before.persist();

    // The node only moved a little while the keeper was down.
    head.sequence = 998;

    const after = new RpcLagMonitor(
      { getLatestLedger: async () => head },
      { store, warningLedgers: 5, criticalLedgers: 20 },
      () => undefined,
    );
    expect(after.getProcessedLedger()).toBe(0);

    await after.restore();
    const report = await after.check();

    expect(after.getProcessedLedger()).toBe(995);
    expect(report.lagLedgers).toBe(3);
    expect(report.severity).toBe('ok');
  });

  it('does not move the marker backwards when the checkpoint is behind', async () => {
    const store = new MemoryCheckpointStore();
    await store.save({
      version: 1,
      nextLedger: 10,
      lastProcessedLedger: 9,
      updatedAt: 0,
    });

    const monitor = new RpcLagMonitor(
      { getLatestLedger: async () => ({ sequence: 100 }) },
      { store },
      () => undefined,
    );
    monitor.recordProcessedLedger(50);
    await monitor.restore();

    expect(monitor.getProcessedLedger()).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Scenario: the whole keeper, end to end
// ---------------------------------------------------------------------------

describe('a keeper coming back after an outage', () => {
  it('picks up exactly the work that was missed', async () => {
    const chain = new FakeChain();
    const listenerStore = new MemoryCheckpointStore();
    const lagStore = new MemoryCheckpointStore();

    // --- Before the outage ------------------------------------------------
    chain.appendRange(1000, 5);
    const listener = new ContractEventListener(chain.source(), {
      startLedger: 1000,
      store: listenerStore,
    });
    const monitor = new RpcLagMonitor(
      { getLatestLedger: async () => ({ sequence: chain.head }) },
      { store: lagStore },
      () => undefined,
    );

    const handled: number[] = [];
    listener.onRaw((e) => handled.push(e.ledger));

    await listener.poll();
    monitor.recordProcessedLedger(listener.lastProcessedLedger);
    await monitor.persist();

    expect(handled).toEqual([1000, 1001, 1002, 1003, 1004]);
    expect(listenerStore.peek()!.nextLedger).toBe(1005);
    expect(lagStore.peek()!.nextLedger).toBe(1005);

    // --- The outage: the process is gone for a long time ------------------
    chain.appendRange(1005, 95);

    // --- After the outage: a fresh process -------------------------------
    const restarted = new ContractEventListener(chain.source(), {
      startLedger: 0,
      store: listenerStore,
    });
    const restartedMonitor = new RpcLagMonitor(
      { getLatestLedger: async () => ({ sequence: chain.head }) },
      { store: lagStore },
      () => undefined,
    );

    await restarted.restore();
    await restartedMonitor.restore();

    const handledAfter = collect(restarted);
    await restarted.poll();
    restartedMonitor.recordProcessedLedger(restarted.lastProcessedLedger);

    // Everything that happened during the outage was handled exactly once.
    expect(handledAfter).toHaveLength(95);
    expect(handledAfter[0]).toBe(1005);
    expect(handledAfter[handledAfter.length - 1]).toBe(1099);

    // No duplicates across the whole lifetime of the keeper.
    const all = [...handled, ...handledAfter];
    expect(new Set(all).size).toBe(all.length);

    // The keeper is caught up again.
    expect(restarted.currentLedger).toBe(1100);
    const report = await restartedMonitor.check();
    expect(report.lagLedgers).toBe(0);
    expect(report.severity).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Scenario: a full page stops in the middle of a busy ledger
// ---------------------------------------------------------------------------

describe('a page that ends mid-ledger', () => {
  /** Ledger 100 carries five events; 101 and 102 carry one each. */
  function busyChain(): FakeChain {
    const chain = new FakeChain();
    for (let i = 0; i < 5; i += 1) chain.append(100, 'deposit');
    chain.append(101, 'harvest');
    chain.append(102, 'withdraw');
    return chain;
  }

  function collectIds(listener: ContractEventListener): string[] {
    const seen: string[] = [];
    listener.onRaw((e) => seen.push(`${e.ledger}:${(e.topic as string[])[0]}`));
    return seen;
  }

  const ALL = [
    '100:deposit', '100:deposit', '100:deposit', '100:deposit', '100:deposit',
    '101:harvest', '102:withdraw',
  ];

  it('delivers every event in the ledger, continuing with the RPC paging cursor', async () => {
    const chain = busyChain();
    const listener = new ContractEventListener(chain.source(), { startLedger: 100, pageSize: 2 });
    const seen = collectIds(listener);

    for (let i = 0; i < 5; i += 1) await listener.poll();

    expect(seen).toEqual(ALL);
    expect(chain.requests[0]).toMatchObject({ startLedger: 100 });
    expect(chain.requests[1].cursor).toBe(chain.events[1].id);
    expect(chain.requests[1].startLedger).toBeUndefined();
    expect(listener.currentLedger).toBe(103);
  });

  it('persists the paging cursor so a restart resumes mid-ledger without replay or gaps', async () => {
    const chain = busyChain();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-cursor-'));
    const file = path.join(dir, 'listener.json');

    try {
      // Run 1 consumes one full page (two of ledger 100's five events) and dies.
      const first = new ContractEventListener(chain.source(), {
        startLedger: 100,
        pageSize: 2,
        store: new FileCheckpointStore(file),
      });
      const beforeCrash = collectIds(first);
      await first.poll();
      expect(beforeCrash).toEqual(ALL.slice(0, 2));

      // Run 2 is a brand new process reading the checkpoint from disk.
      const second = new ContractEventListener(chain.source(), {
        startLedger: 0,
        pageSize: 2,
        store: new FileCheckpointStore(file),
      });
      const afterRestart = collectIds(second);
      for (let i = 0; i < 4; i += 1) await second.poll();

      expect([...beforeCrash, ...afterRestart]).toEqual(ALL);
      expect(second.currentLedger).toBe(103);

      // Once drained, the checkpoint no longer carries a paging cursor.
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(saved.nextLedger).toBe(103);
      expect(saved.metadata?.eventCursor).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('drops a stored paging cursor when the operator moves startLedger past it', async () => {
    const chain = busyChain();
    const store = new MemoryCheckpointStore();

    const first = new ContractEventListener(chain.source(), { startLedger: 100, pageSize: 2, store });
    await first.poll();
    expect(store.peek()!.metadata?.eventCursor).toBe(chain.events[1].id);

    const second = new ContractEventListener(chain.source(), { startLedger: 102, pageSize: 2, store });
    const seen = collectIds(second);
    await second.poll();

    expect(chain.requests[1]).toMatchObject({ startLedger: 102 });
    expect(chain.requests[1].cursor).toBeUndefined();
    expect(seen).toEqual(['102:withdraw']);
  });
});
