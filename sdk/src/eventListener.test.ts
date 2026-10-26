/**
 * Unit tests for ContractEventListener, covering:
 *
 * - Address-filter construction (allow-list, pass-all, case-insensitive)
 * - RPC request building: contractIds pushed into the RPC filter
 * - SDK-level secondary filtering (belt-and-suspenders)
 * - Typed event dispatch (vault / rebalance / reward families)
 * - Raw handler receives every passing event regardless of type
 * - Ledger cursor advancement after each poll
 * - Error handling: custom handler vs console fallback
 * - on/off handler registration
 * - isRunning / start / stop lifecycle (without real timers)
 */

import {
  ContractEventListener,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type ListenerConfig,
  type RawContractEvent,
  type ListenerErrorEvent,
} from './eventListener';
import { MemoryCheckpointStore } from './persistence';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RawContractEvent. */
function makeRaw(
  contractId: string,
  topic: unknown[],
  ledger = 100,
  ledgerClosedAt = '2024-01-01T00:00:00Z',
  value: unknown = null,
): RawContractEvent {
  return { contractId, topic, ledger, ledgerClosedAt, value, id: `${contractId}-${ledger}` };
}

/**
 * Create an EventSource stub that returns a fixed response. Captures the most
 * recent request for assertion in tests.
 */
function stubSource(
  events: RawContractEvent[],
  latestLedger = 110,
): EventSource & { lastRequest: GetEventsRequest | null; callCount: number } {
  let lastRequest: GetEventsRequest | null = null;
  let callCount = 0;
  return {
    get lastRequest() { return lastRequest; },
    get callCount() { return callCount; },
    async getEvents(req: GetEventsRequest): Promise<GetEventsResponse> {
      lastRequest = req;
      callCount += 1;
      return { events, latestLedger };
    },
  };
}

/** Create a listener with a given allow-list and a stub source. */
function makeListener(
  contractAddresses: string[] | undefined,
  events: RawContractEvent[],
  latestLedger = 110,
) {
  const source = stubSource(events, latestLedger);
  const config: ListenerConfig = {
    startLedger: 100,
    contractAddresses,
  };
  const listener = new ContractEventListener(source, config);
  return { listener, source };
}

// ---------------------------------------------------------------------------
// Address filtering
// ---------------------------------------------------------------------------

describe('address filtering', () => {
  const VAULT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const VAULT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM';
  const OTHER  = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCP3JF';

  it('passes all events when no contractAddresses is configured', async () => {
    const events = [
      makeRaw(VAULT_A, ['deposit']),
      makeRaw(OTHER,   ['harvest']),
    ];
    const { listener } = makeListener(undefined, events);

    const seen: string[] = [];
    listener.onRaw((e) => seen.push(e.contractId));
    await listener.poll();

    expect(seen).toEqual([VAULT_A, OTHER]);
  });

  it('passes all events when contractAddresses is an empty array', async () => {
    const events = [
      makeRaw(VAULT_A, ['deposit']),
      makeRaw(OTHER,   ['harvest']),
    ];
    const { listener } = makeListener([], events);

    const seen: string[] = [];
    listener.onRaw((e) => seen.push(e.contractId));
    await listener.poll();

    expect(seen).toEqual([VAULT_A, OTHER]);
  });

  it('drops events from contracts not in the allow-list', async () => {
    const events = [
      makeRaw(VAULT_A, ['deposit']),
      makeRaw(OTHER,   ['deposit']),
    ];
    const { listener } = makeListener([VAULT_A], events);

    const seen: string[] = [];
    listener.onRaw((e) => seen.push(e.contractId));
    await listener.poll();

    expect(seen).toEqual([VAULT_A]);
    expect(seen).not.toContain(OTHER);
  });

  it('accepts events from all listed addresses', async () => {
    const events = [
      makeRaw(VAULT_A, ['deposit']),
      makeRaw(VAULT_B, ['harvest']),
      makeRaw(OTHER,   ['deposit']),
    ];
    const { listener } = makeListener([VAULT_A, VAULT_B], events);

    const seen: string[] = [];
    listener.onRaw((e) => seen.push(e.contractId));
    await listener.poll();

    expect(seen).toContain(VAULT_A);
    expect(seen).toContain(VAULT_B);
    expect(seen).not.toContain(OTHER);
  });

  it('performs case-insensitive address comparison', async () => {
    const upper = VAULT_A.toUpperCase();
    const lower = VAULT_A.toLowerCase();
    const events = [makeRaw(upper, ['deposit'])];
    // Allow-list uses the opposite casing
    const { listener } = makeListener([lower], events);

    const seen: string[] = [];
    listener.onRaw((e) => seen.push(e.contractId));
    await listener.poll();

    expect(seen).toContain(upper);
  });
});

// ---------------------------------------------------------------------------
// RPC request building — contractIds are sent to the RPC layer
// ---------------------------------------------------------------------------

describe('RPC request building', () => {
  const VAULT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it('includes contractIds in the RPC filter when allow-list is set', async () => {
    const { listener, source } = makeListener([VAULT_A], []);
    await listener.poll();

    const req = source.lastRequest!;
    expect(req.filters).toBeDefined();
    expect(req.filters![0].contractIds).toEqual([VAULT_A.toLowerCase()]);
  });

  it('omits contractIds from the RPC filter in pass-all mode', async () => {
    const { listener, source } = makeListener(undefined, []);
    await listener.poll();

    const req = source.lastRequest!;
    expect(req.filters![0].contractIds).toBeUndefined();
  });

  it('sends startLedger equal to the current cursor', async () => {
    const source = stubSource([], 105);
    const listener = new ContractEventListener(source, { startLedger: 99 });
    await listener.poll();

    expect(source.lastRequest!.startLedger).toBe(99);
  });

  it('uses the configured pageSize', async () => {
    const { listener, source } = makeListener(undefined, []);
    // rebuild with explicit pageSize
    const src = stubSource([], 110);
    const l = new ContractEventListener(src, { startLedger: 100, pageSize: 50 });
    await l.poll();
    expect(src.lastRequest!.limit).toBe(50);
  });

  it('defaults to pageSize 200', async () => {
    const { listener, source } = makeListener(undefined, []);
    await listener.poll();
    expect(source.lastRequest!.limit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Typed dispatch — vault events
// ---------------------------------------------------------------------------

describe('typed dispatch — vault events', () => {
  const VAULT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it.each(['deposit', 'withdraw', 'harvest', 'pause', 'unpause'] as const)(
    'dispatches %s to the corresponding vault handler',
    async (evtName) => {
      const raw = makeRaw(VAULT, [evtName]);
      const { listener } = makeListener([VAULT], [raw]);

      const received: unknown[] = [];
      listener.on(evtName, (e) => received.push(e));
      await listener.poll();

      expect(received).toHaveLength(1);
      const evt = received[0] as { type: string; contractId: string };
      expect(evt.type).toBe(evtName);
      expect(evt.contractId).toBe(VAULT);
    },
  );

  it('does not call a vault handler for an unrelated event', async () => {
    const raw = makeRaw(VAULT, ['distribution']);
    const { listener } = makeListener([VAULT], [raw]);

    const called: boolean[] = [];
    listener.on('deposit', () => called.push(true));
    await listener.poll();

    expect(called).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Typed dispatch — rebalance events
// ---------------------------------------------------------------------------

describe('typed dispatch — rebalance events', () => {
  const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it.each(['proposal', 'execution', 'failure'] as const)(
    'dispatches %s to the corresponding rebalance handler',
    async (evtName) => {
      const raw = makeRaw(CONTRACT, [evtName]);
      const { listener } = makeListener([CONTRACT], [raw]);

      const received: unknown[] = [];
      listener.on(evtName, (e) => received.push(e));
      await listener.poll();

      expect(received).toHaveLength(1);
      const evt = received[0] as { type: string; contractId: string };
      expect(evt.type).toBe(evtName);
      expect(evt.contractId).toBe(CONTRACT);
    },
  );
});

// ---------------------------------------------------------------------------
// Typed dispatch — reward events
// ---------------------------------------------------------------------------

describe('typed dispatch — reward events', () => {
  const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it.each(['distribution', 'claim', 'expiry'] as const)(
    'dispatches %s to the corresponding reward handler',
    async (evtName) => {
      const raw = makeRaw(CONTRACT, [evtName]);
      const { listener } = makeListener([CONTRACT], [raw]);

      const received: unknown[] = [];
      listener.on(evtName, (e) => received.push(e));
      await listener.poll();

      expect(received).toHaveLength(1);
      const evt = received[0] as { type: string; contractId: string };
      expect(evt.type).toBe(evtName);
      expect(evt.contractId).toBe(CONTRACT);
    },
  );
});

// ---------------------------------------------------------------------------
// Raw handler
// ---------------------------------------------------------------------------

describe('raw handler', () => {
  const A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM';

  it('receives every event that passes the address filter', async () => {
    const events = [makeRaw(A, ['deposit']), makeRaw(A, ['unknown_event'])];
    const { listener } = makeListener([A], events);

    const rawIds: string[] = [];
    listener.onRaw((e) => rawIds.push(e.contractId));
    await listener.poll();

    expect(rawIds).toHaveLength(2);
    expect(rawIds).toEqual([A, A]);
  });

  it('does NOT receive events that fail the address filter', async () => {
    const events = [makeRaw(B, ['deposit'])];
    const { listener } = makeListener([A], events);

    const rawIds: string[] = [];
    listener.onRaw((e) => rawIds.push(e.contractId));
    await listener.poll();

    expect(rawIds).toHaveLength(0);
  });

  it('offRaw removes the handler', async () => {
    const events = [makeRaw(A, ['deposit'])];
    const { listener } = makeListener([A], events);

    const rawIds: string[] = [];
    const handler = (e: { contractId: string }) => rawIds.push(e.contractId);
    listener.onRaw(handler);
    listener.offRaw(handler);
    await listener.poll();

    expect(rawIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// on / off handler chaining
// ---------------------------------------------------------------------------

describe('on/off handler registration', () => {
  const A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it('supports chained .on() calls', async () => {
    const events = [makeRaw(A, ['deposit'])];
    const { listener } = makeListener([A], events);

    const got: string[] = [];
    listener
      .on('deposit', () => got.push('first'))
      .on('deposit', () => got.push('second'));
    await listener.poll();

    expect(got).toEqual(['first', 'second']);
  });

  it('off() removes only the specified handler', async () => {
    const events = [makeRaw(A, ['deposit'])];
    const { listener } = makeListener([A], events);

    const got: string[] = [];
    const first = () => got.push('first');
    const second = () => got.push('second');
    listener.on('deposit', first).on('deposit', second);
    listener.off('deposit', first);
    await listener.poll();

    expect(got).toEqual(['second']);
  });

  it('off() on a never-registered handler is a no-op', async () => {
    const { listener } = makeListener([A], []);
    expect(() => listener.off('deposit', () => {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cursor advancement
// ---------------------------------------------------------------------------

describe('cursor advancement', () => {
  it('advances the cursor to latestLedger + 1 after a successful poll', async () => {
    const source = stubSource([], 120);
    const listener = new ContractEventListener(source, { startLedger: 100 });

    expect(listener.currentLedger).toBe(100);
    await listener.poll();
    expect(listener.currentLedger).toBe(121); // 120 + 1
  });

  it('does not move the cursor backwards when RPC returns a ledger behind our cursor', async () => {
    const source = stubSource([], 80);
    const listener = new ContractEventListener(source, { startLedger: 100 });

    await listener.poll();
    expect(listener.currentLedger).toBe(100); // unchanged
  });

  it('uses the advanced cursor on the next poll', async () => {
    let call = 0;
    const source: EventSource = {
      async getEvents(req) {
        const ledger = call === 0 ? 110 : 120;
        call += 1;
        return { events: [], latestLedger: ledger };
      },
    };
    const listener = new ContractEventListener(source, { startLedger: 100 });

    await listener.poll(); // cursor -> 111
    await listener.poll(); // should start from 111

    // We can't easily capture the second request start without a spy, but we
    // can verify the cursor advanced correctly through both polls.
    expect(listener.currentLedger).toBe(121);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('calls the registered error handler on RPC failure', async () => {
    const failingSource: EventSource = {
      async getEvents(): Promise<GetEventsResponse> {
        throw new Error('network timeout');
      },
    };
    const listener = new ContractEventListener(failingSource, { startLedger: 100 });

    const errors: ListenerErrorEvent[] = [];
    listener.onError((e) => errors.push(e));
    await listener.poll();

    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe('network timeout');
    expect(errors[0].ledger).toBe(100);
  });

  it('does not throw when no error handler is registered (logs to console)', async () => {
    const failingSource: EventSource = {
      async getEvents(): Promise<GetEventsResponse> {
        throw new Error('oops');
      },
    };
    const listener = new ContractEventListener(failingSource, { startLedger: 100 });

    // Suppress console.error for this test
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(listener.poll()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('does not advance the cursor when a poll fails', async () => {
    const failingSource: EventSource = {
      async getEvents(): Promise<GetEventsResponse> {
        throw new Error('fail');
      },
    };
    const listener = new ContractEventListener(failingSource, { startLedger: 42 });
    listener.onError(() => {}); // suppress console.error

    await listener.poll();
    expect(listener.currentLedger).toBe(42);
  });

  it('continues polling after an error', async () => {
    let calls = 0;
    const source: EventSource = {
      async getEvents() {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return { events: [], latestLedger: 110 };
      },
    };
    const listener = new ContractEventListener(source, { startLedger: 100 });
    listener.onError(() => {}); // suppress console.error

    await listener.poll(); // fails
    await listener.poll(); // succeeds

    expect(calls).toBe(2);
    expect(listener.currentLedger).toBe(111);
  });
});

// ---------------------------------------------------------------------------
// isRunning / start / stop (timer smoke test — no real timers)
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('is not running before start() is called', () => {
    const { listener } = makeListener(undefined, []);
    expect(listener.isRunning).toBe(false);
  });

  it('is running after start() is called', () => {
    const { listener } = makeListener(undefined, []);
    listener.start(60_000);
    expect(listener.isRunning).toBe(true);
    listener.stop();
  });

  it('is not running after stop() is called', () => {
    const { listener } = makeListener(undefined, []);
    listener.start(60_000);
    listener.stop();
    expect(listener.isRunning).toBe(false);
  });

  it('a second start() call while running is a no-op', () => {
    const { listener, source } = makeListener(undefined, []);
    // We only care that there's no throw; call count verification would need
    // fake timers which are out of scope for this smoke test.
    listener.start(60_000);
    listener.start(60_000); // should not throw or create a second interval
    expect(listener.isRunning).toBe(true);
    listener.stop();
  });
});

// ---------------------------------------------------------------------------
// Multiple contracts — integration-style scenario
// ---------------------------------------------------------------------------

describe('multi-contract scenario', () => {
  const VAULT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const VAULT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM';
  const NOISE   = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCP3JF';

  it('routes events from two watched contracts while suppressing noise', async () => {
    const events = [
      makeRaw(VAULT_A, ['deposit'],  100),
      makeRaw(VAULT_B, ['harvest'],  101),
      makeRaw(NOISE,   ['deposit'],  102), // should be dropped
      makeRaw(VAULT_A, ['withdraw'], 103),
    ];
    const source = stubSource(events, 110);
    const listener = new ContractEventListener(source, {
      startLedger: 100,
      contractAddresses: [VAULT_A, VAULT_B],
    });

    const deposits: string[] = [];
    const harvests: string[] = [];
    const withdrawals: string[] = [];

    listener
      .on('deposit',  (e) => deposits.push(e.contractId))
      .on('harvest',  (e) => harvests.push(e.contractId))
      .on('withdraw', (e) => withdrawals.push(e.contractId));

    await listener.poll();

    // NOISE events must not appear
    expect(deposits).toEqual([VAULT_A]);
    expect(harvests).toEqual([VAULT_B]);
    expect(withdrawals).toEqual([VAULT_A]);
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
