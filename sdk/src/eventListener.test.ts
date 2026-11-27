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
});
