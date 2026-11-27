/**
 * Tests for the operational event-listener APIs:
 *
 * - #438: payload sizes are validated before an event is decoded/dispatched.
 * - #436: a bounded ledger range can be replayed without moving live state.
 * - #437: `getHealth()` reports subscription status and counters.
 */

import {
  ContractEventListener,
  DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
  MAX_REPLAY_LEDGERS,
  ReplayRangeError,
  eventPayloadSizeBytes,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type RawContractEvent,
} from './eventListener';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(
  contractId: string,
  topic: unknown[],
  ledger = 100,
  value: unknown = null,
  id?: string,
): RawContractEvent {
  return {
    contractId,
    topic,
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    value,
    id: id ?? `${contractId}-${ledger}`,
  };
}

/** A source whose responses are produced per request. */
function scriptedSource(
  respond: (request: GetEventsRequest) => GetEventsResponse,
): EventSource & { requests: GetEventsRequest[] } {
  const requests: GetEventsRequest[] = [];
  return {
    requests,
    async getEvents(request: GetEventsRequest): Promise<GetEventsResponse> {
      requests.push(request);
      return respond(request);
    },
  };
}

function fixedSource(events: RawContractEvent[], latestLedger = 110) {
  return scriptedSource(() => ({ events, latestLedger }));
}

const VAULT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function listenerWith(
  source: EventSource,
  overrides: Partial<ConstructorParameters<typeof ContractEventListener>[1]> = {},
) {
  return new ContractEventListener(source, {
    startLedger: 100,
    contractAddresses: [VAULT],
    ...overrides,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// #438 — payload size validation
// ---------------------------------------------------------------------------

describe('event payload size validation (#438)', () => {
  it('measures topic and value as UTF-8 bytes and survives BigInt/circular payloads', () => {
    const small = eventPayloadSizeBytes({ topic: ['deposit'], value: 1n });
    expect(small).toBeGreaterThan(0);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => eventPayloadSizeBytes({ topic: ['deposit'], value: cycle })).not.toThrow();

    const wide = eventPayloadSizeBytes({ topic: ['deposit'], value: 'é'.repeat(10) });
    const ascii = eventPayloadSizeBytes({ topic: ['deposit'], value: 'a'.repeat(10) });
    expect(wide).toBeGreaterThan(ascii);
  });

  it('drops an oversized event before any handler or decoder sees it', async () => {
    const raw = makeRaw(VAULT, ['deposit'], 100, 'x'.repeat(4096));
    const source = fixedSource([raw], 110);
    const listener = listenerWith(source, { maxEventPayloadBytes: 128 });

    const typed = jest.fn();
    const rawHandler = jest.fn();
    listener.on('deposit', typed).onRaw(rawHandler);

    await listener.poll();

    expect(typed).not.toHaveBeenCalled();
    expect(rawHandler).not.toHaveBeenCalled();

    const health = listener.getHealth();
    expect(health.events.oversized).toBe(1);
    expect(health.events.skipped).toBe(1);
    expect(health.events.processed).toBe(1);
  });

  it('advances the cursor past a dropped event so it is not re-fetched forever', async () => {
    const source = fixedSource([makeRaw(VAULT, ['harvest'], 100, 'x'.repeat(4096))], 110);
    const listener = listenerWith(source, { maxEventPayloadBytes: 32 });

    const first = await listener.pollWithResult();
    expect(first.status).toBe('ok');
    expect(listener.currentLedger).toBe(111);

    await listener.poll();
    // The event was consumed even though it was never dispatched.
    expect(source.requests[1].startLedger).toBe(111);
  });

  it('accepts a payload of exactly the configured size and rejects one byte more', async () => {
    const accepted = makeRaw(VAULT, ['deposit'], 101, 'ok');
    const exact = eventPayloadSizeBytes(accepted);

    const passSource = fixedSource([accepted], 110);
    const passListener = listenerWith(passSource, { maxEventPayloadBytes: exact });
    const passHandler = jest.fn();
    passListener.on('deposit', passHandler);
    await passListener.poll();
    expect(passHandler).toHaveBeenCalledTimes(1);

    const rejected = makeRaw(VAULT, ['deposit'], 102, 'ok');
    const rejectListener = listenerWith(fixedSource([rejected], 110), {
      maxEventPayloadBytes: exact - 1,
    });
    const rejectHandler = jest.fn();
    rejectListener.on('deposit', rejectHandler);
    await rejectListener.poll();
    expect(rejectHandler).not.toHaveBeenCalled();
  });

  it('defaults to 64 KiB and rejects a non-integer limit', () => {
    const listener = listenerWith(fixedSource([]));
    expect(listener.getHealth().maxEventPayloadBytes).toBe(DEFAULT_MAX_EVENT_PAYLOAD_BYTES);

    expect(
      () => listenerWith(fixedSource([]), { maxEventPayloadBytes: -1 }),
    ).toThrow('maxEventPayloadBytes must be a non-negative integer');
    expect(
      () => listenerWith(fixedSource([]), { maxEventPayloadBytes: 1.5 }),
    ).toThrow('maxEventPayloadBytes must be a non-negative integer');
  });
});

// ---------------------------------------------------------------------------
// #437 — health status
// ---------------------------------------------------------------------------

describe('event subscription health (#437)', () => {
  it('reports idle before the first poll', () => {
    const health = listenerWith(fixedSource([])).getHealth();

    expect(health.status).toBe('idle');
    expect(health.running).toBe(false);
    expect(health.polls).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(health.events).toEqual({ processed: 0, dispatched: 0, skipped: 0, oversized: 0 });
    expect(health.lastError).toBeNull();
  });

  it('reports healthy while running after a successful poll', async () => {
    let now = 1_000;
    const listener = listenerWith(fixedSource([], 110), { now: () => now });

    listener.start(60_000);
    await settle();

    const health = listener.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.running).toBe(true);
    expect(health.polls).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(health.lastPollAt).toBe(1_000);
    expect(health.lastSuccessAt).toBe(1_000);
    expect(health.lastError).toBeNull();

    listener.stop();
    expect(listener.getHealth().status).toBe('stopped');
  });

  it('reports degraded after a failure and clears it on the next success', async () => {
    let fail = true;
    const source = scriptedSource(() => {
      if (fail) throw new Error('rpc unavailable');
      return { events: [], latestLedger: 110 };
    });
    const listener = listenerWith(source, { now: () => 5_000 });

    listener.start(60_000);
    await settle();
    listener.stop();

    let health = listener.getHealth();
    expect(health.status).toBe('stopped');
    expect(health.consecutiveFailures).toBe(1);
    expect(health.polls.failed).toBe(1);
    expect(health.lastError).toEqual({ message: 'rpc unavailable', ledger: 100 });

    // A later success clears the failure state.
    fail = false;
    await listener.poll();
    health = listener.getHealth();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBeNull();
    expect(health.polls.succeeded).toBe(1);
  });

  it('reports degraded while running with an unresolved failure', async () => {
    const source = scriptedSource(() => {
      throw new Error('rpc unavailable');
    });
    const listener = listenerWith(source);
    listener.onError(() => undefined);

    listener.start(60_000);
    await settle();

    expect(listener.getHealth().status).toBe('degraded');
    listener.stop();
  });

  it('counts dispatched, skipped, and oversized events', async () => {
    const events = [
      makeRaw(VAULT, ['deposit'], 100, 'ok'),
      makeRaw(VAULT, ['mystery'], 100, 'ok'),
      makeRaw(VAULT, ['harvest'], 100, 'x'.repeat(512)),
      makeRaw('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', ['deposit'], 100),
    ];
    const listener = listenerWith(fixedSource(events, 110), { maxEventPayloadBytes: 256 });
    listener.on('deposit', () => undefined);

    await listener.poll();

    const health = listener.getHealth();
    expect(health.events.dispatched).toBe(1);
    expect(health.events.skipped).toBe(3); // unknown topic, oversized, address filtered
    expect(health.events.oversized).toBe(1);
    expect(health.events.processed).toBe(3); // filtered event is not "processed"
    expect(health.cursor).toBe(111);
  });

  it('treats a rejected cursor as a failed poll without losing the position', async () => {
    const source = scriptedSource(() => {
      throw new Error('cursor is too old');
    });
    const listener = listenerWith(source);

    const result = await listener.pollWithResult();
    expect(result.status).toBe('cursor_expired');

    const health = listener.getHealth();
    expect(health.polls.failed).toBe(1);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError?.message).toMatch(/cursor/i);
    expect(health.cursor).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// #436 — bounded replay
// ---------------------------------------------------------------------------

describe('bounded ledger replay (#436)', () => {
  it('replays the requested range through handlers', async () => {
    const pageOne = [
      makeRaw(VAULT, ['deposit'], 50, 'a', 'e50'),
      makeRaw(VAULT, ['deposit'], 51, 'b', 'e51'),
    ];
    const pageTwo = [makeRaw(VAULT, ['harvest'], 52, 'c', 'e52')];

    const source = scriptedSource((request) =>
      request.cursor ? { events: pageTwo, latestLedger: 60 } : { events: pageOne, latestLedger: 60 },
    );
    const listener = listenerWith(source, { startLedger: 500 });

    const deposits: number[] = [];
    const harvests: number[] = [];
    listener.on('deposit', (e) => deposits.push((e as { timestamp: number }).timestamp));
    listener.on('harvest', () => harvests.push(52));

    const result = await listener.replay({ fromLedger: 50, toLedger: 55, pageSize: 2 });

    expect(result).toEqual({
      fromLedger: 50,
      toLedger: 55,
      pages: 2,
      eventsProcessed: 3,
      eventsDispatched: 3,
      eventsSkipped: 0,
      eventsOversized: 0,
      lastLedger: 52,
      completed: true,
    });
    expect(deposits).toHaveLength(2);
    expect(harvests).toEqual([52]);

    // The first request starts at fromLedger and is bounded by toLedger.
    expect(source.requests[0].startLedger).toBe(50);
    expect(source.requests[0].endLedger).toBe(55);
    // The second page continues strictly after the last event.
    expect(source.requests[1].cursor).toBe('e51');
    expect(source.requests[1].startLedger).toBeUndefined();
  });

  it('never moves the live cursor or the durable checkpoint', async () => {
    const persisted = jest.fn();
    const store = {
      load: async () => null,
      save: persisted,
      clear: async () => undefined,
    };
    const withStore = listenerWith(fixedSource([makeRaw(VAULT, ['deposit'], 50, 'a')], 60), {
      startLedger: 500,
      store,
    });

    const before = withStore.currentLedger;
    await withStore.replay({ fromLedger: 10, toLedger: 20 });

    expect(withStore.currentLedger).toBe(before);
    expect(persisted).not.toHaveBeenCalled();
    expect(withStore.getHealth().events.processed).toBe(0);
  });

  it('honours a per-replay address override', async () => {
    const events = [
      makeRaw(VAULT, ['deposit'], 10, 'a'),
      makeRaw('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', ['deposit'], 10, 'b'),
    ];
    const source = fixedSource(events, 20);
    const listener = listenerWith(source, { startLedger: 100 });
    const handler = jest.fn();
    listener.on('deposit', handler);

    const result = await listener.replay({
      fromLedger: 10,
      toLedger: 10,
      contractAddresses: [],
    });

    // Empty override means pass-all, so both events are delivered.
    expect(result.eventsProcessed).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(source.requests[0].filters?.[0].contractIds).toBeUndefined();
  });

  it('applies payload validation during replay too', async () => {
    const source = fixedSource([makeRaw(VAULT, ['deposit'], 10, 'x'.repeat(1024))], 20);
    const listener = listenerWith(source, { maxEventPayloadBytes: 64 });
    const handler = jest.fn();
    listener.on('deposit', handler);

    const result = await listener.replay({ fromLedger: 10, toLedger: 10 });

    expect(handler).not.toHaveBeenCalled();
    expect(result.eventsOversized).toBe(1);
    expect(result.eventsSkipped).toBe(1);
  });

  it('stops early at maxEvents and reports an incomplete replay', async () => {
    const events = [
      makeRaw(VAULT, ['deposit'], 10, 'a', 'e10'),
      makeRaw(VAULT, ['deposit'], 10, 'b', 'e11'),
    ];
    const source = scriptedSource(() => ({ events, latestLedger: 20 }));
    const listener = listenerWith(source);

    const result = await listener.replay({
      fromLedger: 10,
      toLedger: 20,
      pageSize: 2,
      maxEvents: 2,
    });

    expect(result.completed).toBe(false);
    expect(result.eventsProcessed).toBe(2);
    expect(source.requests).toHaveLength(1);
  });

  it('rejects invalid and unbounded ranges without calling the RPC', async () => {
    const source = fixedSource([], 20);
    const listener = listenerWith(source);

    await expect(listener.replay({ fromLedger: 20, toLedger: 10 })).rejects.toBeInstanceOf(
      ReplayRangeError,
    );
    await expect(listener.replay({ fromLedger: 20, toLedger: 10 })).rejects.toMatchObject({
      code: 'invalid_range',
    });
    await expect(listener.replay({ fromLedger: -1, toLedger: 5 })).rejects.toMatchObject({
      code: 'invalid_range',
    });
    await expect(listener.replay({ fromLedger: 0.5, toLedger: 5 })).rejects.toMatchObject({
      code: 'invalid_range',
    });
    await expect(
      listener.replay({ fromLedger: 0, toLedger: MAX_REPLAY_LEDGERS }),
    ).rejects.toMatchObject({ code: 'range_too_large' });

    expect(source.requests).toHaveLength(0);
  });

  it('accepts a single-ledger range', async () => {
    const source = fixedSource([makeRaw(VAULT, ['deposit'], 42, 'a')], 60);
    const listener = listenerWith(source, { startLedger: 500 });
    const handler = jest.fn();
    listener.on('deposit', handler);

    const result = await listener.replay({ fromLedger: 42, toLedger: 42 });

    expect(result.completed).toBe(true);
    expect(result.pages).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted replay before fetching', async () => {
    const source = fixedSource([], 20);
    const listener = listenerWith(source);
    const controller = new AbortController();
    controller.abort();

    await expect(
      listener.replay({ fromLedger: 1, toLedger: 2, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(source.requests).toHaveLength(0);
  });

  it('serializes replay with polling so handlers never interleave', async () => {
    const order: string[] = [];
    const source: EventSource = {
      async getEvents(request: GetEventsRequest): Promise<GetEventsResponse> {
        // A poll and a replay must not be in flight at the same time.
        expect(request).toBeDefined();
        order.push('fetch');
        await settle();
        return { events: [makeRaw(VAULT, ['deposit'], request.startLedger ?? 0, 'a')], latestLedger: 110 };
      },
    };
    const listener = listenerWith(source, { startLedger: 100 });
    listener.on('deposit', () => order.push('handler'));

    const poll = listener.poll();
    const replay = listener.replay({ fromLedger: 1, toLedger: 2 });
    await Promise.all([poll, replay]);

    expect(order).toEqual(['fetch', 'handler', 'fetch', 'handler']);
  });
});
